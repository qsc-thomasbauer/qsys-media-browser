/**
 * Build every customer in `branding/`.
 *
 *   npm run build:all
 *   npm run build:all -- --win --linux
 *
 * Failures are collected rather than fatal: one customer's bad colour pairing
 * should not stop the other nine from shipping, and the summary at the end says
 * exactly which ones need attention.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_DIR, listCustomers } from './customer'
import { buildCustomer } from './build-customer'

type Platform = 'win' | 'mac' | 'linux'

const argv = process.argv.slice(2)
const platforms: Platform[] = (['win', 'mac', 'linux'] as const).filter((platform) =>
  argv.includes(`--${platform}`)
)
if (platforms.length === 0) {
  platforms.push(
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  )
}

const customers = listCustomers()
if (customers.length === 0) {
  console.error('No customer configs found in branding/.')
  process.exit(1)
}

mkdirSync(join(ROOT_DIR, 'dist'), { recursive: true })
console.log(`Building ${customers.length} customer(s): ${customers.join(', ')}`)

const failures: Array<{ id: string; reason: string }> = []

for (const customerId of customers) {
  try {
    buildCustomer({
      customerId,
      platforms,
      bundleOnly: argv.includes('--bundle-only')
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    failures.push({ id: customerId, reason })
    console.error(`\n!! ${customerId} failed: ${reason.split('\n')[0]}`)
  }
}

console.log('\n=== Summary ===')
for (const customerId of customers) {
  const failure = failures.find((entry) => entry.id === customerId)
  console.log(`  ${failure ? 'FAILED ' : 'ok     '} ${customerId}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${customers.length} builds failed.`)
  for (const failure of failures) {
    console.error(`\n--- ${failure.id} ---\n${failure.reason}`)
  }
  process.exit(1)
}
