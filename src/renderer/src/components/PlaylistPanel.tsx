/**
 * Playlist panel.
 *
 * Reordering sends the whole track list back (the API's `PUT` replaces it), and
 * tracks that live outside this build's folder are shown greyed and unplayable
 * but are still carried through every reorder - dropping them would delete
 * someone else's work. Tracks the Core can no longer find are flagged as
 * missing rather than silently listed as normal.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, ChevronDown, GripVertical, ListMusic, Plus, Trash2, X
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { clsx } from 'clsx'
import type { MediaResource, PlaylistTrack } from '@shared/types'
import { isAudioFile } from '@shared/media-types'
import { api, keys } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { useUi } from '@/store'
import { Button, IconButton, Input, Placeholder, Spinner } from './primitives'

export function PlaylistPanel({ entries }: { entries: MediaResource[] }): ReactNode {
  const setShowPlaylists = useUi((s) => s.setShowPlaylists)
  const selection = useUi((s) => s.selection)
  const notify = useUi((s) => s.notify)
  const client = useQueryClient()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')

  const playlists = useQuery({ queryKey: keys.playlists, queryFn: () => api.playlists() })

  const detail = useQuery({
    queryKey: keys.playlist(activeId ?? ''),
    queryFn: () => api.playlist(activeId!),
    enabled: activeId !== null
  })

  const refreshAll = (): void => {
    void client.invalidateQueries({ queryKey: keys.playlists })
    if (activeId) void client.invalidateQueries({ queryKey: keys.playlist(activeId) })
  }

  const fail = (err: Error): void => notify('error', err.message)

  const create = useMutation({
    mutationFn: (name: string) => api.createPlaylist(name),
    onSuccess: (playlist) => {
      setNewName('')
      setActiveId(playlist.id)
      refreshAll()
    },
    onError: fail
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.removePlaylist(id),
    onSuccess: () => {
      setActiveId(null)
      refreshAll()
    },
    onError: fail
  })

  const addTracks = useMutation({
    mutationFn: (paths: string[]) => api.addPlaylistTracks(activeId!, paths),
    onSuccess: refreshAll,
    onError: fail
  })

  const setTracks = useMutation({
    mutationFn: (keysInOrder: string[]) => api.setPlaylistTracks(activeId!, keysInOrder),
    onSuccess: refreshAll,
    onError: fail
  })

  /** Selected audio files in the current folder, which can be appended. */
  const addable = entries.filter(
    (entry) =>
      entry.type === 'file' && selection.includes(entry.path) && isAudioFile(entry.name)
  )

  const tracks = detail.data?.media ?? []

  const reorder = (from: number, to: number): void => {
    if (from === to) return
    const next = [...tracks]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    setTracks.mutate(next.map((track) => track.corePath))
  }

  return (
    <aside
      aria-label="Playlists"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-surface-1"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <ListMusic size={14} className="text-brand" />
        <h2 className="text-[12.5px] font-semibold text-ink">Playlists</h2>
        <div className="flex-1" />
        <IconButton
          icon={<X size={14} />}
          title="Hide playlists"
          aria-label="Hide playlists"
          onClick={() => setShowPlaylists(false)}
        />
      </div>

      {/* Create */}
      <form
        className="flex shrink-0 gap-1.5 border-b border-line p-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (newName.trim()) create.mutate(newName.trim())
        }}
      >
        <Input
          value={newName}
          placeholder="New playlist name"
          aria-label="New playlist name"
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          icon={<Plus size={13} />}
          disabled={!newName.trim() || create.isPending}
        >
          Add
        </Button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {playlists.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-4 w-4 text-ink-faint" />
          </div>
        ) : playlists.isError ? (
          <Placeholder
            title="Playlists unavailable"
            detail={playlists.error instanceof Error ? playlists.error.message : undefined}
          />
        ) : playlists.data?.length === 0 ? (
          <p className="px-3 py-4 text-[12px] text-ink-faint">
            No playlists on this Core yet.
          </p>
        ) : (
          <ul>
            {playlists.data?.map((playlist) => {
              const open = activeId === playlist.id
              return (
                <li key={playlist.id} className="border-b border-line/60">
                  <div
                    className={clsx(
                      'flex cursor-default items-center gap-1.5 px-2 py-1.5',
                      open ? 'bg-brand-subtle' : 'hover:bg-surface-2'
                    )}
                    onClick={() => setActiveId(open ? null : playlist.id)}
                  >
                    <ChevronDown
                      size={13}
                      className={clsx(
                        'shrink-0 text-ink-faint transition-transform',
                        !open && '-rotate-90'
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                      {playlist.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                      {playlist.count}
                    </span>
                    <IconButton
                      icon={<Trash2 size={13} />}
                      title="Delete playlist"
                      aria-label={`Delete playlist ${playlist.name}`}
                      className="hover:!bg-danger-subtle hover:!text-danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        remove.mutate(playlist.id)
                      }}
                    />
                  </div>

                  {open ? (
                    <div className="bg-surface-0/40 px-2 pb-2">
                      {detail.isPending ? (
                        <div className="flex justify-center py-3">
                          <Spinner className="h-4 w-4 text-ink-faint" />
                        </div>
                      ) : (
                        <>
                          <ol className="py-1">
                            {tracks.map((track, index) => (
                              <TrackRow
                                key={`${track.corePath}:${index}`}
                                track={track}
                                index={index}
                                onReorder={reorder}
                                onRemove={() =>
                                  setTracks.mutate(
                                    tracks
                                      .filter((_, at) => at !== index)
                                      .map((entry) => entry.corePath)
                                  )
                                }
                              />
                            ))}
                          </ol>

                          {tracks.length === 0 ? (
                            <p className="py-2 text-[11.5px] text-ink-faint">
                              This playlist is empty.
                            </p>
                          ) : null}

                          <Button
                            className="mt-1 w-full justify-center"
                            icon={<Plus size={13} />}
                            disabled={addable.length === 0 || addTracks.isPending}
                            title={
                              addable.length === 0
                                ? 'Select audio files in the list to add them'
                                : undefined
                            }
                            onClick={() =>
                              addTracks.mutate(addable.map((entry) => entry.path))
                            }
                          >
                            {addable.length === 0
                              ? 'Select files to add'
                              : `Add ${addable.length} selected`}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}

function TrackRow({
  track,
  index,
  onReorder,
  onRemove
}: {
  track: PlaylistTrack
  index: number
  onReorder(from: number, to: number): void
  onRemove(): void
}): ReactNode {
  const play = useUi((s) => s.play)
  const [over, setOver] = useState(false)

  const playable = !track.external && track.available && isAudioFile(track.name)

  return (
    <li
      className={clsx(
        'group flex items-center gap-1.5 rounded px-1 py-1 text-[12px]',
        over && 'ring-1 ring-brand',
        track.available ? 'text-ink-muted hover:bg-surface-2' : 'text-ink-faint'
      )}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-qsys-track-index', String(index))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-qsys-track-index')) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const from = Number(event.dataTransfer.getData('application/x-qsys-track-index'))
        if (Number.isInteger(from)) onReorder(from, index)
      }}
    >
      <GripVertical size={12} className="shrink-0 cursor-grab text-ink-faint" />
      <span className="w-4 shrink-0 text-right text-[10.5px] tabular-nums text-ink-faint">
        {index + 1}
      </span>

      <button
        type="button"
        className={clsx('min-w-0 flex-1 truncate text-left', playable && 'hover:text-ink')}
        disabled={!playable}
        title={
          track.external
            ? 'This track is outside this app’s folder'
            : !track.available
              ? 'The Core can no longer find this file'
              : track.name
        }
        onClick={() => {
          if (playable && track.path) play({ path: track.path, name: track.name })
        }}
      >
        {track.name}
      </button>

      {!track.available ? (
        <AlertCircle size={12} className="shrink-0 text-danger" aria-label="File missing" />
      ) : track.external ? (
        <span className="shrink-0 rounded bg-surface-3 px-1 text-[9.5px] uppercase tracking-wide">
          external
        </span>
      ) : (
        <span className="shrink-0 text-[10.5px] tabular-nums">{formatBytes(track.size)}</span>
      )}

      <IconButton
        icon={<X size={12} />}
        className="!h-5 !w-5 opacity-0 group-hover:opacity-100"
        title="Remove from playlist"
        aria-label={`Remove ${track.name} from playlist`}
        onClick={onRemove}
      />
    </li>
  )
}
