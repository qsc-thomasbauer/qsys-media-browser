/**
 * A local stand-in for a Q-SYS Core's Management API.
 *
 * Exists so the whole app - including uploads, range-seeking playback and
 * playlists - can be developed and tested without hardware on the bench. It
 * reproduces the parts of the real Core that the app depends on, *including the
 * awkward ones*, because those are exactly the ones worth having tests for:
 *
 *  - a self-signed certificate, so the TLS path is exercised
 *  - `Host`-header enforcement, answering 406 when it is missing
 *  - bearer tokens with an idle timeout, plus an `open` mode with no auth
 *  - the API's inconsistent leading slashes (`/Audio` for top-level folders,
 *    `Audio/file.mp3` for files)
 *  - read-only default folders
 *
 * Run standalone (`npm run mock-core`) or import `startMockCore` from a test.
 */
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import selfsigned from 'selfsigned'
import { AUDIO_MIME } from '../src/shared/media-types'

export interface MockCoreOptions {
  port?: number
  /** Directory that stands in for the Core's `/media`. */
  root?: string
  /** `open` skips authentication entirely, like a Core with no Access Control. */
  accessMode?: 'protected' | 'open'
  username?: string
  password?: string
  /** Seed the reserved folders and a couple of playable files. */
  seed?: boolean
  quiet?: boolean
  /**
   * Force a fresh certificate instead of reusing the cached one. Use this to
   * exercise the app's trust-on-first-use warning deliberately.
   */
  regenerateCert?: boolean
  /**
   * Cap transfer throughput, in bytes per second.
   *
   * Cancellation tests need a transfer that is reliably still running when the
   * cancel arrives, and over loopback even a 24 MB upload can complete inside
   * a few milliseconds. Throttling makes that window deterministic instead of
   * making the test race a fast local socket.
   */
  throttleBytesPerSec?: number
}

export interface MockCore {
  url: string
  port: number
  root: string
  server: Server
  close(): Promise<void>
  /** Tokens the server currently considers valid. */
  tokenCount(): number
}

/**
 * The mock's default login.
 *
 * Exported, and published in this source, because it is a fixture for a server
 * that only ever listens on localhost - not a secret. `scripts/setup-demo.ts`
 * reads these so the demo build's sidecar cannot drift from what the mock
 * actually accepts.
 */
export const MOCK_DEFAULT_USERNAME = 'demo-user'
export const MOCK_DEFAULT_PASSWORD = 'demo-password'

const RESERVED = ['Audio', 'Messages', 'PageArchives', 'Preambles', 'Ringtones']
const API = '/api/v0'
const MEDIA = `${API}/cores/self/media`
const PLAYLISTS = `${API}/cores/self/media_playlists`
const TOKEN_IDLE_MS = 60 * 60 * 1000

interface Playlist {
  id: string
  name: string
  media: string[]
}

/* ------------------------------------------------------------- utilities */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message, code: status })
}

async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('Request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** A short sine-wave WAV, so audio preview has something real to play. */
function sineWav(seconds = 2, hz = 440, rate = 22050): Buffer {
  const samples = seconds * rate
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    // Fade the tail so the clip does not click when it ends.
    const envelope = Math.min(1, (samples - i) / (rate * 0.2))
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000 * envelope), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** A stream transform that limits throughput to `bytesPerSec`. */
function throttle(bytesPerSec: number): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const delayMs = (chunk.length / bytesPerSec) * 1000
      setTimeout(() => done(null, chunk), delayMs)
    }
  })
}

/* -------------------------------------------------- multipart form parser */

interface UploadedFile {
  filename: string
  path: string
}

/**
 * Stream a `multipart/form-data` body to disk.
 *
 * Written as a streaming boundary scanner rather than buffering the request:
 * the app is expected to push files of hundreds of megabytes, and a mock that
 * fell over on those would hide exactly the bugs it exists to catch. Chunks are
 * held back by `delimiter.length - 1` bytes so a boundary split across two TCP
 * reads is still found.
 */
