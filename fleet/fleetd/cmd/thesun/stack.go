package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/cli"
	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/paths"
	"mcp-fleet/fleetd/internal/svc"
)

// ---- portable location helpers (no literal ~, no shelling for discovery) ----

// mustExe resolves this binary's own path, following symlinks.
//
// The symlink resolution is load-bearing, not tidiness. `thesun` is normally
// reached through a link on PATH (~/.local/bin/thesun -> <bundle>/bin/thesun),
// and os.Executable() returns the LINK, not its target. Every bundle-relative
// path is derived from this, so without EvalSymlinks the bundle root resolves to
// the link's grandparent (~/.local) and everything under it silently points at a
// directory that holds no bundle: install.sh is "missing", the checkout is "not
// a git checkout", and the generator and hermes appear unbuilt.
func mustExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		return real
	}
	return exe
}

func bundleRoot() string { return paths.BundleRoot(mustExe()) }

// nodePath resolves an absolute `node` interpreter, or "" if none is on PATH.
func nodePath() string {
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	return ""
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// passthrough runs prog with args, wiring the child to our stdio (interactive-
// safe), and returns its exit code.
func passthrough(prog string, args ...string) int {
	c := exec.Command(prog, args...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if err := c.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
		return 1
	}
	return 0
}

// httpText does a GET/POST and returns the body text (best effort).
func httpText(method, url string) (int, string, error) {
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return 0, "", err
	}
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, string(b), nil
}

// ---- generator (Node) ----

func runGenerator(cmd string, args []string) int {
	node := nodePath()
	if node == "" {
		fmt.Fprintln(os.Stderr, "thesun: `node` not found on PATH — install Node.js to use the generator")
		return 1
	}
	genCLI := filepath.Join(bundleRoot(), "generator", "dist", "cli", "index.js")
	if !exists(genCLI) {
		fmt.Fprintf(os.Stderr, "thesun: generator not built (%s missing) — run: thesun install\n", genCLI)
		return 1
	}
	full := append([]string{genCLI, cmd}, args...)
	return passthrough(node, full...)
}

// ---- gateway (Node) admin API ----

// loadSuite loads thesun.toml best-effort (nil on any error) so subsystem
// front-ends can read the [gateway]/[hermes] connection settings from the single
// suite config instead of hardcoded constants.
func loadSuite() *manifest.Manifest {
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		return nil
	}
	return m
}

// gatewayURL resolves the gateway admin base URL: $THESUN_GATEWAY_URL wins, then
// the [gateway] section of thesun.toml, then the built-in default.
func gatewayURL() string {
	if u := os.Getenv("THESUN_GATEWAY_URL"); u != "" {
		return u
	}
	if m := loadSuite(); m != nil {
		return m.GatewayBaseURL()
	}
	return fmt.Sprintf("http://127.0.0.1:%d", manifest.DefaultGatewayPort)
}

func gatewayCmd(args []string) int {
	sub := "status"
	if len(args) > 0 {
		sub = args[0]
	}
	base := gatewayURL()
	switch sub {
	case "status":
		code, body, err := httpText(http.MethodGet, base+"/admin/status")
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun: gateway not reachable at %s (%v)\n", base, err)
			return 1
		}
		fmt.Print(body)
		if body != "" && body[len(body)-1] != '\n' {
			fmt.Println()
		}
		if code >= 300 {
			return 1
		}
		return 0
	case "reload":
		code, body, err := httpText(http.MethodPost, base+"/admin/reload-config")
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun: gateway reload failed (%v)\n", err)
			return 1
		}
		if code >= 300 {
			fmt.Fprintf(os.Stderr, "thesun: gateway reload returned %d: %s\n", code, body)
			return 1
		}
		fmt.Println("gateway reloaded")
		return 0
	default:
		fmt.Fprintf(os.Stderr, "thesun: gateway: unknown subcommand %q (status|reload)\n", sub)
		return 2
	}
}

// ---- hermes (Node) broker CLI passthrough ----

func hermesPassthrough(args []string) int {
	node := nodePath()
	if node == "" {
		fmt.Fprintln(os.Stderr, "thesun: `node` not found on PATH — install Node.js to use hermes")
		return 1
	}
	hermesCLI := filepath.Join(bundleRoot(), "hermes", "packages", "broker", "dist", "cli.js")
	if !exists(hermesCLI) {
		fmt.Fprintf(os.Stderr, "thesun: hermes not built (%s missing) — run: thesun install\n", hermesCLI)
		return 1
	}
	full := append([]string{hermesCLI}, args...)
	return passthrough(node, full...)
}

// ---- whole-stack supervision ----

