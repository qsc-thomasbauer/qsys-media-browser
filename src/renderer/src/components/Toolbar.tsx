/**
 * Breadcrumbs and the action bar.
 *
 * Buttons are hidden when a feature is switched off for the build, but that is
 * cosmetic only - `src/main/ipc.ts` refuses the corresponding call regardless,
 * so a hidden button is not the thing keeping the capability away.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp,
  Download,
  FolderPlus,
  HardDriveDownload,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Fragment } from 'react'
import type { MediaResource } from '@shared/types'
import { breadcrumbs } from '@shared/vpath'
import { api, config, keys } from '@/lib/api'
import { useUi } from '@/store'
import { Button, IconButton } from './primitives'

interface ToolbarProps {
  entries: MediaResource[]
  onCreateFolder(): void
  onRename(resource: MediaResource): void
  onDelete(resources: MediaResource[]): void
}

export function Toolbar({
  entries,
  onCreateFolder,
  onRename,
  onDelete
}: ToolbarProps): ReactNode {
  const cwd = useUi((s) => s.cwd)
  const selection = useUi((s) => s.selection)
  const navigate = useUi((s) => s.navigate)
  const goUp = useUi((s) => s.goUp)
  const notify = useUi((s) => s.notify)
  const setShowTransfers = useUi((s) => s.setShowTransfers)
  const client = useQueryClient()

  const selected = entries.filter((entry) => selection.includes(entry.path))
  const selectedFiles = selected.filter((entry) => entry.type === 'file')
  const trail = breadcrumbs(cwd)

  const upload = useMutation({
    mutationFn: () => api.pickUploads(cwd),
    onSuccess: (queued) => {
      if (queued.length > 0) setShowTransfers(true)
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const download = useMutation({
    mutationFn: async () => {
      const targetDir = await api.pickDownloadDir()
      if (!targetDir) return []
      return api.download({
        remotePaths: selectedFiles.map((file) => file.path),
        targetDir
      })
    },
    onSuccess: (queued) => {
      if (queued.length > 0) setShowTransfers(true)
    },
    onError: (err: Error) => notify('error', err.message)
  })

  return (
    <div className="flex flex-col border-b border-line bg-surface-1">
      {/* Breadcrumbs */}
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton
          icon={<ArrowUp size={14} />}
          title="Up one folder"
          aria-label="Up one folder"
          disabled={cwd === '/'}
          onClick={goUp}
        />
        <IconButton
          icon={<RefreshCw size={14} />}
          title="Refresh"
          aria-label="Refresh this folder"
          onClick={() => void client.invalidateQueries({ queryKey: keys.dir(cwd) })}
        />

        <div className="mx-1 h-4 w-px bg-line" />

        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12.5px]">
          <button
            type="button"
            className={
              cwd === '/'
                ? 'shrink-0 rounded px-1.5 py-0.5 font-medium text-ink'
                : 'shrink-0 rounded px-1.5 py-0.5 text-ink-muted hover:bg-surface-2 hover:text-ink'
            }
            onClick={() => navigate('/')}
          >
            {config.rootLabel}
          </button>
          {trail.map((crumb, index) => (
            <Fragment key={crumb.path}>
              <span className="shrink-0 text-ink-faint">/</span>
              <button
                type="button"
                className={
                  index === trail.length - 1
                    ? 'truncate rounded px-1.5 py-0.5 font-medium text-ink'
                    : 'truncate rounded px-1.5 py-0.5 text-ink-muted hover:bg-surface-2 hover:text-ink'
                }
                onClick={() => navigate(crumb.path)}
              >
                {crumb.name}
              </button>
            </Fragment>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex h-10 items-center gap-1.5 border-t border-line px-2">
        {config.features.upload ? (
          <Button
            variant="primary"
            icon={<Upload size={14} />}
            onClick={() => upload.mutate()}
            disabled={upload.isPending}
          >
            Upload
          </Button>
        ) : null}

        {config.features.download ? (
          <Button
            icon={<Download size={14} />}
            onClick={() => download.mutate()}
            disabled={selectedFiles.length === 0 || download.isPending}
            title={
              selectedFiles.length === 0 ? 'Select one or more files first' : undefined
            }
          >
            Download{selectedFiles.length > 1 ? ` (${selectedFiles.length})` : ''}
          </Button>
        ) : null}

        {config.features.createFolder ? (
          <Button icon={<FolderPlus size={14} />} onClick={onCreateFolder}>
            New folder
          </Button>
        ) : null}

        <div className="mx-1 h-4 w-px bg-line" />

        {config.features.rename ? (
          <Button
            icon={<Pencil size={14} />}
            disabled={selected.length !== 1 || selected[0]!.readOnly}
            onClick={() => selected[0] && onRename(selected[0])}
          >
            Rename
          </Button>
        ) : null}

        {config.features.delete ? (
          <Button
            variant="ghost"
            icon={<Trash2 size={14} />}
            className="hover:!bg-danger-subtle hover:!text-danger"
            disabled={selected.length === 0 || selected.some((entry) => entry.readOnly)}
            onClick={() => onDelete(selected)}
          >
            Delete{selected.length > 1 ? ` (${selected.length})` : ''}
          </Button>
        ) : null}

        <div className="flex-1" />

        <span className="pr-1 text-[11.5px] text-ink-faint">
          {selection.length > 0
            ? `${selection.length} of ${entries.length} selected`
            : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
        </span>

        <IconButton
          icon={<HardDriveDownload size={14} />}
          title="Show transfers"
          aria-label="Show transfers"
          onClick={() => setShowTransfers(true)}
        />
      </div>
    </div>
  )
}