async function parseMultipart(
  req: IncomingMessage,
  boundary: string,
  targetDir: string,
  throttleBytesPerSec?: number
): Promise<UploadedFile[]> {
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const files: UploadedFile[] = []

  let buffer = Buffer.alloc(0)
  let state: 'preamble' | 'headers' | 'body' = 'preamble'
  let current: Part | null = null

  const finishPart = async (): Promise<void> => {
    if (!current) return
    const part = current
    current = null
    await new Promise<void>((done, fail) => {
      part.stream.end((err?: Error | null) => (err ? fail(err) : done()))
    })
    files.push({ filename: part.filename, path: part.path })
  }

  type Part = { filename: string; path: string; stream: ReturnType<typeof createWriteStream> }

  const startPart = (headerBlock: string): Part | null => {
    const disposition = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerBlock)
    const field = disposition?.[1] ?? ''
    const filename = disposition?.[2]
    // The real API takes files under the field name `media`; ignore anything else.
    if (field !== 'media' || !filename) return null
    const safeName = filename.split(/[/\\]/).pop() ?? filename
    const path = join(targetDir, safeName)
    return { filename: safeName, path, stream: createWriteStream(path) }
  }

  const source = throttleBytesPerSec ? req.pipe(throttle(throttleBytesPerSec)) : req

  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, chunk as Buffer])

    let progressed = true
    while (progressed) {
      progressed = false

      if (state === 'preamble') {
        // The first boundary has no leading CRLF.
        const first = buffer.indexOf(`--${boundary}`)
        if (first === -1) break
        buffer = buffer.subarray(first + boundary.length + 2)
        state = 'headers'
        progressed = true
        continue
      }

      if (state === 'headers') {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) break
        current = startPart(buffer.subarray(0, end).toString('utf8'))
        buffer = buffer.subarray(end + 4)
        state = 'body'
        progressed = true
        continue
      }

      // state === 'body'
      const at = buffer.indexOf(delimiter)
      if (at === -1) {
        // Keep back enough bytes that a boundary straddling two chunks is found.
        const keep = Math.min(buffer.length, delimiter.length - 1)
        const flushable = buffer.subarray(0, buffer.length - keep)
        if (flushable.length > 0 && current) current.stream.write(flushable)
        buffer = buffer.subarray(buffer.length - keep)
        break
      }

      if (current) current.stream.write(buffer.subarray(0, at))
      await finishPart()
      buffer = buffer.subarray(at + delimiter.length)

      if (buffer.subarray(0, 2).toString() === '--') {
        state = 'preamble'
        buffer = Buffer.alloc(0)
        break
      }
      // Skip the CRLF after the boundary line.
      if (buffer.subarray(0, 2).toString() === '\r\n') buffer = buffer.subarray(2)
      state = 'headers'
      progressed = true
    }
  }

  await finishPart()
  return files
}

/* ---------------------------------------------------------- certificate */

interface Pems {
  private: string
  cert: string
}

/**
 * Generate a certificate, or reuse the cached one.
 *
 * Reuse matters: the app pins the Core's certificate on first contact, so a
 * mock that minted a new one every restart would raise a "certificate changed"
 * warning on every dev run and train us to ignore it.
 */
async function loadOrCreateCert(file: string, regenerate = false): Promise<Pems> {
  if (!regenerate) {
    const cached = await readFile(file, 'utf8')
      .then((raw) => JSON.parse(raw) as Pems)
      .catch(() => null)
    if (cached?.private && cached.cert) return cached
  }

  // selfsigned v5 is async-only, and its 1024-bit default is rejected outright
  // by OpenSSL's security level - which surfaces only as a TLS handshake
  // failure, with nothing in the log to say why.
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  })

  const result: Pems = { private: pems.private, cert: pems.cert }
  await writeFile(file, JSON.stringify(result))
  return result
}

/* ------------------------------------------------------------ the server */

