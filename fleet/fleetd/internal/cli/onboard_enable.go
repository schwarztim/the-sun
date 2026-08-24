package cli

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
)

// setBackendEnabled flips `enabled:` to true for one backend in the gateway's
// YAML config.
//
// This is a LINE-ORIENTED edit, not a YAML round-trip, and that is the whole
// point. Decoding and re-encoding this file would silently drop every comment in
// it, and the comments here are load-bearing: the `fleet:`/`toolhive:` block
// carries an explicit warning that deleting it re-enables container ingestion,
// because every field in it defaults to ON when absent. A formatter that ate
// that warning would eventually cost someone a day.
//
// It returns whether the file changed, so an already-enabled backend is a
// no-op rather than a rewrite.
func setBackendEnabled(configPath, backend string, enabled bool) (bool, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false, err
	}
	lines := strings.Split(string(raw), "\n")

	// The backend key sits at a known indent under `backends:`. Match the key
	// itself rather than the name anywhere in the file, so a backend mentioned
	// in a comment or a URL cannot be mistaken for its declaration.
	keyRe := regexp.MustCompile(`^(\s+)` + regexp.QuoteMeta(backend) + `:\s*$`)
	enabledRe := regexp.MustCompile(`^(\s+)enabled:\s*(true|false)\s*$`)

	start, indent := -1, ""
	for i, ln := range lines {
		if m := keyRe.FindStringSubmatch(ln); m != nil {
			start, indent = i, m[1]
			break
		}
	}
	if start < 0 {
		return false, fmt.Errorf("backend %q not found in %s", backend, configPath)
	}

	want := "false"
	if enabled {
		want = "true"
	}

	// Walk forward only while we are still inside this backend's block. The
	// block ends at the first line indented no deeper than the key itself,
	// ignoring blank lines; without that bound, a backend whose own block has no
	// `enabled:` would flip the NEXT backend's flag instead.
	for i := start + 1; i < len(lines); i++ {
		ln := lines[i]
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lead := ln[:len(ln)-len(strings.TrimLeft(ln, " \t"))]
		if len(lead) <= len(indent) {
			break // left this backend's block
		}
		if m := enabledRe.FindStringSubmatch(ln); m != nil {
			if m[2] == want {
				return false, nil // already in the requested state
			}
			lines[i] = m[1] + "enabled: " + want
			return true, os.WriteFile(configPath, []byte(strings.Join(lines, "\n")), 0o644)
		}
	}
	return false, fmt.Errorf("backend %q has no `enabled:` key in %s", backend, configPath)
}

// gatewayConfigPath resolves the gateway's YAML config the same way the running
// gateway does: the env override first, then the path pinned into the manifest
// when `thesun init` wrote the gateway server spec. Guessing a path relative to
// the working directory would edit the wrong file on any machine where the
// bundle is not the current directory, which is most of them.
func gatewayConfigPath() string {
	if p := os.Getenv("MCP_GATEWAY_CONFIG"); p != "" {
		return p
	}
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		return ""
	}
	for _, s := range m.Servers {
		if s.Name == manifest.SystemGateway {
			if p := s.Env["MCP_GATEWAY_CONFIG"]; p != "" {
				return p
			}
		}
	}
	return ""
}

// gatewayBaseURL resolves the gateway's admin base the same way the `thesun
// gateway` front-end does: the env override, then the [gateway] section of the
// suite manifest, then the built-in default.
func gatewayBaseURL() string {
	if u := os.Getenv("THESUN_GATEWAY_URL"); u != "" {
		return u
	}
	if m, err := manifest.Load(fleet.ManifestPath()); err == nil {
		return m.GatewayBaseURL()
	}
	return fmt.Sprintf("http://127.0.0.1:%d", manifest.DefaultGatewayPort)
}

// reloadGatewayConfig makes the running gateway re-read config.fleet.yaml.
//
// This is deliberately NOT fleetd's `reload`. The two are different levers and
// picking the wrong one is a silent failure: fleetd's reload re-reads the SUITE
// MANIFEST (thesun.toml) and has no idea the gateway's YAML changed, so a
// backend just flipped to `enabled: true` would be reported as enabled while
// the gateway carried on serving its old backend map and never routed it. Only
// the gateway's own /admin/reload-config calls loadConfig(configPath).
//
// The admin surface is loopback-gated unless MCP_GATEWAY_ADMIN_TOKEN is set, in
// which case it wants a bearer token, so send one when the operator configured
// it; otherwise the reload would 401 on exactly the hardened installs that most
// need onboarding to work.
func reloadGatewayConfig() error {
	url := strings.TrimRight(gatewayBaseURL(), "/") + "/admin/reload-config"
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	if tok := os.Getenv("MCP_GATEWAY_ADMIN_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("gateway not reachable at %s: %w", gatewayBaseURL(), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("gateway returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
