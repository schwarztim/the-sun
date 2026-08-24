package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/camouflage"
	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/paths"
	"mcp-fleet/fleetd/internal/svc"
)

// doctor.go implements `thesun doctor` — one command that runs readiness
// diagnostics across the whole suite and prints a clear PASS/WARN/FAIL report.
// It reads only metadata (never a secret value), makes read-only GET /health
// probes, and never mutates the live stack. Exit code is non-zero if any check
// FAILs.

// Status levels, ordered by severity (worst wins for the overall verdict).
const (
	statusPass = "PASS"
	statusWarn = "WARN"
	statusFail = "FAIL"
)

type checkResult struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type doctorReport struct {
	Overall string        `json:"overall"`
	Checks  []checkResult `json:"checks"`
}

// DoctorCheck / DoctorReport are the exported forms of checkResult/doctorReport
// — the same readiness data `thesun doctor --json` prints, but returned
// in-process so callers (e.g. the `thesun install` agent-guided loop) can walk
// the checks and react to FAILs without shelling out to parse JSON off stdout.
type DoctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type DoctorReport struct {
	Overall string        `json:"overall"`
	Checks  []DoctorCheck `json:"checks"`
}

// RunDoctor executes every readiness check (identical logic to `thesun doctor`)
// and returns the structured report — no printing, no flag parsing, no
// process exit. This is the single source of truth both `Doctor` (the CLI
// front-end) and any in-process caller build on.
func RunDoctor() *DoctorReport {
	rep := runDoctorChecks()
	out := &DoctorReport{Overall: rep.Overall, Checks: make([]DoctorCheck, len(rep.Checks))}
	for i, c := range rep.Checks {
		out.Checks[i] = DoctorCheck{Name: c.Name, Status: c.Status, Detail: c.Detail}
	}
	return out
}

// worse returns the more severe of two statuses.
func worse(a, b string) string {
	rank := map[string]int{statusPass: 0, statusWarn: 1, statusFail: 2}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// Doctor runs every readiness check and reports. `--json` emits doctorReport.
func Doctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit the diagnostics report as JSON")
	_ = fs.Parse(args)

	report := runDoctorChecks()

	if *asJSON {
		b, _ := json.MarshalIndent(report, "", "  ")
		fmt.Println(string(b))
	} else {
		renderDoctor(report)
	}

	if report.Overall == statusFail {
		return 1
	}
	return 0
}

// runDoctorChecks executes every readiness check and returns the report,
// independent of CLI flag parsing or output — the shared core behind both
// Doctor (CLI) and RunDoctor (in-process/exported).
func runDoctorChecks() *doctorReport {
	var checks []checkResult
	add := func(name, status, detail string) {
		checks = append(checks, checkResult{Name: name, Status: status, Detail: detail})
	}

	// ---- 1. toolchains ----
	checkToolchains(add)

	// ---- 2. THESUN_HOME + config ----
	m := checkHomeAndConfig(add) // returns parsed manifest or nil

	// ---- gather live fleet state once (nil if the daemon is down) ----
	var live map[string]fleet.ServerStatus
	if resp, err := fleet.SendControl(fleet.Request{Cmd: "status"}); err == nil && resp != nil {
		live = map[string]fleet.ServerStatus{}
		for _, s := range resp.Servers {
			live[s.Name] = s
		}
	}

	// ---- 3. ports ----
	checkPorts(add, m, live)

	// ---- 4. vault/auth (hermes reachable + session expiry) ----
	checkAuth(add, m)

	// ---- 5. manifest sync (published config vs running fleet) ----
	checkManifestSync(add, live)

	// ---- 6. per-server /health ----
	checkServerHealth(add, m, live)

	// ---- 7. OS service registration (reboot/login persistence guarantee) ----
	checkServiceRegistration(add)

	// ---- 8. camouflage fingerprint (browser-matching for generated servers) ----
	checkCamouflage(add)

	// ---- 9. client-side policy hooks (Phase 1b; optional, informational) ----
	HooksDoctorCheck(add)

	// ---- 10. Agent Skills distribution (optional, informational) ----
	SkillsDoctorCheck(add)

	// ---- 11. client MCP wiring (one gateway, not N direct servers) ----
	ClientMCPDoctorCheck(add)

	// ---- 11. MCP Store index reachability (optional, advisory) ----
	StoreIndexDoctorCheck(add)

	// ---- verdict ----
	overall := statusPass
	for _, c := range checks {
		overall = worse(overall, c.Status)
	}
	return &doctorReport{Overall: overall, Checks: checks}
}