// daemonUp reports whether the fleetd control socket answers.
func daemonUp() bool {
	_, err := fleet.SendControl(fleet.Request{Cmd: "status"})
	return err == nil
}

func stackUp(_ []string) int {
	// Ensure THESUN_HOME exists and has a manifest.
	if err := paths.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
		return 1
	}
	if !exists(fleet.ManifestPath()) {
		if rc := initHome(nil); rc != 0 {
			return rc
		}
	}

	if daemonUp() {
		fmt.Println("stack already up — reloading manifest")
		cli.Fleet("reload", nil)
		return cli.Status(nil)
	}

	// Prefer the OS service if installed; else spawn a detached `thesun run`.
	if svc.Installed() {
		fmt.Println("▶ starting fleetd via OS service manager …")
		if err := svc.Control("start"); err != nil {
			fmt.Fprintf(os.Stderr, "thesun: service start failed: %v\n", err)
			return 1
		}
	} else {
		fmt.Println("▶ starting fleetd (detached) …")
		if err := spawnDaemon(); err != nil {
			fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
			return 1
		}
	}

	// Wait for the control socket to come up (fleetd then brings up the tree).
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if daemonUp() {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !daemonUp() {
		fmt.Fprintln(os.Stderr, "thesun: fleetd did not come up within 12s — check logs (thesun logs <server>)")
		return 1
	}
	fmt.Println("up. supervising hermes + gateway + servers.")
	return cli.Status(nil)
}

// spawnDaemon launches `thesun run` detached, logging to THESUN_HOME/logs.
func spawnDaemon() error {
	exe := mustExe()
	if exe == "" {
		return fmt.Errorf("cannot resolve own executable to spawn the daemon")
	}
	if err := paths.EnsureDirs(); err != nil {
		return err
	}
	logPath := filepath.Join(paths.LogDir(), "fleetd.out")
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	defer lf.Close()

	c := exec.Command(exe, "run")
	c.Stdout = lf
	c.Stderr = lf
	c.Env = os.Environ()
	c.SysProcAttr = daemonSysProcAttr()
	if err := c.Start(); err != nil {
		return fmt.Errorf("spawn fleetd: %w", err)
	}
	return nil
}

func stackDown(_ []string) int {
	if daemonUp() {
		// Stop children, then the daemon.
		_, _ = fleet.SendControl(fleet.Request{Cmd: "stop"})
		_, _ = fleet.SendControl(fleet.Request{Cmd: "shutdown"})
		fmt.Println("down.")
		return 0
	}
	if svc.Installed() {
		if err := svc.Control("stop"); err != nil {
			fmt.Fprintf(os.Stderr, "thesun: service stop failed: %v\n", err)
			return 1
		}
		fmt.Println("down.")
		return 0
	}
	fmt.Println("stack already down.")
	return 0
}

// ---- service subcommand (kardianos: launchd/systemd/Windows) ----

func serviceCmd(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: thesun service install|uninstall|start|stop|restart|status")
		return 2
	}
	switch args[0] {
	case "install", "uninstall", "start", "stop", "restart":
		if err := svc.Control(args[0]); err != nil {
			fmt.Fprintf(os.Stderr, "thesun: service %s failed: %v\n", args[0], err)
			return 1
		}
		fmt.Printf("service %s ok (fleetd via `thesun run`, user scope)\n", args[0])
		return 0
	case "status":
		st, err := svc.Status()
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
			return 1
		}
		fmt.Printf("thesun service: %s\n", st)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "thesun: service: unknown action %q\n", args[0])
		return 2
	}
}

// ---- install (build every subsystem via the bundle install.sh) ----

func runInstall(args []string) int {
	script := filepath.Join(bundleRoot(), "install.sh")
	if !exists(script) {
		fmt.Fprintf(os.Stderr, "thesun: %s not found (are you running the installed bundle binary?)\n", script)
		return 1
	}
	sh, err := exec.LookPath("bash")
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun: bash not found — run the bundle's install.sh manually")
		return 1
	}
	return passthrough(sh, append([]string{script}, args...)...)
}

// ---- init: scaffold THESUN_HOME + default manifest ----

func initHome(_ []string) int {
	if err := paths.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
		return 1
	}
	cfg := fleet.ManifestPath()
	if exists(cfg) {
		fmt.Printf("thesun home ready at %s (config %s already exists)\n", paths.Home(), cfg)
		return 0
	}
	content := defaultManifest()
	if err := os.WriteFile(cfg, []byte(content), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "thesun: write %s: %v\n", cfg, err)
		return 1
	}
	fmt.Printf("initialized thesun home at %s\n", paths.Home())
	fmt.Printf("  config:  %s\n", cfg)
	fmt.Printf("  logs:    %s\n", paths.LogDir())
	fmt.Printf("  run:     %s\n", paths.RunDir())
	fmt.Printf("  servers: %s\n", paths.ServersDir())

	added, warn := mergeShippedDefaults(cfg)
	if len(added) > 0 {
		fmt.Printf("  defaults: merged %s (genuinely-easy-auth servers; GitHub stays opt-in — see `thesun add`)\n", strings.Join(added, ", "))
	}
	if warn != "" {
		fmt.Printf("  note: %s\n", warn)
	}
	return 0
}

