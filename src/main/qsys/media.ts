/**
 * Media resource operations.
 *
 * Every function here takes and returns *virtual* paths; the jail is the only
 * thing that knows the customer's real root. Nothing in this module accepts a
 * Core path from outside, so there is no way to address a resource the build is
 * not permitted to see.
 */
import { CORE_RESERVED_FOLDERS } from '@shared/ipc'
import type { MoveRequest, RenameRequest } from '@shared/ipc'
import type { DirectoryListing, MediaResource, ResourceType } from '@shared/types'
import {
  assertValidName,
  baseVirtual,
  joinVirtual,
  parentVirtual,
  splitExtension,
  splitVirtual
} from '@shared/vpath'
import { jail } from '../config'
import { QsysError, headRequest, jsonRequest, voidRequest } from './client'

const MEDIA = '/cores/self/media'

/** Build the request path for a virtual path, percent-encoding each segment. */
function endpoint(virtualPath: string): string {
  const encoded = jail.toEncodedCore(virtualPath)
  return encoded.length === 0 ? MEDIA : `${MEDIA}/${encoded}`
}

/** Shape the Core returns for a file or folder. */
interface ApiResource {
  name: string
  path: string
  type: string
  ext?: string | null
  size?: number | null
  created?: number
  updated?: number
}

/**
 * The Core's built-in folders reject modification. Only the folders themselves
 * are protected - uploading *into* `Audio` is normal - so this is a depth-one
 * check on the real Core path, not a prefix match.
 */
function isReservedFolder(corePath: string): boolean {
  const segments = corePath.split('/').filter(Boolean)
  return (
    segments.length === 1 &&
    (CORE_RESERVED_FOLDERS as readonly string[]).includes(segments[0]!)
  )
}

function toResource(api: ApiResource): MediaResource | null {
  // The API is inconsistent about leading slashes (`/Audio` for top-level
  // folders, `Audio/file.mp3` for files), so normalise before anything else.
  const corePath = String(api.path ?? '').replace(/^\/+/, '')
  const virtualPath = jail.tryToVirtual(corePath)
  if (virtualPath === null) return null

  const type: ResourceType = api.type === 'folder' ? 'folder' : 'file'
  return {
    // The API splits a file's extension out of `name` ("example file" + "mp3"),
    // so the last path segment is the only complete filename it gives us.
    // Normalising here means no consumer has to reassemble it.
    name: baseVirtual(virtualPath) || (api.name ?? ''),
    path: virtualPath,
    type,
    ext: api.ext ?? null,
    size: typeof api.size === 'number' ? api.size : null,
    created: api.created ?? 0,
    updated: api.updated ?? 0,
    readOnly: type === 'folder' && isReservedFolder(corePath)
  }
}

/** Folders first, then files, each by name - a sensible default the UI can re-sort. */
function byTypeThenName(a: MediaResource, b: MediaResource): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export async function list(virtualDir: string): Promise<DirectoryListing> {
  const response = await jsonRequest<ApiResource[] | ApiResource>({
    method: 'GET',
    path: endpoint(virtualDir)
  })

  const raw = Array.isArray(response) ? response : response ? [response] : []
  const entries = raw
    .map(toResource)
    .filter((r): r is MediaResource => r !== null)
    .sort(byTypeThenName)

  return { path: splitVirtual(virtualDir).length ? virtualDir : '/', entries }
}

export async function stat(virtualPath: string): Promise<MediaResource> {
  if (splitVirtual(virtualPath).length === 0) {
    throw new QsysError('INVALID_PATH', 'The top-level folder has no metadata of its own.')
  }
  const response = await jsonRequest<ApiResource>({ method: 'GET', path: endpoint(virtualPath) })
  const resource = toResource(response)
  if (!resource) {
    throw new QsysError('NOT_FOUND', 'That file or folder is outside this app’s folder.')
  }
  return resource
}

export async function exists(virtualPath: string): Promise<boolean> {
  return headRequest(endpoint(virtualPath))
}

