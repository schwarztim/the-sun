package manifest

import "testing"

// TestSystemKindExemptFromPortWindow proves a kind="system" entry may bind a
// well-known port outside the 42000-42999 MCP window (hermes :9876, gateway
// :3100), while kind="mcp" is still confined to the window.
func TestSystemKindExemptFromPortWindow(t *testing.T) {
	raw := []byte(`
[[server]]
name = "hermes"
kind = "system"
bin = "/usr/bin/node"
port = 9876
health = "/health"

[[server]]
name = "shodan-go"
bin = "/opt/shodan"
port = 42101
`)
	m, err := Parse(raw)
	if err != nil {
		t.Fatalf("system entry rejected: %v", err)
	}
	if len(m.Servers) != 2 {
		t.Fatalf("want 2 servers, got %d", len(m.Servers))
	}
	var sys, mcp *Server
	for i := range m.Servers {
		switch m.Servers[i].Name {
		case "hermes":
			sys = &m.Servers[i]
		case "shodan-go":
			mcp = &m.Servers[i]
		}
	}
	if sys == nil || !sys.IsSystem() {
		t.Fatalf("hermes should be a system entry: %+v", sys)
	}
	if mcp == nil || mcp.Kind != KindMCP {
		t.Fatalf("shodan-go should default to kind=mcp: %+v", mcp)
	}
}

// TestMCPKindStillEnforcesWindow: a default (mcp) entry outside the window fails.
func TestMCPKindStillEnforcesWindow(t *testing.T) {
	raw := []byte(`
[[server]]
name = "bad-go"
bin = "/opt/bad"
port = 3100
`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("mcp entry with out-of-window port should be rejected")
	}
}

// TestInvalidKindRejected fails closed on an unknown kind.
func TestInvalidKindRejected(t *testing.T) {
	raw := []byte(`
[[server]]
name = "x"
kind = "daemon"
bin = "/opt/x"
port = 42001
`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("unknown kind should be rejected")
	}
}

// TestSystemPortStillUniqueAndPositive: system entries still need a port and it
// must be unique across the whole fleet.
func TestSystemPortDuplicateRejected(t *testing.T) {
	raw := []byte(`
[[server]]
name = "a"
kind = "system"
bin = "/x"
port = 3100

[[server]]
name = "b"
kind = "system"
bin = "/y"
port = 3100
`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("duplicate system port should be rejected")
	}
}

// TestAppendRendersSystemKind: `add --kind system` writes a kind line that
// round-trips.
func TestAppendRendersSystemKind(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	if err := Append(p, AddSpec{
		Name: "gw", Kind: KindSystem, Bin: "/usr/bin/node",
		Args: []string{"/bundle/gateway/dist/index.js"}, Port: 3100, Health: "/admin/status",
	}); err != nil {
		t.Fatalf("append system entry: %v", err)
	}
	m, err := Load(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	for i := range m.Servers {
		if m.Servers[i].Name == "gw" {
			if !m.Servers[i].IsSystem() {
				t.Fatalf("gw should be system, got kind=%q", m.Servers[i].Kind)
			}
			return
		}
	}
	t.Fatal("gw not found after append")
}
