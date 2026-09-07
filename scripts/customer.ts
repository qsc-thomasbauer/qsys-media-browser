/**
 * Customer config loading and build-time injection.
 *
 * Consumed by `electron.vite.config.ts` (so `npm run dev` and `electron-vite
 * build` both stamp the same constants in) and by `build-customer.ts`.
 *
 * The split between `mainDefines` and `rendererDefines` is the security
 * boundary: the Core host, the credential blob, and the key material go to the
 * main bundle only. The renderer receives the product name, feature flags and
 * theme - nothing that would let it, or anyone reading its bundle, reach the
 * Core directly.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  credentialsSchema,
  parseCustomerConfig,
  type CustomerConfig,
  type CustomerCredentials
} from '../branding/_schema'
import { encryptCredentials } from '../src/main/credentials'
import { validateTheme } from '../src/shared/theme'
import type { RendererConfig } from '../src/shared/types'

export const ROOT_DIR = resolve(fileURLToPath(import.meta.url), '../..')
export const BRANDING_DIR = join(ROOT_DIR, 'branding')

/**
 * Every customer id with a config in `branding/`.
 *
 * Skips `_`-prefixed files (the templates) and the `*.secret.json` sidecars,
 * which are credentials for an existing customer rather than customers of their
 * own - without that filter, `acme.secret.json` would surface as a customer
 * called "acme.secret".
 */
export function listCustomers(): string[] {
  return readdirSync(BRANDING_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.endsWith('.secret.json'))
    .map((f) => basename(f, '.json'))
    .sort()
}

/** Which customer a dev/build run targets. */
export function resolveCustomerId(explicit?: string): string {
  const id = explicit ?? process.env.QSYS_CUSTOMER ?? 'demo'
  if (!existsSync(join(BRANDING_DIR, `${id}.json`))) {
    throw new Error(
      `No customer config at branding/${id}.json. Available: ${listCustomers().join(', ') || '(none)'}`
    )
  }
  return id
}

export interface LoadedCustomer {
  /** The committed, secret-free part of the config. */
  config: CustomerConfig
  /** Resolved from the sidecar file or the environment; null in open mode. */
  credentials: CustomerCredentials | null
  /** Absolute path to the logo file. */
  logoPath: string
  /** Absolute path to the source icon PNG (may not exist yet). */
  iconPath: string
}

export interface LoadOptions {
  /**
   * Fail when a `protected` build has no credentials. True for builds; false
   * for callers that only want the config - schema and theme validation, and
   * the test suite, which must run in a fresh clone with no secrets present.
   */
  requireCredentials?: boolean
}

/** Environment variable name for a customer's credential field. */
function envVarName(id: string, field: 'USERNAME' | 'PASSWORD'): string {
  return `QSYS_CRED_${id.toUpperCase().replace(/-/g, '_')}_${field}`
}

/**
 * Resolve a customer's credentials.
 *
 * Two sources, in order:
 *
 *  1. `branding/<id>.secret.json` - the local path. Gitignored.
 *  2. `QSYS_CRED_<ID>_USERNAME` / `_PASSWORD`, falling back to the unsuffixed
 *     `QSYS_CRED_USERNAME` / `QSYS_CRED_PASSWORD` for single-customer runs.
 *     Per-customer names are what let one CI job build several customers.
 *
 * Returns null in `open` access mode, where the Core wants no credentials at all.
 */
