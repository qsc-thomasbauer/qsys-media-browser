/**
 * IPC registration.
 *
 * Two things happen for every channel, uniformly:
 *
 *  - **Feature flags are enforced here, not in the UI.** A build with
 *    `features.delete: false` does not merely hide the button; the handler
 *    refuses. Hiding alone would leave the capability one devtools call away.
 *  - **Errors are marshalled** through `encodeIpcError` so the renderer gets a
 *    typed code back instead of a stringified Error.
 *
 * Path arguments are passed straight to the media layer, which funnels every
 * one of them through the jail. There is deliberately no channel that accepts a
 * Core path.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CH } from '@shared/ipc'
import type { DownloadRequest, MoveRequest, RenameRequest, UploadRequest } from '@shared/ipc'
import { encodeIpcError } from '@shared/errors'
import { AUDIO_EXTENSIONS } from '@shared/media-types'
import type { FeatureFlags } from '@shared/types'
import { customer } from './config'
import * as auth from './qsys/auth'
import * as media from './qsys/media'
import * as playlists from './qsys/playlists'
import * as transfer from './qsys/transfer'

class FeatureDisabledError extends Error {
  readonly code = 'FEATURE_DISABLED'
  constructor(feature: keyof FeatureFlags) {
    super(`This build does not include the "${feature}" feature.`)
  }
}

function requireFeature(feature: keyof FeatureFlags): void {
  if (!customer.features[feature]) throw new FeatureDisabledError(feature)
}

/** Wrap a handler so every rejection crosses the bridge in a decodable form. */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...(args as A))
    } catch (err) {
      throw new Error(encodeIpcError(err))
    }
  })
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------------------------------------- status */

  handle(CH.coreStatus, () => auth.connectionStatus())
  handle(CH.coreConnect, () => auth.connect())

  /* -------------------------------------------------------------- media */

  handle(CH.mediaList, (dir: string) => media.list(dir))
  handle(CH.mediaStat, (path: string) => media.stat(path))
  handle(CH.mediaExists, (path: string) => media.exists(path))

  handle(CH.mediaMkdir, (parent: string, name: string) => {
    requireFeature('createFolder')
    return media.mkdir(parent, name)
  })

  handle(CH.mediaRename, (req: RenameRequest) => {
    requireFeature('rename')
    return media.rename(req)
  })

  handle(CH.mediaMove, (reqs: MoveRequest[]) => {
    requireFeature('move')
    return media.move(reqs)
  })

  handle(CH.mediaRemove, (paths: string[]) => {
    requireFeature('delete')
    return media.remove(paths)
  })

  /* ---------------------------------------------------------- transfers */

  handle(CH.transferUpload, (req: UploadRequest) => {
    requireFeature('upload')
    return transfer.enqueueUploads(req.targetDir, req.localPaths)
  })

  handle(CH.transferDownload, (req: DownloadRequest) => {
    requireFeature('download')
    return transfer.enqueueDownloads(req.remotePaths, req.targetDir)
  })

  handle(CH.transferCancel, (id: string) => transfer.cancelTransfer(id))
  handle(CH.transferList, () => transfer.listTransfers())
  handle(CH.transferClearFinished, () => transfer.clearFinished())

  /* ---------------------------------------------------------- playlists */

  handle(CH.playlistList, () => {
    requireFeature('playlists')
    return playlists.list()
  })
  handle(CH.playlistGet, (id: string) => {
    requireFeature('playlists')
    return playlists.get(id)
  })
  handle(CH.playlistCreate, (name: string) => {
    requireFeature('playlists')
    return playlists.create(name)
  })
  handle(CH.playlistRename, (id: string, name: string) => {
    requireFeature('playlists')
    return playlists.rename(id, name)
  })
  handle(CH.playlistRemove, (id: string) => {
    requireFeature('playlists')
    return playlists.remove(id)
  })
  handle(CH.playlistSetTracks, (id: string, keys: string[]) => {
    requireFeature('playlists')
    return playlists.setTracks(id, keys)
  })
  handle(CH.playlistAddTracks, (id: string, paths: string[]) => {
    requireFeature('playlists')
    return playlists.addTracks(id, paths)
  })
  handle(CH.playlistRemoveTrack, (id: string, key: string) => {
    requireFeature('playlists')
    return playlists.removeTrack(id, key)
  })

  /* ------------------------------------------------------------ dialogs */

  handle(CH.dialogPickUploads, async (targetDir: string) => {
    requireFeature('upload')
    const window = getWindow()
    if (!window) return []

    const result = await dialog.showOpenDialog(window, {
      title: 'Choose files to upload',
      buttonLabel: 'Upload',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return transfer.enqueueUploads(targetDir, result.filePaths)
  })

  handle(CH.dialogPickDownloadDir, async () => {
    requireFeature('download')
    const window = getWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder to save into',
      buttonLabel: 'Save here',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(CH.shellReveal, (localPath: string) => {
    shell.showItemInFolder(localPath)
  })
}

/** Push main-side events at the renderer. Called once the window exists. */
export function wireEvents(getWindow: () => BrowserWindow | null): () => void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const offStatus = auth.onConnectionChange((status) => send(CH.coreStatusEvent, status))
  const offTransfers = transfer.onTransfersChange((items) => send(CH.transferEvent, items))

  return () => {
    offStatus()
    offTransfers()
  }
}
