/**
 * REPL driver for the packaged app, for automated and headless verification.
 *
 *   npm run mock-core                 # in one terminal
 *   npm run build:customer demo -- --bundle-only
 *   node scripts/drive.mjs            # then type commands
 *
 * Exists because "the window opens" is not evidence that the UI renders. This
 * attaches Playwright to the real Electron process so a screenshot, a click or
 * an assertion about the DOM can be made without a human at the keyboard.
 *
 * Commands: launch, ss [name], open <name>, pick <name> [+], nav <path>, rows,
 *           click <sel>, click-text <text>, type <text>, press <key>,
 *           wait <sel>, eval <js>, text [sel], windows, logs, quit
 */
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ELECTRON_BIN =
  process.platform === 'win32'
    ? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : path.join(APP_DIR, 'node_modules/electron/dist/electron')

let app = null
let page = null
const consoleLog = []

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.mjs'))) {
      return console.log('ERROR: no build in out/ - run `npm run build:customer demo -- --bundle-only`')
    }

    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      // --no-sandbox is needed under a container; harmless otherwise.
      args: ['--no-sandbox', APP_DIR],
      timeout: 60_000
    })

    page = await app.firstWindow()
    page.on('console', (message) => consoleLog.push(`[${message.type()}] ${message.text()}`))
    page.on('pageerror', (error) => consoleLog.push(`[pageerror] ${error.message}`))

    // The app is ready when the shell has painted; the footer carries the
    // product name, so it is the last thing to appear on a successful boot.
    try {
      await page.waitForSelector('footer', { timeout: 20_000 })
    } catch {
      console.log('WARNING: shell did not render within 20s')
    }
    console.log(`launched. ${app.windows().length} window(s):`)
    for (const window of app.windows()) console.log('  ', window.url())
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const file = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`)
    await page.screenshot({ path: file })
    console.log('screenshot:', file)
  },

  async click(selector) {
    if (!page) return console.log('ERROR: launch first')
    const result = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, selector)
    console.log('click', selector, '->', result)
  },

  /**
   * Click a button or menu item by its text.
   *
   * Scoped to an open dialog when there is one. Without that, "Rename" matches
   * the toolbar button before the dialog's confirm button - the toolbar comes
   * first in DOM order - so a scripted rename silently clicked the wrong thing
   * and appeared to do nothing.
   */
  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first')
    const result = await page.evaluate((needle) => {
      const scope = document.querySelector('[role="dialog"]') ?? document
      const candidates = [...scope.querySelectorAll('button, a, [role="menuitem"]')]
      const el =
        candidates.find((e) => e.textContent?.trim() === needle) ??
        candidates.find((e) => e.textContent?.includes(needle))
      if (!el) return 'NOT_FOUND'
      if (el.disabled) return 'DISABLED'
      el.click()
      const where = scope === document ? 'page' : 'dialog'
      return `OK: <${el.tagName.toLowerCase()}> in ${where}`
    }, text)
    console.log('click-text', JSON.stringify(text), '->', result)
  },

  /**
   * Open a row by name (double-click). Targets the `data-row` attributes the
   * file list carries for exactly this purpose - matching on rendered text
   * picks up the sidebar copy of the same name and clicks the wrong element.
   */
  async open(name) {
    if (!page) return console.log('ERROR: launch first')
    const result = await page.evaluate((needle) => {
      const row = document.querySelector(`[data-row-name="${CSS.escape(needle)}"]`)
      if (!row) return 'NOT_FOUND'
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return `OK: ${row.getAttribute('data-row-type')}`
    }, name)
    console.log('open', JSON.stringify(name), '->', result)
  },

  /** Select a row by name, optionally additively (`pick <name> +`). */
  async pick(argument) {
    if (!page) return console.log('ERROR: launch first')
    const [name, modifier] = argument.split(/\s+/)
    const result = await page.evaluate(
      ({ needle, additive }) => {
        const row = document.querySelector(`[data-row-name="${CSS.escape(needle)}"]`)
        if (!row) return 'NOT_FOUND'
        row.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: additive })
        )
        return 'OK'
      },
      { needle: name, additive: modifier === '+' }
    )
    console.log('pick', JSON.stringify(name), '->', result)
  },

  /** Navigate the folder tree by virtual path, e.g. `nav /Messages/ACME`. */
  async nav(virtualPath) {
    if (!page) return console.log('ERROR: launch first')
    const result = await page.evaluate((target) => {
      const node = document.querySelector(`[data-tree="${CSS.escape(target)}"]`)
      if (!node) return 'NOT_FOUND (expand the branch first?)'
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'OK'
    }, virtualPath)
    console.log('nav', virtualPath, '->', result)
  },

  /** List the current folder as `type name size` triples. */
  async rows() {
    if (!page) return console.log('ERROR: launch first')
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row]')].map((row) => ({
        type: row.getAttribute('data-row-type'),
        name: row.getAttribute('data-row-name'),
        path: row.getAttribute('data-row')
      }))
    )
    if (rows.length === 0) {
      console.log('(empty folder)')
      return
    }
    for (const row of rows) console.log(`  ${row.type.padEnd(6)} ${row.name}`)
  },

  /** The breadcrumb trail, to confirm where the app thinks it is. */
  async where() {
    if (!page) return console.log('ERROR: launch first')
    console.log(
      await page.evaluate(() => {
        const crumbs = [...document.querySelectorAll('main > div:first-child > div:first-child button')]
        return crumbs.map((b) => b.innerText).filter(Boolean).join(' / ') || '(unknown)'
      })
    )
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 25 })
  },
  async press(key) {
    if (page) await page.keyboard.press(key)
  },

  /**
   * Wait for an element to exist. `state: 'attached'` rather than the default
   * 'visible', because some things worth waiting for have no box - notably the
   * `<audio>` element the preview player mounts.
   */
  async wait(selector) {
    if (!page) return console.log('ERROR: launch first')
    try {
      await page.waitForSelector(selector, { state: 'attached', timeout: 10_000 })
      console.log('found:', selector)
    } catch {
      console.log('TIMEOUT:', selector)
    }
  },

  async eval(expression) {
    if (!page) return console.log('ERROR: launch first')
    try {
      console.log(JSON.stringify(await page.evaluate(expression)))
    } catch (err) {
      console.log('ERROR:', err.message)
    }
  },

  async text(selector) {
    if (!page) return console.log('ERROR: launch first')
    console.log(
      await page.evaluate(
        (sel) => (sel ? document.querySelector(sel) : document.body)?.innerText ?? '(null)',
        selector || null
      )
    )
  },

  logs() {
    console.log(consoleLog.length === 0 ? '(no console output)' : consoleLog.join('\n'))
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const window of app.windows()) console.log('  ', window.url())
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'driver> '
})

/**
 * Commands run strictly one at a time.
 *
 * readline emits every piped line immediately without waiting for an async
 * handler, so a scripted `launch\nss` would screenshot before the app existed.
 * Chaining onto a tail promise makes piped and interactive use behave alike.
 */
let queue = Promise.resolve()
let shuttingDown = false

/** readline throws if prompted after EOF, which piped input reaches early. */
const prompt = () => {
  if (!shuttingDown) rl.prompt()
}

rl.on('line', (line) => {
  queue = queue.then(async () => {
    const [command, ...rest] = line.trim().split(/\s+/)
    if (!command) return prompt()

    const fn = COMMANDS[command]
    if (!fn) {
      console.log('unknown:', command, '- try: help')
      return prompt()
    }
    try {
      await fn(rest.join(' '))
    } catch (err) {
      console.log('ERROR:', err.message)
    }
    if (command === 'quit') scheduleShutdown()
    else prompt()
  })
})

/**
 * Piped stdin reaches EOF the instant the last line is written, so this fires
 * while earlier commands are still running. Shutdown is *appended to the queue*
 * rather than awaiting it: awaiting from inside a queued task would wait on the
 * task's own promise and deadlock.
 */
rl.on('close', () => scheduleShutdown())

function scheduleShutdown() {
  if (shuttingDown) return
  shuttingDown = true
  queue = queue.then(async () => {
    await COMMANDS.quit()
    // process.exit() discards buffered stdout when it is a pipe, which
    // silently swallowed every line after the first. Flush first.
    await new Promise((done) => process.stdout.write('', done))
    process.exit(0)
  })
}

console.log('Q-SYS Media Browser driver - "help" for commands, "launch" to start')
rl.prompt()
