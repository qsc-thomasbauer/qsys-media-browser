import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { encryptCredentials } from './src/main/credentials'

/**
 * Tests get their own injected customer config.
 *
 * The main process reads its Core address and credentials from build-time
 * constants, which is deliberate - there is no config file and no environment
 * variable that could repoint a shipped build at a different Core. Rather than
 * weakening that by adding a test-only fallback into `src/main/config.ts`,
 * vitest injects the same constants the real build does.
 */
export const TEST_APP_ID = 'com.yourco.qsys.test'
export const TEST_PORT = 18443
export const TEST_USER = 'test-user'
export const TEST_PASSWORD = 'test-password'

const credentials = encryptCredentials(
  { username: TEST_USER, password: TEST_PASSWORD },
  TEST_APP_ID
)

const testCustomer = {
  id: 'test',
  productName: 'Test Build',
  version: '0.0.0',
  appId: TEST_APP_ID,
  core: { host: '127.0.0.1', port: TEST_PORT, accessMode: 'protected' },
  // Integration tests drive the whole /media tree; jail behaviour is covered
  // exhaustively by the unit tests in tests/paths.test.ts.
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
}

export default defineConfig({
  define: {
    __CUSTOMER__: JSON.stringify(testCustomer),
    __CRED_BLOB__: JSON.stringify(credentials.blob),
    __KEY_A__: JSON.stringify(credentials.keyA),
    __KEY_B__: JSON.stringify(credentials.keyB)
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A forked pool keeps the module-level state in the transfer queue and auth
    // token cache from bleeding between test files.
    pool: 'forks',
    // Module-level state (the transfer queue, the cached auth token) must not
    // bleed between files.
    isolate: true,
    fileParallelism: false
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@branding': resolve(__dirname, 'branding')
    }
  }
})
