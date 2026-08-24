# MCP Fleet Migration — Docker/ToolHive → Static Go Binaries + Gateway

> Design by a Fable-model architect (2026-07-03) from a pre-gathered fact pack. Read-only design; no implementation. Companion: the fact pack at the session scratchpad (`go-migration-fact-pack.md`).

## Governing insights
1. **The gateway is transport-pure** — it consumes `url: http://127.0.0.1:<port>/mcp` entries from `~/.config/mcpu/config.generated.json` (schema `{"mcpServers":{"<name>":{"url":"...","transport":{"type":"http"}}}}`) + static `backends:`, strips stdio, quarantines `command:`. It doesn't care HOW a backend runs. **The whole migration happens below the gateway's contract line.**
2. **The fleet is not homogeneous — migrate by trust tier, not 100% Go:**

| Tier | Examples | Route |
|---|---|---|
| **T1** thesun-generated, operator-authored (the majority of the fleet) | Python/FastMCP, http-native in containers | **Regenerate as static Go binaries** (the core) |
| **T2** third-party, native-http capable (github [official Go server w/ http], playwright `--port`, azure) | **Run the vendor binary directly under the supervisor** — no container, no rewrite |
| **T3** third-party, stdio-only (for example an npx-launched server, or a socket-bridge server) | **Stay on ToolHive/Docker** as shrinking residue. Do NOT build a host-side stdio re-fronting shim (recreates the proven-deadlock architecture + violates the transport rule) |

Isolation follows trust class.

