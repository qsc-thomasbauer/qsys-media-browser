# Q-SYS Management API notes

Things the documentation understates, and one place where real hardware simply
disagrees with it. Each of these cost time during development; they are recorded
so they cost nobody else any.

Reference:
[Overview](https://help.qsys.com/q-sys_9.5/content/Management_APIs/Management_APIs_Overview.htm) ·
[Authentication](https://help.qsys.com/q-sys_9.5/content/Management_APIs/authentication.htm) ·
[Media Resources](https://help.qsys.com/q-sys_9.5/content/Management_APIs/media_resources.htm) ·
[Media Playlists](https://help.qsys.com/q-sys_9.5/content/Management_APIs/media_playlists.htm)

## The `Host` header is mandatory

Omit it and the Core answers **406 Not Acceptable** — not 400, and with nothing
in the body to explain why. `src/main/qsys/client.ts` sets it explicitly on
every request rather than trusting a client library's default.

Note that Node's own HTTP *server* rejects an HTTP/1.1 request with no `Host`
with a 400 before any handler runs, so the mock can only be made to demonstrate
the 406 over HTTP/1.0. That is what `tests/integration.test.ts` does.

## `Content-Length` on a DELETE body

Bulk delete puts its paths in a `DELETE` request body. Node's HTTP client does
**not** use chunked encoding for `DELETE`, so without an explicit
`Content-Length` the body goes out with no framing at all: the server reads it
as the start of the next request on the keep-alive connection and answers 400.

The client now sets `Content-Length` for every buffered body regardless of
method. This was a real bug, caught by the integration tests.

## Percent-encoding is per segment, not per path

> Any special characters within the resource endpoint path (spaces, slashes,
> etc.) must be URI encoded.

Spaces **and slashes inside names** must be encoded, which rules out
`encodeURI` on the whole path — it leaves `/`, `+`, `#`, `&` and `?` alone.
`PathJail.encode()` applies `encodeURIComponent` to each segment and rejoins
with `/`.

Conversely, paths in a **JSON body** (bulk delete, `PUT` move destinations,
playlist `media` arrays) are raw and must *not* be encoded. Encoding those was
another real bug.

## Leading slashes are inconsistent

Top-level folders come back with one, everything else without:

```json
{ "name": "Audio",       "path": "/Audio",                "type": "folder" }
{ "name": "example file","path": "Audio/example file.mp3","type": "file"   }
```

`toResource()` strips leading slashes before anything else touches the path.

## `name` excludes the file extension

```json
{ "name": "example file", "ext": "mp3", "path": "Audio/example file.mp3" }
```

`name` is the stem; the extension is in `ext`. The last path segment is the only
complete filename the API gives you, so `media.ts` normalises `name` to that and
keeps `ext` alongside. Otherwise every consumer has to reassemble it and one
eventually forgets.

## Rename takes the stem, not the filename

**Confirmed against real hardware.**

`PATCH /cores/self/media/{path}` takes `{"name": "..."}` where `name` is the
**stem**. The Core re-appends the resource's existing extension itself, so
sending a full filename doubles it:

```
PATCH /cores/self/media/Audio/image.jpeg   {"name": "image.jpeg"}
  -> Audio/image.jpeg.jpeg                 # wrong
PATCH /cores/self/media/Audio/image.jpeg   {"name": "photo"}
  -> Audio/photo.jpeg                      # right
```

Two consequences:

1. **The extension cannot be changed through this endpoint.** The Core keeps the
   original whatever you send. The rename dialog therefore edits the stem only
   and shows the extension as a fixed suffix beside the field, rather than
   offering an edit that would silently not happen.
2. `media.ts:rename` strips a trailing extension that matches the current one
   before sending, so a caller may pass either `photo` or `photo.jpeg` and get
   the same correct result.

The boundary between stem and extension follows Node's `extname` rule, which
is also what the API itself reports:

| filename | stem sent | result |
|---|---|---|
| `image.jpeg` | `photo` | `photo.jpeg` |
| `archive.tar.gz` | `backup.tar` | `backup.tar.gz` |
| `clip.WAV` | `intro` | `intro.WAV` (case preserved) |
| `README` | `NOTES` | `NOTES` |
| `.htaccess` | all stem | no extension to preserve |

Folders have no extension (`ext: null`), so a folder called `v1.2` renames
whole — the stem logic is skipped for them entirely.

`tests/integration.test.ts` locks all of this in, and `scripts/mock-core.ts`
reproduces the Core's re-appending behaviour so the bug cannot come back
unnoticed.

### Still worth checking: does `PUT` (move) do the same?

`PUT` takes `{"path": "..."}` — a full destination path, a different field from
`name` — so it most likely does *not* re-append. This app sends full paths
including the extension, and surfaces whatever path the Core returns, so a
mismatch would be visible immediately in the UI rather than silent. If you ever
see a moved file gain a second extension, the fix is the same shape as the
rename one, in `media.ts:move`.

## Uploads replace silently

> An attempt to upload a file that already exists safely replaces the existing
> file with the new one.

No error, no confirmation. The UI therefore asks *before* uploading, since there
is no chance to ask afterwards.

Also worth relaying to customers:

> there must be enough drive space for both files while the operation is in
> progress

A Core at 60% capacity cannot accept a replacement for a file taking 50% of it.
The client maps HTTP 507 to a message that says so.

## Default folders are read-only

`Audio`, `Messages`, `PageArchives`, `Preambles`, `Ringtones` cannot be renamed,
moved or deleted. Adding files *inside* them is normal and allowed, so the
read-only check is a depth-one match on the Core path, not a prefix match. The
UI marks them with a lock and disables the destructive actions.

## Token expiry is idle-based

> The token expires within 1 hour if the user does not perform any API requests
> with it. This expiration timeout is reset on every request.

Idle, not absolute. `auth.ts` tracks last activity and re-authenticates once it
passes 45 minutes, rather than scheduling against a fixed expiry. A 401 also
triggers one transparent retry.

## Upload form field is `media`

`multipart/form-data` with the field named `media`, repeated for multiple files.
This app sends one file per request anyway — one failure should not take a whole
batch down, and progress is only attributable per-request.

## Playlists are Core-wide, not folder-scoped

A playlist visible to a jailed build can contain tracks from outside that
build's folder. `PUT /{id}` replaces the **entire** track list, so:

- a rename must resend the existing tracks, or the playlist comes back empty
- a reorder must include tracks the build cannot see, or it deletes them

`playlists.ts` therefore identifies tracks by their real Core path, marks
out-of-jail ones `external` (shown, reorderable, not playable or downloadable),
and validates that a reorder only references paths already in the playlist or
inside the jail.

## Undocumented: range requests

Not mentioned in the docs, but the Core honours `Range` on media `GET`s and
answers 206 with `Content-Range`. This is what makes seeking work in the preview
player. If a firmware revision does not, playback still works — Chromium falls
back to a full fetch — but the scrub bar will not seek.
