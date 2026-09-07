/**
 * Folder tree.
 *
 * The root node is the customer's configured folder and there is no way to
 * navigate above it - the tree simply has no parent to offer. Each expanded
 * node is its own query, so opening a branch costs one listing and closing it
 * costs nothing.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { clsx } from 'clsx'
import type { DirectoryListing, MediaResource } from '@shared/types'
import { isWithin } from '@shared/vpath'
import { api, config, invalidatePaths, keys } from '@/lib/api'
import { useUi } from '@/store'
import { Spinner } from './primitives'

export function FolderTree(): ReactNode {
  const cwd = useUi((s) => s.cwd)

  return (
    <nav
      aria-label="Folders"
      className="flex h-full flex-col overflow-y-auto overflow-x-hidden py-1.5"
    >
      <TreeNode
        path="/"
        name={config.rootLabel}
        depth={0}
        readOnly={false}
        selected={cwd === '/'}
      />
    </nav>
  )
}

interface TreeNodeProps {
  path: string
  name: string
  depth: number
  readOnly: boolean
  selected: boolean
}

function TreeNode({ path, name, depth, readOnly }: TreeNodeProps): ReactNode {
  const cwd = useUi((s) => s.cwd)
  const expanded = useUi((s) => s.expanded.has(path))
  const toggleExpanded = useUi((s) => s.toggleExpanded)
  const navigate = useUi((s) => s.navigate)
  const notify = useUi((s) => s.notify)
  const client = useQueryClient()
  const [dropTarget, setDropTarget] = useState(false)

  const isCurrent = cwd === path

  const children = useQuery({
    queryKey: keys.dir(path),
    queryFn: () => api.list(path),
    enabled: expanded,
    staleTime: 15_000
  })

  const folders = (children.data as DirectoryListing | undefined)?.entries.filter(
    (entry) => entry.type === 'folder'
  )

  /** Accept a drag of remote resources to move them into this folder. */
  const canAcceptMove = config.features.move && !readOnly

  const onDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropTarget(false)
    if (!canAcceptMove) return

    const payload = event.dataTransfer.getData('application/x-qsys-paths')
    if (!payload) return

    let sources: string[]
    try {
      sources = JSON.parse(payload) as string[]
    } catch {
      return
    }

    // Dropping a folder into itself or its own descendant would orphan it.
    const moves = sources
      .filter((source) => !isWithin(path, source))
      .map((source) => ({
        from: source,
        to: `${path === '/' ? '' : path}/${source.split('/').pop()!}`
      }))

    if (moves.length === 0) {
      notify('error', 'A folder cannot be moved inside itself.')
      return
    }

    try {
      await api.move(moves)
      invalidatePaths(client, [path, ...moves.map((m) => m.from)])
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'The move failed.')
    }
  }

  return (
    <div>
      <div
        data-tree={path}
        className={clsx(
          'group flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-[12.5px]',
          isCurrent ? 'bg-brand-subtle text-ink' : 'text-ink-muted hover:bg-surface-2',
          dropTarget && 'ring-1 ring-brand'
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => navigate(path)}
        onDragOver={(event) => {
          if (!canAcceptMove || !event.dataTransfer.types.includes('application/x-qsys-paths')) {
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget(true)
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => void onDrop(event)}
      >
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation()
            toggleExpanded(path)
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        {expanded ? (
          <FolderOpen size={14} className="shrink-0 text-brand" />
        ) : (
          <Folder size={14} className="shrink-0 text-ink-faint" />
        )}

        <span className="truncate">{name}</span>
        {readOnly ? (
          <Lock size={11} className="shrink-0 text-ink-faint" aria-label="Read-only folder" />
        ) : null}
        {expanded && children.isFetching && !children.data ? (
          <Spinner className="ml-auto h-3 w-3 text-ink-faint" />
        ) : null}
      </div>

      {expanded ? (
        <div>
          {children.isError ? (
            <p
              className="py-1 text-[11.5px] text-danger"
              style={{ paddingLeft: `${depth * 12 + 28}px` }}
            >
              Could not read this folder
            </p>
          ) : null}
          {folders?.map((folder: MediaResource) => (
            <TreeNode
              key={folder.path}
              path={folder.path}
              name={folder.name}
              depth={depth + 1}
              readOnly={folder.readOnly}
              selected={cwd === folder.path}
            />
          ))}
          {folders?.length === 0 && !children.isFetching ? (
            <p
              className="py-1 text-[11.5px] text-ink-faint"
              style={{ paddingLeft: `${depth * 12 + 28}px` }}
            >
              No subfolders
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