## 1. Go MCP server template
SDK: `github.com/modelcontextprotocol/go-sdk` (official). Typed-tool API (structs auto-derive JSON Schema — diffable vs the Python originals) + `mcp.NewStreamableHTTPHandler`. Serve `/mcp` on `MCP_HOST:MCP_PORT` from env; **stateless** streamable-http (mirrors the gateway; restart doesn't strand sessions); `/healthz`; SIGTERM graceful shutdown; loopback only.

~30-line skeleton:
```go
package main
import ("context";"log";"net/http";"os";"os/signal";"syscall";"github.com/modelcontextprotocol/go-sdk/mcp")
var version = "dev"
type ListDevicesIn struct{ Filter string `json:"filter,omitempty" jsonschema:"substring filter"` }
func main() {
    host, port := envOr("MCP_HOST","127.0.0.1"), envOr("MCP_PORT","42011")
    s := mcp.NewServer(&mcp.Implementation{Name:"tufin-mcp",Version:version}, nil)
    mcp.AddTool(s, &mcp.Tool{Name:"list_devices",Description:"List Tufin devices"},
        func(ctx context.Context, req *mcp.CallToolRequest, in ListDevicesIn) (*mcp.CallToolResult, any, error) { return listDevices(ctx, in) })
    mux := http.NewServeMux()
    mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless:true}))
    mux.HandleFunc("/healthz", func(w http.ResponseWriter,_ *http.Request){ w.WriteHeader(200) })
    srv := &http.Server{Addr: host+":"+port, Handler: mux}
    go func(){ _ = srv.ListenAndServe() }()
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt); defer stop(); <-ctx.Done(); _ = srv.Shutdown(context.Background())
}
```
Build: `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(git describe --always)" -o bin/<name>-mcp ./cmd/<name>-mcp`. Cross-compile: darwin/arm64 (primary), linux/amd64+arm64, windows/amd64 optional. (Honest: on macOS still links libSystem — practically the same: one few-MB self-contained file, ms startup, single-digit-MB RSS vs a container.) Secrets: env consumption + the thesun Hermes dual-mode auth semantic (a small `hermesauth` Go package, `<SERVER>_LEGACY_AUTH` fallback).

## 2. Supervisor `fleetd` (~500–800 LOC Go, replaces `thv`; one launchd/systemd unit)
Rejected: per-MCP launchd (32 plists, no port→config publication); supervisord/pm2 (re-adds a runtime, still no config publish). Responsibilities: (1) one manifest `~/.mcp-fleet/fleet.toml` (bin/port/env/health/max_restarts per server) as source of truth; (2) **STATIC ports 42000–42999** (dynamic ports were a Docker artifact — the reason the thv-sync pipeline exists; static ports make the config near-static, reconnects trivial); fail-closed uniqueness/range validation; (3) spawn/restart with exponential backoff + circuit breaker → degraded (not infinite thrash); (4) TCP+`/healthz` probes; (5) secret injection: resolve `hermes://` refs via Hermes at spawn → child env only (never disk/logs/config); literal env allowed so fleet never hard-blocks on brand-new Hermes; (6) publish `config.go-fleet.json` (MCPU schema, atomic temp+rename) then `POST /admin/fleet/reload`; (7) **detach-and-re-adopt** children via pidfile+port probe (supervisor death ≠ fleet death); (8) CLI `fleetd status|start|stop|restart|reload` over loopback socket. Also supervises T2 non-Go processes (e.g. `node …/playwright-mcp --port 42031`).

## 3. Gateway wiring
- **Phase 0 (zero gateway change):** static ports make static `backends:` entries viable — add pilot Go servers to `config.fleet.yaml` like `az-teams`, `POST /admin/reload-config`.
- **Bulk (one small change):** generalize fleet ingestion to accept extra MCPU-format files:
```yaml
fleet:
  toolhive: { mcpu_generated_config: "~/.config/mcpu/config.generated.json" }   # existing, shrinks
  generated_configs: [ "~/.config/mcpu/config.go-fleet.json" ]                   # NEW
```
Loader already parses the schema; change = iterate N paths + **fail loudly on duplicate backend names** (fail-closed). A/B under a suffixed name (`tufin-go`/`tufin_go`) avoids collisions during cutover.
- **Unchanged:** mux, the 8 `gateway_*` tools, artifact paging, ingest_skip, admin API, auth. **Safety gating unchanged IFF tool names preserved** (manifests key on tool names; a rename → fail-closed UNCLASSIFIED). **Tool-name parity is a hard acceptance criterion.**
- **2026 spec headers `Mcp-Method`/`Mcp-Name` (SEP-2243):** adopt opportunistically in Phase 4 (cheap request classification / per-backend middleware without body inspection); nothing blocks on it.

## 4. Preserving ToolHive benefits without Docker
| Benefit | Go-world replacement | Genuinely lost | Verdict |
|---|---|---|---|
| stdio→http re-fronting | **Eliminated** (Go serves http natively); T3 keeps it in Docker; do NOT rebuild as a host shim | Nothing (was overhead) | Moot for T1/T2 |
| Per-MCP isolation/least-privilege | Operator-compiled binaries + pinned `go.sum` (no runtime npm/image pulls → supply-chain surface shrinks); minimal per-proc env; loopback; opt-in `sandbox=true` (macOS `sandbox-exec` Seatbelt / systemd `ProtectHome`,`NoNewPrivileges`,`PrivateTmp`) | **Real:** no kernel namespace/cgroup ceiling; compromised T1 runs as operator uid | **Accept for T1 (operator-authored, Lab-gated); refuse for untrusted → T3 stays Docker** |
| Network egress filtering | Phase 1: drop for T1 (each generated server egresses to one known host; gateway gates every tool *call*). Phase 3 optional: `fleetd` injects `HTTPS_PROXY` at a local allowlist proxy (Go honors proxy env) | Advisory only (code can ignore proxy); per-container DNS gone | Drop for T1, optional proxy later; T3 keeps sidecars |
| Secret injection | **Hermes** (`@hermes/vault`) replaces the keyring store 1:1; `fleetd` resolves `hermes://`→child env; thesun keeps in-proc dual-mode auth | Nothing (arguably improved) | **Full replacement** |
| Lifecycle + dynamic ports + thv pipeline | `fleetd`: backoff+breaker, health, static ports, atomic publish + reload, log rotation | Nothing; static ports are better | **Full replacement, simplified** |
| image immutability/rollback | Versioned binaries: `bin/<name>-mcp`→`<name>-mcp-<version>` symlink; rollback = repoint+restart | Registry provenance (acceptable at scale) | Lightweight equivalent |

**Net honest statement:** vs Docker you lose kernel containment + resource ceilings for whatever leaves the containers. Compensate: only take out code you compile from generated, conformance-verified source; supply-chain surface shrinks more than blast-radius grows; anything untrusted stays in ToolHive.

## 5. Migration path (incremental, per-MCP, container = rollback)
Per-MCP unit: (1) build replacement, register `<name>-go`; (2) **parity gate** — `tools/list` name+schema diff old vs new, `thesun verify` (Conformance Lab is language-agnostic → gates Go unmodified), **zero new UNCLASSIFIED** at gateway boot; (3) A/B sample READ calls + one gated WRITE `confirmed:true` (decision-log shape identical); (4) flip: `thv stop` → rename in `fleet.toml` → `fleetd reload` (client gap: seconds); (5) soak ~1wk (clean decision log, no reconnect churn, sane RSS/latency); (6) rollback any time: `fleetd stop`+`thv restart` (keep images until Phase 5).
Waves: **0** pilot (fleetd v1 + template + 1–2 hand-ported read-mostly T1 as static backends — seeds the thesun Go template); **1** classify all 32 + thesun `--lang go` + 3-server cohort; **2** T1 bulk in cohorts of 5, read-first, WRITE-critical last (crowdstrike/azure/cloudflare — the config's "manifest FIRST" list — extra rigor); **3** T2 third-party under fleetd + explicit T3 residue list; **4** gateway `generated_configs:` change + optional header/egress; **5** decommission (remove ToolHive source, delete registry/images, uninstall Docker *iff* T3 residue empty — else keep a minimal documented footprint; the residue list is a first-class artifact).

## 6. thesun angle
**Add an opt-in `--lang go` target; do NOT flip the default.** Second template path OpenAPI/HAR → typed Go structs + `mcp.AddTool` on the §1 skeleton + Hermes dual-mode + CGO_ENABLED=0 build. **Key enabler:** the Conformance Lab tests the wire, not the language → applies to Go output unchanged. **Scope limit (honest):** the camouflage/curl_cffi anti-fingerprint path + aiolimiter adaptive limiting are Python-specific investments; Go equivalents (utls) are new work. **Division of labor: Go for clean authenticated corporate APIs (most of the fleet); Python stays the default for fingerprint-sensitive targets.** Revisit default after ~10 Go servers soak.

## 7. Bottom line + risks
**Biggest win:** delete an entire runtime layer while changing nothing clients or the gateway see — ~36 containers + Docker Desktop + registry + image builds + duplicated runtimes → ~32 few-MB processes + one ~500-LOC supervisor + one launchd plist; ms startups, static ports; the stdio problem *dissolved*.
**Biggest risk:** silent behavioral drift in rewritten servers (tool name/schema/semantic divergence → safety-manifest degrades to UNCLASSIFIED, workflows break). Mitigation structural: name/schema parity diff + Lab pass + zero-new-UNCLASSIFIED as HARD per-MCP gates; container as rollback until soak.
**Secondary risks:** isolation regression via 3rd-party code (→ trust-tiering, T3 stays Docker); fleetd SPOF (→ detach-and-re-adopt; KeepAlive on fleetd only; breakers); Hermes brand-new (→ literal-env fallback; commit/harden before Wave 2); Go SDK spec-final 2026-07-28 churn (→ pin per cohort, one coordinated bump); port collisions (→ static block, fail-closed validation); log growth 1GB incident (→ rotation in fleetd v1).
**Roadmap acceptance criteria:** Phase 0 — pilot mux round-trip + kill-9 auto-restart + no secrets on disk + fleetd-crash-survives; Phase 1 — 3 servers pass Lab+parity+zero-UNCLASSIFIED, one soaking under prod name; Phase 2 — per-MCP gates green, decision log clean, container stopped-not-deleted; Phase 3 — T2 under fleetd + residue list accepted; Phase 4 — both config sources ingested, duplicate-name test fails loudly, gateway e2e green; Phase 5 — ToolHive removed, Docker gone iff residue empty.
