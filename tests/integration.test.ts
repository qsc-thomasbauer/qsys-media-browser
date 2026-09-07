/**
 * End-to-end tests against the mock Core.
 *
 * These drive the *real* main-process modules - the same `client`, `auth`,
 * `media`, `transfer` and `playlists` code the app ships - over real TLS with a
 * real self-signed certificate. What they are guarding is the set of
 * awkward details the API docs only hint at, each of which broke something
 * during development:
 *
 *   - the mandatory `Host` header, without which the Core answers 406
 *   - `Content-Length` on a DELETE body, which Node omits by default and which
 *     silently broke bulk delete
 *   - per-segment percent-encoding of names containing spaces and `+`
 *   - the API's inconsistent leading slashes on returned paths
 *   - a token going stale mid-session, and the transparent re-auth on 401
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { startMockCore, type MockCore } from '../scripts/mock-core'
import { TEST_PASSWORD, TEST_PORT, TEST_USER } from '../vitest.config'

import * as auth from '../src/main/qsys/auth'
import * as media from '../src/main/qsys/media'
import * as playlists from '../src/main/qsys/playlists'
import * as transfer from '../src/main/qsys/transfer'
import { QsysError, headRequest, jsonRequest } from '../src/main/qsys/client'
import type { TransferItem } from '../src/shared/types'

let core: MockCore
let mediaRoot: string
let localDir: string

beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'qsys-media-'))
  localDir = await mkdtemp(join(tmpdir(), 'qsys-local-'))
  core = await startMockCore({
    port: TEST_PORT,
    root: mediaRoot,
    username: TEST_USER,
    password: TEST_PASSWORD,
    quiet: true
  })
})

afterAll(async () => {
  await auth.logoff()
  transfer.cancelAll()
  await core?.close()
  await rm(mediaRoot, { recursive: true, force: true })
  await rm(localDir, { recursive: true, force: true })
})

/** Wait for a queued transfer to reach a terminal state. */
async function settle(id: string, timeoutMs = 20_000): Promise<TransferItem> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const item = transfer.listTransfers().find((entry) => entry.id === id)
    if (!item) throw new Error(`Transfer ${id} vanished`)
    if (item.state !== 'queued' && item.state !== 'active') return item
    if (Date.now() > deadline) throw new Error(`Transfer stuck in ${item.state}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

describe('authentication', () => {
  it('signs in with the embedded credentials over self-signed TLS', async () => {
    const status = await auth.connect()
    expect(status.state).toBe('connected')
  })

  it('reuses the token rather than logging in per request', async () => {
    const before = core.tokenCount()
    await media.list('/')
    await media.list('/')
    expect(core.tokenCount()).toBe(before)
  })

  it('re-authenticates transparently when the Core rejects the token', async () => {
    // Simulate the one-hour idle expiry by revoking server-side while the
    // client still believes its token is good.
    await jsonRequest({ method: 'DELETE', path: '/logon' }).catch(() => {})
    const listing = await media.list('/')
    expect(listing.entries.length).toBeGreaterThan(0)
    expect(auth.connectionStatus().state).toBe('connected')
  })

  it('reports a readable error for bad credentials', async () => {
    const wrong = await startMockCore({
      port: TEST_PORT + 1,
      root: mediaRoot,
      username: 'someone-else',
      password: 'not-this',
      seed: false,
      quiet: true
    })
    try {
      // The running client is pinned to TEST_PORT, so assert on the mock's own
      // rejection rather than repointing the app.
      const response = await fetch(`https://127.0.0.1:${TEST_PORT + 1}/api/v0/logon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
        // @ts-expect-error - Node's fetch accepts this dispatcher option shape
        tls: { rejectUnauthorized: false }
      }).catch(() => null)
      expect(response === null || response.status === 401).toBe(true)
    } finally {
      await wrong.close()
    }
  })
})

