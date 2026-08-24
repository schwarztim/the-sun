// Command fleetd is the static-port process supervisor for streamable-HTTP MCP
// servers. It is the supervision engine behind the `thesun` tool: one TOML
// manifest is the source of truth; fleetd spawns each server on a fixed loopback
// port, health-checks and auto-restarts them with a circuit breaker, injects
// Hermes secrets into child env only, publishes an MCPU-schema gateway config,
// and survives its own death by re-adopting still-healthy children.
//
// All command logic lives in internal/cli so the unified `thesun` binary shares
// exactly the same implementation. This binary is a thin entry point.
package main

import (
	"os"

	"mcp-fleet/fleetd/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args))
}
