# The thesun MCP Store

The MCP Store is how you find, install, and publish thesun MCP servers as
signed, integrity-checked binaries. It is not a package manager bolted onto a
trust-me download; every install is verified before it lands on disk (sha256 +
Ed25519), and every installed server is contained at runtime by the same
gateway policy enforcement point that governs the rest of the fleet.

This document covers what the store is, its trust model, and the consumer and
author command reference. The index file format is specified in the registry
repo's `SCHEMA.md` (linked below); this doc summarizes it rather than
duplicating it.

## What the store is

The store spans three repositories, each with one job:

| Repo | What it holds | Role |
| ---- | ------------- | ---- |
| `thesun` | the toolchain (`thesun` CLI, generator, fleetd, gateway, hermes) | generate, run, route, authenticate, and the store client verbs |
| `thesun-servers` (`github.com/schwarztim/thesun-servers`) | the curated Go MCP server monorepo (source) | where curated server source lives and is built from |
| `thesun-registry` (`github.com/schwarztim/thesun-registry`) | the signed catalog index (`index.toml`) | the catalog the CLI fetches for `search`/`add`/`update`; CI re-gates curated releases here |

Data flow for a consumer:

```
thesun search  ─▶  thesun add  ─▶  fleetd supervises  ─▶  gateway routes + classifies
  (catalog)         (verify +          (native binary,        (Tier-A / Tier-B
                     install)           streamable-http)        enforcement)
```

The default index the CLI fetches is
`https://raw.githubusercontent.com/schwarztim/thesun-registry/main/index.toml`.
Override it per command with `--index <ref>` (an https URL, a local file path,
or a `file://` URL) or globally with the `THESUN_REGISTRY_INDEX` environment
variable.

## Trust model

Two independent controls make the store's supply-chain argument. Neither
depends on trusting the server author.

### 1. The Conformance Lab is the publish gate