// ---- init: merge shipped default MCP servers (Atlassian/ServiceNow/M365) ----

// shippedManifestPlaceholderRoot is the placeholder checkout path used
// throughout fleet/default-manifest.toml's `bin`/`args` entries (see that
// file's own header comment: "Replace the path below with your actual thesun
// checkout location"). mergeShippedDefaults substitutes it for this bundle's
// real root so the merged entries point at real paths on this machine,
// instead of shipping a broken placeholder into the operator's live config.
const shippedManifestPlaceholderRoot = "/Users/you/Projects/thesun"

// defaultManifestSourcePath resolves the shipped fleet/default-manifest.toml
// that ships alongside this bundle (fleet/default-manifest.toml, sibling of
// bin/thesun's fleet/fleetd source tree) — the curated, genuinely-easy-auth
// server list (Atlassian, ServiceNow, M365). GitHub is deliberately absent
// from that file (PAT required — not genuinely-easy) and stays opt-in.
func defaultManifestSourcePath() string {
	return filepath.Join(bundleRoot(), "fleet", "default-manifest.toml")
}

// resolveShippedPath rewrites a shipped-manifest path that starts with the
// placeholder checkout root onto this bundle's real root; any other path
// (e.g. a bare "node") is returned unchanged.
func resolveShippedPath(p, bundle string) string {
	if bundle == "" || !strings.HasPrefix(p, shippedManifestPlaceholderRoot) {
		return p
	}
	return bundle + strings.TrimPrefix(p, shippedManifestPlaceholderRoot)
}

func resolveShippedArgs(args []string, bundle string) []string {
	if len(args) == 0 {
		return args
	}
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = resolveShippedPath(a, bundle)
	}
	return out
}

// mergeShippedDefaults idempotently appends every [[server]] block from the
// shipped default-manifest.toml into the live thesun.toml at cfgPath, reusing
// the exact same manifest.Append plumbing `thesun add` uses — no bespoke
// merge logic. Servers already present by name are left untouched (no
// duplicate, no overwrite), which is what makes repeated calls safe: running
// this against an already-merged config is a pure no-op.
//
// A missing/unreadable/unparsable source manifest, or an unexpected per-entry
// Append failure, is reported as a warning string — never a fatal error. A
// fresh install must still end up with a working stack (hermes + gateway)
// even if the shipped-defaults merge can't run for some reason; the operator
// can always add servers by hand with `thesun add`. Likewise, entries whose
// `bin` isn't built yet are still added — fleetd only needs the manifest
// entry to exist, not the binary, at init time (doctor/status report FAIL for
// an unbuilt server, which is the correct place to surface that, not init).
func mergeShippedDefaults(cfgPath string) (added []string, warn string) {
	src := defaultManifestSourcePath()
	raw, err := os.ReadFile(src)
	if err != nil {
		return nil, fmt.Sprintf("shipped default manifest not found at %s (%v) — skipping; add servers with `thesun add`", src, err)
	}
	defaults, err := manifest.Parse(raw)
	if err != nil {
		return nil, fmt.Sprintf("shipped default manifest %s failed to parse: %v — skipping", src, err)
	}

	cur, err := manifest.Load(cfgPath)
	if err != nil {
		return nil, fmt.Sprintf("cannot read %s to merge shipped defaults: %v", cfgPath, err)
	}
	existing := make(map[string]bool, len(cur.Servers))
	for _, s := range cur.Servers {
		existing[s.Name] = true
	}

	bundle := bundleRoot()
	var warnings []string
	for _, s := range defaults.Servers {
		if existing[s.Name] {
			continue // already present — idempotent, no duplicate/overwrite
		}
		spec := manifest.AddSpec{
			Name:        s.Name,
			Kind:        s.Kind,
			Bin:         resolveShippedPath(s.Bin, bundle),
			Args:        resolveShippedArgs(s.Args, bundle),
			Port:        s.Port,
			Env:         s.Env,
			Health:      s.Health,
			MaxRestarts: s.MaxRestarts,
		}
		if err := manifest.Append(cfgPath, spec); err != nil {
			// Name/port were just checked against cur above, so this should not
			// happen in practice — but fail closed on this one entry rather than
			// the whole init if it ever does (e.g. a port collision with a
			// hand-edited system entry).
			warnings = append(warnings, fmt.Sprintf("server %q: %v", s.Name, err))
			continue
		}
		added = append(added, s.Name)
		existing[s.Name] = true
	}
	return added, strings.Join(warnings, "; ")
}

