/**
 * Virtual path helpers.
 *
 * A *virtual* path is what the renderer speaks: always slash-prefixed, always
 * POSIX-style, with `/` meaning the customer's jail root. These helpers are
 * pure string manipulation shared by both processes (breadcrumbs in the
 * renderer, request building in main); the actual jail enforcement lives in
 * `src/main/qsys/paths.ts` and is the only thing that decides what is allowed.
 */

/** Characters a resource name may never contain. */
const ILLEGAL_NAME = /[/\\\0]/

/** Byte length without depending on Buffer - this module also runs in the renderer. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length

export class InvalidPathError extends Error {
  readonly code = 'INVALID_PATH'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPathError'
  }
}

/**
 * Split a virtual path into validated segments.
 *
 * Rejects anything that could mean "somewhere else": `.`/`..` segments,
 * backslashes, null bytes, and names whose single-decoded form contains a path
 * separator. That last case is defensive - every segment is
 * `encodeURIComponent`'d before it reaches the wire, so a literal `%2f` in a
 * name cannot traverse anyway - but a name like `a%2Fb` is pathological enough
 * that failing loudly beats guessing.
 */
export function splitVirtual(path: string): string[] {
  if (typeof path !== 'string') {
    throw new InvalidPathError(`Path must be a string, got ${typeof path}`)
  }
  if (path.includes('\0')) {
    throw new InvalidPathError('Path must not contain null bytes')
  }
  if (path.includes('\\')) {
    throw new InvalidPathError('Path must use forward slashes')
  }

  const segments = path.split('/').filter((s) => s.length > 0)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new InvalidPathError(`Path must not contain "${segment}" segments: ${path}`)
    }
    if (byteLength(segment) > 255) {
      throw new InvalidPathError(`Path segment is too long: ${segment.slice(0, 40)}...`)
    }
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // A stray '%' is fine in a filename; only well-formed escapes matter here.
    }
    if (decoded !== segment && (ILLEGAL_NAME.test(decoded) || decoded === '..')) {
      throw new InvalidPathError(`Path segment decodes to a separator: ${segment}`)
    }
  }
  return segments
}

/** Canonical form: `/`, or `/a/b` with no trailing slash. */
export function normalizeVirtual(path: string): string {
  const segments = splitVirtual(path)
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/** Validate a single resource name (for create / rename). */
export function assertValidName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new InvalidPathError('Name must not be empty')
  if (trimmed === '.' || trimmed === '..') throw new InvalidPathError(`"${trimmed}" is not a valid name`)
  if (ILLEGAL_NAME.test(trimmed)) {
    throw new InvalidPathError('Name must not contain slashes or null bytes')
  }
  if (byteLength(trimmed) > 255) {
    throw new InvalidPathError('Name is too long (max 255 bytes)')
  }
  return trimmed
}

/**
 * Split a filename into its stem and extension.
 *
 * Matters because the Core's rename endpoint takes the *stem* and re-appends
 * the extension itself: sending `image.jpeg` for a file called `image.jpeg`
 * produces `image.jpeg.jpeg`. See docs/API-NOTES.md.
 *
 * Follows the same rule as Node's `extname`, so a dotfile has no extension
 * (`.htaccess` is all stem) and only the final dot separates:
 * `archive.tar.gz` -> `{ stem: 'archive.tar', ext: 'gz' }`, which is also what
 * the API itself reports.
 */
export function splitExtension(filename: string): { stem: string; ext: string } {
  const at = filename.lastIndexOf('.')
  if (at <= 0 || at === filename.length - 1) return { stem: filename, ext: '' }
  return { stem: filename.slice(0, at), ext: filename.slice(at + 1) }
}

/** `/a/b` -> `/a`; `/a` -> `/`; `/` -> `/` */
export function parentVirtual(path: string): string {
  const segments = splitVirtual(path)
  segments.pop()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/** Last segment of a virtual path, or `''` for the root. */
export function baseVirtual(path: string): string {
  const segments = splitVirtual(path)
  return segments.at(-1) ?? ''
}

/** Append a validated name to a virtual directory. */
export function joinVirtual(dir: string, name: string): string {
  const segments = splitVirtual(dir)
  segments.push(assertValidName(name))
  return `/${segments.join('/')}`
}

/** True when `path` is `ancestor` or sits beneath it. Used to block self-moves. */
export function isWithin(path: string, ancestor: string): boolean {
  const a = normalizeVirtual(ancestor)
  const p = normalizeVirtual(path)
  return a === '/' || p === a || p.startsWith(a === '/' ? '/' : `${a}/`)
}

/** Breadcrumb trail from the root down to `path`, inclusive. */
export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const segments = splitVirtual(path)
  const trail: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const segment of segments) {
    acc += `/${segment}`
    trail.push({ name: segment, path: acc })
  }
  return trail
}