A server cannot be published curated (or into the CI-gated registry) unless it
carries a `lab-report.json` with `passed == true`. `thesun publish` reads that
report and REFUSES if it is missing or reports `passed=false`. The registry's
CI re-runs the 9-gate Conformance Lab on every curated release before the entry
goes live. A Lab PASS is necessary, not sufficient: it does not prove semantic
or live-target correctness (see the schema's `residual_unverified_surface`), so
it is a floor on quality, not a guarantee of it.

### 2. The gateway is the runtime floor

Every added server's tools are classified by the gateway using its manifest
plus the default-conservative escalation overlay. WRITE, DELETE, and outbound
tools land in Tier-B (out-of-band human `thesun approve`) regardless of who
wrote the server, curated or community. Tier-A is a model self-confirm, a speed
bump for audit, not a boundary an autonomous model cannot cross. So a pulled
binary is contained at runtime the same way a locally generated one is: tier is
a signal about provenance and proof, never a runtime security boundary.

### Two trust tiers

| Tier | What it means | Install rule |
| ---- | ------------- | ------------ |
| **curated** | maintainer Ed25519-signed, conformance-proven, CI-Lab-re-gated in `thesun-registry` | installs by default; the fail-closed verification chain below must pass in full |
| **community** | self-attested, not conformance-proven, clearly labeled | refused unless you pass `--community` to accept the risk |

### The fail-closed verification chain in `add`

A **curated** install requires ALL of the following; any single failure refuses
the install and writes nothing to disk or the manifest:

1. the entry is not `revoked` in the index,
2. the resolved version's `lab_report.passed == true`,
3. the downloaded binary's sha256 matches the index entry for this OS/arch, and
4. the version's Ed25519 signature verifies against a trusted public key.

A **community** install (only reachable with `--community`) still enforces
sha256; if the entry carries a signature it must verify, and an unsigned
community build installs with a printed warning that integrity is sha256-only
against an unverified index. Revoked entries are refused in every tier.

## Consuming: store, search, add, remove, update

### `thesun store [query] [--tier curated|community] [--index ref]`

The interactive catalog browser, and the easiest entry point if you do not already know
what you are looking for: category-grouped entries with a live fuzzy filter, the same trust
badges `search` prints, write-safety and auth indicators, installed state, and in-place
install/remove through the same verified fail-closed path as `add`. Without a TTY it
degrades to `thesun store list [query]`, the same catalog as a static grouped listing.

```bash
thesun store                      # browse everything
thesun store security             # open with a filter applied
thesun store list --tier curated  # non-interactive listing
```

### `thesun search <query> [--tier curated|community] [--index ref]`

Fetches the index, filters by name, description, category, and tags, and prints
each match with a trust badge (`curated (lab-verified)` or `community
(self-attested, unverified)`) plus a one-line summary (tool count, whether it
has write tools, and its auth scheme). Revoked entries are delisted from search.

```bash
thesun search shodan
thesun search security --tier curated
thesun search netskope --index ./index.toml
```

### `thesun add <name>[@version] [--community] [--index ref]`

Resolves the entry and version, runs the fail-closed verification chain above,
then downloads the platform binary, verifies it, installs it into
`THESUN_HOME/servers/<name>`, allocates a free port in the 42000-42999 window,
appends a `[[server]]` block to the live manifest, and reloads the fleet. When
the entry declares a credential, it PRINTS (never runs) the enrollment command
so you can run it yourself:

```
This server needs a credential. Enroll it in Hermes (interactive, operator-only):
  thesun acquire <service>
```

Omit `@version` to take the entry's latest. If no published binary exists for
your OS/arch, `add` tells you to build from source in `thesun-servers` and add
it manually. `add` refuses when the entry is already installed rather than
creating a duplicate on a second port; this includes a legacy `-go` fleet server
that backs a bare index entry (e.g. `shodan-go` backs entry `shodan`), which the
store recognizes as installed and offers to `update`/`remove` instead. Note: `thesun add <name> --cmd ... --port N` (a manual add with an
explicit command or `--bin`) is the pre-existing manual path and is unchanged; a
store pull is only intercepted when a bare name is given with no `--cmd`/`--bin`.

```bash
thesun add shodan                 # latest curated version
thesun add shodan@0.2.0           # a specific version
thesun add somecommunity --community
```

### `thesun remove <name>`

Removes the server's block from the manifest and reloads the fleet.

```bash
thesun remove shodan
```

### `thesun update [<name>]`

With no name, refreshes the index cache (and confirms the index is reachable).
With a name, upgrades an installed server to a newer verified version, running
the same verified download-and-swap path as `add` (the old manifest block is
removed first so the re-add does not collide). It reports "up to date" when the
installed version is already the latest.

```bash
thesun update                     # refresh the catalog
thesun update shodan              # upgrade one server
```

## Publishing: keygen, publish

### `thesun keygen`

Generates an author Ed25519 keypair under `THESUN_HOME/keys`: `author.key`
(mode 0600) and `author.pub` (mode 0644). The private key is written to disk
0600 and NEVER printed; the command prints the public key (base64) and where to
put it. To trust the key for local installs, append the public key to
`THESUN_HOME/trusted_keys` (one base64 key per line). To make it the curated
key, paste it into `curatedPubKeyB64` in `cmd/thesun/registry.go`.

```bash
thesun keygen
```

### `thesun publish <dir> [--community] [--index localfile] [--release-dir dir] [--download-base url] [--name n] [--version semver] [--upload [--upload-cred hermesref] [--index-url url]]`

The Conformance Lab is the HARD publish gate: `publish` requires
`<dir>/lab-report.json` with `passed == true` and REFUSES otherwise. It then
cross-compiles the platform matrix (darwin/linux amd64+arm64, windows amd64,
`CGO_ENABLED=0` static binaries) into `--release-dir` (default `./dist`),
computes the sha256 of each binary, signs the canonical version bytes with the
author key, and emits the `[[entry]]` TOML block to stdout. With `--index <file>`
it also upserts the entry into a local index file (for testing or a CI staging
index). Locally, platform URLs are `file://` paths; CI rewrites them to https
release URLs.

```bash
thesun verify ./servers/myserver              # produce lab-report.json first
thesun publish ./servers/myserver \
  --index ./index.toml --version 0.1.0
```

### Hosting the release: `--download-base` and `--upload`

`--download-base <url>` sets where the binaries are hosted, so each platform URL
in the index becomes `<base>/<binary>` (an https artifact-store path) instead of
a local `file://`. The Ed25519 signature covers os/arch/sha256, NOT the URL, so
choosing or moving the host never invalidates it.

`--upload` then HTTP PUTs the built binaries to those URLs, and (with
`--index-url`) the finalized index file to the distribution location, using a
write token resolved from Hermes (`--upload-cred`, default
`hermescred://artifactory/token`). This keeps the toolchain portable (any HTTP
artifact store that accepts PUT) with no external CLI dependency.

Distribution split: the git repos (`thesun-servers`, `thesun-registry`) are the
reviewed source of truth (PR review, branch protection, secret scanning); the
artifact store is the anonymous-read distribution layer. Reads are anonymous, so
`thesun add` needs no credential; only publishing carries the write token. A
consumer points at the distribution index with `THESUN_REGISTRY_INDEX` (or
`--index`), e.g. an internal Artifactory `.../thesun-mcp/index.toml`.

```bash
# one-shot release: build, sign, upload binaries + index to the artifact store
thesun publish ./servers/myserver --version 0.1.0 \
  --index ./index.toml \
  --download-base https://<host>/artifactory/binaries-local/thesun-mcp/servers/0.1.0 \
  --index-url    https://<host>/artifactory/binaries-local/thesun-mcp/index.toml \
  --upload
```

### Curated vs community publishing flow

- **Curated:** publish (or let CI publish) the entry, open a PR to
  `thesun-registry`, and CI re-gates it through the 9-gate Conformance Lab
  before the entry goes live. The signature is verified against the curated
  maintainer key. This is the default tier for `publish`.
- **Community:** run `thesun publish --community`. The entry is self-signed with
  your author key and clearly labeled community (self-attested, unverified). A
  consumer must pass `--community` to install it, and a human reviews before use.

## Index schema (summary)

The catalog is a single `index.toml` conforming to schema
`thesun-registry/v1`. Full contract:
[`thesun-registry/SCHEMA.md`](https://github.com/schwarztim/thesun-registry/blob/main/SCHEMA.md).
Shape at a glance:

- Top level: `schema = "thesun-registry/v1"`.
- `[[entry]]` per server: `name`, `description`, `category`, `tags`, `tier`
  (`curated` or `community`), `maintainer`, `source`, and `revoked` (a `true`
  flag delists the entry from search and refuses install).
- `[[entry.version]]` per version (semver): `version`, `status`
  (`pending-release` for seeds, `released` when binaries are populated),
  `ed25519_sig`, plus `camouflage` and `rate_limit` flags derived from the Lab
  report.
- Nested tables per version:
  - `[entry.version.lab_report]` mirrors `lab-report.json`: `passed`, the gate
    list, `tool_count`, `transport` (always `streamable-http`), and
    `residual_unverified_surface` (what a PASS does not prove).
  - `[entry.version.gateway_manifest]`: derived read/write counts and
    `safety_classes` (GET/HEAD count READ, every other method counts WRITE).
  - `[entry.version.auth]`: `auth_scheme`, `hermes_service`, `hermes_scheme`,
    derived from the server's `.env.example` `hermescred://` reference.
  - `[[entry.version.platform]]`: one table per OS/arch with `url` and `sha256`,
    written at publish time only.

The Ed25519 signature covers deterministic canonical bytes over the version
identity plus the sorted per-platform `os/arch sha256` lines, so a swapped
binary or a tampered checksum invalidates the signature.

## Security notes

- **Integrity before install.** A binary is downloaded to a temp file, sha256-
  verified against the index, and Ed25519-verified against a trusted key BEFORE
  it is moved into `THESUN_HOME/servers`. Verification failure writes nothing.
- **Revocation.** Set `revoked = true` on an entry in the index to delist it
  from search and refuse new installs. Revocation is index-driven, so it takes
  effect as soon as the CLI next fetches the index.
- **Trusted keys.** The compiled-in curated public key lives in
  `curatedPubKeyB64` (`cmd/thesun/registry.go`). Operators can trust additional
  keys by adding base64 lines to `THESUN_HOME/trusted_keys` (one per line;
  `#` comments allowed).
- **Runtime containment.** The gateway classifies every added server's tools;
  WRITE/DELETE/outbound land in Tier-B and need out-of-band human `thesun
  approve`. A store install never widens the fleet's blast radius past the
  gateway floor.

## Current rollout status (honest caveats)

- The compiled-in curated public key (`curatedPubKeyB64` in
  `fleet/fleetd/cmd/thesun/registry.go`) is **populated**, not empty. Earlier revisions of
  this doc described it as an empty placeholder; that is out of date. Because it is
  non-empty, it is loaded as a trusted verifier for the curated tier, so curated signature
  verification does not depend on operator-provided keys the way it did while the constant
  was blank.
  **Unconfirmed, needs operator confirmation:** whether the value currently compiled in is
  the production rollout key or a pre-rollout test key. Nothing in the repo distinguishes
  the two, and this doc does not guess. Until an operator confirms which it is, treat a
  curated signature check as "verified against the compiled-in key" rather than "verified
  against the production maintainer key".
- Operators can still trust additional keys by adding base64 lines to
  `THESUN_HOME/trusted_keys` (one per line). That path is unchanged and is what makes local
  end-to-end testing possible.
- The seed index entries are `pending-release`: their binary URLs and checksums
  are not populated until the first CI publish. Real platform binaries, URLs,
  and sha256 values land with the first CI release run.
</content>
</invoke>
