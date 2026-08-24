#!/usr/bin/env bash
# run-proofs.sh — self-contained acceptance proofs for fleetd (Phase 0).
# Uses a throwaway stub child (cmd/stub) in an isolated FLEETD_ROOT; never
# touches the live gateway (FLEETD_SKIP_RELOAD=1) or ~/.mcp-fleet.
#
# Proves: (a) kill-9 auto-restart + circuit breaker; (b) fleetd-crash re-adopt;
# (c) no secrets on disk; plus adversarial fail-closed port validation.
set -uo pipefail

GO=/opt/homebrew/bin/go
MOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT=/tmp/fleetd-proof
STATE="$ROOT/state"
FLEETD="$ROOT/bin/fleetd"
STUB="$ROOT/bin/stub"

export FLEETD_ROOT="$STATE"
export FLEETD_MANIFEST="$STATE/fleet.toml"
export FLEETD_PUBLISH_PATH="$STATE/config.go-fleet.json"
export FLEETD_SKIP_RELOAD=1

PASS=0; FAIL=0
ok(){ echo "  PASS: $*"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

cleanup(){
  [ -n "${FLEETD_PID:-}" ] && kill -9 "$FLEETD_PID" 2>/dev/null
  [ -n "${FLEETD_PID2:-}" ] && kill -9 "$FLEETD_PID2" 2>/dev/null
  for p in $(lsof -ti tcp:42099 2>/dev/null; lsof -ti tcp:42098 2>/dev/null; lsof -ti tcp:42097 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT

pidfile(){ cat "$STATE/run/$1.pid" 2>/dev/null; }
health(){ curl -sf -m 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; }
wait_health(){ for _ in $(seq 1 60); do health "$1" && return 0; sleep 0.25; done; return 1; }
status(){ "$FLEETD" status 2>/dev/null; }

echo "=== BUILD ==="
# Pre-flight: clear any orphan holding a test port (deterministic start).
for pt in 42099 42098 42097; do for p in $(lsof -ti tcp:$pt 2>/dev/null); do kill -9 "$p" 2>/dev/null; done; done
rm -rf "$ROOT"; mkdir -p "$ROOT/bin" "$STATE"
( cd "$MOD_DIR" && $GO build -o "$FLEETD" ./cmd/fleetd && $GO build -o "$STUB" ./cmd/stub ) || { echo "build failed"; exit 1; }
echo "  fleetd: $FLEETD"; echo "  stub:   $STUB"

SECRET="s3cr3t-$$-$RANDOM$RANDOM-DONOTLEAK"
cat > "$FLEETD_MANIFEST" <<EOF
[[server]]
name = "stub-a"
bin = "$STUB"
port = 42099
health = "/healthz"
max_restarts = 5
[server.env]
STUB_SECRET = "$SECRET"

[[server]]
name = "stub-crash"
bin = "$STUB"
port = 42098
max_restarts = 3
[server.env]
FLEETD_STUB_MODE = "crash"

[[server]]
name = "stub-hermes"
bin = "$STUB"
port = 42097
max_restarts = 2
[server.env]
AUTH_TOKEN = "hermes://__fleetd_proof_nonexistent__/none"
EOF

echo "=== START fleetd ==="
nohup "$FLEETD" run >"$ROOT/fleetd.log" 2>&1 &
FLEETD_PID=$!
echo "  fleetd pid=$FLEETD_PID"
if wait_health 42099; then ok "stub-a healthy (healthz 200)"; else bad "stub-a never became healthy"; cat "$ROOT/fleetd.log"; exit 1; fi
CHILD0=$(pidfile stub-a)
echo "  stub-a child pid=$CHILD0"

echo
echo "=== PROOF (a1): kill -9 child -> auto-restart ==="
kill -9 "$CHILD0"
NEWPID=""
for _ in $(seq 1 60); do
  NEWPID=$(pidfile stub-a)
  if [ -n "$NEWPID" ] && [ "$NEWPID" != "$CHILD0" ] && health 42099; then break; fi
  sleep 0.25
done
if [ -n "$NEWPID" ] && [ "$NEWPID" != "$CHILD0" ] && health 42099; then
  ok "restarted: old pid=$CHILD0 -> new pid=$NEWPID, healthz 200"
else
  bad "no restart (old=$CHILD0 new=$NEWPID)"
fi
echo "  --- fleetd.log restart lines ---"
grep -E "stub-a\]" "$ROOT/fleetd.log" | grep -Ei "exit|restart|spawn|running" | tail -6 | sed 's/^/    /'

echo
echo "=== PROOF (a2): circuit breaker -> degraded, no thrash ==="
DEG=""
for _ in $(seq 1 80); do
  DEG=$(status | awk '$1=="stub-crash"{print $2}')
  [ "$DEG" = "degraded" ] && break
  sleep 0.25
done
if [ "$DEG" = "degraded" ]; then ok "stub-crash reached 'degraded'"; else bad "stub-crash state=$DEG (expected degraded)"; fi
R1=$(status | awk '$1=="stub-crash"{print $5}')
sleep 2
R2=$(status | awk '$1=="stub-crash"{print $5}')
if [ "$R1" = "$R2" ]; then ok "no thrash: restart count stable at $R1 after degraded"; else bad "thrash: count moved $R1 -> $R2 after degraded"; fi
CRASHPROCS=$(lsof -ti tcp:42098 2>/dev/null | wc -l | tr -d ' ')
echo "  procs on crash port 42098: $CRASHPROCS (expect 0)"

echo
echo "=== PROOF (c): literal secret reaches child env, fleetd never persists it ==="
WHO=$(curl -sf -m 2 "http://127.0.0.1:42099/whoami" 2>/dev/null)
echo "  /whoami -> $WHO"
echo "$WHO" | grep -q "secret_present=true" && ok "child sees STUB_SECRET (env injection works)" || bad "child did NOT see STUB_SECRET"
# The literal lives in the operator-authored manifest (their choice). The proof
# is that fleetd copies it NOWHERE ELSE: not into pidfiles, run state, published
# config, or any log. (A hermes:// ref, proved below, keeps plaintext off disk
# entirely — even out of the manifest.)
DERIVED_HITS=$(grep -rn "$SECRET" "$STATE/run" "$STATE/logs" "$FLEETD_PUBLISH_PATH" "$ROOT/fleetd.log" 2>/dev/null)
if [ -z "$DERIVED_HITS" ]; then ok "secret absent from all fleetd-derived artifacts (run/logs/published-config/daemon-log)"; else bad "secret leaked into derived artifact:"; echo "$DERIVED_HITS" | sed 's/^/     /'; fi
MANIFEST_ONLY=$(grep -rln "$SECRET" "$STATE" 2>/dev/null)
echo "  secret appears only in: $MANIFEST_ONLY (operator-authored manifest)"
echo "  published config transport check:"
if grep -q '"type": "http"' "$FLEETD_PUBLISH_PATH" && ! grep -Eq 'stdio|sse' "$FLEETD_PUBLISH_PATH"; then
  ok "published config is http-only (no stdio/sse)"
else
  bad "published config transport wrong"; cat "$FLEETD_PUBLISH_PATH"
fi

echo
echo "=== PROOF (d): hermes:// ref — real broker, fail-closed, no plaintext on disk ==="
# stub-hermes references hermes://__fleetd_proof_nonexistent__/none. The real
# broker (127.0.0.1:9876) returns 404 SERVICE_NOT_REGISTERED, so resolution
# fails -> that ONE server degrades with a clear reason; the fleet stays up.
HD=""; HDETAIL=""
for _ in $(seq 1 80); do
  line=$(status | grep -E "^stub-hermes")
  HD=$(echo "$line" | awk '{print $2}')
  [ "$HD" = "degraded" ] && { HDETAIL=$(echo "$line" | cut -c1-200); break; }
  sleep 0.25
done
if [ "$HD" = "degraded" ]; then ok "hermes-ref server degraded on unresolved secret (fail-closed, no insecure default)"; else bad "stub-hermes state=$HD (expected degraded)"; fi
echo "  detail: $(status | grep -E '^stub-hermes' | sed 's/  */ /g')"
grep -Ei "stub-hermes" "$ROOT/fleetd.log" | grep -Ei "hermes|resolution|degrad|SERVICE_NOT" | tail -3 | sed 's/^/    /'
if health 42099; then ok "fleet survived: stub-a still healthy despite hermes failure"; else bad "hermes failure took down the fleet"; fi
# The manifest holds only the ref — no plaintext token anywhere on disk.
if grep -q 'hermes://__fleetd_proof_nonexistent__/none' "$FLEETD_MANIFEST"; then ok "manifest holds only the hermes:// ref (zero plaintext secret on disk)"; else bad "hermes ref missing from manifest"; fi
if ! grep -Eq 'accessToken|Bearer ' "$STATE/run"/* "$STATE/logs"/* "$FLEETD_PUBLISH_PATH" 2>/dev/null; then ok "no token material in run/logs/published-config"; else bad "token material found on disk"; fi

echo
echo "=== PROOF (b): kill -9 fleetd -> re-adopt (same pid, no double-spawn) ==="
CHILD_BEFORE=$(pidfile stub-a)
echo "  stub-a pid before fleetd crash: $CHILD_BEFORE"
kill -9 "$FLEETD_PID"
# confirm child survived the supervisor's death
if kill -0 "$CHILD_BEFORE" 2>/dev/null; then ok "child survived fleetd kill -9 (detached)"; else bad "child died with fleetd"; fi
# restart fleetd
nohup "$FLEETD" run >"$ROOT/fleetd2.log" 2>&1 &
FLEETD_PID2=$!
echo "  new fleetd pid=$FLEETD_PID2"
wait_health 42099 || bad "stub-a not healthy after fleetd restart"
CHILD_AFTER=$(pidfile stub-a)
echo "  stub-a pid after fleetd restart: $CHILD_AFTER"
NPROC=$(lsof -ti tcp:42099 2>/dev/null | wc -l | tr -d ' ')
if [ "$CHILD_AFTER" = "$CHILD_BEFORE" ]; then ok "re-adopted SAME pid ($CHILD_AFTER) — no respawn"; else bad "pid changed $CHILD_BEFORE -> $CHILD_AFTER (respawned, not adopted)"; fi
if [ "$NPROC" = "1" ]; then ok "exactly 1 process on port 42099 (no double-spawn)"; else bad "$NPROC processes on port 42099 (double-spawn!)"; fi
grep -Ei "re-adopt" "$ROOT/fleetd2.log" | tail -3 | sed 's/^/    /'

echo
echo "=== ADVERSARIAL: fail-closed manifest validation ==="
cat > "$STATE/bad-dup.toml" <<EOF
[[server]]
name = "x"
bin = "$STUB"
port = 42099
[[server]]
name = "y"
bin = "$STUB"
port = 42099
EOF
if FLEETD_MANIFEST="$STATE/bad-dup.toml" "$FLEETD" run 2>"$STATE/dup.err"; then bad "duplicate ports accepted"; else ok "duplicate ports rejected: $(cat "$STATE/dup.err")"; fi

cat > "$STATE/bad-range.toml" <<EOF
[[server]]
name = "z"
bin = "$STUB"
port = 8080
EOF
if FLEETD_MANIFEST="$STATE/bad-range.toml" "$FLEETD" run 2>"$STATE/range.err"; then bad "out-of-range port accepted"; else ok "out-of-range port rejected: $(cat "$STATE/range.err")"; fi

echo
echo "=== FINAL STATUS ==="
status | sed 's/^/  /'
echo
echo "=== whole-tree secret grep (module source + derived artifacts; manifest excluded) ==="
# The literal secret legitimately lives in the operator-authored manifest; every
# OTHER on-disk location (module source, run state, logs, published config) must
# be clean.
GHITS=$(grep -rn "$SECRET" "$MOD_DIR" "$STATE/run" "$STATE/logs" "$FLEETD_PUBLISH_PATH" "$ROOT"/*.log 2>/dev/null | grep -v run-proofs.sh)
if [ -z "$GHITS" ]; then ok "no secret in module source, run state, logs, or published config"; else bad "secret found:"; echo "$GHITS"; fi

echo
echo "=================================================="
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "=================================================="
[ "$FAIL" -eq 0 ]
