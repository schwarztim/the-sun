// Package manifest parses and validates the fleetd source-of-truth manifest
// (~/.mcp-fleet/fleet.toml). It enforces the static-port contract (42000-42999),
// port uniqueness, and required fields — failing closed on any violation so the
// supervisor never starts with an ambiguous or unsafe configuration.
package manifest

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

// Static-port window. Every server MUST bind a loopback TCP port inside this
// range. Dynamic ports were a Docker artifact; static ports keep the published
// gateway config near-static and reconnects trivial (see GO-MIGRATION-DESIGN §2).
const (
	PortMin = 42000
	PortMax = 42999

	DefaultHealthPath  = "/healthz"
	DefaultMaxRestarts = 5

	// Server kinds. fleetd supervises every entry the same way (spawn, health-
	// check, restart); kind only changes two things: system entries are exempt
	// from the static-port window (they bind their own well-known ports, e.g.
	// hermes :9876, gateway :3100) and are NOT published to the gateway config
	// (they are infrastructure, not MCP backends).
	KindMCP    = "mcp"
	KindSystem = "system"
)

// Server is one supervised process — an MCP server (kind="mcp", the default) or
// a stack infrastructure component (kind="system": hermes, the gateway).
type Server struct {
	Name        string            `toml:"name"`
	Kind        string            `toml:"kind"`
	Bin         string            `toml:"bin"`
	Args        []string          `toml:"args"`
	Port        int               `toml:"port"`
	Env         map[string]string `toml:"env"`
	Health      string            `toml:"health"`
	MaxRestarts int               `toml:"max_restarts"`
}

// IsSystem reports whether this entry is a supervised infrastructure component
// (not an MCP backend).
func (s Server) IsSystem() bool { return s.Kind == KindSystem }

// Manifest is the whole suite config (thesun.toml): the supervised [[server]]
// tree plus the four optional settings sections (see suite.go).
type Manifest struct {
	// Legacy top-level override for the gateway reload endpoint. Prefer the
	// [gateway] section; this is kept as a back-compat shim and consulted by the
	// GatewayReloadURL() accessor when the section does not specify a reload path.
	GatewayReloadURLRaw string `toml:"gateway_reload_url"`

	// Settings sections. All optional — accessors in suite.go fall back to the
	// system [[server]] entries and then to built-in defaults.
	Generator GeneratorConfig `toml:"generator"`
	Fleet     FleetConfig     `toml:"fleet"`
	Hermes    HermesConfig    `toml:"hermes"`
	Gateway   GatewayConfig   `toml:"gateway"`

	// The supervised process tree (MCP servers + kind="system" infrastructure).
	Servers []Server `toml:"server"`
}

// Load reads, parses, and validates the manifest at path.
func Load(path string) (*Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest %s: %w", path, err)
	}
	m, err := Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return m, nil
}

// Parse unmarshals and validates raw manifest bytes. Exposed so the CLI's
// add/rm editors can validate an edited manifest before committing it to disk.
func Parse(raw []byte) (*Manifest, error) {
	var m Manifest
	if err := toml.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// validate fails closed on any structural problem: missing fields, out-of-range
// ports, or duplicate ports/names across servers.
func (m *Manifest) validate() error {
	if len(m.Servers) == 0 {
		return fmt.Errorf("manifest has no [[server]] entries")
	}

	seenPort := map[int]string{} // port -> owning server name
	seenName := map[string]bool{}

	for i := range m.Servers {
		s := &m.Servers[i]

		s.Name = strings.TrimSpace(s.Name)
		if s.Name == "" {
			return fmt.Errorf("server #%d: missing name", i+1)
		}
		if seenName[s.Name] {
			return fmt.Errorf("duplicate server name %q", s.Name)
		}
		seenName[s.Name] = true

		if strings.TrimSpace(s.Bin) == "" {
			return fmt.Errorf("server %q: missing bin", s.Name)
		}

		// Normalize + validate kind (default mcp).
		s.Kind = strings.TrimSpace(s.Kind)
		if s.Kind == "" {
			s.Kind = KindMCP
		}
		if s.Kind != KindMCP && s.Kind != KindSystem {
			return fmt.Errorf("server %q: invalid kind %q (want %q or %q)", s.Name, s.Kind, KindMCP, KindSystem)
		}

		// Every entry needs a port to health-check on. MCP servers must bind the
		// static window; system infra (hermes/gateway) uses its own well-known
		// port and is exempt from the window (but still port-unique).
		if s.Port <= 0 {
			return fmt.Errorf("server %q: missing port", s.Name)
		}
		if s.Kind == KindMCP && (s.Port < PortMin || s.Port > PortMax) {
			return fmt.Errorf("server %q: port %d out of range (must be %d-%d)",
				s.Name, s.Port, PortMin, PortMax)
		}
		// Fail closed: no two servers may share a port.
		if owner, dup := seenPort[s.Port]; dup {
			return fmt.Errorf("duplicate port %d used by %q and %q", s.Port, owner, s.Name)
		}
		seenPort[s.Port] = s.Name

		// Apply defaults.
		if strings.TrimSpace(s.Health) == "" {
			s.Health = DefaultHealthPath
		}
		if !strings.HasPrefix(s.Health, "/") {
			s.Health = "/" + s.Health
		}
		if s.MaxRestarts <= 0 {
			s.MaxRestarts = DefaultMaxRestarts
		}
		if s.Env == nil {
			s.Env = map[string]string{}
		}
	}
	return nil
}

// Names returns the server names in a stable sorted order (for deterministic
// output and diffing during reload).
func (m *Manifest) Names() []string {
	out := make([]string, 0, len(m.Servers))
	for _, s := range m.Servers {
		out = append(out, s.Name)
	}
	sort.Strings(out)
	return out
}
