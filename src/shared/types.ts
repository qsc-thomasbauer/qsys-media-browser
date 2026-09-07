/** Types shared across main, preload and renderer. */
import type { FeatureFlags, ThemeConfig } from '../../branding/_schema'

export type { FeatureFlags, ThemeConfig }

/* ------------------------------------------------------------------ config */

/**
 * The slice of customer config the renderer is allowed to see.
 *
 * Deliberately excludes `core` and `credentials`: the renderer never learns the
 * Core's address and never holds a token, so a compromised renderer (or an open
 * devtools window) yields nothing reusable outside the app's own IPC surface.
 */
export interface RendererConfig {
  id: string
  productName: string
  version: string
  /** Display-only. The renderer addresses everything by virtual path. */
  rootLabel: string
  features: FeatureFlags
  theme: ThemeConfig
  /** Data-URI of the customer logo, inlined at build time. */
  logoDataUri: string
}

/* -------------------------------------------------------------- resources */

export type ResourceType = 'file' | 'folder'

/** A file or folder as the renderer sees it: paths are always virtual. */
export interface MediaResource {
  name: string
  /** Virtual path, always absolute and slash-prefixed, e.g. `/Announcements/a.mp3` */
  path: string
  type: ResourceType
  ext: string | null
  size: number | null
  created: number
  updated: number
  /**
   * True for the Core's built-in folders (Audio, Messages, PageArchives,
   * Preambles, Ringtones), which reject modification. Set by main, not the API.
   */
  readOnly: boolean
}

export interface DirectoryListing {
  path: string
  entries: MediaResource[]
}

/* -------------------------------------------------------------- transfers */

export type TransferKind = 'upload' | 'download'
export type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled'

export interface TransferItem {
  id: string
  kind: TransferKind
  /** Display name (basename). */
  name: string
  localPath: string
  /** Virtual path of the remote file. */
  remotePath: string
  bytes: number
  /** Total size in bytes, or null when the server sent no content-length. */
  total: number | null
  state: TransferState
  error?: string
  startedAt: number
  finishedAt?: number
}

/* -------------------------------------------------------------- playlists */

export interface PlaylistSummary {
  id: string
  name: string
  count: number
}

export interface PlaylistTrack {
  id: string
  name: string
  /** Virtual path when inside the jail; null when the track lives outside it. */
  path: string | null
  /** Raw Core path, kept so tracks outside the jail can still be reordered. */
  corePath: string
  ext: string | null
  size: number | null
  /** False when the Core can no longer find the underlying file. */
  available: boolean
  /** True when the track sits outside this build's jail root. */
  external: boolean
}

export interface PlaylistDetail extends PlaylistSummary {
  media: PlaylistTrack[]
}

/* ----------------------------------------------------------- connection */

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

export interface ConnectionStatus {
  state: ConnectionState
  /** Host label for display, e.g. `10.0.1.50`. Safe: the user typed it into no field. */
  message?: string
  /**
   * Set when the Core's TLS certificate changed since first contact. Surfaced as
   * a warning banner rather than silently trusted.
   */
  certChanged?: boolean
}

/** Shape of an error crossing the IPC boundary. */
export interface IpcErrorShape {
  code: string
  message: string
  status?: number
}
