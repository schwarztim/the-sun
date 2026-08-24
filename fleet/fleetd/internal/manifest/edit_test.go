package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sampleManifest carries a preamble comment and two servers, one of which has an
// inline comment — the exact shape (comments + [server.env]) the live fleet.toml
// uses, so we prove edits preserve hand-written formatting.
const sampleManifest = `# fleetd manifest — test fixture
[[server]]
name = "alpha-go"
bin = "/opt/alpha/bin/alpha-mcp"
port = 42011
health = "/healthz"
max_restarts = 5
[server.env]
MCP_PORT = "42011"
ALPHA_KEY = "hermescred://alpha/api_key"

[[server]]
name = "beta-go"
bin = "/opt/beta/bin/beta-mcp"
port = 42012
health = "/healthz"
max_restarts = 5
[server.env]
MCP_PORT = "42012"
# beta uses cookie-session auth — self-fetched at request time
`

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "fleet.toml")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAppendAddsServerAndBacksUp(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	err := Append(p, AddSpec{
		Name: "gamma-go",
		Bin:  "/opt/gamma/bin/gamma-mcp",
		Args: []string{"--flag", "x"},
		Port: 42013,
		Env:  map[string]string{"MCP_PORT": "42013", "GAMMA_KEY": "hermescred://gamma/bearer"},
	})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}

	// Backup exists and equals the original.
	bak, err := os.ReadFile(p + ".bak")
	if err != nil {
		t.Fatalf("backup not created: %v", err)
	}
	if string(bak) != sampleManifest {
		t.Fatalf("backup does not match original manifest")
	}

	// New manifest parses and has 3 servers including gamma with args + env.
	m, err := Load(p)
	if err != nil {
		t.Fatalf("reload after append: %v", err)
	}
	if len(m.Servers) != 3 {
		t.Fatalf("want 3 servers, got %d", len(m.Servers))
	}
	var gamma *Server
	for i := range m.Servers {
		if m.Servers[i].Name == "gamma-go" {
			gamma = &m.Servers[i]
		}
	}
	if gamma == nil {
		t.Fatal("gamma-go not found after append")
	}
	if gamma.Port != 42013 || len(gamma.Args) != 2 || gamma.Args[0] != "--flag" {
		t.Fatalf("gamma spec wrong: %+v", gamma)
	}
	if gamma.Env["GAMMA_KEY"] != "hermescred://gamma/bearer" {
		t.Fatalf("gamma env not preserved: %+v", gamma.Env)
	}

	// The original preamble comment and alpha's env survived unchanged.
	raw, _ := os.ReadFile(p)
	if !strings.Contains(string(raw), "# fleetd manifest — test fixture") {
		t.Fatal("preamble comment lost")
	}
}

func TestAppendRejectsDuplicateName(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	err := Append(p, AddSpec{Name: "alpha-go", Bin: "/x", Port: 42099})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("want duplicate-name error, got %v", err)
	}
	// File must be untouched (no backup written on rejection).
	if _, err := os.Stat(p + ".bak"); !os.IsNotExist(err) {
		t.Fatal("backup should not exist after a rejected add")
	}
}

func TestAppendRejectsDuplicatePort(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	err := Append(p, AddSpec{Name: "new-go", Bin: "/x", Port: 42012})
	if err == nil || !strings.Contains(err.Error(), "already used") {
		t.Fatalf("want duplicate-port error, got %v", err)
	}
}

func TestAppendRejectsOutOfRangePort(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	if err := Append(p, AddSpec{Name: "new-go", Bin: "/x", Port: 8080}); err == nil {
		t.Fatal("want out-of-range port error")
	}
}

func TestRemovePreservesOtherBlocksAndComments(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	removed, err := Remove(p, []string{"alpha-go"})
	if err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(removed) != 1 || removed[0] != "alpha-go" {
		t.Fatalf("want [alpha-go] removed, got %v", removed)
	}

	m, err := Load(p)
	if err != nil {
		t.Fatalf("reload after remove: %v", err)
	}
	if len(m.Servers) != 1 || m.Servers[0].Name != "beta-go" {
		t.Fatalf("want only beta-go left, got %+v", m.Servers)
	}

	raw, _ := os.ReadFile(p)
	txt := string(raw)
	// alpha's content is gone…
	if strings.Contains(txt, "alpha-go") || strings.Contains(txt, "ALPHA_KEY") {
		t.Fatal("alpha content still present after remove")
	}
	// …but beta's inline comment and the preamble survived.
	if !strings.Contains(txt, "# beta uses cookie-session auth") {
		t.Fatal("beta inline comment lost")
	}
	if !strings.Contains(txt, "# fleetd manifest — test fixture") {
		t.Fatal("preamble comment lost")
	}
}

func TestRemoveUnknownIsError(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	if _, err := Remove(p, []string{"nope-go"}); err == nil {
		t.Fatal("want error removing a non-existent server")
	}
}

func TestRemoveAllEmptiesManifest(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	removed, err := RemoveAll(p)
	if err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("want 2 removed, got %v", removed)
	}
	raw, _ := os.ReadFile(p)
	if strings.Contains(string(raw), "[[server]]") {
		t.Fatal("server blocks still present after RemoveAll")
	}
	// Preamble is retained.
	if !strings.Contains(string(raw), "# fleetd manifest — test fixture") {
		t.Fatal("preamble comment lost on RemoveAll")
	}
}

// TestAppendRoundTripsThroughParse guards that a rendered block with special
// characters in env values stays valid TOML.
func TestAppendRendersEscapableValues(t *testing.T) {
	p := writeTemp(t, sampleManifest)
	err := Append(p, AddSpec{
		Name: "quote-go",
		Bin:  `/opt/with space/bin/x`,
		Port: 42014,
		Env:  map[string]string{"MSG": `a "quoted" val`},
	})
	if err != nil {
		t.Fatalf("Append with special chars: %v", err)
	}
	m, err := Load(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	for i := range m.Servers {
		if m.Servers[i].Name == "quote-go" {
			if m.Servers[i].Env["MSG"] != `a "quoted" val` {
				t.Fatalf("escaped value round-trip wrong: %q", m.Servers[i].Env["MSG"])
			}
			if m.Servers[i].Bin != `/opt/with space/bin/x` {
				t.Fatalf("bin with space wrong: %q", m.Servers[i].Bin)
			}
			return
		}
	}
	t.Fatal("quote-go not found")
}
