/**
 * The file list.
 *
 * Virtualized because `/media` on a busy Core holds thousands of files and a
 * naive list would stutter on every scroll and re-render. Rows are fixed height,
 * which keeps the virtualizer's measurement trivial.
 *
 * Two drag interactions share this surface: dragging files *in* from the OS
 * queues uploads, and dragging rows *within* the app moves resources. They are
 * told apart by the presence of the app's own private drag type.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  FileAudio,
  FileQuestion,
  Folder,
  Lock,
  Play,
  Upload
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import type { MediaResource } from '@shared/types'
import { isAudioFile } from '@shared/media-types'
import { isWithin } from '@shared/vpath'
import { api, config, invalidatePaths } from '@/lib/api'
import { formatBytes, formatTimestamp } from '@/lib/format'
import { useUi, type SortColumn } from '@/store'
import { Placeholder } from './primitives'

const ROW_HEIGHT = 30

interface FileListProps {
  entries: MediaResource[]
  onRename(resource: MediaResource): void
  onDelete(resources: MediaResource[]): void
  onContextMenu(resource: MediaResource | null, at: { x: number; y: number }): void
}

export function FileList({
  entries,
  onRename,
  onDelete,
  onContextMenu
}: FileListProps): ReactNode {
  const cwd = useUi((s) => s.cwd)
  const selection = useUi((s) => s.selection)
  const sortColumn = useUi((s) => s.sortColumn)
  const sortDirection = useUi((s) => s.sortDirection)
  const select = useUi((s) => s.select)
  const selectAll = useUi((s) => s.selectAll)
  const clearSelection = useUi((s) => s.clearSelection)
  const navigate = useUi((s) => s.navigate)
  const play = useUi((s) => s.play)
  const notify = useUi((s) => s.notify)
  const setShowTransfers = useUi((s) => s.setShowTransfers)
  const setSort = useUi((s) => s.setSort)

  const client = useQueryClient()
  const scroller = useRef<HTMLDivElement>(null)
  const [dropActive, setDropActive] = useState(false)

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const selectedSet = useMemo(() => new Set(selection), [selection])

  const upload = useMutation({
    mutationFn: (localPaths: string[]) => api.upload({ targetDir: cwd, localPaths }),
    onSuccess: (queued) => {
      if (queued.length > 0) setShowTransfers(true)
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const move = useMutation({
    mutationFn: (moves: Array<{ from: string; to: string }>) => api.move(moves),
    onSuccess: (_result, moves) => {
      invalidatePaths(client, [cwd, ...moves.map((m) => m.from), ...moves.map((m) => m.to)])
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const openResource = (resource: MediaResource): void => {
    if (resource.type === 'folder') {
      navigate(resource.path)
      return
    }
    if (config.features.preview && isAudioFile(resource.name)) {
      play({ path: resource.path, name: resource.name })
      return
    }
    notify('info', `${resource.name} cannot be previewed in this app. Download it to open it.`)
  }

  /* --------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        selectAll(entries)
        return
      }
      if (event.key === 'Escape') {
        clearSelection()
        return
      }

      const currentIndex = entries.findIndex((entry) => entry.path === selection.at(-1))

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex =
          currentIndex === -1
            ? delta > 0
              ? 0
              : entries.length - 1
            : Math.min(entries.length - 1, Math.max(0, currentIndex + delta))
        const next = entries[nextIndex]
        if (next) {
          select(next.path, event.shiftKey ? 'range' : 'replace', entries)
          virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
        }
        return
      }

      if (event.key === 'Enter' && currentIndex !== -1) {
        event.preventDefault()
        openResource(entries[currentIndex]!)
        return
      }

      if (event.key === 'F2' && config.features.rename && selection.length === 1) {
        const resource = entries.find((entry) => entry.path === selection[0])
        if (resource && !resource.readOnly) onRename(resource)
        return
      }

      if (event.key === 'Delete' && config.features.delete && selection.length > 0) {
        const selected = entries.filter((entry) => selectedSet.has(entry.path))
        if (selected.length > 0 && !selected.some((entry) => entry.readOnly)) onDelete(selected)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entries, selection, selectedSet, virtualizer])

  /* ------------------------------------------------------------ drops */

  const onDragOver = (event: React.DragEvent): void => {
    const internal = event.dataTransfer.types.includes('application/x-qsys-paths')
    const files = event.dataTransfer.types.includes('Files')
    if (internal || (files && config.features.upload)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = internal ? 'move' : 'copy'
      setDropActive(!internal)
    }
  }

  const onDrop = (event: React.DragEvent, folder?: MediaResource): void => {
    event.preventDefault()
    event.stopPropagation()
    setDropActive(false)

    const internal = event.dataTransfer.getData('application/x-qsys-paths')
    if (internal) {
      // Only a folder row is a valid internal drop target; dropping onto empty
      // space would mean "move into the folder you are already in".
      if (!folder || folder.type !== 'folder' || !config.features.move) return
      let sources: string[] = []
      try {
        sources = JSON.parse(internal) as string[]
      } catch {
        return
      }
      const moves = sources
        .filter((source) => !isWithin(folder.path, source) && source !== folder.path)
        .map((source) => ({
          from: source,
          to: `${folder.path}/${source.split('/').pop()!}`
        }))
      if (moves.length === 0) {
        notify('error', 'A folder cannot be moved inside itself.')
        return
      }
      move.mutate(moves)
      return
    }

    if (!config.features.upload) return
    const localPaths: string[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = api.pathForFile(file)
        if (path) localPaths.push(path)
      } catch {
        // A dragged item with no filesystem path (a browser selection, say) is
        // simply not something we can upload.
      }
    }
    if (localPaths.length === 0) {
      notify('error', 'Those items could not be read from disk.')
      return
    }
    upload.mutate(localPaths)
  }

  /* ------------------------------------------------------------ render */

  if (entries.length === 0) {
    return (
      <div
        className={clsx(
          'relative h-full',
          dropActive && 'bg-brand-subtle ring-1 ring-inset ring-brand'
        )}
        onDragOver={onDragOver}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => onDrop(event)}
        onContextMenu={(event) => {
          event.preventDefault()
          onContextMenu(null, { x: event.clientX, y: event.clientY })
        }}
      >
        <Placeholder
          icon={<Upload size={26} />}
          title="This folder is empty"
          detail={
            config.features.upload
              ? 'Drag audio files here, or use the Upload button, to add them to the Core.'
              : 'Nothing has been added to this folder yet.'
          }
        />
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()

  return (
    <div
      className={clsx(
        'flex h-full min-h-0 flex-col',
        dropActive && 'bg-brand-subtle ring-1 ring-inset ring-brand'
      )}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false)
      }}
      onDrop={(event) => onDrop(event)}
    >
      <ColumnHeader column={sortColumn} direction={sortDirection} onSort={setSort} />

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) clearSelection()
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault()
            onContextMenu(null, { x: event.clientX, y: event.clientY })
          }
        }}
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {items.map((item) => {
            const resource = entries[item.index]!
            return (
              <Row
                key={resource.path}
                resource={resource}
                selected={selectedSet.has(resource.path)}
                top={item.start}
                onOpen={() => openResource(resource)}
                onSelect={(mode) => select(resource.path, mode, entries)}
                onContextMenu={(at) => onContextMenu(resource, at)}
                onDropInto={(event) => onDrop(event, resource)}
                dragPaths={() =>
                  selectedSet.has(resource.path) ? selection : [resource.path]
                }
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- header */

function ColumnHeader({
  column,
  direction,
  onSort
}: {
  column: SortColumn
  direction: 'asc' | 'desc'
  onSort(column: SortColumn): void
}): ReactNode {
  const cell = (key: SortColumn, label: string, className: string): ReactNode => (
    <button
      type="button"
      className={clsx(
        'flex items-center gap-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide',
        column === key ? 'text-ink' : 'text-ink-faint hover:text-ink-muted',
        className
      )}
      onClick={() => onSort(key)}
      aria-sort={column === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {column === key ? (
        direction === 'asc' ? (
          <ArrowUp size={11} />
        ) : (
          <ArrowDown size={11} />
        )
      ) : null}
    </button>
  )

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-3">
      <span className="w-4 shrink-0" />
      {cell('name', 'Name', 'min-w-0 flex-1')}
      {cell('size', 'Size', 'w-24 shrink-0 justify-end')}
      {cell('updated', 'Modified', 'w-32 shrink-0 justify-end')}
    </div>
  )
}

/* ------------------------------------------------------------------ row */

interface RowProps {
  resource: MediaResource
  selected: boolean
  top: number
  onOpen(): void
  onSelect(mode: 'replace' | 'toggle' | 'range'): void
  onContextMenu(at: { x: number; y: number }): void
  onDropInto(event: React.DragEvent): void
  dragPaths(): string[]
}

function Row({
  resource,
  selected,
  top,
  onOpen,
  onSelect,
  onContextMenu,
  onDropInto,
  dragPaths
}: RowProps): ReactNode {
  const [dropTarget, setDropTarget] = useState(false)
  const playable = resource.type === 'file' && isAudioFile(resource.name)
  const isFolder = resource.type === 'folder'

  return (
    <div
      data-row={resource.path}
      data-row-name={resource.name}
      data-row-type={resource.type}
      className={clsx(
        'absolute inset-x-0 flex cursor-default items-center gap-3 px-3',
        selected ? 'bg-brand-subtle text-ink' : 'text-ink-muted hover:bg-surface-1',
        dropTarget && 'ring-1 ring-inset ring-brand'
      )}
      style={{ height: `${ROW_HEIGHT}px`, top: `${top}px` }}
      onMouseDown={(event) => {
        if (event.button === 2) {
          if (!selected) onSelect('replace')
          return
        }
        onSelect(event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'range' : 'replace')
      }}
      onDoubleClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onContextMenu({ x: event.clientX, y: event.clientY })
      }}
      draggable={!resource.readOnly && config.features.move}
      onDragStart={(event) => {
        const paths = dragPaths()
        event.dataTransfer.setData('application/x-qsys-paths', JSON.stringify(paths))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!isFolder || resource.readOnly) return
        if (!event.dataTransfer.types.includes('application/x-qsys-paths')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false)
        onDropInto(event)
      }}
    >
      <span className="w-4 shrink-0">
        {isFolder ? (
          <Folder size={15} className="text-brand" />
        ) : playable ? (
          <FileAudio size={15} className="text-accent" />
        ) : (
          <FileQuestion size={15} className="text-ink-faint" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={clsx('truncate text-[12.5px]', selected && 'font-medium')}>
          {resource.name}
        </span>
        {resource.readOnly ? (
          <Lock size={11} className="shrink-0 text-ink-faint" aria-label="Read-only" />
        ) : null}
        {playable && config.features.preview ? (
          <button
            type="button"
            className="ml-1 shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:bg-surface-3 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [div:hover>span>&]:opacity-100"
            title={`Play ${resource.name}`}
            aria-label={`Play ${resource.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
          >
            <Play size={11} />
          </button>
        ) : null}
      </span>

      <span className="w-24 shrink-0 text-right text-[12px] tabular-nums">
        {isFolder ? '—' : formatBytes(resource.size)}
      </span>
      <span className="w-32 shrink-0 text-right text-[12px] tabular-nums">
        {formatTimestamp(resource.updated)}
      </span>
    </div>
  )
}
