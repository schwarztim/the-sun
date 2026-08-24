# Packaging & release

thesun ships as **one archive per OS** (macOS/Linux/Windows) that an operator
unpacks and runs with no separately-installed `node`, `pnpm`, or `go`. This
document covers the release pipeline, the artifact layout, the Node-runtime
bundling approach (and its current caveat), and `thesun upgrade`.

## Pipeline overview

```
tag pushed  ─▶  goreleaser release
                  │
                  ├─ before hooks (Node subsystem builds)
                  │    ├─ generator: npm install && npm run build   (tsc)
                  │    ├─ gateway:   npm install && npm run build   (tsc)
                  │    ├─ hermes:    pnpm install && pnpm run build (tsc, workspace order)
                  │    └─ packaging/sea/build-all.sh                    (Node SEA binaries — see below)
                  │
                  ├─ builds: Go cross-compile fleet/fleetd/cmd/thesun
                  │    darwin/{amd64,arm64}, linux/{amd64,arm64}, windows/amd64
                  │    CGO_ENABLED=0 — cgo-free, cross-compiles cleanly from one host
                  │
                  └─ archives: one tar.gz (zip on Windows) per OS/arch, containing
                       bin/thesun            (Go CLI — supervises everything)
                       bin/gateway[.exe]     (Node SEA — no system node needed)
                       bin/hermes[.exe]      (Node SEA — no system node needed)
                       fleet/default-manifest.toml
                       README.md
                       docs/PACKAGING.md
```

Config: `.goreleaser.yml` at the repo root. Validate with `goreleaser check`;
dry-run a full build with `goreleaser release --snapshot --clean
--skip=publish,sign,validate` (both proven working as of this writing).

### Why `pnpm run build`, not `pnpm -r build`, for hermes

hermes package build order matters — `provider-akamai-wsa` (and the other
provider packages) import type declarations from the already-built
`@hermes/broker` dist output. pnpm's default topological `-r` scheduling
infers order from `package.json` `dependencies`, which does not capture this
dist-import relationship. The workspace root's own `build` script in
`hermes/package.json` runs the packages in the correct explicit order
(`auth-core` → `broker` → `client` → every provider). Always build hermes via
that script, never via a raw `pnpm -r build`.

## Go CLI (`bin/thesun`)

`fleet/fleetd/cmd/thesun` is CGO-free (`CGO_ENABLED=0` in `.goreleaser.yml`),
so it cross-compiles cleanly for every target from one build host — no
per-platform CI runner needed for the Go half of the archive.

Targets: `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`,
`windows/amd64`. (`windows/arm64` is excluded — see "Node runtime bundling"
below; there is no official prebuilt Node runtime for it to embed.)

## Node runtime bundling

The hard part: `gateway` and `hermes` are Node/TypeScript. Node SEA
(single-executable-application, built into Node 20+) embeds a compiled
JS bundle inside a copy of the Node binary itself, so the archive ships a
`gateway`/`hermes` executable that needs no system `node` at all.

### Pipeline (`packaging/sea/`)

```
packaging/sea/build-all.sh
  │
  ├─ for gateway (entry: gateway/dist/index.js) and
  │  hermes     (entry: hermes/packages/broker/dist/cli.js):
  │
  ├─ 1. bundle.mjs      — esbuild bundles the already-built dist/ output (tsc)
  │                        into ONE CommonJS file. Runs AFTER tsc, never
  │                        touches src/ — packaging-only.
  │
  ├─ 2. sea-config.json — node --experimental-sea-config generates the SEA
  │                        "prep blob" from that bundle, using a Node runtime
  │                        PINNED to THESUN_SEA_NODE_VERSION (default v26.4.0)
  │                        — see the version-match note below.
  │
  └─ 3. build-sea.sh    — per target OS/arch: downloads the OFFICIAL
                           nodejs.org prebuilt binary for that exact platform
                           and Node version, copies it, injects the blob via
                           `postject`, and (macOS only) ad-hoc re-signs it
                           with `codesign --sign -` (arm64 refuses to exec an
                           unsigned Mach-O at all; harmless on x64).
```

