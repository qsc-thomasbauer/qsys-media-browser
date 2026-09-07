/**
 * The jail.
 *
 * Every path the renderer sends is *virtual*: `/` is the customer's configured
 * root folder, and nothing above it exists as far as the UI is concerned. This
 * module is the single place that converts between virtual paths and real Core
 * paths, and the single place that decides whether a path is permitted.
 *
 * Confinement is enforced here in the main process, not in the UI, so a
 * compromised or scripted renderer gains nothing: it can only ever hand strings
 * to `toCore`, which refuses anything that does not resolve inside the root.
 *
 * Two independent guards apply, deliberately redundant:
 *   1. Structural - `splitVirtual` rejects `..`, `.`, backslashes and null bytes
 *      before any joining happens, so traversal cannot be expressed.
 *   2. Prefix - the joined result must be the root itself or a child of
 *      `root + '/'`. This catches sibling-prefix confusion, where a root of
 *      `Audio/ACME` must not admit `Audio/ACMEX`.
 */
import { splitVirtual } from '@shared/vpath'

export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE'
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export class PathJail {
  /** Core-relative root with no leading or trailing slash. `''` = whole tree. */
  readonly root: string

  private readonly rootSegments: string[]

  /**
   * @param rootFolder Core-relative folder, e.g. `Messages/ACME`.
   * @param allowEscape When true the root is ignored and the whole `/media`
   *   tree is addressable. Validation is otherwise identical - the structural
   *   guards still run - so admin builds are not a different code path.
   */
  constructor(rootFolder: string, allowEscape = false) {
    const normalized = allowEscape ? '' : rootFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    this.rootSegments = normalized.length > 0 ? splitVirtual(normalized) : []
    this.root = this.rootSegments.join('/')
  }

  /** True when this build can see the entire `/media` tree. */
  get isUnjailed(): boolean {
    return this.rootSegments.length === 0
  }

  /**
   * Virtual -> Core. Returns `''` for the root itself, which is what the media
   * endpoint expects for "list the top level".
   */
  toCore(virtualPath: string): string {
    const segments = splitVirtual(virtualPath)
    const core = [...this.rootSegments, ...segments].join('/')

    // Redundant with splitVirtual, but this is the invariant that actually
    // matters, so assert it rather than trusting the guard above.
    if (!this.contains(core)) {
      throw new PathEscapeError(
        `Path resolves outside the permitted folder: ${virtualPath || '/'}`
      )
    }
    return core
  }

  /** Core -> Virtual. Throws when the Core path is outside the root. */
  toVirtual(corePath: string): string {
    const core = splitVirtual(corePath).join('/')
    if (!this.contains(core)) {
      throw new PathEscapeError(`Core path is outside the permitted folder: ${corePath}`)
    }
    if (this.isUnjailed) return core.length === 0 ? '/' : `/${core}`
    if (core === this.root) return '/'
    return `/${core.slice(this.root.length + 1)}`
  }

  /** Non-throwing variant, for filtering Core responses that may reach outside. */
  tryToVirtual(corePath: string): string | null {
    try {
      return this.toVirtual(corePath)
    } catch {
      return null
    }
  }

  /** Whether a Core-relative path is the root or beneath it. */
  contains(corePath: string): boolean {
    const core = corePath.replace(/^\/+|\/+$/g, '')
    if (this.isUnjailed) return true
    return core === this.root || core.startsWith(`${this.root}/`)
  }

  /**
   * Percent-encode a Core path for use in a request URL, one segment at a time.
   *
   * `encodeURIComponent` per segment rather than `encodeURI` on the whole
   * string: the API requires spaces *and* slashes inside names to be encoded,
   * and `encodeURI` leaves both `/` and several reserved characters alone.
   */
  encode(corePath: string): string {
    if (corePath.length === 0) return ''
    return corePath.split('/').map(encodeURIComponent).join('/')
  }

  /** Convenience: validate a virtual path and return its encoded Core form. */
  toEncodedCore(virtualPath: string): string {
    return this.encode(this.toCore(virtualPath))
  }
}
