// doctor_mcp.go reports every MCP server each AI client is registered against,
// which is the diagnostic for a failure mode that is otherwise invisible.
//
// thesun's whole routing premise is that every client talks to ONE endpoint, the
// gateway, because the gateway is the policy enforcement point. A client that
// also registers servers directly is running a second copy of tools the gateway
// already fronts, outside the PEP, and nothing tells the operator that is
// happening: a dead port and a policed one look identical in a config file, and
// a client that silently fails to connect to nine of its twelve servers still
// starts up fine.
//
// The two things worth surfacing are therefore:
//
//   - stdio entries, which are prohibited outright. stdio deadlocks under
//     supervision and a stdio backend exposes zero tools while consumers burn
//     tokens retrying a path that can never succeed.
//   - direct http entries, split by whether anything is actually listening.
//     A dead one is dead weight the client retries every session; a live one is
//     a real bypass of the enforcement point.
//
// This check never edits anything. Pruning a developer's own client config is
// their call, not a diagnostic's.
package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// mcpRegistration is one server entry found in one client's config.
type mcpRegistration struct {
	Client    string
	Name      string
	Transport string // "http" | "stdio"
	URL       string
	Live      bool // only meaningful when Transport == "http"

	// File and Container are the exact address of this entry, and they are what
	// makes `wire --prune` safe. One file can hold the same server name in
	// several containers at once: ~/.claude.json carries a global `mcpServers`
	// map AND a `projects.<path>.mcpServers` map per project. Deleting by name
	// alone would take a live global entry that the preview had just promised
	// to leave alone, because a dead project-scoped entry happened to share its
	// name. Container is a slash path, e.g. "mcpServers" or
	// "projects/<key>/mcpServers".
	File      string
	Container string
}

// dialTimeout bounds the liveness probe. This runs inside `doctor`, which an
// operator waits on, and a config carrying fifty stale entries would otherwise
// stall for a minute against unreachable ports.
const mcpProbeTimeout = 250 * time.Millisecond

var hostPortRe = regexp.MustCompile(`://(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)`)

// portIsListening reports whether anything accepts a TCP connection on the
// loopback port in url. A non-loopback URL is reported as live without probing:
// this check is about local fleet drift, and reaching out to a corporate host
// from a diagnostic would be both slow and rude.
func portIsListening(url string) bool {
	m := hostPortRe.FindStringSubmatch(url)
	if m == nil {
		return true
	}
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+m[1], mcpProbeTimeout)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// readJSONFile parses a client config, returning nil when it is absent or
// unreadable. A malformed config is the client's problem to report, not this
// check's to fail on.
func readJSONFile(path string) map[string]any {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc map[string]any
	if json.Unmarshal(b, &doc) != nil {
		return nil
	}
	return doc
}

// collectJSONServers reads one container key ("mcpServers", "mcp", "servers")
// out of a parsed client config and classifies each entry.
func collectJSONServers(client, file string, doc map[string]any, containerKey string) []mcpRegistration {
	container, _ := doc[containerKey].(map[string]any)
	if container == nil {
		return nil
	}
	out := make([]mcpRegistration, 0, len(container))
	for name, raw := range container {
		cfg, _ := raw.(map[string]any)
		if cfg == nil {
			continue
		}
		// Gemini accepts url, httpUrl, or type+url; treat any of them as http.
		url, _ := cfg["url"].(string)
		if url == "" {
			url, _ = cfg["httpUrl"].(string)
		}
		reg := mcpRegistration{Client: client, Name: name, URL: url, File: file, Container: containerKey}
		if url != "" {
			reg.Transport = "http"
			reg.Live = portIsListening(url)
		} else {
			reg.Transport = "stdio"
		}
		out = append(out, reg)
	}
	return out
}

// collectCodexServers reads Codex's TOML [mcp_servers.<name>] tables.
func collectCodexServers(path string) []mcpRegistration {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc map[string]any
	if _, err := toml.Decode(string(b), &doc); err != nil {
		return nil
	}
	servers, _ := doc["mcp_servers"].(map[string]any)
	if servers == nil {
		return nil
	}
	out := make([]mcpRegistration, 0, len(servers))
	for name, raw := range servers {
		cfg, _ := raw.(map[string]any)
		if cfg == nil {
			continue
		}
		url, _ := cfg["url"].(string)
		reg := mcpRegistration{
			Client: "OpenAI Codex CLI", Name: name, URL: url,
			File: path, Container: "mcp_servers",
		}
		if url != "" {
			reg.Transport = "http"
			reg.Live = portIsListening(url)
		} else {
			reg.Transport = "stdio"
		}
		out = append(out, reg)
	}
	return out
}