// checkToolchains verifies the interpreters/build tools needed to build and run
// the subsystems. node is a runtime dependency (generator/gateway/hermes are
// Node) → FAIL if absent; go and a JS package manager are build-time → WARN.
func checkToolchains(add func(name, status, detail string)) {
	if p, err := exec.LookPath("node"); err == nil {
		v := firstLine(cmdOutput(p, "--version"))
		add("toolchain: node", statusPass, fmt.Sprintf("%s (%s)", strings.TrimSpace(v), p))
	} else {
		add("toolchain: node", statusFail, "not on PATH — required to run generator/gateway/hermes")
	}

	if p, err := exec.LookPath("go"); err == nil {
		add("toolchain: go", statusPass, firstLine(cmdOutput(p, "version")))
	} else {
		add("toolchain: go", statusWarn, "not on PATH — needed to build the fleet/servers")
	}

	pm := ""
	if p, err := exec.LookPath("pnpm"); err == nil {
		pm = "pnpm " + strings.TrimSpace(firstLine(cmdOutput(p, "--version")))
	} else if p, err := exec.LookPath("npm"); err == nil {
		pm = "npm " + strings.TrimSpace(firstLine(cmdOutput(p, "--version")))
	}
	if pm != "" {
		add("toolchain: pnpm/npm", statusPass, pm)
	} else {
		add("toolchain: pnpm/npm", statusWarn, "neither pnpm nor npm found — needed to build Node subsystems")
	}
}

// checkHomeAndConfig verifies THESUN_HOME exists and is writable, and that
// thesun.toml is present and parses. Returns the parsed manifest (nil on any
// blocking failure) so later checks can reuse it.
func checkHomeAndConfig(add func(name, status, detail string)) *manifest.Manifest {
	home := paths.Home()
	if fi, err := os.Stat(home); err != nil || !fi.IsDir() {
		add("home: THESUN_HOME", statusWarn, fmt.Sprintf("%s missing — run `thesun init`", home))
	} else if err := probeWritable(home); err != nil {
		add("home: THESUN_HOME", statusFail, fmt.Sprintf("%s not writable: %v", home, err))
	} else {
		add("home: THESUN_HOME", statusPass, home)
	}

	cfg := fleet.ManifestPath()
	if _, err := os.Stat(cfg); err != nil {
		add("config: thesun.toml", statusWarn, fmt.Sprintf("%s missing — run `thesun init`", cfg))
		return nil
	}
	m, err := manifest.Load(cfg)
	if err != nil {
		add("config: thesun.toml", statusFail, fmt.Sprintf("parse error: %v", err))
		return nil
	}
	add("config: thesun.toml", statusPass, fmt.Sprintf("%s (%d server(s))", cfg, len(m.Servers)))
	return m
}

// checkPorts verifies every configured server's port is either free or held by
// its own supervised process, and that the system ports are reachable.
func checkPorts(add func(name, status, detail string), m *manifest.Manifest, live map[string]fleet.ServerStatus) {
	if m == nil {
		add("ports", statusWarn, "skipped — no parseable config")
		return
	}
	// Ports fleetd currently owns (running supervised servers).
	owned := map[int]string{}
	for _, s := range live {
		if s.State == fleet.StateRunning && s.Port > 0 {
			owned[s.Port] = s.Name
		}
	}

	status := statusPass
	var notes []string
	for _, srv := range m.Servers {
		listening := fleet.PortListening(srv.Port)
		switch {
		case listening && owned[srv.Port] == srv.Name:
			// held by its own process — good.
		case listening && owned[srv.Port] != "":
			status = worse(status, statusFail)
			notes = append(notes, fmt.Sprintf("%s port %d held by %q, not %s", srv.Name, srv.Port, owned[srv.Port], srv.Name))
		case listening:
			// Something is on the port but fleetd doesn't own it. For a system
			// component that just means the stack is up but fleetd isn't managing
			// it (adopt-by-health); flag as a conflict only for MCP servers.
			if srv.IsSystem() {
				// reachable infra — fine
			} else {
				status = worse(status, statusFail)
				notes = append(notes, fmt.Sprintf("%s port %d in use by a non-fleet process", srv.Name, srv.Port))
			}
		default:
			// free — fine (server may simply be stopped).
		}
	}
	// System ports should be reachable when the stack is expected to be up.
	for _, name := range []string{manifest.SystemHermes, manifest.SystemGateway} {
		if s, ok := live[name]; ok && s.State != fleet.StateRunning {
			status = worse(status, statusWarn)
			notes = append(notes, fmt.Sprintf("%s not running (state=%s)", name, s.State))
		}
	}

	detail := "all configured ports free or self-owned"
	if len(notes) > 0 {
		detail = strings.Join(notes, "; ")
	}
	add("ports", status, detail)
}

