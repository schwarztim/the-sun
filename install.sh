#!/usr/bin/env bash
# install.sh — build every subsystem so `thesun` runs as one tool.
# Idempotent. Builds: generator (Node), fleet (Go), default servers (atlassian +
# servicenow Go, vendored ms365 Node), gateway (Node), hermes (pnpm).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ok() { echo "  ✓ $*"; }
skip() { echo "  – $* (skipped)"; }
fail() { echo "  ✗ $*"; }

have() { command -v "$1" >/dev/null 2>&1; }
is_num() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }

# Version floors. Match what the code actually needs, so a present-but-too-old
# runtime fails HERE with a copy-pasteable fix instead of mid-build with a raw
# tsc/toolchain error:
#   node >= 18   generator/package.json "engines": { "node": ">=18.0.0" } (the
#                lowest declared floor; gateway/hermes declare none)
#   go   >= 1.26 the `go` directive in fleet/fleetd/go.mod (an older toolchain
#                refuses to build a module that requires a newer go directive)
NODE_MIN_MAJOR=18
GO_MIN_MAJOR=1
GO_MIN_MINOR=26

# preflight: only enforces the floor for a runtime that is actually present. An
# absent tool is not an error here (the matching subsystem steps below already
# skip); the real failure mode this guards is present-but-too-old.
preflight() {
  echo "▶ preflight (runtime versions)"

  if have node; then
    node_raw="$(node --version 2>/dev/null)"           # e.g. v24.3.0
    node_major="${node_raw#v}"; node_major="${node_major%%.*}"
    if is_num "$node_major" && [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
      fail "node $node_raw is too old (need >= ${NODE_MIN_MAJOR}.x for the generator/gateway/hermes TypeScript build)"
      echo
      echo "  fix: install Node >= ${NODE_MIN_MAJOR}, then re-run: bash install.sh"
      echo "       nvm:   nvm install ${NODE_MIN_MAJOR} && nvm use ${NODE_MIN_MAJOR}"
      echo "       brew:  brew install node"
      echo "       else:  https://nodejs.org/en/download"
      exit 1
    fi
    ok "node $node_raw (>= ${NODE_MIN_MAJOR}.x)"
  else
    fail "node is not on PATH"
    echo
    echo "  node >= ${NODE_MIN_MAJOR} is required: the generator, gateway, and hermes are all TypeScript."
    echo "  re-run without --no-bootstrap to install it, or install it yourself:"
    echo "    https://nodejs.org/en/download   (macOS: brew install node)"
    exit 1
  fi

  if have go; then
    go_ver="$(go version 2>/dev/null | awk '{print $3}')"; go_ver="${go_ver#go}"   # 1.26.0
    go_major="${go_ver%%.*}"
    go_rest="${go_ver#*.}"; go_minor="${go_rest%%.*}"
    if is_num "$go_major" && is_num "$go_minor"; then
      if [ "$go_major" -lt "$GO_MIN_MAJOR" ] || { [ "$go_major" -eq "$GO_MIN_MAJOR" ] && [ "$go_minor" -lt "$GO_MIN_MINOR" ]; }; then
        fail "go $go_ver is too old (fleet/fleetd/go.mod requires go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR})"
        echo
        echo "  fix: install Go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR}, then re-run: bash install.sh"
        echo "       https://go.dev/dl/  (or your package manager, e.g. brew install go)"
        exit 1
      fi
    fi
    ok "go $go_ver (>= ${GO_MIN_MAJOR}.${GO_MIN_MINOR})"
  else
    fail "go is not on PATH"
    echo
    echo "  go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR} is required: without it there is no fleetd and no"
    echo "  \`thesun\` binary at all, so the install would report success and leave nothing runnable."
    echo "  re-run without --no-bootstrap to install it, or install it yourself:"
    echo "    https://go.dev/dl/   (macOS: brew install go)"
    exit 1
  fi
}

# ─── bootstrap: obtain missing prerequisites ──────────────────────────────────
#
# A bare machine is the normal case for someone receiving this, not the
# exception. Without this, an absent runtime silently SKIPS its subsystem and
# the install reports success while leaving a stack that cannot run: no `go`
# means no fleetd and no `thesun` binary at all. So: try to install what is
# missing, and if it is still missing afterwards, FAIL rather than skip.
#
# Homebrew itself is never installed automatically. Doing that means piping a
# remote script into a shell unattended, which is a supply-chain decision that
# belongs to the person at the keyboard, not to this script. It is printed
# instead.
#
# --no-bootstrap skips this entirely for air-gapped or centrally-managed hosts.

BOOTSTRAP=1
for arg in "$@"; do
  case "$arg" in
    --no-bootstrap) BOOTSTRAP=0 ;;
    -h|--help)
      echo "usage: bash install.sh [--no-bootstrap]"
      echo "  --no-bootstrap   do not attempt to install missing prerequisites"
      exit 0 ;;
  esac
done

