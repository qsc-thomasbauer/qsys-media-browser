/**
 * The IPC contract.
 *
 * This is the *entire* surface the renderer has. Everything here is implemented
 * in main and re-exported by preload through `contextBridge`; there is no raw
 * `fetch`, no Node access, and no way to reach the Core except through these
 * calls. Paths crossing this boundary are always *virtual* - relative to the
 * customer's jail root - and are validated in main before use.
 */
import type {
  ConnectionStatus,
  DirectoryListing,
  MediaResource,
  PlaylistDetail,
  PlaylistSummary,
  TransferItem
} from './types'

export const CH = {
  coreStatus: 'core:status',
  coreConnect: 'core:connect',
  coreStatusEvent: 'core:status-event',

  mediaList: 'media:list',
  mediaStat: 'media:stat',
  mediaExists: 'media:exists',
  mediaMkdir: 'media:mkdir',
  mediaRename: 'media:rename',
  mediaMove: 'media:move',
  mediaRemove: 'media:remove',

  transferUpload: 'transfer:upload',
  transferDownload: 'transfer:download',
  transferCancel: 'transfer:cancel',
  transferList: 'transfer:list',
  transferClearFinished: 'transfer:clear-finished',
  transferEvent: 'transfer:event',

  playlistList: 'playlist:list',
  playlistGet: 'playlist:get',
  playlistCreate: 'playlist:create',
  playlistRename: 'playlist:rename',
  playlistRemove: 'playlist:remove',
  playlistSetTracks: 'playlist:set-tracks',
  playlistAddTracks: 'playlist:add-tracks',
  playlistRemoveTrack: 'playlist:remove-track',

  dialogPickUploads: 'dialog:pick-uploads',
  dialogPickDownloadDir: 'dialog:pick-download-dir',
  shellReveal: 'shell:reveal'
} as const

export type Channel = (typeof CH)[keyof typeof CH]

/** A rename request: `path` identifies the resource, `name` is the new basename. */
export interface RenameRequest {
  path: string
  name: string
}

/** A move request: `from` and `to` are both full virtual paths. */
export interface MoveRequest {
  from: string
  to: string
}

export interface UploadRequest {
  /** Virtual path of the destination folder. */
  targetDir: string
  /** Absolute local file paths. */
  localPaths: string[]
}

export interface DownloadRequest {
  /** Virtual paths of the files to fetch. */
  remotePaths: string[]
  /** Absolute local directory to write into. */
  targetDir: string
}

/**
 * What the renderer sees as `window.qsys`.
 *
 * Note the absence of a config getter: the renderer's slice of customer config
 * is stamped into its own bundle as `__CUSTOMER__`, so the theme is available
 * synchronously on first paint instead of arriving a frame later.
 */
export interface QsysApi {
  getStatus(): Promise<ConnectionStatus>
  /** Force a (re)connect and auth attempt. Resolves once the outcome is known. */
  connect(): Promise<ConnectionStatus>
  onStatus(cb: (status: ConnectionStatus) => void): () => void

  list(virtualDir: string): Promise<DirectoryListing>
  stat(virtualPath: string): Promise<MediaResource>
  exists(virtualPath: string): Promise<boolean>
  mkdir(virtualParentDir: string, name: string): Promise<MediaResource>
  rename(req: RenameRequest): Promise<MediaResource>
  /** Move one or many resources. Returns the moved resources' new metadata. */
  move(reqs: MoveRequest[]): Promise<MediaResource[]>
  remove(virtualPaths: string[]): Promise<void>

  upload(req: UploadRequest): Promise<TransferItem[]>
  download(req: DownloadRequest): Promise<TransferItem[]>
  cancelTransfer(id: string): Promise<void>
  listTransfers(): Promise<TransferItem[]>
  clearFinishedTransfers(): Promise<void>
  onTransfers(cb: (items: TransferItem[]) => void): () => void

  playlists(): Promise<PlaylistSummary[]>
  playlist(id: string): Promise<PlaylistDetail>
  createPlaylist(name: string): Promise<PlaylistSummary>
  renamePlaylist(id: string, name: string): Promise<PlaylistDetail>
  removePlaylist(id: string): Promise<void>
  /**
   * Replace the whole track list - used for reordering and removal.
   *
   * `trackKeys` are `PlaylistTrack.corePath` values in the desired order. Keys
   * must already be in the playlist or resolve inside the jail, which is what
   * keeps tracks added elsewhere on the Core from being wiped by a reorder.
   */
  setPlaylistTracks(id: string, trackKeys: string[]): Promise<PlaylistDetail>
  addPlaylistTracks(id: string, virtualPaths: string[]): Promise<PlaylistDetail>
  removePlaylistTrack(id: string, trackKey: string): Promise<void>

  /** Native file picker; returns the queued transfers (empty if cancelled). */
  pickUploads(targetDir: string): Promise<TransferItem[]>
  /** Native directory picker; returns the chosen path or null. */
  pickDownloadDir(): Promise<string | null>
  revealInFolder(localPath: string): Promise<void>

  /**
   * Resolve a dropped `File` to an absolute path. Needs `webUtils` from the
   * preload context - `File.path` no longer exists in current Electron.
   */
  pathForFile(file: File): string

  /**
   * Build a `qsys-media://` URL for `<audio src>`. The protocol handler in main
   * attaches the bearer token, so the renderer never sees it.
   */
  mediaUrl(virtualPath: string): string
}

/** Folders the Core ships with and refuses to modify. */
export const CORE_RESERVED_FOLDERS = [
  'Audio',
  'Messages',
  'PageArchives',
  'Preambles',
  'Ringtones'
] as const