// checkAuth verifies the Hermes broker is reachable and healthy (read-only
// GET /health, no secrets) and rolls up session expiry from its values-free
// status surface.
func checkAuth(add func(name, status, detail string), m *manifest.Manifest) {
	port := manifest.DefaultHermesPort
	healthPath := manifest.DefaultHermesHealth
	if m != nil {
		port = m.HermesPort()
		healthPath = m.HermesHealth()
	}
	if fleet.ProbeHealth(port, healthPath) {
		add("auth: hermes broker", statusPass, fmt.Sprintf("healthy on :%d%s", port, healthPath))
	} else {
		add("auth: hermes broker", statusFail, fmt.Sprintf("unreachable/unhealthy on :%d%s", port, healthPath))
		// Without a broker we cannot query session status.
		add("auth: sessions", statusWarn, "skipped — hermes broker not reachable")
		return
	}

	st, err := fetchHermesStatus()
	if err != nil {
		add("auth: sessions", statusWarn, fmt.Sprintf("could not read session status: %v", err))
		return
	}
	var expiring, expired int
	var probs []string
	for _, s := range st.Services {
		switch expiryState(s.tokenExpiry()) {
		case "expiring":
			expiring++
			probs = append(probs, fmt.Sprintf("%s/%s expiring soon", s.Service, s.Scheme))
		case "expired":
			expired++
			probs = append(probs, fmt.Sprintf("%s/%s EXPIRED — `thesun acquire %s`", s.Service, s.Scheme, s.Service))
		}
	}
	switch {
	case expired > 0:
		add("auth: sessions", statusWarn, strings.Join(probs, "; "))
	case expiring > 0:
		add("auth: sessions", statusWarn, strings.Join(probs, "; "))
	default:
		add("auth: sessions", statusPass, fmt.Sprintf("%d service(s), none expiring", len(st.Services)))
	}
}

// checkManifestSync compares fleetd's published gateway config against the set
// of MCP servers fleetd is actually running, flagging drift.
func checkManifestSync(add func(name, status, detail string), live map[string]fleet.ServerStatus) {
	if live == nil {
		add("manifest sync", statusWarn, "skipped — fleetd not running")
		return
	}
	published, err := readPublishedServers()
	if err != nil {
		add("manifest sync", statusWarn, fmt.Sprintf("published config unreadable: %v", err))
		return
	}
	// Running MCP backends (system infra is intentionally never published).
	runningMCP := map[string]bool{}
	for _, s := range live {
		if s.Kind != manifest.KindSystem && s.State == fleet.StateRunning {
			runningMCP[s.Name] = true
		}
	}
	var missing, extra []string
	for name := range runningMCP {
		if !published[name] {
			missing = append(missing, name)
		}
	}
	for name := range published {
		if !runningMCP[name] {
			extra = append(extra, name)
		}
	}
	if len(missing) == 0 && len(extra) == 0 {
		add("manifest sync", statusPass, fmt.Sprintf("published config matches %d running backend(s)", len(runningMCP)))
		return
	}
	var notes []string
	if len(missing) > 0 {
		notes = append(notes, "running but not published: "+strings.Join(missing, ","))
	}
	if len(extra) > 0 {
		notes = append(notes, "published but not running: "+strings.Join(extra, ","))
	}
	add("manifest sync", statusWarn, "drift — "+strings.Join(notes, "; ")+" (try `thesun reload`)")
}

