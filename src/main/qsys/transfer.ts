/**
 * Upload and download queue.
 *
 * Media files are audio assets and routinely run to hundreds of megabytes, so
 * nothing here is ever buffered whole: uploads stream from disk through a
 * hand-built multipart body, downloads stream to a `.part` file that is only
 * renamed into place once complete. Both directions report byte-level progress
 * and can be cancelled mid-flight.
 *
 * Each file is its own request rather than using the API's multi-file form, so
 * one failure cannot take a whole batch down and progress is attributable.
 */
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import type { TransferItem, TransferKind } from '@shared/types'
import { baseVirtual, joinVirtual } from '@shared/vpath'
import { mimeFor } from '@shared/media-types'
import { jail } from '../config'
import { QsysError, rawRequest } from './client'

const MEDIA = '/cores/self/media'
const MAX_CONCURRENT = 3
/** Progress is emitted at most this often; a fast LAN transfer would otherwise flood IPC. */
const EMIT_INTERVAL_MS = 100

interface Job {
  item: TransferItem
  controller: AbortController
  run: () => Promise<void>
  /** Cleanup for a partially written download. */
  cleanup?: () => Promise<void>
}

const jobs = new Map<string, Job>()
const queue: string[] = []
let active = 0

const events = new EventEmitter()
let emitTimer: NodeJS.Timeout | null = null
let emitPending = false

function snapshot(): TransferItem[] {
  return [...jobs.values()]
    .map((j) => ({ ...j.item }))
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** Coalesce change notifications so progress ticks do not saturate IPC. */
function emitChange(immediate = false): void {
  if (immediate) {
    if (emitTimer) {
      clearTimeout(emitTimer)
      emitTimer = null
    }
    emitPending = false
    events.emit('change', snapshot())
    return
  }
  if (emitTimer) {
    emitPending = true
    return
  }
  events.emit('change', snapshot())
  emitTimer = setTimeout(() => {
    emitTimer = null
    if (emitPending) {
      emitPending = false
      emitChange()
    }
  }, EMIT_INTERVAL_MS)
}

export function onTransfersChange(listener: (items: TransferItem[]) => void): () => void {
  events.on('change', listener)
  return () => void events.off('change', listener)
}

export function listTransfers(): TransferItem[] {
  return snapshot()
}

export function clearFinished(): void {
  for (const [id, job] of jobs) {
    if (job.item.state !== 'queued' && job.item.state !== 'active') jobs.delete(id)
  }
  emitChange(true)
}

export function cancelTransfer(id: string): void {
  const job = jobs.get(id)
  if (!job) return
  if (job.item.state === 'queued') {
    const at = queue.indexOf(id)
    if (at >= 0) queue.splice(at, 1)
    job.item.state = 'cancelled'
    job.item.finishedAt = Date.now()
    emitChange(true)
    return
  }
  if (job.item.state === 'active') job.controller.abort()
}

/** Cancel everything still in flight - used when the window is closing. */
export function cancelAll(): void {
  for (const id of [...jobs.keys()]) cancelTransfer(id)
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!
    const job = jobs.get(id)
    if (!job || job.item.state !== 'queued') continue

    active++
    job.item.state = 'active'
    job.item.startedAt = Date.now()
    emitChange(true)

    void job
      .run()
      .then(() => {
        job.item.state = 'done'
        job.item.bytes = job.item.total ?? job.item.bytes
      })
      .catch(async (err: unknown) => {
        const aborted =
          job.controller.signal.aborted ||
          (err instanceof QsysError && err.code === 'CANCELLED') ||
          (err instanceof Error && err.name === 'AbortError')
        job.item.state = aborted ? 'cancelled' : 'error'
        if (!aborted) {
          job.item.error =
            err instanceof QsysError || err instanceof Error
              ? err.message
              : 'The transfer failed for an unknown reason.'
        }
        await job.cleanup?.().catch(() => {})
      })
      .finally(() => {
        active--
        job.item.finishedAt = Date.now()
        emitChange(true)
        pump()
      })
  }
}

function enqueue(job: Job): TransferItem {
  jobs.set(job.item.id, job)
  queue.push(job.item.id)
  emitChange(true)
  pump()
  return { ...job.item }
}

function newItem(kind: TransferKind, name: string, localPath: string, remotePath: string): TransferItem {
  return {
    id: randomUUID(),
    kind,
    name,
    localPath,
    remotePath,
    bytes: 0,
    total: null,
    state: 'queued',
    startedAt: Date.now()
  }
}

