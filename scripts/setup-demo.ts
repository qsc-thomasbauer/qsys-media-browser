/**
 * Write the demo build's credential sidecar.
 *
 * Credentials are gitignored, which is right for real customers but would
 * otherwise mean a fresh clone could not run `npm run dev` at all. The demo
 * build targets `scripts/mock-core.ts` on localhost, and that server's login is
 * a default published in its own source - not a secret - so this can safely
 * generate it rather than asking someone to invent one.
 *
 *   npm run setup:demo
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRANDING_DIR } from './customer'
import { MOCK_DEFAULT_PASSWORD, MOCK_DEFAULT_USERNAME } from './mock-core'

const target = join(BRANDING_DIR, 'demo.secret.json')

if (existsSync(target)) {
  console.log('branding/demo.secret.json already exists - leaving it alone.')
} else {
  writeFileSync(
    target,
    `${JSON.stringify(
      { username: MOCK_DEFAULT_USERNAME, password: MOCK_DEFAULT_PASSWORD },
      null,
      2
    )}\n`
  )
  console.log('Wrote branding/demo.secret.json (gitignored).')
  console.log(`  username: ${MOCK_DEFAULT_USERNAME}`)
  console.log('  These are scripts/mock-core.ts defaults, not real credentials.')
}

console.log('\nNext:')
console.log('  npm run mock-core     # a fake Core on https://127.0.0.1:8443')
console.log('  npm run dev           # the app, pointed at it')
