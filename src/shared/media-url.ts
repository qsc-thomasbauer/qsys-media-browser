/**
 * The `qsys-media://` URL form.
 *
 * Lives in shared because three places must agree on it: preload builds these
 * URLs for the renderer, the renderer hands them to `<audio>`, and the main
 * process parses them back into virtual paths.
 */
import { splitVirtual } from './vpath'

export const MEDIA_SCHEME = 'qsys-media'

/**
 * A fixed authority component. The scheme is registered as `standard`, so URLs
 * need a host; it carries no meaning and is ignored when parsing.
 */
const AUTHORITY = 'core'

export function mediaUrlFor(virtualPath: string): string {
  const segments = splitVirtual(virtualPath).map(encodeURIComponent)
  return `${MEDIA_SCHEME}://${AUTHORITY}/${segments.join('/')}`
}

/** Inverse of `mediaUrlFor`. Throws on a malformed URL. */
export function virtualPathFromMediaUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol !== `${MEDIA_SCHEME}:`) {
    throw new Error(`Not a ${MEDIA_SCHEME} URL: ${rawUrl}`)
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  return `/${segments.join('/')}`
}
