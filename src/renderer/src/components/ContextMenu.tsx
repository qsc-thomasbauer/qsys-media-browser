/**
 * Right-click menu.
 *
 * Positioned so it never leaves the window, and closed by any click, scroll or
 * Escape - the usual desktop expectations, which are the whole reason a context
 * menu is worth having over a toolbar alone.
 */
import { Download, FolderPlus, ListPlus, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MediaResource } from '@shared/types'
import { isAudioFile } from '@shared/media-types'
import { config } from '@/lib/api'

export interface MenuTarget {
  resource: MediaResource | null
  at: { x: number; y: number }
}

interface ContextMenuProps {
  target: MenuTarget
  /** Every currently selected resource, for the multi-item actions. */
  selected: MediaResource[]
  onClose(): void
  onOpen(resource: MediaResource): void
  onRename(resource: MediaResource): void
  onDelete(resources: MediaResource[]): void
  onDownload(resources: MediaResource[]): void
  onCreateFolder(): void
  onRefresh(): void
  onAddToPlaylist(resources: MediaResource[]): void
}

export function ContextMenu({
  target,
  selected,
  onClose,
  onOpen,
  onRename,
  onDelete,
  onDownload,
  onCreateFolder,
  onRefresh,
  onAddToPlaylist
}: ContextMenuProps): ReactNode {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(target.at)

  // Flip the menu back inside the viewport once its real size is known.
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPosition({
      x: Math.min(target.at.x, window.innerWidth - width - 6),
      y: Math.min(target.at.y, window.innerHeight - height - 6)
    })
  }, [target])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const { resource } = target
  // Act on the whole selection when the clicked row is part of it.
  const acting =
    resource && selected.some((entry) => entry.path === resource.path)
      ? selected
      : resource
        ? [resource]
        : []

  const files = acting.filter((entry) => entry.type === 'file')
  const audioFiles = files.filter((entry) => isAudioFile(entry.name))
  const anyReadOnly = acting.some((entry) => entry.readOnly)

  return (
    <div
      ref={menu}
      role="menu"
      className="animate-fade-in fixed z-40 min-w-52 rounded-md border border-line bg-surface-2 py-1 shadow-2xl"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {resource ? (
        <>
          <Item
            icon={resource.type === 'folder' ? <FolderPlus size={13} /> : <Play size={13} />}
            label={resource.type === 'folder' ? 'Open' : 'Play'}
            disabled={resource.type === 'file' && (!config.features.preview || !isAudioFile(resource.name))}
            onClick={() => {
              onOpen(resource)
              onClose()
            }}
          />

          {config.features.download ? (
            <Item
              icon={<Download size={13} />}
              label={files.length > 1 ? `Download ${files.length} files` : 'Download'}
              disabled={files.length === 0}
              onClick={() => {
                onDownload(files)
                onClose()
              }}
            />
          ) : null}

          {config.features.playlists ? (
            <Item
              icon={<ListPlus size={13} />}
              label="Add to playlist…"
              disabled={audioFiles.length === 0}
              onClick={() => {
                onAddToPlaylist(audioFiles)
                onClose()
              }}
            />
          ) : null}

          <Separator />

          {config.features.rename ? (
            <Item
              icon={<Pencil size={13} />}
              label="Rename"
              shortcut="F2"
              disabled={acting.length !== 1 || anyReadOnly}
              onClick={() => {
                onRename(resource)
                onClose()
              }}
            />
          ) : null}

          {config.features.delete ? (
            <Item
              icon={<Trash2 size={13} />}
              label={acting.length > 1 ? `Delete ${acting.length} items` : 'Delete'}
              shortcut="Del"
              danger
              disabled={anyReadOnly}
              onClick={() => {
                onDelete(acting)
                onClose()
              }}
            />
          ) : null}

          <Separator />
        </>
      ) : null}

      {config.features.createFolder ? (
        <Item
          icon={<FolderPlus size={13} />}
          label="New folder"
          onClick={() => {
            onCreateFolder()
            onClose()
          }}
        />
      ) : null}

      <Item
        icon={<RefreshCw size={13} />}
        label="Refresh"
        onClick={() => {
          onRefresh()
          onClose()
        }}
      />
    </div>
  )
}

function Item({
  icon,
  label,
  shortcut,
  disabled,
  danger,
  onClick
}: {
  icon: ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick(): void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
        'disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-subtle' : 'text-ink hover:bg-surface-3'
      ].join(' ')}
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="text-[11px] text-ink-faint">{shortcut}</span> : null}
    </button>
  )
}

function Separator(): ReactNode {
  return <div className="my-1 h-px bg-line" />
}
