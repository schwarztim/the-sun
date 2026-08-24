// Package paths is the single source of truth for every runtime path the thesun
// stack uses. Everything is derived from one root, THESUN_HOME, so the whole
// tool relocates by setting a single environment variable and is identical on
// macOS, Linux, and Windows.
//
// Resolution of the root:
//
//	$THESUN_HOME               explicit override (any OS)
//	os.UserConfigDir()/thesun  default:
//	                             macOS   ~/Library/Application Support/thesun
//	                             Linux   ~/.config/thesun            ($XDG_CONFIG_HOME)
//	                             Windows %AppData%\thesun
//
// No literal "~" and no "/"-joined string paths appear anywhere — filepath.Join
// keeps separators correct on Windows.
package paths

import (
	"os"
	"path/filepath"
)

// EnvHome is the environment variable that overrides the root.
const EnvHome = "THESUN_HOME"

// EnvBundle overrides the installed-bundle location (where the Node subsystems —
// generator, gateway, hermes — live). Defaults to the parent of the running
// binary's directory (…/thesun/bin/thesun → …/thesun).
const EnvBundle = "THESUN_BUNDLE"

// Home returns the resolved THESUN_HOME root. It never returns "" — on the
// (unlikely) failure of os.UserConfigDir it falls back to the OS temp dir so
// callers always get a usable, writable-ish location rather than a panic.
func Home() string {
	if h := os.Getenv(EnvHome); h != "" {
		return h
	}
	cfg, err := os.UserConfigDir()
	if err != nil || cfg == "" {
		return filepath.Join(os.TempDir(), "thesun")
	}
	return filepath.Join(cfg, "thesun")
}

// Config is the fleet manifest / stack config file (thesun.toml).
func Config() string { return filepath.Join(Home(), "thesun.toml") }

// LogDir holds per-server combined stdout/stderr logs.
func LogDir() string { return filepath.Join(Home(), "logs") }

// RunDir holds ephemeral runtime state: the control socket, pid files, and the
// published gateway config.
func RunDir() string { return filepath.Join(Home(), "run") }

// ServersDir is where generated MCP server binaries are installed.
func ServersDir() string { return filepath.Join(Home(), "servers") }

// VaultDir is the on-disk location for the Hermes credential vault when the
// stack manages it under THESUN_HOME.
func VaultDir() string { return filepath.Join(Home(), "vault") }

// SocketPath is the fleetd control unix socket.
func SocketPath() string { return filepath.Join(RunDir(), "fleetd.sock") }

// PidFile / LogFile are the per-server runtime files.
func PidFile(name string) string { return filepath.Join(RunDir(), name+".pid") }
func LogFile(name string) string { return filepath.Join(LogDir(), name+".log") }

// PublishedConfigPath is the MCPU-schema file fleetd writes and the gateway
// ingests. It lives under THESUN_HOME so the bundle never collides with any
// other fleet's published config on the same machine.
func PublishedConfigPath() string {
	return filepath.Join(RunDir(), "gateway-config.json")
}

// BundleRoot resolves the installed bundle directory (containing generator/,
// gateway/, hermes/, bin/). Override with $THESUN_BUNDLE; otherwise it is the
// parent of the running executable's directory. exe is normally os.Executable().
func BundleRoot(exe string) string {
	if b := os.Getenv(EnvBundle); b != "" {
		return b
	}
	if exe == "" {
		return ""
	}
	// Resolve symlinks FIRST, then walk up. thesun is normally reached through a
	// link on PATH (~/.local/bin/thesun -> <bundle>/bin/thesun), and
	// os.Executable() hands back the LINK, so walking up from it lands on the
	// link's grandparent (~/.local) rather than the bundle. Everything
	// bundle-relative is derived here, so that one wrong turn makes install.sh
	// "missing", the checkout "not a git checkout", and the built subsystems
	// invisible, all with paths that look plausible in the error message.
	//
	// Fixed here rather than at each call site because there are several, and the
	// next one added would reintroduce it.
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	// <bundle>/bin/thesun -> <bundle>
	return filepath.Dir(filepath.Dir(exe))
}

// EnsureDirs creates the runtime directory tree (Home, logs, run, servers,
// vault) with private-ish permissions. Idempotent.
func EnsureDirs() error {
	for _, d := range []string{Home(), LogDir(), RunDir(), ServersDir(), VaultDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