pkg_manager() {
  case "$(uname -s)" in
    Darwin) have brew && echo brew ;;
    Linux)
      if   have apt-get; then echo apt
      elif have dnf;     then echo dnf
      elif have pacman;  then echo pacman
      fi ;;
  esac
}

# Map a required tool to its package name for one package manager. Kept as a
# case rather than an associative array: bash 3.2 ships on macOS and has none.
pkg_name_for() {
  case "$1:$2" in
    brew:go) echo go ;;   brew:node) echo node ;;   brew:git) echo git ;;
    apt:go) echo golang-go ;; apt:node) echo nodejs ;; apt:git) echo git ;;
    dnf:go) echo golang ;;    dnf:node) echo nodejs ;; dnf:git) echo git ;;
    pacman:go) echo go ;;     pacman:node) echo nodejs ;; pacman:git) echo git ;;
  esac
}

install_pkg() {
  pm="$1"; tool="$2"
  name="$(pkg_name_for "$pm" "$tool")"
  [ -n "$name" ] || return 1
  echo "    installing $tool ($pm: $name)…"
  case "$pm" in
    brew)   brew install "$name" >/dev/null 2>&1 ;;
    apt)    sudo apt-get install -y "$name" >/dev/null 2>&1 ;;
    dnf)    sudo dnf install -y "$name" >/dev/null 2>&1 ;;
    pacman) sudo pacman -S --noconfirm "$name" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

bootstrap_prereqs() {
  echo "▶ bootstrap (prerequisites)"

  missing=""
  for t in git node go; do have "$t" || missing="$missing $t"; done
  # pnpm is handled separately: corepack ships with Node, so it never needs a
  # package manager and must be attempted only after node exists.
  if [ -z "$missing" ]; then
    ok "git, node, and go already present"
  else
    if [ "$BOOTSTRAP" -eq 0 ]; then
      skip "bootstrap disabled (--no-bootstrap); missing:$missing"
    else
      pm="$(pkg_manager)"
      if [ -z "$pm" ]; then
        fail "missing:$missing: and no supported package manager was found"
        echo
        case "$(uname -s)" in
          Darwin)
            echo "  macOS needs Homebrew to install these automatically. Install it once:"
            echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            echo "  then re-run: bash install.sh"
            echo
            echo "  Or install them by hand:  https://go.dev/dl/   https://nodejs.org/en/download" ;;
          *)
            echo "  install git, node (>= ${NODE_MIN_MAJOR}) and go (>= ${GO_MIN_MAJOR}.${GO_MIN_MINOR}) with your"
            echo "  distribution's package manager, then re-run: bash install.sh" ;;
        esac
        exit 1
      fi
      echo "    package manager: $pm"
      for t in $missing; do
        install_pkg "$pm" "$t" || true
      done
      # Re-check. A package manager can succeed and still not put the tool on
      # PATH for THIS shell, which would otherwise look like a failed install.
      still=""
      for t in $missing; do have "$t" || still="$still $t"; done
      if [ -n "$still" ]; then
        fail "still missing after bootstrap:$still"
        echo
        echo "  the package manager ran but these are not on PATH in this shell."
        echo "  open a new terminal and re-run: bash install.sh"
        exit 1
      fi
      ok "installed:$missing"
    fi
  fi

  # pnpm via corepack: bundled with Node, so no download and no extra trust.
  if ! have pnpm; then
    if have corepack; then
      echo "    enabling pnpm via corepack…"
      corepack enable pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    fi
    if ! have pnpm && have npm; then
      echo "    installing pnpm via npm…"
      npm install -g pnpm >/dev/null 2>&1 || true
    fi
    if have pnpm; then ok "pnpm enabled"; else fail "pnpm unavailable (hermes will not build)"; fi
  else
    ok "pnpm present"
  fi
}

echo "installing thesun (one tool: generate → run → route → authenticate)…"

bootstrap_prereqs
preflight

# 1) generator (Node/TypeScript)
echo "▶ generator"
if [ -f "$ROOT/generator/package.json" ] && have npm; then
  ( cd "$ROOT/generator" && npm install --silent && npm run build --silent ) && ok "generator built" || fail "generator build failed"
else skip "generator (no package.json or npm)"; fi

# 2) fleet (Go: fleetd + generated servers)
echo "▶ fleet"
if [ -d "$ROOT/fleet/fleetd" ] && have go; then
  ( cd "$ROOT/fleet/fleetd" \
      && go build -o bin/fleetd ./cmd/fleetd \
      && go build -o "$ROOT/bin/thesun" ./cmd/thesun ) \
    && ok "fleetd + thesun CLI built" || fail "fleet build failed"
else skip "fleet (no fleetd dir or go)"; fi