// defaultManifest renders a well-commented thesun.toml — THE single config for
// the whole suite. It carries four settings sections ([generator], [fleet],
// [hermes], [gateway]) plus the supervised process tree ([[server]]). The two
// kind="system" entries (hermes, gateway) are seeded from the same values as the
// sections so there is no drift, and are resolved to this bundle's Node scripts
// and an absolute node interpreter (so the daemon finds node even under a
// minimal service-manager PATH). MCP servers are added later via `thesun add`.
func defaultManifest() string {
	node := nodePath()
	if node == "" {
		node = "node" // fall back to PATH lookup at spawn time
	}
	bundle := bundleRoot()
	generatorCLI := filepath.Join(bundle, "generator", "dist", "cli", "index.js")
	hermesCLI := filepath.Join(bundle, "hermes", "packages", "broker", "dist", "cli.js")
	gatewayEntry := filepath.Join(bundle, "gateway", "dist", "index.js")
	// Pin the gateway to the fleet config explicitly. The gateway defaults to
	// config.yaml (the small sample); fleetd's child env intentionally drops
	// process-env passthrough, so without this the supervised gateway would fall
	// back to config.yaml on restart and lose the explicit fleet namespaces.
	gatewayConfig := filepath.Join(bundle, "gateway", "config.fleet.yaml")

	q := strconv.Quote
	hp := manifest.DefaultHermesPort
	gp := manifest.DefaultGatewayPort

	return "# thesun.toml — the single config for the whole suite (generated by `thesun init`).\n" +
		"#\n" +
		"# Four settings sections describe the subsystems; the [[server]] tree is what\n" +
		"# fleetd actually supervises. kind=\"system\" entries are stack infrastructure\n" +
		"# (own well-known ports, never published as MCP backends); kind=\"mcp\" (the\n" +
		"# default) entries are streamable-HTTP MCP servers on static loopback ports.\n" +
		"# Add MCP servers with `thesun add`; check readiness with `thesun doctor`.\n" +
		"\n" +
		"# The Node generator that turns a REST API into an MCP server.\n" +
		"[generator]\n" +
		"node = " + q(node) + "\n" +
		"cli  = " + q(generatorCLI) + "\n" +
		"\n" +
		"# The static-port window every kind=\"mcp\" server must bind.\n" +
		"[fleet]\n" +
		"port_min = " + strconv.Itoa(manifest.PortMin) + "\n" +
		"port_max = " + strconv.Itoa(manifest.PortMax) + "\n" +
		"\n" +
		"# The Hermes auth broker + encrypted vault.\n" +
		"[hermes]\n" +
		"port     = " + strconv.Itoa(hp) + "\n" +
		"base_url = " + q(fmt.Sprintf("http://127.0.0.1:%d", hp)) + "\n" +
		"health   = \"/health\"\n" +
		"cmd      = [" + q(node) + ", " + q(hermesCLI) + ", \"start\"]\n" +
		"\n" +
		"# The gateway that muxes MCP servers to clients.\n" +
		"[gateway]\n" +
		"port        = " + strconv.Itoa(gp) + "\n" +
		"base_url    = " + q(fmt.Sprintf("http://127.0.0.1:%d", gp)) + "\n" +
		"health      = \"/admin/status\"\n" +
		"reload_path = \"/admin/reload-config\"\n" +
		"cmd         = [" + q(node) + ", " + q(gatewayEntry) + "]\n" +
		"\n" +
		"# ---- supervised process tree ----\n" +
		"\n" +
		"[[server]]\n" +
		"name = \"hermes\"\n" +
		"kind = \"system\"\n" +
		"bin = " + q(node) + "\n" +
		"args = [" + q(hermesCLI) + ", \"start\"]\n" +
		"port = " + strconv.Itoa(hp) + "\n" +
		"health = \"/health\"\n" +
		"max_restarts = 5\n" +
		"\n" +
		"[[server]]\n" +
		"name = \"gateway\"\n" +
		"kind = \"system\"\n" +
		"bin = " + q(node) + "\n" +
		"args = [" + q(gatewayEntry) + "]\n" +
		"port = " + strconv.Itoa(gp) + "\n" +
		"health = \"/admin/status\"\n" +
		"max_restarts = 5\n" +
		"[server.env]\n" +
		"MCP_GATEWAY_CONFIG = " + q(gatewayConfig) + "\n"
}
