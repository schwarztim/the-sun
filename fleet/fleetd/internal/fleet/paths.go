package fleet

import (
	"os"
	"path/filepath"

	"mcp-fleet/fleetd/internal/paths"
)

// Runtime layout. All paths derive from one root. By default that root is
// THESUN_HOME (see internal/paths) so the whole stack is cross-platform and
// relocatable. The legacy FLEETD_* environment overrides are still honoured —
// they keep test isolation and any existing deployment working unchanged.

// Root is the fleetd state root; override with FLEETD_ROOT (used by tests to
// stay isolated from a real deployment). Otherwise it is THESUN_HOME.
func Root() string {
	if r := os.Getenv("FLEETD_ROOT"); r != "" {
		return r
	}
	return paths.Home()
}

// rootedUnderLegacy reports whether a legacy FLEETD_ROOT override is in effect;
// when it is, per-server runtime paths stay rooted under it (test isolation).
func rootedUnderLegacy() (string, bool) {
	r := os.Getenv("FLEETD_ROOT")
	return r, r != ""
}

func ManifestPath() string {
	if p := os.Getenv("FLEETD_MANIFEST"); p != "" {
		return p
	}
	if r, ok := rootedUnderLegacy(); ok {
		return filepath.Join(r, "fleet.toml")
	}
	return paths.Config()
}

func SocketPath() string {
	if r, ok := rootedUnderLegacy(); ok {
		return filepath.Join(r, "fleetd.sock")
	}
	return paths.SocketPath()
}

func RunDir() string {
	if r, ok := rootedUnderLegacy(); ok {
		return filepath.Join(r, "run")
	}
	return paths.RunDir()
}

func LogDir() string {
	if r, ok := rootedUnderLegacy(); ok {
		return filepath.Join(r, "logs")
	}
	return paths.LogDir()
}

func pidFile(n string) string { return filepath.Join(RunDir(), n+".pid") }
func logFile(n string) string { return filepath.Join(LogDir(), n+".log") }

// PidFile and LogFile expose the per-server runtime paths to the CLI (`fleetd
// list` reads the pidfile mtime for uptime; `fleetd logs` reads the log file).
func PidFile(n string) string { return pidFile(n) }
func LogFile(n string) string { return logFile(n) }

// PublishedConfigPath is the MCPU-schema file the gateway ingests.
func PublishedConfigPath() string {
	if p := os.Getenv("FLEETD_PUBLISH_PATH"); p != "" {
		return p
	}
	if r, ok := rootedUnderLegacy(); ok {
		return filepath.Join(r, "run", "gateway-config.json")
	}
	return paths.PublishedConfigPath()
}

// altGatewayReloadPaths are also attempted if the primary path 404s.
var altGatewayReloadPaths = []string{
	"http://127.0.0.1:3100/admin/fleet/reload",
}