// CollectClientMCPRegistrations enumerates every MCP server registration across
// every supported client. home and cwd are parameters so tests can point them at
// throwaway trees rather than the operator's real config.
func CollectClientMCPRegistrations(home, cwd string) []mcpRegistration {
	var all []mcpRegistration

	claudeJSON := filepath.Join(home, ".claude.json")
	if doc := readJSONFile(claudeJSON); doc != nil {
		all = append(all, collectJSONServers("Claude Code", claudeJSON, doc, "mcpServers")...)
		// Project-scoped entries live under projects.<path>.mcpServers and are
		// just as capable of bypassing the gateway as global ones. They are
		// addressed by their real key, not by basename: two projects can share
		// a basename, and the container path has to identify exactly one map.
		if projects, _ := doc["projects"].(map[string]any); projects != nil {
			for proj, raw := range projects {
				pc, _ := raw.(map[string]any)
				if pc == nil {
					continue
				}
				label := "Claude Code (" + filepath.Base(proj) + ")"
				got := collectJSONServers(label, claudeJSON, pc, "mcpServers")
				for i := range got {
					got[i].Container = "projects/" + proj + "/mcpServers"
				}
				all = append(all, got...)
			}
		}
	}
	projectMCP := filepath.Join(cwd, ".mcp.json")
	if doc := readJSONFile(projectMCP); doc != nil {
		all = append(all, collectJSONServers("Claude Code (project .mcp.json)", projectMCP, doc, "mcpServers")...)
	}
	copilot := filepath.Join(home, ".copilot", "mcp-config.json")
	if doc := readJSONFile(copilot); doc != nil {
		all = append(all, collectJSONServers("GitHub Copilot CLI", copilot, doc, "mcpServers")...)
	}
	gemini := filepath.Join(home, ".gemini", "settings.json")
	if doc := readJSONFile(gemini); doc != nil {
		all = append(all, collectJSONServers("Gemini CLI", gemini, doc, "mcpServers")...)
	}
	opencode := filepath.Join(home, ".config", "opencode", "opencode.json")
	if doc := readJSONFile(opencode); doc != nil {
		all = append(all, collectJSONServers("OpenCode", opencode, doc, "mcp")...)
	}
	vscode := filepath.Join(cwd, ".vscode", "mcp.json")
	if doc := readJSONFile(vscode); doc != nil {
		all = append(all, collectJSONServers("VS Code", vscode, doc, "servers")...)
	}
	all = append(all, collectCodexServers(filepath.Join(home, ".codex", "config.toml"))...)

	sort.Slice(all, func(i, j int) bool {
		if all[i].Client != all[j].Client {
			return all[i].Client < all[j].Client
		}
		return all[i].Name < all[j].Name
	})
	return all
}

// summariseMCPRegistrations turns the raw list into the status and one-line
// detail the doctor report shows.
func summariseMCPRegistrations(regs []mcpRegistration) (string, string) {
	if len(regs) == 0 {
		return statusWarn, "no AI client has any MCP server registered; run `thesun wire`"
	}

	var stdio, deadHTTP, liveExtra []string
	gatewayClients := map[string]bool{}

	for _, r := range regs {
		if r.Name == GatewayEntryName {
			gatewayClients[r.Client] = true
			continue
		}
		switch {
		case r.Transport == "stdio":
			stdio = append(stdio, r.Client+"/"+r.Name)
		case !r.Live:
			deadHTTP = append(deadHTTP, r.Client+"/"+r.Name)
		default:
			liveExtra = append(liveExtra, r.Client+"/"+r.Name)
		}
	}

	if len(stdio) == 0 && len(deadHTTP) == 0 && len(liveExtra) == 0 {
		return statusPass, fmt.Sprintf("every client routes through the gateway only (%d client(s))", len(gatewayClients))
	}

	parts := make([]string, 0, 3)
	if len(stdio) > 0 {
		parts = append(parts, fmt.Sprintf("%d stdio (prohibited: %s)", len(stdio), truncateList(stdio)))
	}
	if len(deadHTTP) > 0 {
		parts = append(parts, fmt.Sprintf("%d dead port(s) (%s)", len(deadHTTP), truncateList(deadHTTP)))
	}
	if len(liveExtra) > 0 {
		parts = append(parts, fmt.Sprintf("%d live outside the gateway (%s)", len(liveExtra), truncateList(liveExtra)))
	}

	// stdio is a rule violation; the rest is drift worth knowing about.
	status := statusWarn
	if len(stdio) > 0 {
		status = statusFail
	}
	return status, strings.Join(parts, "; ") + ". These bypass the gateway policy enforcement point; `thesun wire --prune` removes the dead and prohibited ones"
}

// truncateList keeps the doctor line readable when a config has drifted badly.
func truncateList(items []string) string {
	const max = 4
	if len(items) <= max {
		return strings.Join(items, ", ")
	}
	return strings.Join(items[:max], ", ") + fmt.Sprintf(", +%d more", len(items)-max)
}

// ClientMCPDoctorCheck is the doctor entry point.
func ClientMCPDoctorCheck(add func(name, status, detail string)) {
	home, err := os.UserHomeDir()
	if err != nil {
		add("client MCP wiring", statusWarn, "cannot resolve home directory: "+err.Error())
		return
	}
	cwd, _ := os.Getwd()
	status, detail := summariseMCPRegistrations(CollectClientMCPRegistrations(home, cwd))
	add("client MCP wiring", status, detail)
}
