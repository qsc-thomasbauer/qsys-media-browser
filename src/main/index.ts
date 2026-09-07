/**
 * Main process entry point.
 *
 * Responsibilities, in order: lock down the renderer, register the media
 * protocol, open the window, connect to the Core, and revoke the token on the
 * way out.
 *
 * The renderer is treated as untrusted. It runs sandboxed with context
 * isolation and no Node integration, cannot navigate anywhere, cannot open
 * windows, and reaches the Core only through the IPC channels in `ipc.ts`.
 */
import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { customer } from './config'
import { registerIpc, wireEvents } from './ipc'
import { installMediaProtocol, registerMediaScheme } from './protocol'
import { MEDIA_SCHEME } from '@shared/media-url'
import { CH } from '@shared/ipc'
import * as auth from './qsys/auth'
import { setCertStore } from './qsys/client'
import { cancelAll } from './qsys/transfer'

// Per-customer app identity: two builds installed side by side keep separate
// userData, so their cert pins and window state do not collide.
app.setName(customer.productName)
app.setAppUserModelId(customer.appId)

registerMediaScheme()

let window: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => window

/* ------------------------------------------------------- certificate pin */

/**
 * Trust-on-first-use storage for the Core's self-signed certificate. A change
 * does not block anything - an integrator legitimately regenerates these - but
 * it does raise a banner rather than passing unnoticed.
 */
function installCertStore(): void {
  const file = join(app.getPath('userData'), 'core-cert.json')
  let cached: string | null | undefined

  setCertStore(
    {
      get: () => {
        if (cached === undefined) {
          try {
            cached = (JSON.parse(readFileSync(file, 'utf8')) as { fingerprint: string })
              .fingerprint
          } catch {
            cached = null
          }
        }
        return cached
      },
      set: (fingerprint) => {
        cached = fingerprint
        try {
          writeFileSync(file, JSON.stringify({ fingerprint, host: customer.core.host }, null, 2))
        } catch {
          // A read-only profile is not worth failing startup over; the pin just
          // will not persist across restarts.
        }
      }
    },
    (presented, expected) => {
      console.warn(
        `[tls] The Core presented a different certificate.\n  expected ${expected}\n  got      ${presented}`
      )
      window?.webContents.send(CH.coreStatusEvent, {
        state: 'connected',
        message: customer.core.host,
        certChanged: true
      })
    }
  )
}

/* --------------------------------------------------------------- window */

function createWindow(): void {
  window = new BrowserWindow({
    width: customer.window.width,
    height: customer.window.height,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: customer.productName,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: customer.features.devTools
    }
  })

  // Avoid the white flash: paint only once the renderer has content.
  window.once('ready-to-show', () => window?.show())

  // Nothing in this app navigates. External links go to the OS browser; every
  // other navigation or window request is refused.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const isDevServer =
      !!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!isDevServer && !url.startsWith('file://')) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  window.on('closed', () => {
    window = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * Content Security Policy, applied as a header so it also covers the dev
 * server. `media-src` admits the custom protocol - that is how audio preview
 * reaches the Core without the renderer holding a token - and `connect-src` is
 * closed entirely, because the renderer has no business making requests.
 */
function installCsp(): void {
  const dev = process.env.ELECTRON_RENDERER_URL
  const policy = [
    "default-src 'none'",
    `script-src 'self'${dev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `media-src ${MEDIA_SCHEME}: blob:`,
    `connect-src 'self'${dev ? ` ${dev} ws:` : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })

  // No permission this app needs is gated behind a prompt, so deny all of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, deny) => deny(false))
}

/* ----------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(() => {
    installCertStore()
    installCsp()
    installMediaProtocol()
    registerIpc(getWindow)
    wireEvents(getWindow)
    createWindow()

    // Sign in immediately so the first listing does not pay for a login.
    void auth.connect()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', () => {
    cancelAll()
    // Best-effort token revocation; quitting is not blocked on the Core.
    void auth.logoff()
  })
}
