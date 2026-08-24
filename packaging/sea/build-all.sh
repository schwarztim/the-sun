#!/usr/bin/env bash
# packaging/sea/build-all.sh — build Node SEA (single-executable-application)
# binaries for gateway and hermes, for every thesun release target platform.
#
# Pipeline per subsystem:
#   1. bundle.mjs   — esbuild the already-built `dist/` output into one CJS file
#   2. blob-gen     — `node --experimental-sea-config` produces the SEA prep
#                      blob from that bundle (MUST use the pinned NODE_VERSION —
#                      see build-sea.sh header)
#   3. build-sea.sh — per target OS/arch: download the official Node runtime of
#                      the SAME pinned version, inject the blob, (macOS) sign
#
# Output layout (consumed by .goreleaser.yml's `archives.files`):
#   dist-sea/gateway/<os>_<arch>/gateway[.exe]
#   dist-sea/hermes/<os>_<arch>/hermes[.exe]
#
# Requires: gateway/dist and hermes/packages/broker/dist already built
# (`npm run build` / `pnpm -r build` — see install.sh). Does not build them
# itself so it can be re-run quickly while iterating on the SEA step alone.
set -euo pipefail

SEA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SEA_DIR/../.." && pwd -P)"
OUT_ROOT="$ROOT/dist-sea"
NODE_VERSION="${THESUN_SEA_NODE_VERSION:-v26.4.0}"

# thesun's release targets — kept in lockstep with .goreleaser.yml's
# `builds[].goos`/`goarch` matrix (minus goreleaser's own `ignore:` entries).
TARGETS=(
  "darwin amd64"
  "darwin arm64"
  "linux amd64"
  "linux arm64"
  "windows amd64"
)

# gateway/hermes externals — native addons and dynamic-import-only browser
# automation deps that cannot be single-file bundled. See docs/PACKAGING.md
# "Node runtime bundling" for the rationale on each entry.
GATEWAY_EXTERNAL="fsevents"
HERMES_EXTERNAL="@napi-rs/keyring,patchright,patchright-core,playwright,playwright-core,pino-pretty,fsevents,lightningcss,@rolldown/binding-darwin-arm64,@rolldown/binding-darwin-x64,@rolldown/binding-linux-x64-gnu,@rolldown/binding-linux-arm64-gnu,@rolldown/binding-win32-x64-msvc"

mkdir -p "$OUT_ROOT"

# Host platform used ONLY to generate the version-pinned SEA blob (blob
# content is pure JS/resource data — not platform-specific — so a blob
# generated on the build host is valid to inject into every target's binary,
# as long as the Node VERSION matches exactly; verified cross-arch under
# Rosetta 2026-07-06). We still fetch the official tarball for this exact
# version rather than trust whatever `node` is on PATH, since a locally
# installed Node (e.g. Homebrew's) may be a different build/version and may
# also be dynamically linked against a separate libnode dylib, which is not
# portable and not what a shipped SEA binary should assume.
host_uname_os="$(uname -s)"
host_uname_arch="$(uname -m)"
case "$host_uname_os" in
  Darwin) host_os="darwin" ;;
  Linux)  host_os="linux" ;;
  *) echo "build-all: unsupported build host OS '$host_uname_os' — SEA blobs must be generated on macOS or Linux" >&2; exit 2 ;;
esac
case "$host_uname_arch" in
  arm64|aarch64) host_arch="arm64" ;;
  x86_64|amd64)  host_arch="amd64" ;;
  *) echo "build-all: unsupported build host arch '$host_uname_arch'" >&2; exit 2 ;;
esac

CACHE_DIR="${THESUN_SEA_CACHE:-$SEA_DIR/.cache}"
mkdir -p "$CACHE_DIR"
host_dist_name="node-${NODE_VERSION}-${host_os}-${host_arch}"
host_node_dir="$CACHE_DIR/${host_dist_name}"
if [ ! -d "$host_node_dir" ]; then
  echo "build-all: fetching host blob-gen runtime ${host_dist_name}"
  curl -fsSL -o "$CACHE_DIR/${host_dist_name}.tar.gz" \
    "https://nodejs.org/dist/${NODE_VERSION}/${host_dist_name}.tar.gz"
  tar -xzf "$CACHE_DIR/${host_dist_name}.tar.gz" -C "$CACHE_DIR"
fi
BLOB_GEN_NODE="$host_node_dir/bin/node"
[ -x "$BLOB_GEN_NODE" ] || { echo "build-all: $BLOB_GEN_NODE missing after extraction" >&2; exit 1; }
echo "build-all: pinned Node $NODE_VERSION — blob-gen via $BLOB_GEN_NODE"

build_subsystem() {
  local name="$1" entry="$2" cwd="$3" external="$4" binname="$5"

  echo "== $name =="
  local bundle="$OUT_ROOT/${name}.bundle.cjs"
  node "$SEA_DIR/bundle.mjs" --entry "$entry" --outfile "$bundle" --cwd "$cwd" --external "$external"

  local sea_config="$OUT_ROOT/${name}.sea-config.json"
  local blob="$OUT_ROOT/${name}.blob"
  cat > "$sea_config" <<EOF
{
  "main": "$bundle",
  "output": "$blob",
  "disableExperimentalSEAWarning": true
}
EOF
  "$BLOB_GEN_NODE" --experimental-sea-config "$sea_config"

  for target in "${TARGETS[@]}"; do
    read -r t_os t_arch <<< "$target"
    local outname="$binname"
    [ "$t_os" = "windows" ] && outname="${binname}.exe"
    local outdir="$OUT_ROOT/$name/${t_os}_${t_arch}"
    "$SEA_DIR/build-sea.sh" "$bundle" "$blob" "$outdir/$outname" "$t_os" "$t_arch" "$NODE_VERSION"
  done
}

build_subsystem "gateway" "dist/index.js" "$ROOT/gateway" "$GATEWAY_EXTERNAL" "gateway"
build_subsystem "hermes" "dist/cli.js" "$ROOT/hermes/packages/broker" "$HERMES_EXTERNAL" "hermes"

echo
echo "build-all: done. Binaries under $OUT_ROOT/{gateway,hermes}/<os>_<arch>/"
