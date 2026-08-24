#!/usr/bin/env bash
# Hermes broker launchd preflight + start wrapper.
#
# WHY: two recurring rot vectors take the broker's refresh/propagation down
# silently (diagnosed 2026-05-29):
#   1. `brew upgrade` leaves /opt/homebrew/bin/thv a dangling symlink to a
#      deleted Cellar version -> Hermes propagation lane spawns thv -> ENOENT.
#   2. A commit/pull lands after the last build -> launchd serves stale dist.
#
# This wrapper self-heals #1 on every start (idempotent, safe) and LOUDLY
# warns on #2 (it does NOT rebuild in the start path: a failed `pnpm build`
# does `rm -rf dist` and would leave the broker unable to start, turning a
# warning into an outage. Rebuilds happen in the git post-merge hook instead,
# where a build failure is visible and the running broker keeps old dist).
#
# Best-effort: every self-heal step is non-fatal. The wrapper always ends by
# exec'ing the broker so launchd tracks the node PID directly (exec replaces
# this shell — KeepAlive still monitors the real process).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
NODE="$(command -v node)"
LOG="${HOME}/.hermes/logs/hermes-preflight.log"
CHECK_ONLY="${1:-}"

mkdir -p "${HOME}/.hermes/logs" 2>/dev/null || true
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [preflight] $*" >>"$LOG" 2>&1; }

# 1. thv resolvability — repair dangling brew symlink (root cause #2 of 2026-05-29)
if ! thv version >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    log "thv unresolvable -> brew link --overwrite thv"
    if brew link --overwrite thv >>"$LOG" 2>&1 && thv version >/dev/null 2>&1; then
      log "thv repaired: $(thv version 2>&1 | head -1)"
    else
      log "thv repair FAILED (continuing; propagation lane may be degraded until fixed)"
    fi
  else
    log "thv unresolvable and brew not on PATH (continuing)"
  fi
fi

# 2. stale-dist detection — WARN only, never rebuild here (see header)
if [ -f "$REPO/packages/broker/dist/cli.js" ]; then
  stale_src="$(find "$REPO"/packages/*/src -name '*.ts' -newer "$REPO/packages/broker/dist/cli.js" -print -quit 2>/dev/null)"
  if [ -n "$stale_src" ]; then
    log "WARN stale dist: source newer than compiled cli.js (e.g. $stale_src). Run 'pnpm build' + kickstart. Serving existing dist."
  fi
else
  log "WARN dist/cli.js missing — broker will fail to start until 'pnpm build' runs"
fi

if [ "$CHECK_ONLY" = "--check-only" ]; then
  log "check-only mode: self-heal complete, not starting broker"
  exit 0
fi

log "starting broker"
exec "$NODE" "$REPO/packages/broker/dist/cli.js" start
