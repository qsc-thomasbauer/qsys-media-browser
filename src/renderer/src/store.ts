/**
 * UI state.
 *
 * Deliberately narrow: anything that comes from the Core lives in React Query,
 * and this store holds only what the user is doing right now - where they are,
 * what they have selected, how the list is sorted, which panels are open. That
 * split means a refetch never clobbers a selection, and a selection change
 * never triggers a request.
 */
import { create } from 'zustand'
import type { MediaResource } from '@shared/types'
import { normalizeVirtual, parentVirtual } from '@shared/vpath'

export type SortColumn = 'name' | 'size' | 'updated'
export type SortDirection = 'asc' | 'desc'

export interface NowPlaying {
  path: string
  name: string
}

interface UiState {
  /** Current directory, as a virtual path. */
  cwd: string
  /** Selected virtual paths, in click order. */
  selection: string[]
  /** Anchor for shift-click range selection. */
  anchor: string | null
  sortColumn: SortColumn
  sortDirection: SortDirection
  expanded: Set<string>
  showTransfers: boolean
  showPlaylists: boolean
  nowPlaying: NowPlaying | null
  /** Transient error banner text, set by mutation handlers. */
  toast: { kind: 'error' | 'info'; message: string } | null

  navigate(path: string): void
  goUp(): void

  select(path: string, mode?: 'replace' | 'toggle' | 'range', visible?: MediaResource[]): void
  selectAll(visible: MediaResource[]): void
  clearSelection(): void
  /** Drop selected paths that no longer exist in the current listing. */
  pruneSelection(visible: MediaResource[]): void

  setSort(column: SortColumn): void
  toggleExpanded(path: string): void
  setExpanded(path: string, open: boolean): void

  setShowTransfers(open: boolean): void
  setShowPlaylists(open: boolean): void
  play(track: NowPlaying | null): void
  notify(kind: 'error' | 'info', message: string): void
  dismissToast(): void
}

export const useUi = create<UiState>((set, get) => ({
  cwd: '/',
  selection: [],
  anchor: null,
  sortColumn: 'name',
  sortDirection: 'asc',
  expanded: new Set<string>(['/']),
  showTransfers: false,
  showPlaylists: false,
  nowPlaying: null,
  toast: null,

  navigate: (path) => {
    const target = normalizeVirtual(path)
    if (target === get().cwd) return
    // Selection is per-directory; carrying it across would let a later action
    // apply to files the user can no longer see.
    set({ cwd: target, selection: [], anchor: null })
    // Reveal the new location in the tree.
    const expanded = new Set(get().expanded)
    let walk = target
    while (walk !== '/') {
      expanded.add(walk)
      walk = parentVirtual(walk)
    }
    set({ expanded })
  },

  goUp: () => {
    const { cwd, navigate } = get()
    if (cwd !== '/') navigate(parentVirtual(cwd))
  },

  select: (path, mode = 'replace', visible = []) => {
    const { selection, anchor } = get()

    if (mode === 'toggle') {
      const next = selection.includes(path)
        ? selection.filter((p) => p !== path)
        : [...selection, path]
      set({ selection: next, anchor: path })
      return
    }

    if (mode === 'range' && anchor) {
      const paths = visible.map((r) => r.path)
      const from = paths.indexOf(anchor)
      const to = paths.indexOf(path)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        set({ selection: paths.slice(lo, hi + 1) })
        return
      }
    }

    set({ selection: [path], anchor: path })
  },

  selectAll: (visible) => set({ selection: visible.map((r) => r.path) }),
  clearSelection: () => set({ selection: [], anchor: null }),

  pruneSelection: (visible) => {
    const present = new Set(visible.map((r) => r.path))
    const { selection } = get()
    const next = selection.filter((p) => present.has(p))
    if (next.length !== selection.length) set({ selection: next })
  },

  setSort: (column) =>
    set((state) => ({
      sortColumn: column,
      sortDirection:
        state.sortColumn === column && state.sortDirection === 'asc' ? 'desc' : 'asc'
    })),

  toggleExpanded: (path) =>
    set((state) => {
      const expanded = new Set(state.expanded)
      if (expanded.has(path)) expanded.delete(path)
      else expanded.add(path)
      return { expanded }
    }),

  setExpanded: (path, open) =>
    set((state) => {
      const expanded = new Set(state.expanded)
      if (open) expanded.add(path)
      else expanded.delete(path)
      return { expanded }
    }),

  setShowTransfers: (open) => set({ showTransfers: open }),
  setShowPlaylists: (open) => set({ showPlaylists: open }),
  play: (track) => set({ nowPlaying: track }),
  notify: (kind, message) => set({ toast: { kind, message } }),
  dismissToast: () => set({ toast: null })
}))

/** Apply the current sort to a listing. Folders always lead. */
export function sortResources(
  entries: MediaResource[],
  column: SortColumn,
  direction: SortDirection
): MediaResource[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    switch (column) {
      case 'size':
        return sign * ((a.size ?? 0) - (b.size ?? 0))
      case 'updated':
        return sign * (a.updated - b.updated)
      default:
        return (
          sign * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        )
    }
  })
}