Output layout (consumed by `.goreleaser.yml`'s `archives[].files`):

```
dist-sea/gateway/<os>_<arch>/gateway[.exe]
dist-sea/hermes/<os>_<arch>/hermes[.exe]
```

**Version-match requirement (load-bearing):** the SEA blob and the Node
binary it gets injected into must be the SAME Node version. A blob generated
by one version injected into a binary of a different version does not error
— the sentinel fuse looks flipped and the binary runs, but the embedded
main script silently never executes (`isSea()` still reports correctly, but
nothing from the bundle runs). Verified empirically 2026-07-06 while building
this pipeline. `build-all.sh` and `build-sea.sh` both derive the Node version
from the single `THESUN_SEA_NODE_VERSION` env var (default `v26.4.0`) to make
this impossible to get wrong by construction — there is exactly one place the
version is set.

**Why the OFFICIAL nodejs.org binary, not the build host's own `node`:** a
locally installed Node (Homebrew, nvm, etc.) may be a different exact patch
version than the pin, and on macOS it is typically dynamically linked against
a separate `libnode.*.dylib` — not portable, and not what a shipped
standalone binary should assume. `build-sea.sh` always fetches+caches the
official static/self-contained tarball for the target platform.

**Verified working (2026-07-06, this build host, darwin/arm64):**
- `goreleaser check` — valid config.
- `goreleaser release --snapshot --clean --skip=publish,sign,validate` — full
  pipeline (Node subsystem builds → SEA build → Go cross-compile → archives →
  checksums) completes and produces all 5 platform archives.
- Both gateway and hermes SEA binaries run **with `node` removed from
  `PATH`** (`env -i PATH=/usr/bin:/bin ./dist-sea/gateway/darwin_arm64/gateway`
  and the hermes equivalent) — confirmed via `--help`/`--version` output and
  the gateway's real config-loading error path (proves the bundled JS is
  actually executing, not just the host binary printing something).
- All 10 target binaries (gateway × 5 platforms, hermes × 5 platforms) built
  successfully in one `build-all.sh` run.

### Externals — native addons and browser-automation deps

Some dependencies cannot be esbuild-bundled into a single file because they
either ship a native `.node` addon or are only ever meant to be
dynamically imported at runtime. These are passed to esbuild's `--external`
and therefore are **not** embedded in the SEA blob:

| Package | Why external | Handling |
|---|---|---|
| `@napi-rs/keyring` | Native addon (OS keychain bindings) | **Already lazy** in `@hermes/vault`'s `master-key.ts` — see below |
| `patchright`, `patchright-core`, `playwright`, `playwright-core` | Browser automation; dynamically `import()`ed only inside specific SSO provider code paths (crowdstrike, managed-browser, etc.), never on the `hermes start`/`gateway` hot path | Not needed for the supervised stack's steady-state operation; only `hermes acquire` flows that hit a browser-driven provider need them, and those are dev/operator-invoked, not fleetd-supervised |
| `pino-pretty` | Gateway's logger deliberately avoids pino's worker-thread transport (see `gateway/src/logger.ts` — a dead worker thread would crash the whole gateway); hermes's broker only uses `pretty: true` in the interactive `acquire` CLI path | Fine to omit from the `start` SEA binary; not on the supervised path |
| `fsevents`, `lightningcss-*`, `@rolldown/binding-*` | macOS/platform-specific native watch/build tooling pulled in transitively by dev dependencies, never referenced by the runtime entry points actually bundled | Never reached at runtime; excluded purely to keep esbuild from trying (and failing) to resolve platform-specific optional natives for OTHER platforms during a single bundle pass |

### The `@napi-rs/keyring` caveat (already handled, verified)

`@hermes/vault`'s master-key resolution cascade
(`hermes/packages/vault/src/master-key.ts`) was **already written** to treat
the OS keychain as optional and lazy, independent of this packaging effort:

```
resolveMasterKey():
  1. HERMES_MASTER_KEY env
  2. key file ~/.hermes/master.key      ← checked BEFORE the keychain
  3. OS keychain (@napi-rs/keyring)     ← lazy dynamic import(), catches load failure
  4. generate-on-first-use → key file (0600, EXCLUSIVE) + keychain (best effort)
  5. fail closed
```

`loadNapiKeychain()` does `await import('@napi-rs/keyring')` inside a
`try/catch` and returns `null` on any failure — including "module not
found," which is exactly what happens inside a SEA binary that excluded this
native addon. The cascade then falls through to the key-FILE path (step 2,
which is checked first anyway specifically so an unattended daemon never
needs an interactive keychain prompt) or generates-and-persists a key file
(step 4) with the keychain write wrapped in its own best-effort `try/catch`.