export function resolveCredentials(
  config: CustomerConfig,
  options: LoadOptions = {}
): CustomerCredentials | null {
  if (config.core.accessMode === 'open') return null

  const sidecar = join(BRANDING_DIR, `${config.id}.secret.json`)
  if (existsSync(sidecar)) {
    const raw: unknown = JSON.parse(readFileSync(sidecar, 'utf8'))
    const parsed = credentialsSchema.safeParse(raw)
    if (!parsed.success) {
      const lines = parsed.error.issues.map(
        (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`
      )
      throw new Error(
        `Invalid credentials in branding/${config.id}.secret.json:\n${lines.join('\n')}`
      )
    }
    return parsed.data
  }

  const username =
    process.env[envVarName(config.id, 'USERNAME')] ?? process.env.QSYS_CRED_USERNAME
  const password =
    process.env[envVarName(config.id, 'PASSWORD')] ?? process.env.QSYS_CRED_PASSWORD

  if (username && password) return { username, password }

  if (options.requireCredentials) {
    throw new Error(
      [
        `No credentials for "${config.id}", which targets a protected Core.`,
        `  Create branding/${config.id}.secret.json:`,
        '',
        '    { "username": "...", "password": "..." }',
        '',
        `  or set ${envVarName(config.id, 'USERNAME')} and ${envVarName(config.id, 'PASSWORD')}.`,
        '  Copy branding/_template.secret.example.json to get started.'
      ].join('\n')
    )
  }
  return null
}

/**
 * Read, validate and resolve a customer config. Throws with a readable message
 * on a schema violation, a missing asset, or a colour pairing that cannot be
 * made legible.
 */
export function loadCustomer(id: string, options: LoadOptions = {}): LoadedCustomer {
  const file = join(BRANDING_DIR, `${id}.json`)
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const config = parseCustomerConfig(raw, `branding/${id}.json`)

  if (config.id !== id) {
    throw new Error(`branding/${id}.json declares id "${config.id}"; these must match`)
  }

  const logoPath = join(BRANDING_DIR, config.theme.logo)
  if (!existsSync(logoPath)) {
    throw new Error(`Missing logo for "${id}": ${config.theme.logo} (looked in branding/)`)
  }

  const problems = validateTheme(config.theme)
  if (problems.length > 0) {
    const lines = problems.map(
      (p) => `  - ${p.pair}: contrast ${p.ratio}:1, needs ${p.required}:1 - ${p.hint}`
    )
    throw new Error(`Theme for "${id}" fails contrast checks:\n${lines.join('\n')}`)
  }

  return {
    config,
    credentials: resolveCredentials(config, options),
    logoPath,
    iconPath: join(BRANDING_DIR, config.theme.icon)
  }
}

/* ----------------------------------------------------------- defines */

/** Config visible to the main process. */
export interface MainConfig {
  id: string
  productName: string
  version: string
  appId: string
  core: CustomerConfig['core']
  rootFolder: string
  allowRootEscape: boolean
  features: CustomerConfig['features']
  window: CustomerConfig['window']
}

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function dataUri(path: string): string {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()]
  if (!mime) throw new Error(`Unsupported logo format: ${basename(path)}`)
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

export function mainConfigOf(config: CustomerConfig): MainConfig {
  return {
    id: config.id,
    productName: config.productName,
    version: config.version,
    appId: config.appId,
    core: config.core,
    rootFolder: config.rootFolder,
    allowRootEscape: config.allowRootEscape,
    features: config.features,
    window: config.window
  }
}

export function rendererConfigOf(loaded: LoadedCustomer): RendererConfig {
  const { config } = loaded
  return {
    id: config.id,
    productName: config.productName,
    version: config.version,
    rootLabel: config.allowRootEscape ? 'media' : config.rootFolder || 'media',
    features: config.features,
    theme: config.theme,
    logoDataUri: dataUri(loaded.logoPath)
  }
}

export interface CustomerDefines {
  main: Record<string, string>
  renderer: Record<string, string>
}

export function buildDefines(loaded: LoadedCustomer): CustomerDefines {
  const creds = encryptCredentials(loaded.credentials ?? undefined, loaded.config.appId)
  return {
    main: {
      __CUSTOMER__: JSON.stringify(mainConfigOf(loaded.config)),
      __CRED_BLOB__: JSON.stringify(creds.blob),
      __KEY_A__: JSON.stringify(creds.keyA),
      __KEY_B__: JSON.stringify(creds.keyB)
    },
    renderer: {
      __CUSTOMER__: JSON.stringify(rendererConfigOf(loaded))
    }
  }
}
