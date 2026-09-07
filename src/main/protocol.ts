/**
 * `qsys-media://` - an authenticated proxy for audio playback.
 *
 * The renderer needs to hand a URL to an `<audio>` element, but it must never
 * hold the bearer token. So it builds a `qsys-media://` URL from a virtual path
 * and this handler, in the main process, performs the real request with the
 * token attached and streams the response back.
 *
 * `Range` is forwarded in both directions, which is what makes seeking work:
 * Chromium requests byte ranges as the user drags the scrub bar, and the Core
 * answers them with 206.
 */
import { protocol } from 'electron'
import { Readable } from 'node:stream'
import { jail } from './config'
import { QsysError, rawRequest } from './qsys/client'
import { MEDIA_SCHEME, virtualPathFromMediaUrl } from '@shared/media-url'

const MEDIA_ENDPOINT = '/cores/self/media'

export { MEDIA_SCHEME }

/**
 * Must run before `app.whenReady()`. `stream: true` is what allows a response
 * body to be delivered incrementally, and `supportFetchAPI` lets Chromium's
 * media stack issue range requests against the scheme.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/** Register the handler. Call after `app.whenReady()`. */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let virtualPath: string
    try {
      virtualPath = virtualPathFromMediaUrl(request.url)
    } catch {
      return new Response('Bad media URL', { status: 400 })
    }

    try {
      const encoded = jail.toEncodedCore(virtualPath)
      if (encoded.length === 0) return new Response('Not a file', { status: 400 })

      const range = request.headers.get('range')
      const response = await rawRequest({
        method: 'GET',
        path: `${MEDIA_ENDPOINT}/${encoded}`,
        accept: 'audio/*',
        headers: range ? { Range: range } : undefined,
        signal: request.signal
      })

      const headers = new Headers()
      const forward = ['content-type', 'content-length', 'content-range', 'accept-ranges']
      for (const name of forward) {
        const value = response.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')

      return new Response(Readable.toWeb(response.stream) as ReadableStream, {
        status: response.status,
        headers
      })
    } catch (err) {
      if (err instanceof QsysError) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CANCELLED' ? 499 : 502
        return new Response(err.message, { status })
      }
      return new Response('Playback failed', { status: 502 })
    }
  })
}