/* ---------------------------------------------------------------- upload */

/**
 * A multipart body as a stream.
 *
 * Written by hand rather than via `FormData` so the file is read lazily and
 * every chunk can be counted for progress. `Content-Length` is computed up
 * front, which keeps the request out of chunked transfer encoding - appliance
 * HTTP stacks are noticeably happier with a declared length.
 */
function multipartStream(
  localPath: string,
  filename: string,
  boundary: string,
  signal: AbortSignal,
  onBytes: (n: number) => void
): { body: Readable; length: (fileSize: number) => number } {
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename.replace(/"/g, '')}"\r\n` +
      `Content-Type: ${mimeFor(filename)}\r\n\r\n`,
    'utf8'
  )
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  async function* generate(): AsyncGenerator<Buffer> {
    yield preamble
    const source = createReadStream(localPath, { signal })
    for await (const chunk of source) {
      const buf = chunk as Buffer
      onBytes(buf.length)
      yield buf
    }
    yield epilogue
  }

  return {
    body: Readable.from(generate()),
    length: (fileSize) => preamble.length + fileSize + epilogue.length
  }
}

/** Queue one or more local files for upload into a virtual directory. */
export function enqueueUploads(virtualDir: string, localPaths: string[]): TransferItem[] {
  return localPaths.map((localPath) => {
    const name = basename(localPath)
    const remotePath = joinVirtual(virtualDir, name)
    // Validate the destination now so a bad path fails before it is queued.
    jail.toCore(remotePath)

    const item = newItem('upload', name, localPath, remotePath)
    const controller = new AbortController()

    const run = async (): Promise<void> => {
      const { size } = await fsStat(localPath)
      item.total = size
      item.bytes = 0

      const boundary = `----qsysmb${randomUUID().replace(/-/g, '')}`
      const { body, length } = multipartStream(
        localPath,
        name,
        boundary,
        controller.signal,
        (n) => {
          item.bytes += n
          emitChange()
        }
      )

      const encoded = jail.toEncodedCore(virtualDir)
      const response = await rawRequest({
        method: 'POST',
        path: encoded.length === 0 ? MEDIA : `${MEDIA}/${encoded}`,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(length(size))
        },
        body,
        signal: controller.signal
      })
      // Drain the (small) JSON acknowledgement so the socket is released for reuse.
      for await (const _chunk of response.stream) void _chunk
    }

    return enqueue({ item, controller, run })
  })
}

/* -------------------------------------------------------------- download */

/** Avoid clobbering an existing local file: `song.mp3` -> `song (2).mp3`. */
async function uniqueLocalPath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name
  let candidate = join(dir, name)
  for (let n = 2; n < 1000; n++) {
    try {
      await fsStat(candidate)
    } catch {
      return candidate
    }
    candidate = join(dir, `${stem} (${n})${ext}`)
  }
  return candidate
}

/** Queue one or more remote files for download into a local directory. */
export function enqueueDownloads(virtualPaths: string[], targetDir: string): TransferItem[] {
  return virtualPaths.map((remotePath) => {
    const name = baseVirtual(remotePath)
    const encoded = jail.toEncodedCore(remotePath)

    const item = newItem('download', name, join(targetDir, name), remotePath)
    const controller = new AbortController()
    let partPath: string | null = null

    const run = async (): Promise<void> => {
      await mkdir(targetDir, { recursive: true })
      const finalPath = await uniqueLocalPath(targetDir, name)
      item.localPath = finalPath
      partPath = `${finalPath}.part`

      const response = await rawRequest({
        method: 'GET',
        path: `${MEDIA}/${encoded}`,
        accept: 'application/octet-stream',
        signal: controller.signal
      })

      const declared = Number(response.headers['content-length'])
      item.total = Number.isFinite(declared) && declared > 0 ? declared : null

      // Count bytes inside the pipeline rather than with a 'data' listener:
      // attaching one would put the stream into flowing mode before the write
      // stream is connected, and the first chunks would be lost.
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          item.bytes += chunk.length
          emitChange()
          done(null, chunk)
        }
      })

      await pipeline(response.stream, counter, createWriteStream(partPath), {
        signal: controller.signal
      })
      await rename(partPath, finalPath)
      partPath = null
    }

    const cleanup = async (): Promise<void> => {
      if (partPath) await unlink(partPath).catch(() => {})
    }

    return enqueue({ item, controller, run, cleanup })
  })
}
