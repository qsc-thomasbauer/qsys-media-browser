/**
 * Single source of truth for a customer build definition.
 *
 * Every `branding/<id>.json` is validated against this schema before a build is
 * allowed to proceed. A malformed config must fail the build loudly rather than
 * produce a binary pointed at the wrong Core or missing its theme.
 */
import { z } from 'zod'

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REVERSE_DNS = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/

const hexColor = z.string().regex(HEX, 'must be a hex colour such as #E4002B')

/**
 * A Core-relative folder path. Stored without leading or trailing slashes so
 * that `""` unambiguously means "the whole /media tree".
 */
const corePath = z
  .string()
  .transform((v) => v.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  .refine((v) => !v.split('/').some((s) => s === '.' || s === '..'), {
    message: 'must not contain "." or ".." segments'
  })
  .refine((v) => !v.includes('\0'), { message: 'must not contain null bytes' })

export const themeSchema = z.object({
  /** Chooses the direction shades are derived in, and the default text colour. */
  mode: z.enum(['light', 'dark']).default('dark'),
  colors: z.object({
    /** Brand colour: primary buttons, selection, focus rings, progress. */
    primary: hexColor,
    /** Base application background; every other surface is derived from it. */
    surface: hexColor,
    /** Optional secondary highlight. Defaults to a hue-rotated primary. */
    accent: hexColor.optional(),
    /** Optional override for destructive actions. Defaults to a neutral red. */
    danger: hexColor.optional()
  }),
  /** Path relative to `branding/`, shown in the app header. */
  logo: z.string().min(1),
  /** Path relative to `branding/`. Square PNG, 1024x1024 recommended. */
  icon: z.string().min(1)
})

export const featuresSchema = z.object({
  upload: z.boolean().default(true),
  download: z.boolean().default(true),
  delete: z.boolean().default(true),
  rename: z.boolean().default(true),
  move: z.boolean().default(true),
  createFolder: z.boolean().default(true),
  preview: z.boolean().default(true),
  playlists: z.boolean().default(true),
  /** Ship devtools + the reload shortcut. Leave false for customer builds. */
  devTools: z.boolean().default(false)
})

export const windowSchema = z.object({
  width: z.number().int().min(640).default(1180),
  height: z.number().int().min(480).default(760)
})

export const customerSchema = z
  .object({
    id: z.string().regex(SLUG, 'must be a lowercase kebab-case slug'),
    productName: z.string().min(1),
    appId: z.string().regex(REVERSE_DNS, 'must be reverse-DNS, e.g. com.yourco.qsys.acme'),
    version: z.string().regex(SEMVER, 'must be semver, e.g. 1.0.0'),

    core: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(443),
      /**
       * `protected` = Access Control enabled on the Core, bearer token required.
       * `open`      = no Access Control, requests carry no Authorization header.
       */
      accessMode: z.enum(['protected', 'open']).default('protected')
    }),

    /** The jail root. `""` exposes the whole /media tree. */
    rootFolder: corePath.default(''),
    /** Admin builds only: ignore `rootFolder` and allow the full tree. */
    allowRootEscape: z.boolean().default(false),

    features: featuresSchema.default(() => featuresSchema.parse({})),
    theme: themeSchema,

    window: windowSchema.default(() => windowSchema.parse({}))
  })

/**
 * Credentials for a Core in `protected` access mode.
 *
 * Deliberately *not* part of `customerSchema`: customer configs are committed
 * to git, and a password in a committed file is in every clone and fork of the
 * repository for good. These live in a gitignored `branding/<id>.secret.json`
 * sidecar, or in environment variables for CI. See docs/SECURITY.md.
 */
export const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
})

export type CustomerCredentials = z.output<typeof credentialsSchema>

export type CustomerConfig = z.output<typeof customerSchema>
export type ThemeConfig = z.output<typeof themeSchema>
export type FeatureFlags = z.output<typeof featuresSchema>

/**
 * Parse and normalise a raw config object, throwing a readable error on failure.
 *
 * An inline `credentials` block is rejected outright rather than ignored. Zod
 * strips unknown keys silently, which would mean a password pasted into a
 * committed config kept working locally while quietly reaching the remote - the
 * exact failure this split exists to prevent.
 */
export function parseCustomerConfig(raw: unknown, source: string): CustomerConfig {
  if (typeof raw === 'object' && raw !== null && 'credentials' in raw) {
    throw new Error(
      [
        `${source} contains an inline "credentials" block.`,
        '  Customer configs are committed to git, so credentials must not live in them.',
        '  Move it to a sidecar file, which .gitignore excludes:',
        '',
        '    branding/<id>.secret.json   { "username": "...", "password": "..." }',
        '',
        '  or set QSYS_CRED_<ID>_USERNAME / QSYS_CRED_<ID>_PASSWORD for CI.',
        '  See docs/CUSTOMER_BUILDS.md.'
      ].join('\n')
    )
  }

  const result = customerSchema.safeParse(raw)
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
    )
    throw new Error(`Invalid customer config ${source}:\n${lines.join('\n')}`)
  }
  return result.data
}
