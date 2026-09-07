/**
 * Modal flows: create folder, rename, delete confirmation.
 *
 * The overwrite check on upload lives here too. The Core replaces an existing
 * file silently, so the only chance to warn someone is before the request goes
 * out - which is why upload asks first rather than reporting afterwards.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { MediaResource } from '@shared/types'
import { splitExtension } from '@shared/vpath'
import { api, invalidatePaths } from '@/lib/api'
import { useUi } from '@/store'
import { Button, Dialog, Input } from './primitives'

/* ------------------------------------------------------- create folder */

export function CreateFolderDialog({
  parent,
  onClose
}: {
  parent: string
  onClose(): void
}): ReactNode {
  const [name, setName] = useState('')
  const client = useQueryClient()
  const notify = useUi((s) => s.notify)

  const create = useMutation({
    mutationFn: () => api.mkdir(parent, name.trim()),
    onSuccess: () => {
      invalidatePaths(client, [parent])
      onClose()
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const valid = name.trim().length > 0 && !/[/\\]/.test(name)

  return (
    <Dialog
      title="New folder"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) create.mutate()
        }}
      >
        <label className="mb-1.5 block text-[12px] text-ink-muted" htmlFor="folder-name">
          Folder name
        </label>
        <Input
          id="folder-name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        {name && !valid ? (
          <p className="mt-1.5 text-[11.5px] text-danger">
            A folder name cannot contain slashes.
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}

/* -------------------------------------------------------------- rename */

export function RenameDialog({
  resource,
  onClose
}: {
  resource: MediaResource
  onClose(): void
}): ReactNode {
  // The Core's rename endpoint takes the stem and re-appends the extension
  // itself, and gives no way to change it. So the field edits the stem only and
  // the extension sits beside it as a fixed suffix - which also makes
  // `image.jpeg` -> `image.jpeg.jpeg` impossible to type by accident.
  const { stem, ext } = splitExtension(resource.name)
  const [name, setName] = useState(stem)
  const client = useQueryClient()
  const notify = useUi((s) => s.notify)

  const rename = useMutation({
    mutationFn: () => api.rename({ path: resource.path, name: name.trim() }),
    onSuccess: (updated) => {
      invalidatePaths(client, [resource.path, updated.path])
      onClose()
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const trimmed = name.trim()
  const valid = trimmed.length > 0 && !/[/\\]/.test(trimmed) && trimmed !== stem
  const finalName = ext ? `${trimmed}.${ext}` : trimmed

  return (
    <Dialog
      title={`Rename ${resource.type}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || rename.isPending}
            onClick={() => rename.mutate()}
          >
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) rename.mutate()
        }}
      >
        <label className="mb-1.5 block text-[12px] text-ink-muted" htmlFor="new-name">
          New name
        </label>

        <div className="flex items-center gap-1.5">
          <Input
            id="new-name"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
          {ext ? (
            <span
              className="shrink-0 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[13px] text-ink-muted"
              aria-label={`File extension .${ext}, which cannot be changed`}
            >
              .{ext}
            </span>
          ) : null}
        </div>

        {ext ? (
          <p className="mt-1.5 text-[11.5px] text-ink-faint">
            Renames to <span className="select-text text-ink-muted">{finalName}</span>. The Core
            keeps the file extension, so it cannot be changed here.
          </p>
        ) : null}
        {name && !valid && trimmed.length > 0 && trimmed !== stem ? (
          <p className="mt-1.5 text-[11.5px] text-danger">A name cannot contain slashes.</p>
        ) : null}
      </form>
    </Dialog>
  )
}

/* -------------------------------------------------------------- delete */

export function DeleteDialog({
  resources,
  onClose
}: {
  resources: MediaResource[]
  onClose(): void
}): ReactNode {
  const client = useQueryClient()
  const notify = useUi((s) => s.notify)
  const clearSelection = useUi((s) => s.clearSelection)

  const remove = useMutation({
    mutationFn: () => api.remove(resources.map((resource) => resource.path)),
    onSuccess: () => {
      invalidatePaths(client, resources.map((resource) => resource.path))
      clearSelection()
      onClose()
    },
    onError: (err: Error) => notify('error', err.message)
  })

  const folders = resources.filter((resource) => resource.type === 'folder')
  const single = resources.length === 1 ? resources[0] : null

  return (
    <Dialog
      title={single ? `Delete ${single.type}` : `Delete ${resources.length} items`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-[13px] text-ink">
            {single ? (
              <>
                Delete <span className="select-text font-medium">{single.name}</span> from the
                Core?
              </>
            ) : (
              <>Delete these {resources.length} items from the Core?</>
            )}
          </p>

          {folders.length > 0 ? (
            <p className="mt-1.5 text-[12px] text-ink-muted">
              {folders.length === 1
                ? 'Everything inside that folder is deleted too.'
                : `Everything inside those ${folders.length} folders is deleted too.`}
            </p>
          ) : null}

          <p className="mt-1.5 text-[12px] text-ink-muted">This cannot be undone.</p>

          {resources.length > 1 ? (
            <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-line bg-surface-0 p-2 text-[11.5px] text-ink-muted">
              {resources.map((resource) => (
                <li key={resource.path} className="select-text truncate">
                  {resource.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------- overwrite warning */

export function OverwriteDialog({
  names,
  onConfirm,
  onClose
}: {
  names: string[]
  onConfirm(): void
  onClose(): void
}): ReactNode {
  return (
    <Dialog
      title="Replace existing files?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            Replace
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-[13px] text-ink">
            {names.length === 1
              ? 'This folder already has a file with that name.'
              : `This folder already has ${names.length} files with these names.`}
          </p>
          <p className="mt-1.5 text-[12px] text-ink-muted">
            Uploading replaces the version on the Core. The old file cannot be recovered.
          </p>
          <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-line bg-surface-0 p-2 text-[11.5px] text-ink-muted">
            {names.map((name) => (
              <li key={name} className="select-text truncate">
                {name}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  )
}
