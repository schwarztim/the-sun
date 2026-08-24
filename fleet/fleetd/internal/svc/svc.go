// Package svc registers the thesun supervisor with the OS service manager —
// launchd (macOS), systemd (Linux), or the Windows Service Manager — through a
// single cross-platform library (github.com/kardianos/service). There is no
// launchctl/systemctl/sc shelling anywhere: one code path installs the root
// supervisor everywhere.
//
// The registered service runs `thesun run` (this same binary in daemon mode),
// which brings up the whole supervised tree: hermes + gateway + every MCP
// server. Installing as a *user* service means no root/sudo is required.
package svc

import (
	"fmt"
	"os"

	"github.com/kardianos/service"

	"mcp-fleet/fleetd/internal/paths"
)

// program satisfies service.Interface. The service manager launches the
// configured Executable+Arguments (`thesun run`) directly, so these methods are
// only exercised on platforms that invoke the in-process runner; they are safe
// no-ops for our install/uninstall/start/stop/status control flow.
type program struct{}

func (program) Start(service.Service) error { return nil }
func (program) Stop(service.Service) error  { return nil }

// Config builds the cross-platform service.Config for `thesun run`. The running
// executable is used as the service binary, THESUN_HOME/THESUN_BUNDLE are
// propagated so the daemon resolves the same paths the CLI did, and the service
// is installed at user scope (no sudo).
func config() (*service.Config, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve executable: %w", err)
	}

	env := map[string]string{
		paths.EnvHome:   paths.Home(),
		paths.EnvBundle: paths.BundleRoot(exe),
	}

	return &service.Config{
		Name:             "thesun",
		DisplayName:      "thesun MCP fleet",
		Description:      "thesun supervisor — hermes, gateway, and all MCP servers as one tree",
		Executable:       exe,
		Arguments:        []string{"run"},
		WorkingDirectory: paths.BundleRoot(exe),
		EnvVars:          env,
		Option: service.KeyValue{
			// User-scoped agent/unit (no root); start at load and keep alive.
			"UserService": true,
			"RunAtLoad":   true,
			"KeepAlive":   true,
		},
	}, nil
}

// New constructs the service handle.
func New() (service.Service, error) {
	cfg, err := config()
	if err != nil {
		return nil, err
	}
	return service.New(program{}, cfg)
}

// Control runs an install/uninstall/start/stop/restart action. Valid actions are
// exactly service.ControlAction values.
func Control(action string) error {
	s, err := New()
	if err != nil {
		return err
	}
	valid := false
	for _, a := range service.ControlAction {
		if a == action {
			valid = true
			break
		}
	}
	if !valid {
		return fmt.Errorf("unknown service action %q (want one of %v)", action, service.ControlAction)
	}
	return service.Control(s, action)
}

// Status returns a human-readable service status ("running", "stopped",
// "not installed", or an error string).
func Status() (string, error) {
	s, err := New()
	if err != nil {
		return "", err
	}
	st, err := s.Status()
	if err != nil {
		if err == service.ErrNotInstalled {
			return "not installed", nil
		}
		return "", err
	}
	switch st {
	case service.StatusRunning:
		return "running", nil
	case service.StatusStopped:
		return "stopped", nil
	default:
		return "unknown", nil
	}
}

// Installed reports whether the service is registered with the OS manager.
func Installed() bool {
	s, err := New()
	if err != nil {
		return false
	}
	_, err = s.Status()
	return err != service.ErrNotInstalled
}
