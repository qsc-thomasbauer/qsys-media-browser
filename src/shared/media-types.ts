/** Audio format knowledge shared by the transfer layer and the UI. */

/** Extension (lowercase, no dot) -> MIME type. */
export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  aif: 'audio/aiff'
}

export const AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME)

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at === -1 ? '' : name.slice(at + 1).toLowerCase()
}

/**
 * Whether the preview player should offer this file.
 *
 * Chromium cannot decode every format the Core will happily store - FLAC and
 * WAV are fine, AIFF is not - but offering playback and letting the element
 * report an error is friendlier than refusing outright, so this is deliberately
 * permissive and the player surfaces failures.
 */
export function isAudioFile(nameOrExt: string): boolean {
  const ext = nameOrExt.includes('.') ? extensionOf(nameOrExt) : nameOrExt.toLowerCase()
  return ext in AUDIO_MIME
}

/** MIME type for a filename, falling back to a generic binary type. */
export function mimeFor(name: string): string {
  return AUDIO_MIME[extensionOf(name)] ?? 'application/octet-stream'
}
