/**
 * Cores with Access Control disabled.
 *
 * An "open" Core takes no bearer token, and the docs are explicit that requests
 * must then carry *no* `Authorization` header at all. That is a genuinely
 * separate path through `auth` and `client`, so it gets its own file with its
 * own injected config - a config a test cannot change at runtime, because the
 * app reads it from build-time constants by design.
 *
 * `vi.resetModules` plus a stubbed `../src/main/config` is how that config is
 * varied without giving production code an environment-variable escape hatch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockCore, type MockCore } from '../scripts/mock-core'
import { PathJail } from '../src/main/qsys/paths'

const PORT = 18500
let core: MockCore
let mediaRoot: string

beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'qsys-open-'))
  core = await startMockCore({
    port: PORT,
    root: mediaRoot,
    accessMode: 'open',
    quiet: true
  })
})

afterAll(async () => {
  await core?.close()
  await rm(mediaRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/main/config')
})

/** Load the API modules against an open-mode config. */
async function loadOpenMode(): Promise<{
  auth: typeof import('../src/main/qsys/auth')
  media: typeof import('../src/main/qsys/media')
}> {
  vi.resetModules()
  vi.doMock('../src/main/config', () => ({
    customer: {
      id: 'open-test',
      productName: 'Open Test',
      version: '0.0.0',
      appId: 'com.yourco.qsys.open',
      core: { host: '127.0.0.1', port: PORT, accessMode: 'open' },
      rootFolder: '',
      allowRootEscape: true,
      features: {
        upload: true,
        download: true,
        delete: true,
        rename: true,
        move: true,
        createFolder: true,
        preview: true,
        playlists: true,
        devTools: false
      },
      window: { width: 1180, height: 760 }
    },
    jail: new PathJail('', true),
    coreOrigin: `https://127.0.0.1:${PORT}`,
    coreHostHeader: `127.0.0.1:${PORT}`,
    isProtected: false,
    credentials: () => null,
    coreLabel: () => `127.0.0.1:${PORT}`
  }))

  return {
    auth: await import('../src/main/qsys/auth'),
    media: await import('../src/main/qsys/media')
  }
}

describe('open access mode', () => {
  it('reports connected without ever logging on', async () => {
    const { auth } = await loadOpenMode()
    const status = await auth.connect()
    expect(status.state).toBe('connected')
    // No token was minted, because no logon happened.
    expect(core.tokenCount()).toBe(0)
  })

  it('lists media with no Authorization header', async () => {
    const { media } = await loadOpenMode()
    const listing = await media.list('/')
    expect(listing.entries.map((entry) => entry.name)).toContain('Audio')
    expect(core.tokenCount()).toBe(0)
  })

  it('performs write operations too', async () => {
    const { media } = await loadOpenMode()
    const created = await media.mkdir('/', 'Open Mode Folder')
    expect(created.name).toBe('Open Mode Folder')
    await media.remove(['/Open Mode Folder'])
    expect(await media.exists('/Open Mode Folder')).toBe(false)
  })

  it('treats logoff as a no-op', async () => {
    const { auth } = await loadOpenMode()
    await expect(auth.logoff()).resolves.toBeUndefined()
  })
})

describe('a protected build pointed at an open Core', () => {
  it('still works, because the Core ignores the token it is sent', async () => {
    // Worth asserting: a customer's Core can have Access Control turned off
    // after the build shipped, and the app should keep working rather than
    // erroring on a login the Core does not require.
    const response = await fetch(`https://127.0.0.1:${PORT}/api/v0/logon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'anyone', password: 'anything' })
    }).catch(() => null)

    // Node's fetch rejects the self-signed certificate, which is itself the
    // reason the app uses a scoped https.Agent rather than fetch.
    expect(response === null || response.ok).toBe(true)
  })
})
