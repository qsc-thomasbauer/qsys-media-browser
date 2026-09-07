/**
 * Media playlist operations.
 *
 * One wrinkle drives the shape of this module: playlists are Core-wide, so a
 * playlist a customer build can see may contain tracks that live *outside* that
 * build's jail (added from Core Manager, or by an admin build). Reordering and
 * renaming both go through `PUT /{id}`, which replaces the entire track list -
 * so if this module only knew about jail-visible tracks, every reorder would
 * silently delete the rest.
 *
 * Tracks are therefore identified by their real Core path, and those outside
 * the jail are surfaced as `external` with no virtual path: the UI can show and
 * reorder them but cannot play, download or navigate to them. Adding a track
 * still requires a jail-visible path, and `assertKnownTracks` makes sure a
 * reorder can only reference paths the playlist already contains - so the Core
 * path being visible buys no ability to pull in arbitrary files.
 */
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack } from '@shared/types'
import { jail } from '../config'
import { QsysError, jsonRequest, voidRequest } from './client'

const PLAYLISTS = '/cores/self/media_playlists'

interface ApiPlaylist {
  id: string
  name: string
  count?: number
}

interface ApiTrack {
  id?: string
  name?: string
  path: string
  ext?: string | null
  size?: number | null
  type?: string
  available?: boolean
}

interface ApiPlaylistDetail extends ApiPlaylist {
  media?: ApiTrack[]
}

function encodeId(id: string): string {
  return encodeURIComponent(id)
}

function toSummary(api: ApiPlaylist): PlaylistSummary {
  return { id: String(api.id), name: api.name ?? '', count: api.count ?? 0 }
}

function toTrack(api: ApiTrack): PlaylistTrack {
  const corePath = String(api.path ?? '').replace(/^\/+/, '')
  const virtualPath = jail.tryToVirtual(corePath)
  return {
    id: String(api.id ?? corePath),
    // As with media resources, the API strips the extension out of `name`;
    // the path's last segment is the complete filename.
    name: corePath.split('/').pop() ?? api.name ?? corePath,
    path: virtualPath,
    corePath,
    ext: api.ext ?? null,
    size: typeof api.size === 'number' ? api.size : null,
    available: api.available !== false,
    external: virtualPath === null
  }
}

function toDetail(api: ApiPlaylistDetail): PlaylistDetail {
  return {
    ...toSummary(api),
    media: (api.media ?? []).map(toTrack)
  }
}

export async function list(): Promise<PlaylistSummary[]> {
  const response = await jsonRequest<ApiPlaylist[]>({ method: 'GET', path: PLAYLISTS })
  return (response ?? []).map(toSummary)
}

export async function get(id: string): Promise<PlaylistDetail> {
  const response = await jsonRequest<ApiPlaylistDetail>({
    method: 'GET',
    path: `${PLAYLISTS}/${encodeId(id)}`
  })
  return toDetail(response)
}

export async function create(name: string): Promise<PlaylistSummary> {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new QsysError('INVALID_NAME', 'A playlist needs a name.')

  const response = await jsonRequest<ApiPlaylist>({
    method: 'POST',
    path: PLAYLISTS,
    body: JSON.stringify({ name: trimmed })
  })
  return toSummary(response)
}

export async function remove(id: string): Promise<void> {
  await voidRequest({ method: 'DELETE', path: `${PLAYLISTS}/${encodeId(id)}` })
}

/**
 * `PUT /{id}` replaces name *and* tracks, so a rename has to resend the
 * existing track list or the playlist would come back empty.
 */
export async function rename(id: string, name: string): Promise<PlaylistDetail> {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new QsysError('INVALID_NAME', 'A playlist needs a name.')

  const current = await get(id)
  return replace(id, trimmed, current.media.map((t) => t.corePath))
}

/**
 * Reorder or trim a playlist.
 *
 * `trackKeys` are Core paths, ordered. Every key must already be in the
 * playlist or resolve inside the jail - so this cannot be used to attach a file
 * the build is not allowed to see.
 */
export async function setTracks(id: string, trackKeys: string[]): Promise<PlaylistDetail> {
  const current = await get(id)
  assertKnownTracks(current, trackKeys)
  return replace(id, current.name, trackKeys)
}

export async function addTracks(id: string, virtualPaths: string[]): Promise<PlaylistDetail> {
  if (virtualPaths.length === 0) return get(id)

  // Every addition must be inside the jail; `toCore` throws otherwise.
  const body = virtualPaths.map((path) => ({ path: jail.toCore(path) }))
  const response = await jsonRequest<ApiPlaylistDetail>({
    method: 'POST',
    path: `${PLAYLISTS}/${encodeId(id)}/media`,
    body: JSON.stringify(body.length === 1 ? body[0] : body)
  })
  // Some firmware answers with the playlist, some with just the added tracks.
  return response?.media && response.id ? toDetail(response) : get(id)
}

export async function removeTrack(id: string, trackKey: string): Promise<void> {
  const current = await get(id)
  assertKnownTracks(current, [trackKey])

  const encodedPath = trackKey.split('/').map(encodeURIComponent).join('/')
  await voidRequest({
    method: 'DELETE',
    path: `${PLAYLISTS}/${encodeId(id)}/media/${encodedPath}`
  })
}

async function replace(id: string, name: string, corePaths: string[]): Promise<PlaylistDetail> {
  const response = await jsonRequest<ApiPlaylistDetail>({
    method: 'PUT',
    path: `${PLAYLISTS}/${encodeId(id)}`,
    body: JSON.stringify({ name, media: corePaths.map((path) => ({ path })) })
  })
  return response?.id ? toDetail(response) : get(id)
}

/**
 * A track key is acceptable if the playlist already contains it, or if it
 * resolves inside this build's jail.
 */
function assertKnownTracks(playlist: PlaylistDetail, trackKeys: string[]): void {
  const known = new Set(playlist.media.map((t) => t.corePath))
  for (const key of trackKeys) {
    if (known.has(key)) continue
    if (jail.contains(key)) continue
    throw new QsysError(
      'FORBIDDEN',
      'That track is not in this playlist and is outside this app’s folder.'
    )
  }
}