// checkServerHealth probes each supervised server's /health endpoint.
func checkServerHealth(add func(name, status, detail string), m *manifest.Manifest, live map[string]fleet.ServerStatus) {
	if live == nil {
		// Fall back to probing manifest-declared servers directly.
		if m == nil {
			add("servers: health", statusWarn, "skipped — fleetd down and no config")
			return
		}
		status := statusWarn
		var notes []string
		healthy := 0
		for _, srv := range m.Servers {
			if fleet.ProbeHealth(srv.Port, srv.Health) {
				healthy++
			} else {
				notes = append(notes, srv.Name)
			}
		}
		detail := fmt.Sprintf("fleetd down; %d/%d responding directly", healthy, len(m.Servers))
		if len(notes) > 0 {
			detail += " (not responding: " + strings.Join(notes, ",") + ")"
		}
		add("servers: health", status, detail)
		return
	}

	status := statusPass
	var down []string
	total := 0
	for _, s := range live {
		total++
		switch s.State {
		case fleet.StateRunning:
			if !fleet.ProbeHealth(s.Port, s.Health) {
				status = worse(status, statusFail)
				down = append(down, fmt.Sprintf("%s (running but /health not 200)", s.Name))
			}
		case fleet.StateDegraded:
			// Trust the live probe over supervisor state. A degraded server whose
			// port is still serving is a supervision problem (an unowned process
			// holds the port, or state is stale), not an outage, and reporting it
			// as a hard failure is what makes real outages indistinguishable from
			// noise for anything gating on doctor's exit code.
			if s.Serving {
				status = worse(status, statusWarn)
				down = append(down, fmt.Sprintf("%s (degraded but port %d is serving; fleetd does not own the process)", s.Name, s.Port))
				break
			}
			status = worse(status, statusFail)
			// Say whether waiting will help. A server that auto-recovery cannot
			// fix must not read the same as one that is merely mid-restart; the
			// gateway stayed down for 27 hours behind exactly that ambiguity.
			if s.PersistentlyDegraded() {
				label := "NEEDS OPERATOR"
				if s.Kind == manifest.KindSystem {
					label = "NEEDS OPERATOR (system component)"
				}
				detail := fmt.Sprintf("%s (degraded, %s: cause=%s, %d failed recovery attempts)", s.Name, label, causeOrUnknown(s.DegradeCause), s.RecoverAttempts)
				if s.Detail != "" {
					detail += " — " + s.Detail
				}
				down = append(down, detail)
				break
			}
			down = append(down, fmt.Sprintf("%s (degraded, auto-recovery retrying)", s.Name))
		default:
			if s.Serving {
				status = worse(status, statusWarn)
				down = append(down, fmt.Sprintf("%s (%s but port %d is serving)", s.Name, s.State, s.Port))
				break
			}
			status = worse(status, statusWarn)
			down = append(down, fmt.Sprintf("%s (%s)", s.Name, s.State))
		}
	}
	detail := fmt.Sprintf("all %d supervised server(s) healthy", total)
	if len(down) > 0 {
		detail = strings.Join(down, "; ")
	}
	add("servers: health", status, detail)
}

// causeOrUnknown renders a degrade cause, tolerating an older daemon that does
// not report one (the CLI and the daemon are versioned independently).
func causeOrUnknown(cause string) string {
	if cause == "" {
		return "unclassified"
	}
	return cause
}

// checkCamouflage verifies the browser-matching fingerprint config exists and
// its User-Agent OS token is consistent with the host OS. Generated MCP servers
// read <THESUN_HOME>/camouflage.json to blend outbound calls with the user's
// real browser traffic; a missing config means they fall back to a default
// Chrome fingerprint (a WARN, not a failure).
func checkCamouflage(add func(name, status, detail string)) {
	ok, detail := camouflage.Verify(paths.Home())
	if ok {
		add("camouflage fingerprint", statusPass, detail)
	} else {
		add("camouflage fingerprint", statusWarn, detail+" — run `thesun install` (or it regenerates on next install) to write camouflage.json")
	}
}

