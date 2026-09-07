/**
 * Runtime access to the baked-in customer configuration.
 *
 * `__CUSTOMER__` and the credential constants are replaced with literals at
 * build time, so there is no config file to read, no first-run setup screen,
 * and nothing a user can point at a different Core.
 */
import { PathJail } from './qsys/paths'
import { decryptCredentials, type Credentials } from './credentials'
import type { MainConfig } from '../../scripts/customer'

export const customer: MainConfig = __CUSTOMER__

/** The jail every path operation is funnelled through. */
export const jail = new PathJail(customer.rootFolder, customer.allowRootEscape)

/** `https://host[:port]` - no trailing slash. */
export const coreOrigin = `https://${customer.core.host}${
  customer.core.port === 443 ? '' : `:${customer.core.port}`
}`

/** Value for the mandatory `Host` header; omitting it makes the Core reply 406. */
export const coreHostHeader =
  customer.core.port === 443
    ? customer.core.host
    : `${customer.core.host}:${customer.core.port}`

export const isProtected = customer.core.accessMode === 'protected'

let cached: Credentials | null | undefined

/**
 * Decrypt the embedded credentials on first use.
 *
 * Returns null in `open` access mode, where the Core has no Access Control and
 * requests carry no Authorization header at all.
 */
export function credentials(): Credentials | null {
  if (cached === undefined) {
    if (!isProtected) {
      cached = null
    } else {
      cached = decryptCredentials(__CRED_BLOB__, __KEY_A__, __KEY_B__, customer.appId)
      if (!cached) {
        throw new Error(
          'This build is configured for a protected Core but carries no credentials. ' +
            'Rebuild with `npm run build:customer <id>`.'
        )
      }
    }
  }
  return cached
}

/** A one-line description of the target, safe to show in the UI. */
export function coreLabel(): string {
  return `${customer.core.host}${customer.core.port === 443 ? '' : `:${customer.core.port}`}`
}