**Net effect:** the hermes SEA binary runs correctly with zero native addons
present. It uses the key-file cascade path exactly as an unattended
launchd/systemd-managed hermes already does today (see
`hermes/CLAUDE.md` — Recovery Procedure). The OS keychain becomes available
again only if `@napi-rs/keyring`'s prebuilt `.node` for the current
platform is later placed as a sibling file next to the SEA binary AND
Node's native `require`/`import` can resolve it there — not yet wired up,
and not required for correct operation.

### What's not yet in the archive

- **`generator`** (turns a REST API spec into a new MCP server) is a
  developer/power-user path, not part of the always-on supervised stack
  (hermes + gateway + servers). It stays a `dist/cli/index.js` + system-`node`
  invocation (`thesun generate`/`thesun verify` in `fleet/fleetd/cmd/thesun/stack.go`
  `runGenerator`) rather than an SEA binary for now. Candidate for a future
  pass if operators want `thesun generate` to work with no system Node too.
- **Interactive `hermes acquire` browser flows** need `patchright`/`playwright`,
  which are excluded from the SEA bundle (see externals table above). These
  remain a system-`node`-dependent path — the fleetd-supervised `hermes start`
  is unaffected, since it never touches those code paths on the steady-state
  hot path.
- **Windows arm64** — no official prebuilt Node runtime is published upstream
  for `win-arm64` as a static tarball/zip matching this pipeline's fetch
  pattern as of this writing; excluded from `.goreleaser.yml`'s build matrix
  until that changes.

## `thesun upgrade`

Implemented in `fleet/fleetd/cmd/thesun/upgrade.go` (+ `version.go` for
`thesun version`). Self-update against a GitHub Releases feed:

```
thesun upgrade [--check] [--repo owner/repo]
```

- Repo resolution: `--repo` flag > `THESUN_UPDATE_REPO` env > compiled-in
  default (`defaultUpdateRepo` in `upgrade.go`, currently a placeholder —
  set via `-ldflags -X main.defaultUpdateRepo=owner/repo` at release build
  time once a real repo exists).
- `--check`: fetches `GET /repos/<repo>/releases/latest`, compares this
  binary's own `version` (stamped via `.goreleaser.yml`'s
  `-X main.version={{.Version}}`; a dev checkout reports `"dev"`, which
  always compares as older than any real tag) against the release's
  `tag_name`. Reports only — makes no writes.
- Without `--check`: on finding a newer tag, downloads the archive matching
  `runtime.GOOS`/`runtime.GOARCH` (`thesun-<os>-<arch>.tar.gz`, `.zip` on
  Windows — name computed by `assetName()`, kept in lockstep with
  `.goreleaser.yml`'s `archives[].name_template`), verifies its sha256
  against the release's `checksums.txt` (refuses to install if that asset
  is missing — no unverifiable installs), extracts it to a temp dir, and
  atomically swaps it in for the live bundle via a two-rename dance
  (current bundle → `<bundle>.old-upgrade` backup → new bundle → live path;
  a failure on the second rename rolls the backup back into place, so the
  tool never ends up bundle-less). Finally triggers `thesun service
  restart` (or a manual `down`+`up` if the OS service isn't installed).
- This download → temp → verify → atomic-rename pattern mirrors how `gh`
  and `hugo` self-update.

### Tests

`fleet/fleetd/cmd/thesun/upgrade_test.go` covers, against an `httptest`
stub release feed (no real network, no real self-replace):
- semver comparison (`compareSemver`) including the `"dev"`-always-behind
  case and numeric-not-lexicographic ordering (`v1.9.0 < v1.10.0`)
- asset-name generation for every target OS/arch
- repo resolution order (flag > env > default)
- `checkForUpdate` against up-to-date / newer-available / no-releases feeds
- the `--check` CLI path (asserts exit code only — no filesystem mutation)
- checksum verification (match, mismatch, missing-entry)
- tar.gz/zip extraction round-trip AND path-escape rejection
  (`../../etc/passwd`-style entries)
- `replaceBundle`'s rename dance: successful swap, one-level wrapping
  directory in the archive, and rejection of a non-bundle extracted dir
  (with the live bundle left untouched)

Run: `cd fleet/fleetd && go test ./cmd/thesun/...`
