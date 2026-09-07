/**
 * Build one customer's binary.
 *
 *   npm run build:customer acme                 # this machine's platform
 *   npm run build:customer acme -- --win --linux
 *   npm run build:customer acme -- --bundle-only
 *
 * The whole per-customer story lives in this one script: validate the config,
 * generate icons, run electron-vite with that customer's constants injected,
 * assert no secrets reached the renderer, then hand electron-builder the shared
 * base config plus per-customer overrides. Nothing customer-specific is checked
 * into the app source.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { ROOT_DIR, loadCustomer, resolveCustomerId } from './customer'
import { generateIconSet } from './gen-icons'

type Platform = 'win' | 'mac' | 'linux'

export interface BuildOptions {
  customerId: string
  platforms: Platform[]
  /** Stop after `electron-vite build`, skipping packaging. */
  bundleOnly: boolean
}

function parseArgs(argv: string[]): BuildOptions {
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  const platforms: Platform[] = (['win', 'mac', 'linux'] as const).filter((platform) =>
    argv.includes(`--${platform}`)
  )

  if (platforms.length === 0) {
    // Default to what this machine can actually produce: electron-builder
    // cannot cross-build a notarized dmg, and AppImage needs Linux.
    platforms.push(
      process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
    )
  }

  return {
    customerId: resolveCustomerId(positional[0]),
    platforms,
    bundleOnly: argv.includes('--bundle-only')
  }
}

const requireFrom = createRequire(import.meta.url)

/** Absolute path to a dependency's CLI entry point. */
function resolveBin(pkg: string, binName = pkg): string {
  const manifestPath = requireFrom.resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (!bin) throw new Error(`${pkg} declares no "${binName}" binary`)
  return join(manifestPath, '..', bin)
}

/**
 * Run a dependency's CLI under this Node, never through a shell.
 *
 * Not `npx`: since Node 20 closed CVE-2024-27980, `spawnSync` refuses to
 * execute a `.cmd` shim without `shell: true` - and `shell: true` would break
 * the moment a customer's product name contained a space. Resolving the bin's
 * JS entry and passing argv straight to Node sidesteps both problems.
 */
function run(pkg: string, binName: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync(process.execPath, [resolveBin(pkg, binName), ...args], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
}

export function buildCustomer(options: BuildOptions): string {
  const { customerId, platforms, bundleOnly } = options
  const customer = loadCustomer(customerId, { requireCredentials: true })
  const { config } = customer

  console.log(`\n=== ${config.productName} (${customerId}) v${config.version} ===`)
  console.log(`  core        ${config.core.host}:${config.core.port} (${config.core.accessMode})`)
  console.log(
    `  root folder ${
      config.allowRootEscape ? '(entire /media)' : config.rootFolder || '(entire /media)'
    }`
  )
  console.log(
    `  features    ${Object.entries(config.features)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(', ')}`
  )

  /* 1. Icons -------------------------------------------------------------- */

  const buildDir = join(ROOT_DIR, 'build', customerId)
  rmSync(buildDir, { recursive: true, force: true })
  const icons = generateIconSet(customer, buildDir)
  console.log(`  icons       ${relative(ROOT_DIR, buildDir)}`)

  /* 2. Bundle ------------------------------------------------------------- */

  // electron.vite.config.ts reads QSYS_CUSTOMER and injects this customer's
  // constants, including the encrypted credential blob (main bundle only).
  console.log('\n-> electron-vite build')
  run('electron-vite', 'electron-vite', ['build'], { QSYS_CUSTOMER: customerId })
  assertNoSecretsInRenderer(customer.credentials?.password, config.core.host)

  if (bundleOnly) {
    console.log('\nBundle written to out/ (packaging skipped).')
    return join(ROOT_DIR, 'out')
  }

  /* 3. Package ------------------------------------------------------------ */

  const outputDir = join(ROOT_DIR, 'dist', customerId)

  // Dot-notation overrides rather than a generated config file: they merge over
  // electron-builder.base.yml without needing a YAML parser here, and keep the
  // documented base file as the single description of the shared settings.
  console.log(`\n-> electron-builder (${platforms.join(', ')})`)
  run('electron-builder', 'electron-builder', [
    ...platforms.map((platform) => `--${platform}`),
    '--config',
    'electron-builder.base.yml',
    '--config.productName',
    config.productName,
    '--config.appId',
    config.appId,
    '--config.extraMetadata.version',
    config.version,
    '--config.extraMetadata.name',
    customerId,
    '--config.buildVersion',
    config.version,
    '--config.directories.output',
    outputDir,
    '--config.directories.buildResources',
    buildDir,
    '--config.win.icon',
    icons.ico,
    '--config.mac.icon',
    icons.icns,
    '--config.linux.icon',
    icons.png
  ])

  console.log(`\nArtifacts: ${relative(ROOT_DIR, outputDir)}`)
  return outputDir
}

/**
 * A build-time assertion that the security boundary actually held.
 *
 * The credential design rests entirely on secrets never reaching the renderer
 * bundle, which is exactly the kind of property a refactor breaks quietly - one
 * stray `import ... from '../config'` in a renderer file would do it. Scanning
 * the emitted bundle costs milliseconds and fails the build loudly.
 */
function assertNoSecretsInRenderer(password: string | undefined, host: string): void {
  const rendererDir = join(ROOT_DIR, 'out', 'renderer')
  if (!existsSync(rendererDir)) return

  const offenders: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(js|mjs|cjs|css|html|map)$/.test(entry)) continue

      const text = readFileSync(full, 'utf8')
      if (password && password.length > 3 && text.includes(password)) {
        offenders.push(`${entry} contains the Core password`)
      }
      if (host.length > 3 && text.includes(host)) {
        offenders.push(`${entry} contains the Core address (${host})`)
      }
    }
  }
  walk(rendererDir)

  if (offenders.length > 0) {
    throw new Error(
      'Build aborted: secrets leaked into the renderer bundle.\n' +
        offenders.map((line) => `  - ${line}`).join('\n') +
        '\nThe renderer must receive only the fields in rendererConfigOf(); look for an ' +
        'import of src/main/config (directly or transitively) from a renderer file.'
    )
  }
  console.log('  verified    no credentials or Core address in the renderer bundle')
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
  mkdirSync(join(ROOT_DIR, 'dist'), { recursive: true })
  buildCustomer(parseArgs(process.argv.slice(2)))
}