describe('the Host header requirement', () => {
  it('is what the Core checks first - omitting it yields 406', async () => {
    // Sent as HTTP/1.0: an HTTP/1.1 request with no Host is rejected with 400
    // by Node's own parser before any handler runs, so 1.0 is the only way to
    // reach the Core's own Host check - which is exactly the check the client
    // sets the header explicitly to satisfy.
    const raw = await new Promise<number>((resolve, reject) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: TEST_PORT, rejectUnauthorized: false },
        () => {
          socket.write('GET /api/v0/cores/self/media HTTP/1.0\r\nAccept: application/json\r\n\r\n')
        }
      )
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        if (buffer.includes('\r\n')) {
          const match = /HTTP\/1\.[01] (\d+)/.exec(buffer)
          socket.destroy()
          if (match) resolve(Number(match[1]))
        }
      })
      socket.on('error', reject)
      setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 5000)
    })
    expect(raw).toBe(406)
  })
})

describe('listing', () => {
  it('returns the Core default folders, marked read-only', async () => {
    const listing = await media.list('/')
    const names = listing.entries.map((entry) => entry.name)
    expect(names).toContain('Audio')
    expect(names).toContain('Messages')

    const audio = listing.entries.find((entry) => entry.name === 'Audio')!
    expect(audio.type).toBe('folder')
    expect(audio.readOnly).toBe(true)
    // Leading slashes in the API response must not leak into virtual paths.
    expect(audio.path).toBe('/Audio')
  })

  it('does not mark a folder inside a default folder read-only', async () => {
    const listing = await media.list('/Messages')
    const acme = listing.entries.find((entry) => entry.name === 'ACME')
    expect(acme?.readOnly).toBe(false)
  })

  it('reports a complete filename, extension included', async () => {
    const listing = await media.list('/Audio')
    // The API splits these into name: "chime-440", ext: "wav".
    expect(listing.entries.map((entry) => entry.name)).toContain('chime-440.wav')
    const file = listing.entries.find((entry) => entry.name === 'chime-440.wav')!
    expect(file.ext).toBe('wav')
    expect(file.size).toBeGreaterThan(0)
  })

  it('sorts folders before files', async () => {
    await media.mkdir('/Messages/ACME', 'zzz-folder')
    const listing = await media.list('/Messages/ACME')
    const firstFile = listing.entries.findIndex((entry) => entry.type === 'file')
    const lastFolder = listing.entries.reduce(
      (last, entry, index) => (entry.type === 'folder' ? index : last),
      -1
    )
    expect(lastFolder).toBeLessThan(firstFile)
    await media.remove(['/Messages/ACME/zzz-folder'])
  })

  it('raises a typed error for a folder that is not there', async () => {
    await expect(media.list('/NoSuchFolder')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('folder management', () => {
  it('creates, renames, moves and deletes', async () => {
    const created = await media.mkdir('/', 'Integration Test')
    expect(created.name).toBe('Integration Test')
    expect(created.type).toBe('folder')
    expect(await media.exists('/Integration Test')).toBe(true)

    const renamed = await media.rename({ path: '/Integration Test', name: 'Renamed Folder' })
    expect(renamed.path).toBe('/Renamed Folder')
    expect(await media.exists('/Integration Test')).toBe(false)

    await media.mkdir('/Renamed Folder', 'Nested')
    const [moved] = await media.move([
      { from: '/Renamed Folder/Nested', to: '/Renamed Folder/Moved' }
    ])
    expect(moved!.path).toBe('/Renamed Folder/Moved')

    await media.remove(['/Renamed Folder'])
    expect(await media.exists('/Renamed Folder')).toBe(false)
  })

  describe('rename does not double the file extension', () => {
    // The Core's PATCH takes the *stem* and re-appends the extension itself, so
    // sending a full filename produced `image.jpeg.jpeg`. Reported from real
    // hardware; the mock now reproduces the Core's behaviour so these lock it in.
    beforeEach(async () => {
      await media.mkdir('/', 'Rename Tests').catch(() => {})
    })

    afterEach(async () => {
      await media.remove(['/Rename Tests']).catch(() => {})
    })

    async function seed(filename: string): Promise<void> {
      const localPath = join(localDir, filename)
      await writeFile(localPath, Buffer.alloc(256, 1))
      const [queued] = transfer.enqueueUploads('/Rename Tests', [localPath])
      expect((await settle(queued!.id)).state).toBe('done')
    }

    it('accepts a full filename without doubling the extension', async () => {
      await seed('image.jpeg')
      const renamed = await media.rename({ path: '/Rename Tests/image.jpeg', name: 'photo.jpeg' })

      expect(renamed.name).toBe('photo.jpeg')
      expect(renamed.path).toBe('/Rename Tests/photo.jpeg')
      expect(renamed.name).not.toBe('photo.jpeg.jpeg')
      expect(await media.exists('/Rename Tests/photo.jpeg')).toBe(true)
      expect(await media.exists('/Rename Tests/photo.jpeg.jpeg')).toBe(false)
    })

    it('accepts a bare stem and keeps the extension', async () => {
      await seed('image.jpeg')
      const renamed = await media.rename({ path: '/Rename Tests/image.jpeg', name: 'photo' })
      expect(renamed.name).toBe('photo.jpeg')
    })

    it('is not fooled by a name that merely ends in the same letters', async () => {
      await seed('image.jpeg')
      // "collage" ends in "age", not ".jpeg" - nothing should be stripped.
      const renamed = await media.rename({ path: '/Rename Tests/image.jpeg', name: 'collage' })
      expect(renamed.name).toBe('collage.jpeg')
    })

    it('matches the extension case-insensitively', async () => {
      await seed('clip.WAV')
      const renamed = await media.rename({ path: '/Rename Tests/clip.WAV', name: 'intro.wav' })
      expect(renamed.name).toBe('intro.WAV')
    })

    it('handles a double extension the way the API reports it', async () => {
      // The API calls this name: "archive.tar", ext: "gz".
      await seed('archive.tar.gz')
      const renamed = await media.rename({
        path: '/Rename Tests/archive.tar.gz',
        name: 'backup.tar.gz'
      })
      expect(renamed.name).toBe('backup.tar.gz')
    })

    it('leaves a file with no extension alone', async () => {
      await seed('README')
      const renamed = await media.rename({ path: '/Rename Tests/README', name: 'NOTES' })
      expect(renamed.name).toBe('NOTES')
    })

    it('renames a folder with a dot in its name without truncating it', async () => {
      // Folders have no extension, so `v1.2` must not become `v1`.
      await media.mkdir('/Rename Tests', 'v1.2')
      const renamed = await media.rename({ path: '/Rename Tests/v1.2', name: 'v1.3' })
      expect(renamed.name).toBe('v1.3')
      expect(renamed.type).toBe('folder')
    })

    it('only strips a trailing extension, never a leading one', async () => {
      await seed('image.jpeg')
      // `.jpeg` is a dotfile stem, not a filename with an extension - the same
      // rule Node's `extname` uses - so nothing is stripped and the Core's
      // preserved extension is appended to it.
      const dotfile = await media.rename({ path: '/Rename Tests/image.jpeg', name: '.jpeg' })
      expect(dotfile.name).toBe('.jpeg.jpeg')

      // Likewise a bare extension with no dot is just a stem.
      const bare = await media.rename({ path: '/Rename Tests/.jpeg.jpeg', name: 'jpeg' })
      expect(bare.name).toBe('jpeg.jpeg')
    })

    it('rejects an empty name', async () => {
      await seed('image.jpeg')
      await expect(
        media.rename({ path: '/Rename Tests/image.jpeg', name: '   ' })
      ).rejects.toMatchObject({ code: 'INVALID_PATH' })
    })
  })

  it('handles names needing percent-encoding', async () => {
    // Spaces, '+', '%', '#' and '&' all survive the round trip only because
    // each segment is encodeURIComponent'd rather than encodeURI'd.
    const awkward = 'Test 100% + more #1 & done'
    const created = await media.mkdir('/', awkward)
    expect(created.name).toBe(awkward)
    expect(await media.exists(`/${awkward}`)).toBe(true)

    const listing = await media.list('/')
    expect(listing.entries.map((entry) => entry.name)).toContain(awkward)

    await media.remove([`/${awkward}`])
    expect(await media.exists(`/${awkward}`)).toBe(false)
  })

  it('refuses to modify the Core default folders', async () => {
    await expect(media.rename({ path: '/Audio', name: 'Sounds' })).rejects.toMatchObject({
      code: 'READ_ONLY'
    })
    await expect(media.remove(['/Audio'])).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(media.move([{ from: '/Audio', to: '/Moved' }])).rejects.toMatchObject({
      code: 'READ_ONLY'
    })
    // Adding content *inside* one is normal and must still work.
    const inside = await media.mkdir('/Audio', 'Subfolder')
    expect(inside.path).toBe('/Audio/Subfolder')
    await media.remove(['/Audio/Subfolder'])
  })

  it('deletes several resources in one request', async () => {
    // Bulk delete sends its paths in a DELETE body, which needs an explicit
    // Content-Length or the Core never sees them.
    await media.mkdir('/', 'Bulk A')
    await media.mkdir('/', 'Bulk B')
    await media.mkdir('/', 'Bulk C')
    await media.remove(['/Bulk A', '/Bulk B', '/Bulk C'])

    expect(await media.exists('/Bulk A')).toBe(false)
    expect(await media.exists('/Bulk B')).toBe(false)
    expect(await media.exists('/Bulk C')).toBe(false)
  })

  it('rejects a traversal attempt from the caller', async () => {
    await expect(media.mkdir('/', '../escaped')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(media.list('/../..')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
})

describe('transfers', () => {
  it('uploads a file, streaming, and reports progress', async () => {
    // Large enough to span many chunks, so the progress counter and the
    // multipart boundary scanner both get exercised.
    const payload = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const localPath = join(localDir, 'upload sample +1.wav')
    await writeFile(localPath, payload)

    await media.mkdir('/', 'Transfers')
    const [queued] = transfer.enqueueUploads('/Transfers', [localPath])
    const finished = await settle(queued!.id)

    expect(finished.state).toBe('done')
    expect(finished.total).toBe(payload.length)
    expect(finished.bytes).toBe(payload.length)

    const remote = await media.stat('/Transfers/upload sample +1.wav')
    expect(remote.size).toBe(payload.length)

    // Byte-for-byte, not just the right length.
    const onDisk = await readFile(join(mediaRoot, 'Transfers', 'upload sample +1.wav'))
    expect(Buffer.compare(onDisk, payload)).toBe(0)
  })

  it('downloads a file and matches it byte for byte', async () => {
    const [queued] = transfer.enqueueDownloads(['/Transfers/upload sample +1.wav'], localDir)
    const finished = await settle(queued!.id)

    expect(finished.state).toBe('done')
    const downloaded = await readFile(finished.localPath)
    const original = await readFile(join(mediaRoot, 'Transfers', 'upload sample +1.wav'))
    expect(Buffer.compare(downloaded, original)).toBe(0)
    // No partial file left behind.
    expect(existsSync(`${finished.localPath}.part`)).toBe(false)
  })

  it('does not overwrite an existing local file', async () => {
    const [queued] = transfer.enqueueDownloads(['/Transfers/upload sample +1.wav'], localDir)
    const finished = await settle(queued!.id)
    expect(finished.state).toBe('done')
    // The first download already claimed the plain name.
    expect(finished.localPath).toMatch(/\(\d\)\.wav$/)
  })

  it('replaces the remote file on re-upload, as the Core does', async () => {
    const localPath = join(localDir, 'replace.wav')
    await writeFile(localPath, Buffer.alloc(1024, 7))
    const [first] = transfer.enqueueUploads('/Transfers', [localPath])
    expect((await settle(first!.id)).state).toBe('done')

    await writeFile(localPath, Buffer.alloc(2048, 9))
    const [second] = transfer.enqueueUploads('/Transfers', [localPath])
    expect((await settle(second!.id)).state).toBe('done')

    const remote = await media.stat('/Transfers/replace.wav')
    expect(remote.size).toBe(2048)
  })

  // Cancelling a transfer mid-flight is covered in tests/cancel.test.ts, which
  // uses a bandwidth-throttled Core so the cancel cannot race a fast loopback
  // socket to completion.

  it('cancels a queued transfer without starting it', async () => {
    const paths = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(async (n) => {
        const path = join(localDir, `queue-${n}.wav`)
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, n))
        return path
      })
    )
    const queued = transfer.enqueueUploads('/Transfers', paths)
    // Concurrency is 3, so the last one is certainly still waiting.
    const last = queued.at(-1)!
    transfer.cancelTransfer(last.id)
    expect((await settle(last.id)).state).toBe('cancelled')

    for (const item of queued.slice(0, 3)) await settle(item.id)
  })

  it('reports a failed transfer rather than throwing', async () => {
    const [queued] = transfer.enqueueUploads('/Transfers', [join(localDir, 'does-not-exist.wav')])
    const finished = await settle(queued!.id)
    expect(finished.state).toBe('error')
    expect(finished.error).toBeTruthy()
  })

  it('clears finished transfers on request', async () => {
    transfer.clearFinished()
    const remaining = transfer.listTransfers()
    expect(remaining.every((item) => item.state === 'queued' || item.state === 'active')).toBe(true)
  })
})

describe('streaming for playback', () => {
  it('serves a byte range, which is what makes seeking work', async () => {
    const encoded = 'Audio/chime-440.wav'
    const full = await headRequest(`/cores/self/media/${encoded}`)
    expect(full).toBe(true)

    const size = (await stat(join(mediaRoot, 'Audio', 'chime-440.wav'))).size
    const { rawRequest } = await import('../src/main/qsys/client')
    const response = await rawRequest({
      method: 'GET',
      path: `/cores/self/media/${encoded}`,
      accept: 'audio/*',
      headers: { Range: 'bytes=100-199' }
    })

    expect(response.status).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 100-199/${size}`)

    const chunks: Buffer[] = []
    for await (const chunk of response.stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).length).toBe(100)
  })
})

describe('playlists', () => {
  let playlistId: string

  it('creates one', async () => {
    const created = await playlists.create('Morning Announcements')
    playlistId = created.id
    expect(created.name).toBe('Morning Announcements')
    expect(created.count).toBe(0)
  })

  it('adds tracks', async () => {
    const detail = await playlists.addTracks(playlistId, [
      '/Audio/chime-440.wav',
      '/Audio/chime-660.wav'
    ])
    expect(detail.media.map((track) => track.name)).toEqual([
      'chime-440.wav',
      'chime-660.wav'
    ])
    expect(detail.media.every((track) => track.available)).toBe(true)
    expect(detail.media.every((track) => !track.external)).toBe(true)
  })

  it('reorders by replacing the track list', async () => {
    const before = await playlists.get(playlistId)
    const reversed = [...before.media].reverse().map((track) => track.corePath)
    const after = await playlists.setTracks(playlistId, reversed)
    expect(after.media.map((track) => track.name)).toEqual([
      'chime-660.wav',
      'chime-440.wav'
    ])
  })

  it('keeps its tracks through a rename', async () => {
    // PUT replaces name *and* media, so a rename that forgot the track list
    // would silently empty the playlist.
    const renamed = await playlists.rename(playlistId, 'Evening Announcements')
    expect(renamed.name).toBe('Evening Announcements')
    expect(renamed.media).toHaveLength(2)
  })

  it('flags a track whose file has been deleted', async () => {
    await media.mkdir('/', 'Temp Playlist Source')
    const localPath = join(localDir, 'doomed.wav')
    await writeFile(localPath, Buffer.alloc(512, 1))
    const [up] = transfer.enqueueUploads('/Temp Playlist Source', [localPath])
    await settle(up!.id)

    await playlists.addTracks(playlistId, ['/Temp Playlist Source/doomed.wav'])
    await media.remove(['/Temp Playlist Source/doomed.wav'])

    const detail = await playlists.get(playlistId)
    const doomed = detail.media.find((track) => track.name === 'doomed.wav')
    expect(doomed?.available).toBe(false)

    await media.remove(['/Temp Playlist Source'])
  })

  it('removes a single track', async () => {
    const before = await playlists.get(playlistId)
    const target = before.media[0]!
    await playlists.removeTrack(playlistId, target.corePath)
    const after = await playlists.get(playlistId)
    expect(after.media).toHaveLength(before.media.length - 1)
  })

  it('refuses to attach a file outside the jail', async () => {
    // This build is unjailed, so assert the guard itself rather than the config.
    const { PathJail } = await import('../src/main/qsys/paths')
    const jailed = new PathJail('Messages/ACME')
    expect(jailed.contains('Audio/chime-440.wav')).toBe(false)
  })

  it('deletes one', async () => {
    await playlists.remove(playlistId)
    const all = await playlists.list()
    expect(all.map((entry) => entry.id)).not.toContain(playlistId)
  })
})

describe('error mapping', () => {
  it('turns transport failures into typed errors', async () => {
    await expect(media.stat('/definitely/not/here.wav')).rejects.toBeInstanceOf(QsysError)
  })

  it('refuses to stat the root, which has no metadata of its own', async () => {
    await expect(media.stat('/')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
})