export async function startMockCore(options: MockCoreOptions = {}): Promise<MockCore> {
  const port = options.port ?? 8443
  const root = resolve(options.root ?? join(process.cwd(), '.mock-media'))
  const stateDir = join(root, '..', '.mock-state')
  const accessMode = options.accessMode ?? 'protected'
  const username = options.username ?? MOCK_DEFAULT_USERNAME
  const password = options.password ?? MOCK_DEFAULT_PASSWORD
  const log = (...args: unknown[]): void => {
    if (!options.quiet) console.log('[mock-core]', ...args)
  }

  await mkdir(root, { recursive: true })
  await mkdir(stateDir, { recursive: true })

  if (options.seed !== false) {
    for (const folder of RESERVED) await mkdir(join(root, folder), { recursive: true })
    await mkdir(join(root, 'Messages', 'ACME'), { recursive: true })
    await writeFile(join(root, 'Audio', 'chime-440.wav'), sineWav(2, 440))
    await writeFile(join(root, 'Audio', 'chime-660.wav'), sineWav(3, 660))
    await writeFile(join(root, 'Messages', 'ACME', 'welcome.wav'), sineWav(2, 330))
  }

  const playlistFile = join(stateDir, 'playlists.json')
  let playlists: Playlist[] = await readFile(playlistFile, 'utf8')
    .then((raw) => JSON.parse(raw) as Playlist[])
    .catch(() => [])
  const savePlaylists = (): Promise<void> =>
    writeFile(playlistFile, JSON.stringify(playlists, null, 2))

  /** token -> last-used timestamp */
  const tokens = new Map<string, number>()

  /* --------------------------------------------------------- path safety */

  /**
   * Resolve a Core-relative path inside `root`, refusing to escape it.
   *
   * Takes an *already decoded* path: the router decodes URL segments, and
   * paths arriving in a JSON body are raw. Decoding again here would throw on
   * a perfectly legal name like "Test 100% off".
   */
  function resolveInRoot(corePath: string): string | null {
    const segments = corePath.split('/').filter(Boolean)
    if (segments.some((s) => s === '.' || s === '..' || s.includes('\0'))) return null
    const full = resolve(join(root, ...segments))
    if (full !== root && !full.startsWith(root + sep)) return null
    return full
  }

  const isReserved = (corePath: string): boolean => {
    const segments = corePath.split('/').filter(Boolean)
    return segments.length === 1 && RESERVED.includes(segments[0]!)
  }

  async function describe(corePath: string, absolute: string): Promise<unknown> {
    const info = await stat(absolute)
    const name = corePath.split('/').filter(Boolean).pop() ?? ''
    const depth = corePath.split('/').filter(Boolean).length
    if (info.isDirectory()) {
      return {
        created: Math.floor(info.birthtimeMs),
        ext: null,
        name,
        // Faithful to the real API's inconsistency: top-level folders come back
        // with a leading slash, everything else without one.
        path: depth === 1 ? `/${corePath}` : corePath,
        size: null,
        type: 'folder',
        updated: Math.floor(info.mtimeMs)
      }
    }
    const ext = extname(name).replace('.', '')
    return {
      created: Math.floor(info.birthtimeMs),
      ext: ext || null,
      name: ext ? name.slice(0, -(ext.length + 1)) : name,
      path: corePath,
      size: info.size,
      type: 'file',
      updated: Math.floor(info.mtimeMs)
    }
  }

  /* ------------------------------------------------------------ handlers */

  async function handleMedia(
    req: IncomingMessage,
    res: ServerResponse,
    corePath: string
  ): Promise<void> {
    const absolute = resolveInRoot(corePath)
    if (!absolute) return sendError(res, 400, 'Bad path')

    const info = await stat(absolute).catch(() => null)
    const accept = req.headers.accept ?? 'application/json'

    switch (req.method) {
      case 'HEAD': {
        res.writeHead(info ? 200 : 404)
        return void res.end()
      }

      case 'GET': {
        if (!info) return sendError(res, 404, 'Not found')

        if (info.isDirectory()) {
          const names = await readdir(absolute)
          const entries = await Promise.all(
            names
              .filter((n) => !n.startsWith('.'))
              .map((n) => {
                const child = corePath ? `${corePath}/${n}` : n
                return describe(child, join(absolute, n))
              })
          )
          return sendJson(res, 200, entries)
        }

        if (accept.includes('application/json')) {
          return sendJson(res, 200, await describe(corePath, absolute))
        }

        // Binary or audio: honour Range so the app's seeking can be tested.
        const mime = AUDIO_MIME[extname(absolute).slice(1).toLowerCase()]
        const contentType = accept.startsWith('audio/')
          ? (mime ?? 'audio/mpeg')
          : 'application/octet-stream'
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')

        if (range) {
          const start = range[1] ? Number(range[1]) : 0
          const end = range[2] ? Number(range[2]) : info.size - 1
          if (start >= info.size || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
            return void res.end()
          }
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes'
          })
          await pipeline(
            createReadStream(absolute, { start, end }),
            ...(options.throttleBytesPerSec ? [throttle(options.throttleBytesPerSec)] : []),
            res
          )
          return
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': info.size,
          'Accept-Ranges': 'bytes'
        })
        await pipeline(
          createReadStream(absolute),
          ...(options.throttleBytesPerSec ? [throttle(options.throttleBytesPerSec)] : []),
          res
        )
        return
      }

      case 'POST': {
        const contentType = req.headers['content-type'] ?? ''

        if (contentType.startsWith('multipart/form-data')) {
          if (!info?.isDirectory()) return sendError(res, 404, 'Upload target is not a folder')
          const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
          const value = boundary?.[1] ?? boundary?.[2]
          if (!value) return sendError(res, 400, 'Missing multipart boundary')

          const uploaded = await parseMultipart(
            req,
            value.trim(),
            absolute,
            options.throttleBytesPerSec
          )
          if (uploaded.length === 0) return sendError(res, 400, 'No "media" part in the request')

          const described = await Promise.all(
            uploaded.map((f) =>
              describe(corePath ? `${corePath}/${f.filename}` : f.filename, f.path)
            )
          )
          return sendJson(res, 201, described.length === 1 ? described[0] : described)
        }

        // JSON body: create folder(s).
        if (!info?.isDirectory()) return sendError(res, 404, 'Parent folder not found')
        const body: unknown = JSON.parse((await readBody(req)).toString('utf8') || 'null')
        const requests = (Array.isArray(body) ? body : [body]) as Array<{ name?: string }>
        const created: unknown[] = []
        for (const request of requests) {
          const name = request?.name
          if (!name || /[/\\]/.test(name)) return sendError(res, 400, 'Bad folder name')
          const child = corePath ? `${corePath}/${name}` : name
          const childAbsolute = resolveInRoot(child)
          if (!childAbsolute) return sendError(res, 400, 'Bad path')
          if (await stat(childAbsolute).catch(() => null)) {
            return sendError(res, 409, 'Already exists')
          }
          await mkdir(childAbsolute)
          created.push(await describe(child, childAbsolute))
        }
        return sendJson(res, 201, created.length === 1 ? created[0] : created)
      }

      case 'PATCH': {
        if (!info) return sendError(res, 404, 'Not found')
        if (isReserved(corePath)) return sendError(res, 403, 'Default folders are read-only')
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { name?: string }
        if (!body.name || /[/\\]/.test(body.name)) return sendError(res, 400, 'Bad name')

        // Faithful to the real Core: `name` is the *stem*, and the existing
        // extension is re-appended. A client that sends a full filename here
        // gets `image.jpeg.jpeg` - which is exactly the bug this reproduces so
        // that it cannot come back.
        const parent = corePath.split('/').slice(0, -1).join('/')
        const currentExt = info.isDirectory() ? '' : extname(corePath)
        const newBase = `${body.name}${currentExt}`
        const target = parent ? `${parent}/${newBase}` : newBase

        const targetAbsolute = resolveInRoot(target)
        if (!targetAbsolute) return sendError(res, 400, 'Bad path')
        await rename(absolute, targetAbsolute)
        return sendJson(res, 200, await describe(target, targetAbsolute))
      }

      case 'PUT': {
        if (!info) return sendError(res, 404, 'Not found')
        if (isReserved(corePath)) return sendError(res, 403, 'Default folders are read-only')
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { path?: string }
        if (!body.path) return sendError(res, 400, 'Missing destination path')

        const destination = resolveInRoot(body.path)
        if (!destination) return sendError(res, 400, 'Bad destination')
        await mkdir(dirname(destination), { recursive: true })
        await rename(absolute, destination)
        return sendJson(res, 200, await describe(body.path.replace(/^\/+/, ''), destination))
      }

      case 'DELETE': {
        // Bulk form: an array of Core paths in the body, addressed at /media.
        if (corePath === '') {
          const body: unknown = JSON.parse((await readBody(req)).toString('utf8') || '[]')
          if (!Array.isArray(body)) return sendError(res, 400, 'Expected an array of paths')
          for (const entry of body as string[]) {
            if (isReserved(entry)) return sendError(res, 403, 'Default folders are read-only')
            const target = resolveInRoot(entry)
            if (!target) return sendError(res, 400, 'Bad path')
            await rm(target, { recursive: true, force: true })
          }
          res.writeHead(204)
          return void res.end()
        }

        if (!info) return sendError(res, 404, 'Not found')
        if (isReserved(corePath)) return sendError(res, 403, 'Default folders are read-only')
        await rm(absolute, { recursive: true, force: true })
        res.writeHead(204)
        return void res.end()
      }

      default:
        return sendError(res, 405, 'Method not allowed')
    }
  }

  async function handlePlaylists(
    req: IncomingMessage,
    res: ServerResponse,
    rest: string
  ): Promise<void> {
    const parts = rest.split('/').filter(Boolean).map(decodeURIComponent)
    const [id, sub, ...trackPath] = parts

    const detail = async (playlist: Playlist): Promise<unknown> => ({
      id: playlist.id,
      name: playlist.name,
      count: playlist.media.length,
      media: await Promise.all(
        playlist.media.map(async (path) => {
          const absolute = resolveInRoot(path)
          const info = absolute ? await stat(absolute).catch(() => null) : null
          const name = path.split('/').pop() ?? path
          const ext = extname(name).replace('.', '')
          return {
            id: path,
            name: ext ? name.slice(0, -(ext.length + 1)) : name,
            path,
            ext: ext || null,
            size: info?.size ?? null,
            type: 'file',
            available: info !== null,
            created: info ? Math.floor(info.birthtimeMs) : 0,
            updated: info ? Math.floor(info.mtimeMs) : 0
          }
        })
      )
    })

    if (!id) {
      if (req.method === 'GET') {
        return sendJson(
          res,
          200,
          playlists.map((p) => ({ id: p.id, name: p.name, count: p.media.length }))
        )
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { name?: string }
        if (!body.name) return sendError(res, 400, 'Missing name')
        const playlist: Playlist = { id: randomUUID(), name: body.name, media: [] }
        playlists.push(playlist)
        await savePlaylists()
        return sendJson(res, 201, { id: playlist.id, name: playlist.name, count: 0 })
      }
      return sendError(res, 405, 'Method not allowed')
    }

    const playlist = playlists.find((p) => p.id === id)
    if (!playlist) return sendError(res, 404, 'No such playlist')

    if (sub === 'media') {
      if (req.method === 'POST') {
        const body: unknown = JSON.parse((await readBody(req)).toString('utf8'))
        const additions = (Array.isArray(body) ? body : [body]) as Array<{ path?: string }>
        for (const addition of additions) {
          if (addition.path) playlist.media.push(addition.path.replace(/^\/+/, ''))
        }
        await savePlaylists()
        return sendJson(res, 200, await detail(playlist))
      }
      if (req.method === 'DELETE') {
        const target = trackPath.join('/')
        const at = playlist.media.indexOf(target)
        if (at === -1) return sendError(res, 404, 'Track not in playlist')
        playlist.media.splice(at, 1)
        await savePlaylists()
        res.writeHead(204)
        return void res.end()
      }
      return sendError(res, 405, 'Method not allowed')
    }

    switch (req.method) {
      case 'GET':
        return sendJson(res, 200, await detail(playlist))
      case 'PUT': {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          name?: string
          media?: Array<{ path: string }>
        }
        if (body.name) playlist.name = body.name
        if (body.media) playlist.media = body.media.map((m) => m.path.replace(/^\/+/, ''))
        await savePlaylists()
        return sendJson(res, 200, await detail(playlist))
      }
      case 'DELETE':
        playlists = playlists.filter((p) => p.id !== id)
        await savePlaylists()
        res.writeHead(204)
        return void res.end()
      default:
        return sendError(res, 405, 'Method not allowed')
    }
  }

  /* -------------------------------------------------------------- router */

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The real Core enforces this, and the app sets it explicitly because of it.
    if (!req.headers.host) return sendError(res, 406, 'Missing Host header')

    const url = new URL(req.url ?? '/', `https://${req.headers.host}`)
    const path = url.pathname

    if (path === `${API}/logon`) {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          username?: string
          password?: string
        }
        if (accessMode === 'open') return sendJson(res, 200, { token: 'open-mode' })
        if (body.username !== username || body.password !== password) {
          return sendError(res, 401, 'Bad credentials')
        }
        const token = randomUUID()
        tokens.set(token, Date.now())
        log(`logon ok for "${body.username}"`)
        return sendJson(res, 200, { token })
      }
      if (req.method === 'DELETE') {
        const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        if (presented) tokens.delete(presented)
        res.writeHead(204)
        return void res.end()
      }
      return sendError(res, 405, 'Method not allowed')
    }

    if (accessMode === 'protected') {
      const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const lastUsed = presented ? tokens.get(presented) : undefined
      if (!presented || lastUsed === undefined) {
        return sendError(res, 401, 'Missing or unknown bearer token')
      }
      if (Date.now() - lastUsed > TOKEN_IDLE_MS) {
        tokens.delete(presented)
        return sendError(res, 401, 'Token expired')
      }
      // The real Core resets the idle timer on every request.
      tokens.set(presented, Date.now())
    }

    if (path === MEDIA || path.startsWith(`${MEDIA}/`)) {
      const corePath = path
        .slice(MEDIA.length)
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent)
        .join('/')
      return handleMedia(req, res, corePath)
    }

    if (path === PLAYLISTS || path.startsWith(`${PLAYLISTS}/`)) {
      return handlePlaylists(req, res, path.slice(PLAYLISTS.length))
    }

    return sendError(res, 404, 'No such endpoint')
  }

  const pems = await loadOrCreateCert(join(stateDir, 'cert.json'), options.regenerateCert)
  const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    void route(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log('error:', message)
      if (!res.headersSent) sendError(res, 500, message)
      else res.destroy()
    })
  })

  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  const actualPort = (server.address() as { port: number }).port
  log(`listening on https://127.0.0.1:${actualPort} (${accessMode} mode)`)
  log(`media root: ${root}`)

  return {
    url: `https://127.0.0.1:${actualPort}`,
    port: actualPort,
    root,
    server,
    tokenCount: () => tokens.size,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

/* --------------------------------------------------------------- CLI */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }

  const core = await startMockCore({
    port: Number(flag('port') ?? 8443),
    root: flag('root'),
    accessMode: args.includes('--open') ? 'open' : 'protected',
    username: flag('username'),
    password: flag('password'),
    regenerateCert: args.includes('--new-cert'),
    throttleBytesPerSec: flag('throttle') ? Number(flag('throttle')) : undefined
  })

  const shutdown = (): void => {
    void core.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
