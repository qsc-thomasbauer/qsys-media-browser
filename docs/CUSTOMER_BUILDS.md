# Adding a customer

Everything that makes a build "theirs" lives in one JSON file plus two image
files. No app source changes.

## 1. Write the config

Copy `branding/_template.json` to `branding/<slug>.json` and fill it in. The
`id` must match the filename.

```json
{
  "id": "acme",
  "productName": "ACME Audio Manager",
  "appId": "com.yourco.qsys.acme",
  "version": "1.0.0",

  "core": {
    "host": "10.0.1.50",
    "port": 443,
    "accessMode": "protected"
  },

  "rootFolder": "Messages/ACME",
  "allowRootEscape": false,

  "features": {
    "upload": true, "download": true, "delete": true,
    "rename": true, "move": true, "createFolder": true,
    "preview": true, "playlists": false, "devTools": false
  },

  "theme": {
    "mode": "light",
    "colors": { "primary": "#B0122B", "surface": "#F7F5F2", "accent": "#C87F0A" },
    "logo": "assets/acme/logo.svg",
    "icon": "assets/acme/icon.png"
  },

  "window": { "width": 1120, "height": 740 }
}
```

### Fields worth thinking about

| Field | Notes |
|---|---|
| `appId` | Reverse-DNS, unique per customer. Two builds sharing one `appId` share userData, so their certificate pins collide. |
| `core.accessMode` | `protected` = Access Control is on and a bearer token is required. `open` = no Access Control; `credentials` becomes optional and no `Authorization` header is sent. |
| `rootFolder` | The jail. `""` exposes the whole `/media` tree. Enforced in the main process — see [SECURITY.md](SECURITY.md). |
| `allowRootEscape` | `true` ignores `rootFolder` and shows everything. Admin builds only. |
| `features.devTools` | Leave `false` for customer builds. |
| `theme.mode` | Picks the direction shades are derived in and the default text polarity. |

Give each customer **their own Core user, scoped to their own folder**. That is
what limits the damage if a credential is recovered from the binary — read
[SECURITY.md](SECURITY.md) before shipping.

## 2. Add the credentials — in a sidecar, never in the config

The config above has no `credentials` block, and the schema **rejects one**.
Customer configs are committed to git, and a password in a committed file is in
every clone and fork of the repository for good — removable only by rewriting
history. So credentials live beside the config in a file `.gitignore` excludes:

```bash
cp branding/_template.secret.example.json branding/acme.secret.json
```

```json
{
  "username": "acme-media",
  "password": "the-real-password"
}
```

That file is all that stands between a fresh clone and a working build, so keep
it in your password manager, not in the repo.

For CI, set environment variables instead — named after the slug in upper snake
case, so one job can build several customers:

```
QSYS_CRED_ACME_USERNAME   QSYS_CRED_ACME_PASSWORD
QSYS_CRED_DDD_USERNAME    QSYS_CRED_DDD_PASSWORD
```

A single-customer run may use the unsuffixed `QSYS_CRED_USERNAME` /
`QSYS_CRED_PASSWORD`. The sidecar file wins over the environment when both are
present, so a local build always uses your local credentials.

A Core in `open` access mode needs no credentials at all — omit both.

**Without credentials**, `npm test`, `npm run typecheck` and config validation
all still work; only `build:customer` fails, with a message naming both ways to
supply them. That is deliberate: CI can run the test suite on a pull request
from a fork without any secrets exposed.

## 3. Add the assets

```
branding/assets/<slug>/
  logo.svg     # ~168x28, shown in the header. SVG, PNG, JPEG or WebP.
  icon.png     # square, 1024x1024. Converted to .ico/.icns/.png at build time.
```

The logo is inlined as a data URI, so it needs no separate hosting and cannot
fail to load. `currentColor` in an SVG resolves to the customer's text colour,
which is handy for wordmarks that must work in both light and dark modes.

If `icon.png` is missing, the build **generates a placeholder** from the brand
colours — a waveform mark on a rounded square — and writes it to that path. A
build never silently ships the default Electron icon. Replace it with the real
thing when you have it.

## 4. Colours

Supply two or three and the rest are derived in OKLCH:

- `primary` — brand colour: buttons, selection, focus rings, progress
- `surface` — the base background; raised surfaces, borders and text all come
  from it
- `accent` *(optional)* — secondary highlight; defaults to a hue-rotated primary
- `danger` *(optional)* — destructive actions; defaults to a neutral red

The build **fails** if a pairing cannot be made legible. Two kinds of problem
are handled differently:

- **Fixable** — a dark brand colour that would give unreadable button labels, or
  a surface ramp too light for white text. The derivation corrects these
  automatically (foregrounds are computed to clear WCAG AA; the surface ramp
  flattens if it has to).
