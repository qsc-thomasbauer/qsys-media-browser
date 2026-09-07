/** Presentation helpers. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human-readable byte count. `null` renders as an em dash, not "0 B". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes === 0) return '0 B'

  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  // One decimal below 10 so "1.4 MB" does not round to a misleading "1 MB".
  const digits = exponent === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${UNITS[exponent]}`
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Epoch millis as a compact timestamp; today's files show a time instead. */
export function formatTimestamp(millis: number | null | undefined): string {
  if (!millis) return '—'
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return '—'

  const now = new Date()
  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()

  return sameDay ? timeFormat.format(date) : dateFormat.format(date)
}

/** Transfer rate, or an empty string when there is nothing meaningful to show. */
export function formatRate(bytes: number, startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1000
  if (seconds < 0.5 || bytes === 0) return ''
  return `${formatBytes(Math.round(bytes / seconds))}/s`
}

/** Seconds as `m:ss`, for the audio player. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
