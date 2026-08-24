package manifest

import "fmt"

// suite.go formalizes thesun.toml as THE single config for the whole suite. In
// addition to the supervised [[server]] tree (parsed by manifest.go), the file
// carries four optional settings sections:
//
//	[generator]  node interpreter + generator CLI entrypoint
//	[fleet]      the static-port window MCP servers must bind
//	[hermes]     the auth broker: port, base URL, health path, launch command
//	[gateway]    the mux/router: port, base URL, health + reload paths, command
//
// These replace scattered env vars and hardcoded constants. Every field is
// optional: accessors fall back first to the matching system [[server]] entry
// (so a manifest that only declares the supervised tree still works), then to a
// built-in default. This keeps full back-compat — old manifests that predate the
// sections parse and behave exactly as before.

// Built-in defaults for the two system components and the generator. These are
// the single source of truth for the values that used to be hardcoded across
// stack.go and fleet/paths.go.
const (
	DefaultHermesPort        = 9876
	DefaultHermesHealth      = "/health"
	DefaultGatewayPort       = 3100
	DefaultGatewayHealth     = "/admin/status"
	DefaultGatewayReloadPath = "/admin/reload-config"

	// Well-known system server names (their [[server]] entries, when present,
	// are the fallback source for the section accessors below).
	SystemHermes  = "hermes"
	SystemGateway = "gateway"
)

// GeneratorConfig is the [generator] section: how to invoke the Node generator.
type GeneratorConfig struct {
	Node string `toml:"node"` // node interpreter (absolute path or "node")
	CLI  string `toml:"cli"`  // generator CLI entrypoint (…/generator/dist/cli/index.js)
}

// FleetConfig is the [fleet] section: the static-port window for MCP servers.
type FleetConfig struct {
	PortMin int `toml:"port_min"`
	PortMax int `toml:"port_max"`
}

// HermesConfig is the [hermes] section: the auth broker's connection settings.
type HermesConfig struct {
	Port    int      `toml:"port"`
	BaseURL string   `toml:"base_url"`
	Health  string   `toml:"health"`
	Cmd     []string `toml:"cmd"` // launch command (informational / init seed)
}

// GatewayConfig is the [gateway] section: the mux/router's connection settings.
type GatewayConfig struct {
	Port       int      `toml:"port"`
	BaseURL    string   `toml:"base_url"`
	Health     string   `toml:"health"`
	ReloadPath string   `toml:"reload_path"`
	Cmd        []string `toml:"cmd"`
}

// systemServer returns the named system [[server]] entry, if declared.
func (m *Manifest) systemServer(name string) (Server, bool) {
	for _, s := range m.Servers {
		if s.Name == name && s.IsSystem() {
			return s, true
		}
	}
	return Server{}, false
}

// ---- hermes accessors (section → system server → default) ----

// HermesPort resolves the broker port from [hermes].port, else the hermes system
// server entry, else the built-in default.
func (m *Manifest) HermesPort() int {
	if m.Hermes.Port > 0 {
		return m.Hermes.Port
	}
	if s, ok := m.systemServer(SystemHermes); ok && s.Port > 0 {
		return s.Port
	}
	return DefaultHermesPort
}

// HermesHealth resolves the broker health path.
func (m *Manifest) HermesHealth() string {
	if m.Hermes.Health != "" {
		return ensureLeadingSlash(m.Hermes.Health)
	}
	if s, ok := m.systemServer(SystemHermes); ok && s.Health != "" {
		return s.Health
	}
	return DefaultHermesHealth
}

// HermesBaseURL resolves the broker base URL: [hermes].base_url, else
// http://127.0.0.1:<HermesPort>.
func (m *Manifest) HermesBaseURL() string {
	if m.Hermes.BaseURL != "" {
		return trimSlash(m.Hermes.BaseURL)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", m.HermesPort())
}

// HermesHealthURL is the full URL a health probe should GET.
func (m *Manifest) HermesHealthURL() string {
	return m.HermesBaseURL() + m.HermesHealth()
}

// ---- gateway accessors (section → system server → default) ----

// GatewayPort resolves the gateway admin port.
func (m *Manifest) GatewayPort() int {
	if m.Gateway.Port > 0 {
		return m.Gateway.Port
	}
	if s, ok := m.systemServer(SystemGateway); ok && s.Port > 0 {
		return s.Port
	}
	return DefaultGatewayPort
}

// GatewayHealth resolves the gateway health/status path.
func (m *Manifest) GatewayHealth() string {
	if m.Gateway.Health != "" {
		return ensureLeadingSlash(m.Gateway.Health)
	}
	if s, ok := m.systemServer(SystemGateway); ok && s.Health != "" {
		return s.Health
	}
	return DefaultGatewayHealth
}

// GatewayBaseURL resolves the gateway base URL.
func (m *Manifest) GatewayBaseURL() string {
	if m.Gateway.BaseURL != "" {
		return trimSlash(m.Gateway.BaseURL)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", m.GatewayPort())
}

// GatewayStatusURL is the full URL for a gateway status probe.
func (m *Manifest) GatewayStatusURL() string {
	return m.GatewayBaseURL() + m.GatewayHealth()
}

// GatewayReloadURL resolves the admin reload endpoint: [gateway].reload_path
// joined to the base URL, else the legacy top-level gateway_reload_url override,
// else base URL + the default reload path.
func (m *Manifest) GatewayReloadURL() string {
	if m.Gateway.ReloadPath != "" {
		return m.GatewayBaseURL() + ensureLeadingSlash(m.Gateway.ReloadPath)
	}
	if m.GatewayReloadURLRaw != "" {
		return m.GatewayReloadURLRaw
	}
	return m.GatewayBaseURL() + DefaultGatewayReloadPath
}

// ---- fleet window accessors ----

// FleetPortMin / FleetPortMax resolve the static-port window (defaults 42000-42999).
func (m *Manifest) FleetPortMin() int {
	if m.Fleet.PortMin > 0 {
		return m.Fleet.PortMin
	}
	return PortMin
}

func (m *Manifest) FleetPortMax() int {
	if m.Fleet.PortMax > 0 {
		return m.Fleet.PortMax
	}
	return PortMax
}

// ---- small string helpers ----

func ensureLeadingSlash(p string) string {
	if p == "" || p[0] == '/' {
		return p
	}
	return "/" + p
}

func trimSlash(u string) string {
	for len(u) > 0 && u[len(u)-1] == '/' {
		u = u[:len(u)-1]
	}
	return u
}
