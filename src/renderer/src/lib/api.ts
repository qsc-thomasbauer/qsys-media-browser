/**
 * Renderer-side access to the bridge, plus the React Query key scheme.
 *
 * `window.qsys` is the whole of the renderer's capability. Wrapping it here
 * keeps `window` out of components and gives one place to define how cache
 * invalidation maps onto the operations that mutate the Core.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { QsysApi } from '@shared/ipc'
import { parentVirtual } from '@shared/vpath'

export const api: QsysApi = window.qsys

/** The non-secret customer config, stamped into this bundle at build time. */
export const config = __CUSTOMER__

export const keys = {
  status: ['status'] as const,
  dir: (path: string) => ['dir', path] as const,
  playlists: ['playlists'] as const,
  playlist: (id: string) => ['playlist', id] as const
}

/**
 * Refresh the directories a mutation could have changed.
 *
 * Both the folder itself and its parent are invalidated: a rename changes the
 * parent's listing, a delete changes the parent's, and a move changes two
 * parents. Over-invalidating a listing is cheap; showing a stale one is not.
 */
export function invalidatePaths(client: QueryClient, paths: string[]): void {
  const dirs = new Set<string>()
  for (const path of paths) {
    dirs.add(path)
    dirs.add(parentVirtual(path))
  }
  for (const dir of dirs) {
    void client.invalidateQueries({ queryKey: keys.dir(dir) })
  }
}
