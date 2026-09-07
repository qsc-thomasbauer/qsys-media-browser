/**
 * A stand-in for `src/main/config`.
 *
 * The main process reads its Core address, credentials and jail root from
 * build-time constants. That is deliberate - there is no config file and no
 * environment variable a shipped build could be repointed with - but it means a
 * test cannot vary them at runtime either.
 *
 * So tests that need a *different* Core (a throttled one, an open-mode one)
 * stub this module with `vi.doMock` and re-import the API modules. The
 * production code keeps its single, unoverridable source of configuration.
 */
import { PathJail } from '../../src/main/qsys/paths'
import type { Credentials } from '../../src/main/credentials'
import type { MainConfig } from '../../scripts/customer'

export interface MockConfigOptions {
  port: number
  host?: string
  accessMode?: 'protected' | 'open'
  credentials?: Credentials | null
  rootFolder?: string
  allowRootEscape?: boolean
  appId?: string
}

/** The exact shape `src/main/config.ts` exports. */
export interface ConfigModule {
  customer: MainConfig
  jail: PathJail
  coreOrigin: string
  coreHostHeader: string
  isProtected: boolean
  credentials(): Credentials | null
  coreLabel(): string
}

export function makeConfigMock(options: MockConfigOptions): ConfigModule {
  const host = options.host ?? '127.0.0.1'
  const accessMode = options.accessMode ?? 'protected'
  const rootFolder = options.rootFolder ?? ''
  const allowRootEscape = options.allowRootEscape ?? true
  const label = `${host}:${options.port}`

  const customer: MainConfig = {
    id: 'test',
    productName: 'Test Build',
    version: '0.0.0',
    appId: options.appId ?? 'com.yourco.qsys.test',
    core: { host, port: options.port, accessMode },
    rootFolder,
    allowRootEscape,
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
  }

  const credentials =
    options.credentials === undefined
      ? accessMode === 'protected'
        ? { username: 'test-user', password: 'test-password' }
        : null
      : options.credentials

  return {
    customer,
    jail: new PathJail(rootFolder, allowRootEscape),
    coreOrigin: `https://${label}`,
    coreHostHeader: label,
    isProtected: accessMode === 'protected',
    credentials: () => credentials,
    coreLabel: () => label
  }
}
