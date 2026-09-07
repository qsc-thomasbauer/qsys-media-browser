/**
 * The preload bridge.
 *
 * This is the only channel between the renderer and anything privileged, and it
 * is deliberately thin: every method forwards to a named IPC channel and
 * nothing more. There is no `ipcRenderer` exposed, no `require`, no path or fs
 * access, and no way to reach an arbitrary channel - so the renderer's
 * capabilities are exactly the list in `QsysApi` and nothing else.
 *
 * The one piece of real logic here is error unwrapping: `ipcRenderer.invoke`
 * rejects with a stringified Error, so rejections are decoded back into typed
 * `QsysClientError`s before they reach the UI.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '@shared/ipc'
import type {
  DownloadRequest,
  MoveRequest,
  QsysApi,
  RenameRequest,
  UploadRequest
} from '@shared/ipc'
import { decodeIpcError } from '@shared/errors'
import { mediaUrlFor } from '@shared/media-url'
import type { ConnectionStatus, TransferItem } from '@shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw decodeIpcError(err)
  }
}

/** Subscribe to a push channel, returning an unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => void ipcRenderer.off(channel, listener)
}

const api: QsysApi = {
  getStatus: () => invoke(CH.coreStatus),
  connect: () => invoke(CH.coreConnect),
  onStatus: (cb) => subscribe<ConnectionStatus>(CH.coreStatusEvent, cb),

  list: (dir) => invoke(CH.mediaList, dir),
  stat: (path) => invoke(CH.mediaStat, path),
  exists: (path) => invoke(CH.mediaExists, path),
  mkdir: (parent, name) => invoke(CH.mediaMkdir, parent, name),
  rename: (req: RenameRequest) => invoke(CH.mediaRename, req),
  move: (reqs: MoveRequest[]) => invoke(CH.mediaMove, reqs),
  remove: (paths) => invoke(CH.mediaRemove, paths),

  upload: (req: UploadRequest) => invoke(CH.transferUpload, req),
  download: (req: DownloadRequest) => invoke(CH.transferDownload, req),
  cancelTransfer: (id) => invoke(CH.transferCancel, id),
  listTransfers: () => invoke(CH.transferList),
  clearFinishedTransfers: () => invoke(CH.transferClearFinished),
  onTransfers: (cb) => subscribe<TransferItem[]>(CH.transferEvent, cb),

  playlists: () => invoke(CH.playlistList),
  playlist: (id) => invoke(CH.playlistGet, id),
  createPlaylist: (name) => invoke(CH.playlistCreate, name),
  renamePlaylist: (id, name) => invoke(CH.playlistRename, id, name),
  removePlaylist: (id) => invoke(CH.playlistRemove, id),
  setPlaylistTracks: (id, keys) => invoke(CH.playlistSetTracks, id, keys),
  addPlaylistTracks: (id, paths) => invoke(CH.playlistAddTracks, id, paths),
  removePlaylistTrack: (id, key) => invoke(CH.playlistRemoveTrack, id, key),

  pickUploads: (targetDir) => invoke(CH.dialogPickUploads, targetDir),
  pickDownloadDir: () => invoke(CH.dialogPickDownloadDir),
  revealInFolder: (localPath) => invoke(CH.shellReveal, localPath),

  // `File.path` was removed from Electron; `webUtils` is the supported way to
  // resolve a dropped file, and it only works from a preload context.
  pathForFile: (file) => webUtils.getPathForFile(file),

  mediaUrl: (virtualPath) => mediaUrlFor(virtualPath)
}

contextBridge.exposeInMainWorld('qsys', api)