export async function mkdir(virtualParentDir: string, rawName: string): Promise<MediaResource> {
  const name = assertValidName(rawName)
  // No writability check on the parent: adding content inside the Core's
  // built-in folders is the normal workflow, and only the folders themselves
  // are protected. If a given firmware disagrees, its error is clearer than a
  // guess made here.

  const response = await jsonRequest<ApiResource | ApiResource[]>({
    method: 'POST',
    path: endpoint(virtualParentDir),
    body: JSON.stringify({ name })
  })

  const created = Array.isArray(response) ? response[0] : response
  const resource = created ? toResource(created) : null
  // Some firmware revisions answer with an empty body; fall back to a stat so
  // callers always get real metadata back.
  return resource ?? stat(joinVirtual(virtualParentDir, name))
}

/**
 * Rename a file or folder.
 *
 * The Core's `PATCH` takes the **stem**, not the full filename, and re-appends
 * the resource's existing extension itself - so sending `image.jpeg` for a file
 * already called `image.jpeg` yields `image.jpeg.jpeg`. This strips a trailing
 * extension that matches the current one before sending, so callers may pass
 * either form and get the same, correct result.
 *
 * A consequence worth knowing: the extension cannot be changed through this
 * endpoint. The Core keeps the original regardless of what is sent, so the
 * rename dialog presents it as a fixed suffix rather than pretending otherwise.
 */
export async function rename(req: RenameRequest): Promise<MediaResource> {
  assertWritable(req.path, 'rename')

  const currentExt = splitExtension(baseVirtual(req.path)).ext
  let name = assertValidName(req.name)

  if (currentExt.length > 0) {
    const suffix = `.${currentExt}`
    if (name.length > suffix.length && name.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = name.slice(0, -suffix.length)
    }
  }
  // Re-validate: stripping the extension must not have left an empty name.
  name = assertValidName(name)

  const response = await jsonRequest<ApiResource | ApiResource[]>({
    method: 'PATCH',
    path: endpoint(req.path),
    body: JSON.stringify({ name })
  })

  const updated = Array.isArray(response) ? response[0] : response
  const resource = updated ? toResource(updated) : null
  if (resource) return resource

  // Empty response: reconstruct the path the Core will have produced.
  const finalName = currentExt.length > 0 ? `${name}.${currentExt}` : name
  return stat(joinVirtual(parentVirtual(req.path), finalName))
}

/**
 * Move resources one request at a time.
 *
 * The API does offer a bulk `PUT /media` form, but its body shape
 * (`[{"src": {"path": "dst"}}]`) makes per-item failures impossible to attribute,
 * and a partial bulk move is exactly the case a user needs a clear error for.
 */
export async function move(requests: MoveRequest[]): Promise<MediaResource[]> {
  const moved: MediaResource[] = []
  for (const req of requests) {
    assertWritable(req.from, 'move')
    // Validate the destination through the jail before it goes anywhere near a body.
    const destination = jail.toCore(req.to)

    const response = await jsonRequest<ApiResource | ApiResource[]>({
      method: 'PUT',
      path: endpoint(req.from),
      body: JSON.stringify({ path: destination })
    })

    const updated = Array.isArray(response) ? response[0] : response
    const resource = updated ? toResource(updated) : null
    moved.push(resource ?? (await stat(req.to)))
  }
  return moved
}

export async function remove(virtualPaths: string[]): Promise<void> {
  if (virtualPaths.length === 0) return
  for (const path of virtualPaths) assertWritable(path, 'delete')

  if (virtualPaths.length === 1) {
    await voidRequest({ method: 'DELETE', path: endpoint(virtualPaths[0]!) })
    return
  }

  // Bulk delete takes raw Core paths in the body - percent-encoding applies to
  // the endpoint path only.
  await voidRequest({
    method: 'DELETE',
    path: MEDIA,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(virtualPaths.map((p) => jail.toCore(p)))
  })
}

/**
 * Refuse operations the Core would reject anyway, with a message that explains
 * why. Enforced here rather than only in the UI so scripted IPC calls hit it too.
 */
function assertWritable(virtualPath: string, action: string): void {
  const core = jail.toCore(virtualPath)
  if (core.length === 0) {
    throw new QsysError('READ_ONLY', `You cannot ${action} the top-level folder.`)
  }
  if (isReservedFolder(core)) {
    throw new QsysError(
      'READ_ONLY',
      `"${core}" is one of the Core's built-in folders and cannot be changed. You can still add files inside it.`
    )
  }
}