// checkServiceRegistration verifies the OS-level service registration that
// makes `thesun up` survive a reboot/login without operator intervention — the
// drift detector for the "fleet starts itself" guarantee. It only ever reads
// service-manager state (svc.Installed/Status, `loginctl show-user`); it never
// installs, starts, or stops anything.
//
// Platform notes:
//   - Linux (systemd --user): the unit only starts at login unless lingering
//     is enabled for the user (`loginctl enable-linger <user>`) — a headless/
//     SSH-only box with no interactive login session would otherwise never
//     start the fleet after a reboot even though the unit is correctly
//     installed and enabled.
//   - Windows: kardianos' UserService session handling can be flaky across
//     lock/unlock and RDP reconnects; a Task Scheduler "At log on" entry
//     running `thesun up` is the robust fallback, and the service should be
//     configured to restart on failure.
//   - macOS (launchd): a user-scope LaunchAgent starts at LOGIN, not boot —
//     expected and fine for this use case; informational only.
func checkServiceRegistration(add func(name, status, detail string)) {
	if !svc.Installed() {
		add("service: registered", statusWarn,
			"not registered with the OS service manager — the fleet will NOT auto-start after reboot/login; run `thesun service install`")
		return
	}
	if st, err := svc.Status(); err != nil {
		add("service: registered", statusWarn, fmt.Sprintf("registered but status unreadable: %v", err))
	} else {
		add("service: registered", statusPass, fmt.Sprintf("registered (%s)", st))
	}

	switch runtime.GOOS {
	case "linux":
		checkLinuxLinger(add)
	case "windows":
		add("service: windows persistence", statusWarn,
			"kardianos UserService sessions can be flaky across lock/unlock and RDP reconnects — for a robust reboot guarantee, also add a Task Scheduler \"At log on\" entry running `thesun up`, and confirm the service is configured to restart on failure")
	case "darwin":
		add("service: macOS persistence", statusPass,
			"LaunchAgent starts at LOGIN (not boot) — expected for a user-scope service; no action needed")
	}
}

// checkLinuxLinger verifies `loginctl enable-linger` is on for the current
// user. Without it, a systemd --user unit only runs while a login session is
// active — on a headless/SSH-only box with no console/GUI login, the fleet
// would never start after a reboot even though the unit is correctly
// installed and enabled. This is read-only (`loginctl show-user --property`);
// it never enables lingering itself.
func checkLinuxLinger(add func(name, status, detail string)) {
	u, err := user.Current()
	if err != nil {
		add("service: linux linger", statusWarn, fmt.Sprintf("could not resolve current user: %v", err))
		return
	}
	out, err := exec.Command("loginctl", "show-user", u.Username, "--property=Linger").Output()
	if err != nil {
		add("service: linux linger", statusWarn,
			fmt.Sprintf("could not query loginctl (%v) — if this host uses systemd --user, run: loginctl enable-linger %s", err, u.Username))
		return
	}
	if lingerEnabled(string(out)) {
		add("service: linux linger", statusPass,
			fmt.Sprintf("lingering enabled for %s — the user unit starts at boot even with no login session", u.Username))
		return
	}
	add("service: linux linger", statusWarn,
		fmt.Sprintf("lingering is OFF for %s — a headless/SSH box will NOT auto-start the fleet at boot; run: loginctl enable-linger %s", u.Username, u.Username))
}

// lingerEnabled parses `loginctl show-user --property=Linger` output
// ("Linger=yes" / "Linger=no", possibly with trailing whitespace/newline).
// Split out from checkLinuxLinger so the parse logic is unit-testable without
// depending on a real systemd host.
func lingerEnabled(loginctlOutput string) bool {
	return strings.TrimSpace(loginctlOutput) == "Linger=yes"
}

func renderDoctor(r *doctorReport) {
	icon := map[string]string{statusPass: "✓", statusWarn: "!", statusFail: "✗"}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, c := range r.Checks {
		fmt.Fprintf(tw, "  %s  %s\t%s\t%s\n", icon[c.Status], c.Status, c.Name, c.Detail)
	}
	tw.Flush()
	fmt.Printf("\noverall: %s\n", r.Overall)
}

// ---- small local helpers ----

// readPublishedServers reads the MCPU-schema published config and returns its
// backend name set. Missing file is a real error (nothing published yet).
func readPublishedServers() (map[string]bool, error) {
	b, err := os.ReadFile(fleet.PublishedConfigPath())
	if err != nil {
		return nil, err
	}
	var cfg struct {
		McpServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for name := range cfg.McpServers {
		out[name] = true
	}
	return out, nil
}

// probeWritable confirms a directory is writable by creating and removing a
// temp file — the only mutation doctor performs, and only inside THESUN_HOME.
func probeWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".thesun-doctor-*")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

func cmdOutput(prog string, args ...string) string {
	out, err := exec.Command(prog, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