- **Not fixable without a human** — a brand colour indistinguishable from its own
  surface, or a surface too close to mid-grey to carry any text. These stop the
  build with a message naming the pair and the measured ratio, because fixing
  them means changing the customer's colours.

To see what a palette produces without a full build:

```bash
QSYS_CUSTOMER=acme npm run dev
```

## 5. Build

```bash
npm run build:customer acme                  # this machine's platform
npm run build:customer acme -- --win --linux # explicit targets
npm run build:customer acme -- --bundle-only # skip packaging, just bundle
npm run build:all                            # every config in branding/
```

Artifacts land in `dist/<slug>/`. `build:all` collects failures rather than
stopping, and prints a per-customer summary at the end.

### What to ship, and what to ignore

```
dist/acme/
  ACME Audio Manager 1.0.0.exe   <- ship this. Nothing else.
  win-unpacked/                  <- build intermediate; ignore
  builder-debug.yml              <- resolved build config; ignore
```

The portable `.exe` is **fully self-contained** — Electron, Chromium, the app
bundle and the encrypted credentials are all inside it. Verified by copying just
that one file to an empty directory and running it: it launches and connects
with no siblings present. It needs no installer, no runtime, and no admin
rights.

`win-unpacked/` is the staging tree electron-builder packs *from*, and its
contents are already inside the `.exe`. It is useful for debugging — you can run
the executable inside it directly, and inspect `resources/app.asar` — but it is
four times the size and must not be distributed.

`builder-debug.yml` is a dump of the fully-resolved electron-builder config,
written on every build. Read it when a packaging option is not taking effect;
otherwise ignore it.

Both are safe to delete, and both are regenerated on the next build. `dist/` is
gitignored in full.

One consequence of the portable target: the `.exe` extracts itself to a
temporary directory on each launch, so the *first* start takes a few seconds
longer than an installed app would. Nothing is left behind on the machine
afterwards, which is usually what you want on a shared customer PC. If you would
rather have a conventional installer, swap `portable` for `nsis` in the `win`
target list in `electron-builder.base.yml`.

### What the build does

1. Validates the config against `branding/_schema.ts` — a bad config, or one
   with an inline `credentials` block, fails loudly.
2. Resolves credentials from the sidecar or the environment, and fails if a
   `protected` build has none.
3. Runs the contrast guard.
4. Encrypts the credentials with a per-build key.
5. Generates the icon set (drawing a placeholder if needed).
6. Runs `electron-vite build` with that customer's constants injected —
   credentials and the Core address into the main bundle only.
7. **Scans the renderer bundle** for the password and the Core host and aborts
   if either leaked.
8. Runs `electron-builder` with per-customer `productName`, `appId` and icons
   merged over `electron-builder.base.yml`.

### Platform support

| Target | Build host |
|---|---|
| Windows portable `.exe` | any (Windows recommended) |
| macOS `.dmg` | **macOS only** — cannot be cross-built or notarized elsewhere |
| Linux `AppImage` + `.deb` | Linux, or Windows/macOS with Docker |

Builds are unsigned. On Windows, SmartScreen warns on first run until you add a
code-signing certificate to the `win` section of `electron-builder.base.yml`.
macOS builds need signing and notarization before they will open on a customer
machine without a right-click override.

`.github/workflows/release.yml` runs all three on a CI matrix.

## 6. Test it

```bash
npm run mock-core                          # a fake Core on :8443
QSYS_CUSTOMER=acme npm run dev             # against the mock

npm test                                   # 143 tests, no hardware or secrets needed
npm run typecheck
```

The mock reproduces the real API's awkward parts — `Host`-header enforcement,
self-signed TLS, read-only default folders, the inconsistent leading slashes —
so most problems surface without a Core on the bench. The sample `demo` and
`acme` configs point at it on ports 8443 and 8444; change `core.host` to a real
Core when you have one.

For automated checks against the built app:

```bash
npm run build:customer acme -- --bundle-only
node scripts/drive.mjs
driver> launch
driver> rows
driver> ss acme-landing
```

### Before shipping

- [ ] Confirm `branding/<slug>.secret.json` exists and is *not* tracked by git
      (`git check-ignore -v branding/<slug>.secret.json`)
- [ ] Point `core.host` at the real Core and confirm the app connects
- [ ] Confirm the breadcrumb cannot go above `rootFolder`
- [ ] Upload a large file (>100 MB) and watch progress and memory
- [ ] Download it back and compare
- [ ] Verify the window title, taskbar icon and palette are the customer's
- [ ] Confirm `features.devTools` is `false`
- [ ] Rename a file and confirm the extension is not doubled (fixed, but it is
      the one behaviour real hardware disagreed with the docs about — see
      [API-NOTES.md](API-NOTES.md#rename-takes-the-stem-not-the-filename))
- [ ] Move a file between folders and confirm its name is unchanged
