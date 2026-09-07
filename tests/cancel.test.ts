/**
 * Cancelling a transfer mid-flight.
 *
 * Separated from the main integration suite because it needs a *slow* Core.
 * Over loopback even a 24 MB upload can finish in a few milliseconds, so a test
 * that sleeps and then cancels is racing the socket - it passed about two runs
 * in three. Throttling the mock's throughput makes the in-flight window
 * deterministic, so these assertions test the cancellation path rather than the
 * machine's disk speed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockCore, type MockCore } from '../scripts/mock-core'
import { makeConfigMock } from './support/mock-config'
import type { TransferItem } from '../src/shared/types'

const PORT = 18600
/** 2 MB/s: a 12 MB file then takes ~6s, far longer than any cancel needs. */
const THROTTLE = 2 * 1024 * 1024
const FILE_SIZE = 12 * 1024 * 1024

let core: MockCore
let mediaRoot: string
let localDir: string
let transfer: typeof import('../src/main/qsys/transfer')
let media: typeof import('../src/main/qsys/media')

beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'qsys-cancel-media-'))
  localDir = await mkdtemp(join(tmpdir(), 'qsys-cancel-local-'))

  core = await startMockCore({
    port: PORT,
    root: mediaRoot,
    username: 'test-user',
    password: 'test-password',
    throttleBytesPerSec: THROTTLE,
    quiet: true
  })

  vi.resetModules()
  vi.doMock('../src/main/config', () => makeConfigMock({ port: PORT }))
  transfer = await import('../src/main/qsys/transfer')
  media = await import('../src/main/qsys/media')

  await media.mkdir('/', 'Cancel')
})

afterAll(async () => {
  transfer.cancelAll()
  await core?.close()
  await rm(mediaRoot, { recursive: true, force: true })
  await rm(localDir, { recursive: true, force: true })
  vi.doUnmock('../src/main/config')
})

/** Wait until a transfer is provably mid-flight, so a cancel cannot miss it. */
async function waitUntilFlowing(id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const item = transfer.listTransfers().find((entry) => entry.id === id)
    if (item?.state === 'active' && item.bytes > 0) return
    if (item?.state === 'done' || item?.state === 'error') {
      throw new Error(`Transfer reached ${item.state} before it could be cancelled`)
    }
    if (Date.now() > deadline) throw new Error('Transfer never started flowing')
    await new Promise((done) => setTimeout(done, 10))
  }
}

async function settle(id: string, timeoutMs = 25_000): Promise<TransferItem> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const item = transfer.listTransfers().find((entry) => entry.id === id)
    if (!item) throw new Error(`Transfer ${id} vanished`)
    if (item.state !== 'queued' && item.state !== 'active') return item
    if (Date.now() > deadline) throw new Error(`Transfer stuck in ${item.state}`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

describe('cancelling an upload', () => {
  it('stops mid-flight and reports cancelled, not failed', async () => {
    const localPath = join(localDir, 'upload-cancel.wav')
    await writeFile(localPath, Buffer.alloc(FILE_SIZE, 3))

    const [queued] = transfer.enqueueUploads('/Cancel', [localPath])
    await waitUntilFlowing(queued!.id)

    const inFlight = transfer.listTransfers().find((item) => item.id === queued!.id)!
    expect(inFlight.bytes).toBeGreaterThan(0)
    expect(inFlight.bytes).toBeLessThan(FILE_SIZE)

    transfer.cancelTransfer(queued!.id)
    const finished = await settle(queued!.id)

    expect(finished.state).toBe('cancelled')
    // A cancellation is not an error, and must not be reported as one.
    expect(finished.error).toBeUndefined()
  })
})

describe('cancelling a download', () => {
  it('stops mid-flight and removes the partial file', async () => {
    // Seed a file on the Core to pull back down.
    const source = join(localDir, 'download-source.wav')
    await writeFile(source, Buffer.alloc(FILE_SIZE, 5))
    const [up] = transfer.enqueueUploads('/Cancel', [source])
    expect((await settle(up!.id)).state).toBe('done')

    const target = await mkdtemp(join(tmpdir(), 'qsys-cancel-target-'))
    try {
      const [down] = transfer.enqueueDownloads(['/Cancel/download-source.wav'], target)
      await waitUntilFlowing(down!.id)

      transfer.cancelTransfer(down!.id)
      const finished = await settle(down!.id)

      expect(finished.state).toBe('cancelled')
      // The `.part` file is unlinked, and no truncated file is left in its place.
      expect(existsSync(`${finished.localPath}.part`)).toBe(false)
      expect(existsSync(finished.localPath)).toBe(false)
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

describe('cancelling everything at once', () => {
  it('stops in-flight and queued transfers together', async () => {
    // What happens when the window closes with transfers running.
    const paths = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const path = join(localDir, `all-${n}.wav`)
        await writeFile(path, Buffer.alloc(FILE_SIZE, n))
        return path
      })
    )

    const queued = transfer.enqueueUploads('/Cancel', paths)
    await waitUntilFlowing(queued[0]!.id)

    transfer.cancelAll()
    const settled = await Promise.all(queued.map((item) => settle(item.id)))

    expect(settled.every((item) => item.state === 'cancelled')).toBe(true)
  })
})
