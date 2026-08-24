package fleet

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// MCPU schema: {"mcpServers":{"<name>":{"url":"http://127.0.0.1:<port>/mcp",
//                                        "transport":{"type":"http"}}}}
// Streamable-HTTP ONLY — transport.type is always "http"; never stdio/sse.

type mcpuTransport struct {
	Type string `json:"type"`
}
type mcpuEntry struct {
	URL       string        `json:"url"`
	Transport mcpuTransport `json:"transport"`
}
type mcpuConfig struct {
	McpServers map[string]mcpuEntry `json:"mcpServers"`
}

// publishDebounce is the quiet window used to coalesce bursts of publishConfig
// triggers (e.g. every server in the fleet turning healthy within the same
// startup window) into a small, bounded number of gateway reloads instead of
// one reload per server — the other half of the fix (alongside supervisor.go's
// ordered startup) for the parallel-start -> reload-cascade -> circuit-
// breaker-retrip failure proven in production on 2026-07-06.
const publishDebounce = 2 * time.Second

// publishConfig requests a config publish. The first request in a quiet window
// fires immediately — so a single isolated change (e.g. `thesun start x`)
// still reloads the gateway promptly — and any further requests arriving
// within publishDebounce of that fire are coalesced into exactly one trailing
// catch-up publish at the end of the window, so N servers turning healthy in
// the same second produce at most 2 writes/reloads instead of N.
func (s *Supervisor) publishConfig() {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	if s.publishCooldown {
		s.publishPending = true
		return
	}
	s.publishCooldown = true
	go s.writePublishedConfig()
	time.AfterFunc(publishDebounce, s.endPublishCooldown)
}

// endPublishCooldown closes out one debounce window. If a request arrived
// during the window it re-enters publishConfig — firing one trailing publish
// immediately and opening a fresh window — otherwise the debounce goes idle
// until the next request.
func (s *Supervisor) endPublishCooldown() {
	s.publishMu.Lock()
	pending := s.publishPending
	s.publishPending = false
	s.publishCooldown = false
	s.publishMu.Unlock()
	if pending {
		s.publishConfig()
	}
}

// writePublishedConfig does the actual work: writes the current set of running
// servers to the published config file atomically (temp + rename), then
// best-effort POSTs a reload to the gateway. Only servers in the "running"
// state are published (a degraded server has no live listener, so advertising
// it would hand the gateway a dead backend). Secrets never appear here —
// entries carry only url + transport. Called only from publishConfig's
// debounce wrapper above — never call this directly.
func (s *Supervisor) writePublishedConfig() {
	atomic.AddInt64(&s.publishCount, 1)
	cfg := mcpuConfig{McpServers: map[string]mcpuEntry{}}
	s.mu.Lock()
	for _, srv := range s.servers {
		srv.mu.Lock()
		// System infra (hermes, gateway) is supervised but is NOT an MCP backend,
		// so it is never advertised in the published gateway config.
		if srv.state == StateRunning && !srv.spec.IsSystem() {
			cfg.McpServers[srv.spec.Name] = mcpuEntry{
				URL:       fmt.Sprintf("http://127.0.0.1:%d/mcp", srv.spec.Port),
				Transport: mcpuTransport{Type: "http"},
			}
		}
		srv.mu.Unlock()
	}
	reloadURL := s.gatewayReloadURL
	s.mu.Unlock()

	if err := writeJSONAtomic(PublishedConfigPath(), cfg); err != nil {
		s.logf("publish: write %s failed: %v", PublishedConfigPath(), err)
		return
	}
	s.logf("publish: wrote %d running server(s) to %s", len(cfg.McpServers), PublishedConfigPath())
	go s.reloadGateway(reloadURL)
}

// writeJSONAtomic marshals v and writes it via temp-file + rename so a reader
// (the gateway) never sees a partial file.
func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".fleetd-cfg-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// reloadGateway POSTs the published config path to the gateway admin reload
// endpoint. A failed POST is non-fatal — publishing the file is the contract;
// the reload is a nicety. Tries the primary URL then documented alternates.
func (s *Supervisor) reloadGateway(primary string) {
	if os.Getenv("FLEETD_SKIP_RELOAD") == "1" {
		return // proofs/tests never disrupt the live gateway
	}
	urls := append([]string{primary}, altGatewayReloadPaths...)
	body, _ := json.Marshal(map[string]string{"config": PublishedConfigPath()})
	client := &http.Client{Timeout: 3 * time.Second}
	for _, u := range urls {
		req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(body))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			s.logf("publish: gateway reload POST %s failed (non-fatal): %v", u, err)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode < 300 {
			s.logf("publish: gateway reload OK via %s (%d)", u, resp.StatusCode)
			return
		}
		s.logf("publish: gateway reload %s returned %d (non-fatal)", u, resp.StatusCode)
	}
}
