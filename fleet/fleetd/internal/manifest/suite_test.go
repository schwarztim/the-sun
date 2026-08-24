package manifest

import "testing"

// A full thesun.toml with all four sections plus the supervised tree parses and
// every accessor returns the section value.
func TestSuiteSectionsParsed(t *testing.T) {
	raw := []byte(`
[generator]
node = "/usr/bin/node"
cli  = "/opt/thesun/generator/dist/cli/index.js"

[fleet]
port_min = 42100
port_max = 42200

[hermes]
port    = 9900
base_url = "http://127.0.0.1:9900"
health  = "healthz"
cmd     = ["node", "hermes.js", "start"]

[gateway]
port        = 3200
health      = "/admin/status"
reload_path = "/admin/reload-config"

[[server]]
name = "hermes"
kind = "system"
bin  = "node"
args = ["hermes.js", "start"]
port = 9900
health = "/health"

[[server]]
name = "gateway"
kind = "system"
bin  = "node"
args = ["gw.js"]
port = 3200
health = "/admin/status"

[[server]]
name = "shodan"
bin  = "shodan-server"
port = 42101
`)
	m, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	if m.Generator.Node != "/usr/bin/node" {
		t.Errorf("generator.node = %q", m.Generator.Node)
	}
	if m.FleetPortMin() != 42100 || m.FleetPortMax() != 42200 {
		t.Errorf("fleet window = %d-%d", m.FleetPortMin(), m.FleetPortMax())
	}
	if m.HermesPort() != 9900 {
		t.Errorf("HermesPort = %d, want 9900", m.HermesPort())
	}
	if m.HermesHealth() != "/healthz" { // leading slash normalized
		t.Errorf("HermesHealth = %q, want /healthz", m.HermesHealth())
	}
	if got := m.HermesBaseURL(); got != "http://127.0.0.1:9900" {
		t.Errorf("HermesBaseURL = %q", got)
	}
	if got := m.HermesHealthURL(); got != "http://127.0.0.1:9900/healthz" {
		t.Errorf("HermesHealthURL = %q", got)
	}
	if m.GatewayPort() != 3200 {
		t.Errorf("GatewayPort = %d, want 3200", m.GatewayPort())
	}
	if got := m.GatewayBaseURL(); got != "http://127.0.0.1:3200" {
		t.Errorf("GatewayBaseURL = %q", got)
	}
	if got := m.GatewayReloadURL(); got != "http://127.0.0.1:3200/admin/reload-config" {
		t.Errorf("GatewayReloadURL = %q", got)
	}
}

// A manifest that declares ONLY the supervised tree (no settings sections) is
// still fully back-compat: accessors fall back to the system [[server]] entries.
func TestSuiteFallbackToSystemServers(t *testing.T) {
	raw := []byte(`
[[server]]
name = "hermes"
kind = "system"
bin  = "node"
args = ["hermes.js", "start"]
port = 9876
health = "/health"

[[server]]
name = "gateway"
kind = "system"
bin  = "node"
args = ["gw.js"]
port = 3100
health = "/admin/status"
`)
	m, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if m.HermesPort() != 9876 {
		t.Errorf("HermesPort fallback = %d, want 9876", m.HermesPort())
	}
	if m.GatewayPort() != 3100 {
		t.Errorf("GatewayPort fallback = %d, want 3100", m.GatewayPort())
	}
	if got := m.GatewayReloadURL(); got != "http://127.0.0.1:3100/admin/reload-config" {
		t.Errorf("GatewayReloadURL fallback = %q", got)
	}
	if got := m.HermesHealthURL(); got != "http://127.0.0.1:9876/health" {
		t.Errorf("HermesHealthURL fallback = %q", got)
	}
}

// With neither sections nor system servers, accessors return built-in defaults.
func TestSuiteBuiltinDefaults(t *testing.T) {
	raw := []byte(`
[[server]]
name = "shodan"
bin  = "shodan-server"
port = 42101
`)
	m, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if m.HermesPort() != DefaultHermesPort {
		t.Errorf("HermesPort default = %d", m.HermesPort())
	}
	if m.GatewayPort() != DefaultGatewayPort {
		t.Errorf("GatewayPort default = %d", m.GatewayPort())
	}
	if m.FleetPortMin() != PortMin || m.FleetPortMax() != PortMax {
		t.Errorf("fleet window default = %d-%d", m.FleetPortMin(), m.FleetPortMax())
	}
	if got := m.GatewayReloadURL(); got != "http://127.0.0.1:3100/admin/reload-config" {
		t.Errorf("GatewayReloadURL default = %q", got)
	}
}

// The legacy top-level gateway_reload_url override is still honoured when the
// [gateway] section does not specify a reload path.
func TestSuiteLegacyReloadOverride(t *testing.T) {
	raw := []byte(`
gateway_reload_url = "http://127.0.0.1:3100/admin/fleet/reload"

[[server]]
name = "shodan"
bin  = "shodan-server"
port = 42101
`)
	m, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := m.GatewayReloadURL(); got != "http://127.0.0.1:3100/admin/fleet/reload" {
		t.Errorf("legacy reload override = %q", got)
	}
}