# 3) default MCP servers (Go: atlassian + servicenow; Node: vendored ms365)
# thesun ships ONLY these built-in defaults in-tree; they are the offline
# fallback so a fresh install stands up a working stack with no network. Every
# other curated server now lives in the separate thesun-servers repo and is
# installed on demand from the signed registry with `thesun add <name>` (which
# verifies the SHA-256 + Ed25519 signature before it touches the manifest). See
# docs/MCP-STORE.md.
# Non-fatal: a failure here leaves a default server unbuilt (doctor/status will
# flag it FAIL) but must never abort the whole install.
echo "▶ default servers"
if have go; then
  for name in atlassian servicenow; do
    d="$ROOT/fleet/servers/generated/$name"
    if [ -d "$d" ]; then
      ( cd "$d" && go build -o "bin/$name-mcp" . ) \
        && ok "$name-mcp built" \
        || fail "$name-mcp build failed (default server stays unavailable until fixed)"
    else skip "$name-mcp (no source at $d)"; fi
  done
else skip "default Go servers (no go)"; fi
# ms365 is optional: only wire it when the vendored package is present. Absent is
# fine (no npm fetch of a missing server); the default is skipped, not failed.
if [ -f "$ROOT/servers/vendor/ms365/package.json" ]; then
  if have npm; then
    ( cd "$ROOT/servers/vendor/ms365" && npm install --silent ) \
      && ok "ms365 vendor deps installed (device-code login still needed before first use)" \
      || fail "ms365 vendor npm install failed"
  else skip "ms365 vendor (no npm)"; fi
else skip "ms365 default server not vendored; see servers/vendor/ms365/README.md or run \`thesun add\`"; fi

# 4) gateway (Node/TypeScript)
echo "▶ gateway"
if [ -f "$ROOT/gateway/package.json" ] && have npm; then
  ( cd "$ROOT/gateway" && npm install --silent && npm run build --silent ) && ok "gateway built" || fail "gateway build failed"
else skip "gateway (no package.json or npm)"; fi

# 5) hermes (pnpm monorepo)
echo "▶ hermes"
if [ -f "$ROOT/hermes/package.json" ]; then
  if have pnpm; then
    ( cd "$ROOT/hermes" && pnpm install --silent && pnpm run build ) && ok "hermes built" || fail "hermes build failed"
  else fail "hermes needs pnpm (npm i -g pnpm)"; fi
else skip "hermes (no package.json)"; fi

# 6) CLI on PATH
chmod +x "$ROOT/bin/thesun" 2>/dev/null && ok "thesun CLI executable at $ROOT/bin/thesun"

# 7) durable PATH: symlink bin/thesun into a standard bin dir so `thesun` works
# in new shells without editing any rc file. Idempotent (a correct symlink is
# left as-is) and non-clobbering (a DIFFERENT existing thesun is never
# overwritten, only noted). Prefers /usr/local/bin, falls back to ~/.local/bin.
persist_path() {
  src="$ROOT/bin/thesun"
  if [ ! -x "$src" ]; then skip "PATH link (bin/thesun not built)"; return; fi

  # Note (do not touch) any different thesun already resolvable on PATH.
  existing="$(command -v thesun 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$src" ] && [ "$(readlink "$existing" 2>/dev/null)" != "$src" ]; then
    fail "a different 'thesun' is already on PATH at $existing (left untouched)"
    echo "     to prefer this build: export PATH=\"$ROOT/bin:\$PATH\""
  fi

  # Pick the first writable standard bin dir (create ~/.local/bin if needed).
  target_dir=""
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    target_dir="/usr/local/bin"
  else
    mkdir -p "$HOME/.local/bin" 2>/dev/null || true
    if [ -w "$HOME/.local/bin" ]; then target_dir="$HOME/.local/bin"; fi
  fi
  if [ -z "$target_dir" ]; then
    skip "PATH link (no writable /usr/local/bin or ~/.local/bin)"
    echo "     add thesun to PATH manually: export PATH=\"$ROOT/bin:\$PATH\""
    return
  fi

  link="$target_dir/thesun"
  if [ -L "$link" ] && [ "$(readlink "$link" 2>/dev/null)" = "$src" ]; then
    ok "thesun already on PATH: $link -> $src"
  elif [ -e "$link" ] || [ -L "$link" ]; then
    fail "$link already exists and points elsewhere (left untouched, not clobbered)"
    echo "     to prefer this build: export PATH=\"$ROOT/bin:\$PATH\""
  elif ln -s "$src" "$link" 2>/dev/null; then
    ok "linked thesun onto PATH: $link -> $src"
    case ":$PATH:" in
      *":$target_dir:"*) : ;;
      *) echo "     note: $target_dir is not on your PATH yet; add it: export PATH=\"$target_dir:\$PATH\"" ;;
    esac
  else
    skip "PATH link failed; add thesun to PATH manually: export PATH=\"$ROOT/bin:\$PATH\""
  fi
}
persist_path

echo
echo "done. next:"
echo "  export PATH=\"$ROOT/bin:\$PATH\"   # fallback: only if the PATH link above was skipped"
echo "  thesun up        # start hermes → fleetd → gateway"
echo "  thesun status    # whole-stack health"
