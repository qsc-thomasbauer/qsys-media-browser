/**
 * Application shell.
 *
 * Owns the layout and the modal/menu state; every pane below is driven by the
 * current directory in the store and one React Query per listing.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderX, ServerCrash, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import type { ConnectionStatus, MediaResource, TransferItem } from '@shared/types'
import { api, config, invalidatePaths, keys } from '@/lib/api'
import { sortResources, useUi } from '@/store'
import { AudioPlayer } from './components/AudioPlayer'
import { ContextMenu, type MenuTarget } from './components/ContextMenu'
import { FileList } from './components/FileList'
import { FolderTree } from './components/FolderTree'
import { Header } from './components/Header'
import { PlaylistPanel } from './components/PlaylistPanel'
import { Toolbar } from './components/Toolbar'
import { TransferDrawer } from './components/TransferDrawer'
import { CreateFolderDialog, DeleteDialog, RenameDialog } from './components/dialogs'
import { Button, IconButton, Placeholder, Spinner } from './components/primitives'

type Modal =
  | { kind: 'create-folder' }
  | { kind: 'rename'; resource: MediaResource }
  | { kind: 'delete'; resources: MediaResource[] }
  | null

export function App(): ReactNode {
  const cwd = useUi((s) => s.cwd)
  const selection = useUi((s) => s.selection)
  const sortColumn = useUi((s) => s.sortColumn)
  const sortDirection = useUi((s) => s.sortDirection)
  const showPlaylists = useUi((s) => s.showPlaylists)
  const pruneSelection = useUi((s) => s.pruneSelection)
  const notify = useUi((s) => s.notify)
  const setShowTransfers = useUi((s) => s.setShowTransfers)
  const setShowPlaylists = useUi((s) => s.setShowPlaylists)

  const client = useQueryClient()
  const [modal, setModal] = useState<Modal>(null)
  const [menu, setMenu] = useState<MenuTarget | null>(null)

  /* ----------------------------------------------- main-process streams */

  const [status, setStatus] = useState<ConnectionStatus>({ state: 'connecting' })
  const [transfers, setTransfers] = useState<TransferItem[]>([])

  useEffect(() => {
    void api.getStatus().then(setStatus)
    void api.listTransfers().then(setTransfers)
    const offStatus = api.onStatus(setStatus)
    const offTransfers = api.onTransfers(setTransfers)
    return () => {
      offStatus()
      offTransfers()
    }
  }, [])

  /**
   * A finished upload changes a listing the Core knows about but we do not, so
   * refresh the destination folder as each transfer completes.
   */
  useEffect(() => {
    const finished = transfers.filter((item) => item.state === 'done')
    if (finished.length === 0) return
    invalidatePaths(
      client,
      finished.filter((item) => item.kind === 'upload').map((item) => item.remotePath)
    )
  }, [transfers.filter((item) => item.state === 'done').length])

  /* --------------------------------------------------------- listing */

  const listing = useQuery({
    queryKey: keys.dir(cwd),
    queryFn: () => api.list(cwd),
    // A Core is a shared appliance; a short stale window keeps a second
    // operator's changes from lingering on screen without hammering it.
    staleTime: 10_000,
    retry: 1
  })

  const entries = useMemo(
    () => sortResources(listing.data?.entries ?? [], sortColumn, sortDirection),
    [listing.data, sortColumn, sortDirection]
  )

  useEffect(() => {
    if (listing.data) pruneSelection(listing.data.entries)
  }, [listing.data])

  const selected = entries.filter((entry) => selection.includes(entry.path))

  /* --------------------------------------------------------- actions */

  const download = useMutation({
    mutationFn: async (resources: MediaResource[]) => {
      const files = resources.filter((resource) => resource.type === 'file')
      if (files.length === 0) return []
      const targetDir = await api.pickDownloadDir()
      if (!targetDir) return []
      return api.download({ remotePaths: files.map((file) => file.path), targetDir })
    },
    onSuccess: (queued) => {
      if (queued.length > 0) setShowTransfers(true)
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const openResource = (resource: MediaResource): void => {
    if (resource.type === 'folder') useUi.getState().navigate(resource.path)
    else useUi.getState().play({ path: resource.path, name: resource.name })
  }

  /* ---------------------------------------------------------- render */

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <Header status={status} />

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-line bg-surface-1">
          <FolderTree />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            entries={entries}
            onCreateFolder={() => setModal({ kind: 'create-folder' })}
            onRename={(resource) => setModal({ kind: 'rename', resource })}
            onDelete={(resources) => setModal({ kind: 'delete', resources })}
          />

          <div className="min-h-0 flex-1">
            {listing.isPending ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="h-5 w-5 text-ink-faint" />
              </div>
            ) : listing.isError ? (
              <ListingError
                message={
                  listing.error instanceof Error
                    ? listing.error.message
                    : 'This folder could not be read.'
                }
                onRetry={() => void listing.refetch()}
              />
            ) : (
              <FileList
                entries={entries}
                onRename={(resource) => setModal({ kind: 'rename', resource })}
                onDelete={(resources) => setModal({ kind: 'delete', resources })}
                onContextMenu={(resource, at) => setMenu({ resource, at })}
              />
            )}
          </div>

          <AudioPlayer />
          <TransferDrawer transfers={transfers} />
        </main>

        {showPlaylists && config.features.playlists ? (
          <PlaylistPanel entries={entries} />
        ) : null}
      </div>

      <StatusBar />

      {/* Modals */}
      {modal?.kind === 'create-folder' ? (
        <CreateFolderDialog parent={cwd} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === 'rename' ? (
        <RenameDialog resource={modal.resource} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === 'delete' ? (
        <DeleteDialog resources={modal.resources} onClose={() => setModal(null)} />
      ) : null}

      {menu ? (
        <ContextMenu
          target={menu}
          selected={selected}
          onClose={() => setMenu(null)}
          onOpen={openResource}
          onRename={(resource) => setModal({ kind: 'rename', resource })}
          onDelete={(resources) => setModal({ kind: 'delete', resources })}
          onDownload={(resources) => download.mutate(resources)}
          onCreateFolder={() => setModal({ kind: 'create-folder' })}
          onRefresh={() => void client.invalidateQueries({ queryKey: keys.dir(cwd) })}
          onAddToPlaylist={() => setShowPlaylists(true)}
        />
      ) : null}
    </div>
  )
}

/** Bottom strip: the transient toast, plus the build identity. */
function StatusBar(): ReactNode {
  const toast = useUi((s) => s.toast)
  const dismiss = useUi((s) => s.dismissToast)

  // Informational messages fade on their own; errors stay until dismissed, so a
  // failure cannot scroll past unnoticed.
  useEffect(() => {
    if (!toast || toast.kind === 'error') return
    const timer = setTimeout(dismiss, 5000)
    return () => clearTimeout(timer)
  }, [toast, dismiss])

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface-1 px-3">
      {toast ? (
        <>
          <span
            className={clsx(
              'min-w-0 flex-1 select-text truncate text-[11.5px]',
              toast.kind === 'error' ? 'text-danger' : 'text-ink-muted'
            )}
          >
            {toast.message}
          </span>
          <IconButton
            icon={<X size={12} />}
            className="!h-5 !w-5"
            title="Dismiss"
            aria-label="Dismiss message"
            onClick={dismiss}
          />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 text-[11px] text-ink-faint">
        {config.productName} {config.version}
      </span>
    </footer>
  )
}

function ListingError({
  message,
  onRetry
}: {
  message: string
  onRetry(): void
}): ReactNode {
  const isMissing = message.toLowerCase().includes('no longer exists')
  return (
    <Placeholder
      icon={isMissing ? <FolderX size={26} /> : <ServerCrash size={26} />}
      title={isMissing ? 'This folder is gone' : 'Could not read this folder'}
      detail={message}
      action={
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  )
}
