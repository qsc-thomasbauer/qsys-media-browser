# Security model

Read this before shipping a build to a customer. One section of it is a
limitation you need to design around, not a feature.

## Credentials are never committed

Customer configs (`branding/<slug>.json`) are tracked in git. Their credentials
are not: the schema **rejects** an inline `credentials` block, and the build
reads them from a gitignored `branding/<slug>.secret.json` sidecar or from
`QSYS_CRED_<SLUG>_USERNAME` / `_PASSWORD` in CI.

This is a separate concern from the obfuscation below, and a more serious one. A
password in a committed file is in every clone, every fork and every CI cache
for good — removing it means rewriting history and rotating the credential
anyway. Shipping it in a binary exposes it to whoever holds that binary;
committing it exposes it to whoever can read the repo, forever.

`npm test`, `npm run typecheck` and config validation all work without any
credentials present, so CI can run the full suite on a pull request from a fork
with no secrets in scope.

## Baked-in credentials are obfuscation, not secrecy

Each build carries its Core username and password encrypted with AES-256-GCM.
The key is generated fresh per build and split across two constants injected at
different points in the main bundle, and the blob is bound to the build's
`appId` so it cannot be decrypted by another build.

**The key ships in the same binary as the ciphertext.** Anyone willing to unpack
the `.asar` and read the main bundle can recover the password. There is no way
around this for an app that logs in without prompting — the secret has to be
present for the app to use it.

What the obfuscation does buy:

- the password is not a greppable string in the binary
- it never exists in the renderer bundle, so it cannot be read from devtools,
  a `window` dump, or a crash report from the UI process
- casual inspection (strings, a text editor, a curious end user) finds nothing
- a leaked blob from one customer is useless for another

### What actually contains the risk

Give every customer build its own Core user, scoped to that build's folder:

1. In Core Manager, create a user per customer (`acme-media`, not `admin`).
2. Grant it the narrowest role that permits media upload/download.
3. Set the build's `rootFolder` to that customer's folder and leave
   `allowRootEscape: false`.

Then a recovered credential grants exactly what the binary already granted, and
nothing more. That is the property to aim for — not "the password cannot be
found", which is not achievable here.

If a customer's threat model genuinely requires the password to stay secret,
switch that build to a login prompt and store the password in the OS keychain.
The app is not currently built that way, because it was specified to open
straight into the folder with no prompt.

## The jail

`rootFolder` confines a build to one subtree of `/media`. Enforcement lives in
`src/main/qsys/paths.ts`, in the main process — not in the UI.

Every path the renderer sends passes through `PathJail.toCore()`, which applies
two independent guards:

1. **Structural** — `..`, `.`, backslashes, null bytes, over-long segments and
   percent-encoded separators are rejected before any joining happens, so
   traversal cannot be expressed in the first place.
2. **Prefix** — the joined result must be the root itself or a child of
   `root + '/'`. This is what catches sibling-prefix confusion: a root of
   `Audio/ACME` must not admit `Audio/ACMEX`.

There is deliberately no IPC channel that accepts a real Core path. A
compromised renderer, or someone typing into devtools on a `devTools: true`
build, can only hand strings to `toCore` — which refuses anything outside the
root. `tests/paths.test.ts` covers this exhaustively; treat a failure there as
a release blocker.

`allowRootEscape: true` exposes the whole tree for admin builds. It is not a
separate code path — the same validation runs, only with an empty root — so it
cannot silently disable the structural guards.

## Renderer isolation

The renderer is treated as untrusted:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
- a strict CSP with `default-src 'none'` and `connect-src 'self'`, applied as a
  response header so it covers the dev server too
- all navigation and window-opening is denied; `https://` links are handed to
  the OS browser
- `devTools` is a per-customer flag, off by default
- the preload exposes exactly the methods in `src/shared/ipc.ts` — no
  `ipcRenderer`, no `require`, no arbitrary channel

The renderer never learns the Core's address, and never holds a bearer token.
Audio preview works through a `qsys-media://` protocol handler that performs the
authenticated request in the main process, so `<audio src>` works without the
token crossing the bridge.

`scripts/build-customer.ts` scans the emitted renderer bundle for the password
and the Core host and **fails the build** if either appears. That guard exists
because a single stray `import ... from '../config'` in a renderer file would
undo the whole arrangement with no visible symptom.

## Feature flags are enforced, not just hidden

A build with `features.delete: false` hides the button *and* refuses the IPC
call in `src/main/ipc.ts`. Hiding alone would leave the capability one devtools
call away.

## TLS

Q-SYS Cores use self-signed certificates, so there is no CA to validate
against. `NODE_TLS_REJECT_UNAUTHORIZED` is deliberately **not** touched — that
would disable verification for the whole process. Instead a single
`https.Agent`, scoped to the configured host and port, relaxes verification, and
the certificate fingerprint is recorded on first contact
(trust-on-first-use, stored in `core-cert.json` under the app's userData).

A later change does not block anything — integrators legitimately regenerate
these — but it raises a banner in the header rather than passing unnoticed. This
detects a swapped certificate, not an active MITM on first connection.

SNI is only sent when the host is a hostname; sending it for an IP violates
RFC 6066, and Cores are usually addressed by IP.

## Reporting

Security issues in this app: raise them with whoever maintains this repo.
Issues in the Q-SYS Management API itself belong with QSC.
