/**
 * The branding pipeline.
 *
 * Two properties matter most here, and both are the kind that break silently:
 *
 *  1. **No secrets in the renderer config.** The whole credential design rests
 *     on it, and a single careless field added to `rendererConfigOf` would undo
 *     it without any visible symptom.
 *  2. **Derived colours are legible.** A customer supplies three hex values and
 *     the app derives thirty from them; the derivation must not be able to
 *     produce unreadable text, whatever those three values are.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wcagContrast } from 'culori'
import { parseCustomerConfig, type ThemeConfig } from '../branding/_schema'
import { AA_TEXT, AA_UI, deriveTheme, validateTheme } from '../src/shared/theme'
import {
  BRANDING_DIR,
  buildDefines,
  listCustomers,
  loadCustomer,
  mainConfigOf,
  rendererConfigOf,
  resolveCredentials
} from '../scripts/customer'
import { decryptCredentials, encryptCredentials } from '../src/main/credentials'

const contrast = (a: string, b: string): number => wcagContrast(a, b) ?? 0

describe('customer configs on disk', () => {
  const customers = listCustomers()

  it('there is at least one', () => {
    expect(customers.length).toBeGreaterThan(0)
  })

  for (const id of customers) {
    describe(id, () => {
      // `requireCredentials` is off: the sidecars are gitignored, so these must
      // pass in a fresh clone and in CI where no secrets are present.
      const customer = loadCustomer(id)

      it('validates, and its assets exist', () => {
        expect(customer.config.id).toBe(id)
        expect(customer.logoPath).toContain(id)
      })

      it('passes the contrast guard', () => {
        expect(validateTheme(customer.config.theme)).toEqual([])
      })

      it('carries no inline credentials, which git would preserve for good', () => {
        const raw = JSON.parse(readFileSync(join(BRANDING_DIR, `${id}.json`), 'utf8')) as Record<
          string,
          unknown
        >
        expect(raw).not.toHaveProperty('credentials')
      })

      it('keeps the Core address and credentials out of the renderer config', () => {
        const renderer = JSON.stringify(rendererConfigOf(customer))
        expect(renderer).not.toContain(customer.config.core.host)
        if (customer.credentials) {
          expect(renderer).not.toContain(customer.credentials.password)
          expect(renderer).not.toContain(customer.credentials.username)
        }
        // And nothing shaped like a credential field, in case one is added later.
        expect(renderer).not.toMatch(/password|credential|"core"/i)
      })

      it('keeps the password out of the main bundle in plaintext', () => {
        const defines = buildDefines(customer)
        const main = JSON.stringify(defines.main)
        if (customer.credentials) {
          expect(main).not.toContain(customer.credentials.password)
        }
      })

      it('gives the renderer everything the UI needs', () => {
        const renderer = rendererConfigOf(customer)
        expect(renderer.productName).toBe(customer.config.productName)
        expect(renderer.logoDataUri).toMatch(/^data:image\/(svg\+xml|png|jpeg|webp);base64,/)
        expect(renderer.theme.colors.primary).toBeTruthy()
        expect(typeof renderer.features.upload).toBe('boolean')
      })

      it('round-trips whatever credentials it resolved through the embedded blob', () => {
        const defines = buildDefines(customer)
        const blob = JSON.parse(defines.main.__CRED_BLOB__!) as string
        const keyA = JSON.parse(defines.main.__KEY_A__!) as string
        const keyB = JSON.parse(defines.main.__KEY_B__!) as string
        const recovered = decryptCredentials(blob, keyA, keyB, customer.config.appId)
        expect(recovered).toEqual(customer.credentials ?? null)
      })
    })
  }
})

describe('schema validation', () => {
  const valid = {
    id: 'sample',
    productName: 'Sample',
    appId: 'com.example.sample',
    version: '1.0.0',
    core: { host: '10.0.0.1' },
    theme: { colors: { primary: '#3B82F6', surface: '#101418' }, logo: 'l.svg', icon: 'i.png' }
  }

  it('accepts a minimal config and fills in defaults', () => {
    const parsed = parseCustomerConfig(valid, 'test')
    expect(parsed.core.port).toBe(443)
    expect(parsed.core.accessMode).toBe('protected')
    expect(parsed.rootFolder).toBe('')
    expect(parsed.allowRootEscape).toBe(false)
    expect(parsed.features.upload).toBe(true)
    expect(parsed.features.devTools).toBe(false)
    expect(parsed.window.width).toBeGreaterThan(0)
    expect(parsed.theme.mode).toBe('dark')
  })

  it('rejects an inline credentials block outright', () => {
    // Zod strips unknown keys silently, so without an explicit guard a password
    // pasted into a committed config would keep working locally while reaching
    // the remote. The error has to say where to put it instead.
    expect(() =>
      parseCustomerConfig({ ...valid, credentials: { username: 'u', password: 'p' } }, 'test')
    ).toThrow(/secret\.json/)
  })

  it('normalises the root folder', () => {
    for (const input of ['/Messages/ACME/', 'Messages/ACME', '\\Messages\\ACME']) {
      expect(parseCustomerConfig({ ...valid, rootFolder: input }, 'test').rootFolder).toBe(
        'Messages/ACME'
      )
    }
  })

  it('rejects a root folder containing traversal', () => {
    expect(() => parseCustomerConfig({ ...valid, rootFolder: 'a/../b' }, 'test')).toThrow(/\.\./)
  })

  it('rejects malformed identifiers, versions and colours', () => {
    expect(() => parseCustomerConfig({ ...valid, id: 'Not A Slug' }, 'test')).toThrow(/kebab/)
    expect(() => parseCustomerConfig({ ...valid, version: '1.0' }, 'test')).toThrow(/semver/)
    expect(() => parseCustomerConfig({ ...valid, appId: 'notreversedns' }, 'test')).toThrow(
      /reverse-DNS/
    )
    expect(() =>
      parseCustomerConfig(
        { ...valid, theme: { ...valid.theme, colors: { primary: 'blue', surface: '#101418' } } },
        'test'
      )
    ).toThrow(/hex colour/)
  })

  it('names every offending field in the error message', () => {
    // A build failure is only useful if it says which field to fix.
    try {
      parseCustomerConfig({ ...valid, version: 'x', id: 'BAD' }, 'branding/foo.json')
      expect.unreachable()
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('branding/foo.json')
      expect(message).toContain('version')
      expect(message).toContain('id')
    }
  })
})

describe('theme derivation', () => {
  const theme = (overrides: Partial<ThemeConfig['colors']>, mode: 'light' | 'dark'): ThemeConfig =>
    ({
      mode,
      colors: { primary: '#3B82F6', surface: mode === 'dark' ? '#101418' : '#F7F7F5', ...overrides },
      logo: 'l.svg',
      icon: 'i.png'
    }) as ThemeConfig

  it('produces every variable the stylesheet references', () => {
    const vars = deriveTheme(theme({}, 'dark'))
    for (const name of [
      'surface-0',
      'surface-1',
      'surface-2',
      'surface-3',
      'border',
      'border-strong',
      'text',
      'text-muted',
      'text-faint',
      'primary',
      'primary-hover',
      'primary-active',
      'primary-subtle',
      'primary-fg',
      'accent',
      'accent-subtle',
      'accent-fg',
      'danger',
      'danger-hover',
      'danger-subtle',
      'danger-fg',
      'ring'
    ]) {
      expect(vars[name], name).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('preserves the brand colour exactly', () => {
    // A customer's primary must appear as given; only the shades are derived.
    expect(deriveTheme(theme({ primary: '#B0122B' }, 'light')).primary).toBe('#B0122B')
  })

  it('moves raised surfaces away from the base in the right direction', () => {
    const dark = deriveTheme(theme({}, 'dark'))
    const light = deriveTheme(theme({}, 'light'))
    const luminance = (hex: string): number => contrast(hex, '#000000')

    expect(luminance(dark['surface-3']!)).toBeGreaterThan(luminance(dark['surface-0']!))
    expect(luminance(light['surface-3']!)).toBeLessThan(luminance(light['surface-0']!))
  })

  /**
   * The property that matters: whatever three colours a customer picks, the
   * derived text and button labels clear WCAG AA. Swept over the hue circle and
   * both modes, including the pathological mid-grey surfaces.
   */
  it('keeps derived text legible across the hue circle', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (let hue = 0; hue < 360; hue += 30) {
        for (const lightness of [15, 35, 50, 65, 90]) {
          const surface = hslHex(hue, 20, mode === 'dark' ? Math.min(lightness, 30) : Math.max(lightness, 80))
          const primary = hslHex((hue + 180) % 360, 70, 50)
          const vars = deriveTheme(theme({ primary, surface }, mode))
          const label = `${mode} h${hue} l${lightness}`

          expect(contrast(vars.text!, vars['surface-0']!), `text/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars.text!, vars['surface-3']!), `text-raised/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars['text-muted']!, vars['surface-0']!), `muted/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars['primary-fg']!, vars.primary!), `on-brand/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars['danger-fg']!, vars.danger!), `on-danger/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars['accent-fg']!, vars.accent!), `on-accent/${label}`).toBeGreaterThanOrEqual(AA_TEXT)
          expect(contrast(vars.ring!, vars['surface-0']!), `ring/${label}`).toBeGreaterThanOrEqual(AA_UI)
        }
      }
    }
  })

  it('reports - rather than hides - a brand colour lost against its surface', () => {
    // The one case the derivation refuses to fix silently, because fixing it
    // would mean changing the customer's brand colour.
    const problems = validateTheme(theme({ primary: '#101418', surface: '#101418' }, 'dark'))
    expect(problems.map((p) => p.pair)).toContain('primary on surface')
    expect(problems[0]!.hint).toBeTruthy()
  })

  it('rejects an unparseable colour outright', () => {
    expect(() =>
      validateTheme({
        mode: 'dark',
        colors: { primary: 'not-a-colour', surface: '#101418' },
        logo: 'l.svg',
        icon: 'i.png'
      } as ThemeConfig)
    ).toThrow(/not a parseable colour/)
  })

  it('derives an accent when none is given', () => {
    const withAccent = deriveTheme(theme({ accent: '#3FD68C' }, 'dark'))
    const without = deriveTheme(theme({}, 'dark'))
    expect(withAccent.accent).toBe('#3FD68C')
    expect(without.accent).toMatch(/^#[0-9a-f]{6}$/i)
    expect(without.accent).not.toBe(without.primary)
  })
})

describe('credential resolution', () => {
  const protectedConfig = parseCustomerConfig(
    {
      id: 'resolve-test',
      productName: 'Resolve Test',
      appId: 'com.example.resolve',
      version: '1.0.0',
      core: { host: '10.0.0.9', accessMode: 'protected' },
      theme: { colors: { primary: '#3B82F6', surface: '#101418' }, logo: 'l.svg', icon: 'i.png' }
    },
    'test'
  )

  const openConfig = parseCustomerConfig(
    { ...protectedConfig, core: { host: '10.0.0.9', accessMode: 'open' } },
    'test'
  )

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('QSYS_CRED_')) delete process.env[key]
    }
  })

  it('returns null for an open Core, which wants no credentials at all', () => {
    expect(resolveCredentials(openConfig)).toBeNull()
    // Even with credentials available, open mode must not use them.
    process.env.QSYS_CRED_USERNAME = 'u'
    process.env.QSYS_CRED_PASSWORD = 'p'
    expect(resolveCredentials(openConfig)).toBeNull()
  })

  it('reads per-customer environment variables', () => {
    process.env.QSYS_CRED_RESOLVE_TEST_USERNAME = 'from-specific'
    process.env.QSYS_CRED_RESOLVE_TEST_PASSWORD = 'secret-1'
    expect(resolveCredentials(protectedConfig)).toEqual({
      username: 'from-specific',
      password: 'secret-1'
    })
  })

  it('falls back to the unsuffixed variables for single-customer runs', () => {
    process.env.QSYS_CRED_USERNAME = 'from-generic'
    process.env.QSYS_CRED_PASSWORD = 'secret-2'
    expect(resolveCredentials(protectedConfig)).toEqual({
      username: 'from-generic',
      password: 'secret-2'
    })
  })

  it('prefers the per-customer variables over the fallback', () => {
    // This is what lets one CI job build several customers.
    process.env.QSYS_CRED_USERNAME = 'generic'
    process.env.QSYS_CRED_PASSWORD = 'generic-pw'
    process.env.QSYS_CRED_RESOLVE_TEST_USERNAME = 'specific'
    process.env.QSYS_CRED_RESOLVE_TEST_PASSWORD = 'specific-pw'
    expect(resolveCredentials(protectedConfig)).toEqual({
      username: 'specific',
      password: 'specific-pw'
    })
  })

  it('returns null when nothing is available and nothing is required', () => {
    // The fresh-clone case: no sidecars, no env. Validation still works.
    expect(resolveCredentials(protectedConfig)).toBeNull()
  })

  it('fails a build with a message naming both ways to supply them', () => {
    try {
      resolveCredentials(protectedConfig, { requireCredentials: true })
      expect.unreachable()
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('resolve-test.secret.json')
      expect(message).toContain('QSYS_CRED_RESOLVE_TEST_USERNAME')
    }
  })

  it('never lists a sidecar as a customer of its own', () => {
    // `acme.secret.json` must not surface as a customer called "acme.secret".
    expect(listCustomers().some((id) => id.endsWith('.secret'))).toBe(false)
  })
})

describe('credential obfuscation', () => {
  const credentials = { username: 'media-user', password: 'a-long-enough-password' }
  const appId = 'com.example.app'

  it('round-trips', () => {
    const blob = encryptCredentials(credentials, appId)
    expect(decryptCredentials(blob.blob, blob.keyA, blob.keyB, appId)).toEqual(credentials)
  })

  it('never embeds the password as a readable string', () => {
    const blob = encryptCredentials(credentials, appId)
    for (const part of [blob.blob, blob.keyA, blob.keyB]) {
      expect(part).not.toContain(credentials.password)
    }
  })

  it('produces a different blob every build, even for identical input', () => {
    const a = encryptCredentials(credentials, appId)
    const b = encryptCredentials(credentials, appId)
    expect(a.blob).not.toBe(b.blob)
    expect(a.keyA).not.toBe(b.keyA)
  })

  it('is bound to the app id, so one build cannot read another blob', () => {
    const blob = encryptCredentials(credentials, appId)
    expect(() => decryptCredentials(blob.blob, blob.keyA, blob.keyB, 'com.example.other')).toThrow()
  })

  it('detects a tampered blob or key', () => {
    const blob = encryptCredentials(credentials, appId)
    expect(() => decryptCredentials(blob.blob, 'wrong', blob.keyB, appId)).toThrow()
    expect(() => decryptCredentials(blob.blob, blob.keyA, 'wrong', appId)).toThrow()

    const corrupted = Buffer.from(blob.blob, 'base64')
    const last = corrupted.length - 1
    corrupted[last] = (corrupted[last] ?? 0) ^ 0xff
    expect(() =>
      decryptCredentials(corrupted.toString('base64'), blob.keyA, blob.keyB, appId)
    ).toThrow()
  })

  it('handles open mode, where there is nothing to encrypt', () => {
    const blob = encryptCredentials(undefined, appId)
    expect(blob.blob).toBe('')
    expect(decryptCredentials('', '', '', appId)).toBeNull()
  })

  it('rejects a truncated blob rather than returning nonsense', () => {
    expect(() => decryptCredentials('AAAA', 'a', 'b', appId)).toThrow(/truncated/)
  })
})

describe('main config', () => {
  it('carries everything main needs and nothing more', () => {
    const customer = loadCustomer(listCustomers()[0]!)
    const main = mainConfigOf(customer.config)
    expect(main.core.host).toBe(customer.config.core.host)
    expect(main.rootFolder).toBe(customer.config.rootFolder)
    // Credentials travel in the encrypted blob, never in the plain config.
    expect(JSON.stringify(main)).not.toContain('password')
  })
})

describe('the template config', () => {
  it('is a working starting point once its placeholders are filled in', () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(BRANDING_DIR, '_template.json'), 'utf8')
    )
    const parsed = parseCustomerConfig(raw, '_template.json')
    expect(parsed.id).toBe('customer-slug')
    expect(validateTheme(parsed.theme)).toEqual([])
  })
})

/** Tiny HSL helper, so the sweep does not need a colour library. */
function hslHex(h: number, s: number, l: number): string {
  const saturation = s / 100
  const lightness = l / 100
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = lightness - c / 2
  const byte = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}
