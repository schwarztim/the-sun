package main

// install.go implements `thesun install` — a structured, agent-followable
// setup flow: (build, if this is a dev checkout) → thesun init → thesun
// service install → thesun up → doctor --json → wire the gateway into every
// detected AI client. Every step reuses an existing command (initHome,
// svc.Control, stackUp, cli.RunDoctor, cli.WireClients) — this file adds
// orchestration and PASS/WARN/FAIL reporting on top, nothing new underneath.
//
// The goal: an agent (or a human) can run `thesun install`, read the
// structured step-by-step output, resolve any FAIL using the printed
// next-action, and land on a green `thesun status`.

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"mcp-fleet/fleetd/internal/camouflage"
	"mcp-fleet/fleetd/internal/cli"
	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/paths"
	"mcp-fleet/fleetd/internal/svc"
)

// installStep is one row of `thesun install`'s report — deliberately the same
// shape as doctor's checkResult (name/status/detail) plus a next-action that
// is only populated when the step needs operator/agent attention.
type installStep struct {
	Name       string
	Status     string // "PASS" | "WARN" | "FAIL"
	Detail     string
	NextAction string
}

// runInstallFlow drives the whole setup sequence and prints PASS/WARN/FAIL for
// every step as it completes (not buffered to the end) so an agent watching
// the output can start reacting before the flow finishes.
func runInstallFlow(args []string) int {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	skipBuild := fs.Bool("skip-build", false, "skip the dev-checkout build step (generator/gateway/hermes/fleet)")
	skipWire := fs.Bool("skip-wire", false, "skip wiring the gateway into detected AI clients")
	gatewayOverride := fs.String("gateway-url", "", "override the MCP URL wired into clients (default: this manifest's gateway URL + /mcp)")
	noOnboard := fs.Bool("no-onboard", false, "finish after the install steps instead of running the credential walkthrough")
	noAutoUpdate := fs.Bool("no-auto-update", false, "do not schedule automatic updates from the tracked branch")
	_ = fs.Parse(args)

	fmt.Println("thesun install — agent-guided setup")
	fmt.Println()

	overallFail := false
	emit := func(s installStep) {
		printInstallStep(s)
		if s.Status == "FAIL" {
			overallFail = true
		}
	}

	// ---- 1. build (dev checkout only) ----
	if *skipBuild {
		emit(installStep{Name: "build subsystems", Status: "PASS", Detail: "skipped (--skip-build)"})
	} else {
		emit(buildStep())
	}

	// ---- 2. init ----
	emit(initStep())

	// ---- 3. camouflage (browser-matching fingerprint for generated servers) ----
	emit(camouflageStep())

	// ---- 4. Agent Skills distribution (BEFORE the gateway/up, per the setup
	// requirement: the MCP-generation skill must be present in each detected
	// client before the stack comes up). --skip-wire also skips this, since it
	// writes into the same AI-client config trees. ----
	if *skipWire {
		emit(installStep{Name: "client skills", Status: "PASS", Detail: "skipped (--skip-wire also skips client-skill install)"})
	} else {
		emit(skillsStep())
	}

	// ---- 5. service install ----
	emit(serviceInstallStep())

	// ---- 6. up ----
	emit(upStep())

	// ---- 7. doctor --json ----
	for _, s := range doctorSteps() {
		emit(s)
	}

	// ---- 8. wire AI clients ----
	if *skipWire {
		emit(installStep{Name: "wire AI clients", Status: "PASS", Detail: "skipped (--skip-wire)"})
	} else {
		emit(wireStep(*gatewayOverride))
	}

	// ---- 9. client-side policy hooks (defense in depth; the gateway stays the floor) ----
	// --skip-wire opts out of touching AI-client config files, and the hook
	// install writes to those same files, so honor it here too.
	if *skipWire {
		emit(installStep{Name: "client policy hooks", Status: "PASS", Detail: "skipped (--skip-wire also skips client-hook install)"})
	} else {
		emit(hooksStep())
	}

	// ---- 9b. automatic updates ----
	emit(autoUpdateStep(*noAutoUpdate))

	fmt.Println()
	if overallFail {
		fmt.Println("install: one or more steps FAILed — resolve the next-action(s) above, then re-run `thesun install`.")
		return 1
	}
	fmt.Println("install: complete. `thesun status` checks the stack any time.")

	// ---- 10. onboarding ----
	//
	// A finished install is not a usable install. Every bundled server ships
	// DISABLED because a server without a credential fails its health check, so
	// at this point the stack is green and nothing useful is reachable. That gap
	// was the whole reason onboarding exists, and a walkthrough nobody is told
	// about closes it for nobody, so run it here rather than hoping the reader
	// finds it in `thesun help`.
	//
	// Only when a human is actually at the terminal: onboarding asks questions
	// and hands the terminal to Hermes for sign-in, neither of which a scripted
	// or CI install can answer. Those get the pointer instead.
	//
	// STDIN is the stream that decides it, and stdout alone is not enough. An
	// installer piping input, or a wrapper running this with `< /dev/null`, can
	// still have a terminal on stdout; onboarding would launch, every Scan()
	// would return EOF, askYesNo would answer "no" to everything, and the run
	// would exit 0 having declined every dependency and every backend. That
	// reads in the transcript exactly like a human who said no, and it burns
	// the one guided-setup moment this exists for.
	if *noOnboard || !stdinIsTTY() || !stdoutIsTTY() {
		fmt.Println()
		fmt.Println("Next: `thesun onboard` signs you in and turns on the servers you want.")
		fmt.Println("Until then the stack is running but no backend has a credential, so")
		fmt.Println("none of them are reachable. `thesun onboard --check` reports the state.")
		return 0
	}
	fmt.Println()
	fmt.Println("The stack is up, but no backend has a credential yet, so none are")
	fmt.Println("reachable. Onboarding signs you in and turns on the ones you want.")
	fmt.Println("(Skip it with Ctrl-C; `thesun onboard` picks up where you left off.)")
	fmt.Println()
	return cli.OnboardCmd(nil)
}

// camouflageStep detects the host's OS/browser and writes the browser-matching
// fingerprint (curl_cffi impersonate + uTLS ClientHello + User-Agent) to
// <THESUN_HOME>/camouflage.json, which every generated MCP server reads so its
// outbound API calls blend with the user's real browser traffic. OS-match is
// the guaranteed minimum; browser+version is applied when detectable.
func camouflageStep() installStep {
	profile, err := camouflage.Detect()
	if err != nil {
		return installStep{Name: "camouflage fingerprint", Status: "WARN",
			Detail:     "detection failed: " + err.Error(),
			NextAction: "generated servers will fall back to a default Chrome fingerprint"}
	}
	if err := camouflage.WriteConfig(paths.Home(), profile); err != nil {
		return installStep{Name: "camouflage fingerprint", Status: "WARN",
			Detail:     "could not write camouflage.json: " + err.Error(),
			NextAction: "generated servers will fall back to a default Chrome fingerprint"}
	}
	return installStep{Name: "camouflage fingerprint", Status: "PASS",
		Detail: fmt.Sprintf("%s / %s %s → %s", profile.OS, profile.Browser, profile.BrowserVersion, profile.Impersonate)}
}

func printInstallStep(s installStep) {
	icon := "?"
	switch s.Status {
	case "PASS":
		icon = "✓"
	case "WARN":
		icon = "!"
	case "FAIL":
		icon = "✗"
	}
	if s.Detail != "" {
		fmt.Printf("  %s %s  %-24s %s\n", icon, s.Status, s.Name, s.Detail)
	} else {
		fmt.Printf("  %s %s  %s\n", icon, s.Status, s.Name)
	}
	if s.NextAction != "" {
		fmt.Printf("      → next: %s\n", s.NextAction)
	}
}

// ---- step 1: build (dev checkout only) ----

// subsystemsBuilt reports whether every subsystem entry point this bundle
// needs already exists, and which are missing.
func subsystemsBuilt() (bool, []string) {
	bundle := bundleRoot()
	checks := []struct{ name, path string }{
		{"generator", filepath.Join(bundle, "generator", "dist", "cli", "index.js")},
		{"gateway", filepath.Join(bundle, "gateway", "dist", "index.js")},
		{"hermes", filepath.Join(bundle, "hermes", "packages", "broker", "dist", "cli.js")},
		{"fleet CLI (bin/thesun)", filepath.Join(bundle, "bin", "thesun")},
	}
	var missing []string
	for _, c := range checks {
		if !exists(c.path) {
			missing = append(missing, c.name)
		}
	}
	return len(missing) == 0, missing
}

// buildStep runs the bundle's install.sh only when this looks like a dev
// checkout (install.sh present) AND something is actually missing — it never
// forces a rebuild of an already-built bundle.
func buildStep() installStep {
	if built, _ := subsystemsBuilt(); built {
		return installStep{Name: "build subsystems", Status: "PASS", Detail: "generator/gateway/hermes/fleet already built"}
	}
	_, missing := subsystemsBuilt()
	script := filepath.Join(bundleRoot(), "install.sh")
	if !exists(script) {
		return installStep{
			Name: "build subsystems", Status: "WARN",
			Detail:     fmt.Sprintf("missing: %s (no install.sh here — not a dev checkout)", strings.Join(missing, ", ")),
			NextAction: "install a pre-built thesun bundle, or build these subsystems manually",
		}
	}
	fmt.Println("  ▶ dev checkout detected — building missing subsystems (this can take a minute)…")
	rc := runInstall(nil)
	stillBuilt, stillMissing := subsystemsBuilt()
	if rc != 0 || !stillBuilt {
		return installStep{
			Name: "build subsystems", Status: "FAIL",
			Detail:     fmt.Sprintf("install.sh exit=%d, still missing: %s", rc, strings.Join(stillMissing, ", ")),
			NextAction: "run `bash install.sh` directly and read its per-subsystem output for the failing one",
		}
	}
	return installStep{Name: "build subsystems", Status: "PASS", Detail: "built via install.sh"}
}

// ---- step 2: init ----

func initStep() installStep {
	cfg := fleet.ManifestPath()
	alreadyExisted := exists(cfg)
	if rc := initHome(nil); rc != 0 {
		return installStep{
			Name: "thesun init", Status: "FAIL", Detail: fmt.Sprintf("exit=%d", rc),
			NextAction: fmt.Sprintf("check %s is writable, then re-run `thesun init`", paths.Home()),
		}
	}
	if alreadyExisted {
		return installStep{Name: "thesun init", Status: "PASS", Detail: fmt.Sprintf("already initialized (%s)", cfg)}
	}
	return installStep{Name: "thesun init", Status: "PASS", Detail: fmt.Sprintf("scaffolded %s", cfg)}
}

// ---- step 3: service install ----

func serviceInstallStep() installStep {
	if svc.Installed() {
		return installStep{Name: "thesun service install", Status: "PASS", Detail: "already registered with the OS service manager"}
	}
	if err := svc.Control("install"); err != nil {
		return installStep{
			Name: "thesun service install", Status: "WARN",
			Detail:     fmt.Sprintf("service NOT registered (%v) — the reboot/login auto-start guarantee is lost: the fleet will NOT come back on its own after a reboot", err),
			NextAction: "run `thesun up` manually each time, or re-run `thesun service install` after fixing the reported error to restore auto-start",
		}
	}
	return installStep{Name: "thesun service install", Status: "PASS", Detail: "registered (user scope, no sudo)"}
}

// ---- step 4: up ----

func upStep() installStep {
	if rc := stackUp(nil); rc != 0 {
		return installStep{
			Name: "thesun up", Status: "FAIL", Detail: fmt.Sprintf("exit=%d", rc),
			NextAction: "run `thesun logs <server>` for the component that failed to come up",
		}
	}
	return installStep{Name: "thesun up", Status: "PASS", Detail: "stack up (hermes + gateway + servers)"}
}

// ---- step 5: doctor ----

// doctorSteps runs the exact same readiness checks `thesun doctor --json`
// prints, in-process, and maps each check straight onto an installStep row so
// every FAIL surfaces with the same one-line next-action doctor already
// carries in its Detail field.
func doctorSteps() []installStep {
	report := cli.RunDoctor()
	steps := make([]installStep, 0, len(report.Checks))
	for _, c := range report.Checks {
		s := installStep{Name: "doctor: " + c.Name, Status: c.Status, Detail: c.Detail}
		if c.Status == "FAIL" {
			s.NextAction = c.Detail
		}
		steps = append(steps, s)
	}
	return steps
}

// ---- step 4: Agent Skills distribution ----

// skillsStep copies the packaged MCP-generation skill into every detected AI
// client by calling the same in-process path as `thesun skills install`
// (cli.Skills). It runs BEFORE the gateway/up steps so the skill is present in
// each client before the stack comes up. A failure here is a WARN, never a FAIL:
// a missing client is not a failure, and the stack is fully functional without
// the skill distributed (the skill is a convenience, not a security control).
func skillsStep() installStep {
	fmt.Println("  ▶ distributing the MCP-generation skill into detected AI clients…")
	if rc := cli.Skills([]string{"install"}); rc != 0 {
		return installStep{
			Name: "client skills", Status: "WARN",
			Detail:     "one or more clients could not receive the skill (see the per-client lines above)",
			NextAction: "re-run `thesun skills install` after resolving the reported client error",
		}
	}
	return installStep{Name: "client skills", Status: "PASS", Detail: "thesun skill distributed into detected AI clients"}
}

// ---- step 8: wire AI clients ----

// ---- step 9: client-side policy hooks ----

// hooksStep wires the shared client-side policy hook into every detected AI
// client by calling the same in-process path as `thesun hooks install`
// (cli.Hooks) — the README security story reachable straight from the guided
// install. Its per-client lines print above the step row. A failure here is a
// WARN, never a FAIL: the gateway is the un-bypassable security floor, so the
// stack is fully functional and policy-enforced even if a client hook can't be
// wired; the hooks are an additive, near-universal first line of defense.
func hooksStep() installStep {
	fmt.Println("  ▶ installing client-side policy hooks (defense in depth; the gateway remains the floor)…")
	if rc := cli.Hooks([]string{"install"}); rc != 0 {
		return installStep{
			Name: "client policy hooks", Status: "WARN",
			Detail:     "one or more clients could not be wired (see the per-client lines above)",
			NextAction: "re-run `thesun hooks install` after resolving the reported client error (the gateway enforces policy regardless)",
		}
	}
	return installStep{Name: "client policy hooks", Status: "PASS", Detail: "shared policy hook wired into detected AI clients"}
}

func wireStep(overrideURL string) installStep {
	home, err := os.UserHomeDir()
	if err != nil {
		return installStep{
			Name: "wire AI clients", Status: "WARN", Detail: fmt.Sprintf("cannot resolve home dir: %v", err),
			NextAction: "wire clients manually — add an mcp-gateway http entry pointing at the gateway URL",
		}
	}
	cwd, _ := os.Getwd()
	url := overrideURL
	if url == "" {
		url = gatewayURL() + "/mcp"
	}

	results := cli.WireClients(home, cwd, url)
	lines := make([]string, 0, len(results))
	anyErr := false
	for _, r := range results {
		lines = append(lines, fmt.Sprintf("%s: %s", r.Client, r.Status))
		if r.Status == "error" {
			anyErr = true
		}
	}
	detail := strings.Join(lines, "; ")
	if anyErr {
		return installStep{
			Name: "wire AI clients", Status: "WARN", Detail: detail,
			NextAction: "re-run `thesun install` after fixing the reported client config error",
		}
	}
	return installStep{Name: "wire AI clients", Status: "PASS", Detail: detail}
}

// autoUpdateStep turns on scheduled branch tracking, which is ON by default.
//
// Default-on is the right call for the fleet this ships to: the gateway is the
// policy enforcement point for every AI client on the machine, so a fix to it
// only protects people once it is actually running. Left opt-in, the machines
// that most need a security fix are exactly the ones nobody remembers to update.
//
// It is skipped, not failed, when it cannot apply. A packaged (non-checkout)
// install has no branch to track, and a checkout with no upstream or with local
// commits is somebody's working copy, not a deployment: scheduling a job that
// can only ever refuse would produce a log line every six hours forever and
// teach the operator to ignore it.
func autoUpdateStep(disabled bool) installStep {
	const name = "automatic updates"
	if disabled {
		return installStep{Name: name, Status: "PASS", Detail: "skipped (--no-auto-update)"}
	}
	root := bundleRoot()
	if !isGitCheckout(root) {
		return installStep{Name: name, Status: "PASS",
			Detail: "not applicable: this install is not a git checkout, so use `thesun upgrade` for releases"}
	}
	up, err := upstreamRef(root)
	if err != nil {
		return installStep{Name: name, Status: "WARN",
			Detail:     "no upstream branch configured, so there is nothing to track",
			NextAction: "set one (`git branch --set-upstream-to=<remote>/<branch>`) then run `thesun upgrade --track --auto=on`"}
	}
	if ahead, _, err := aheadBehind(root, up); err == nil && ahead > 0 {
		return installStep{Name: name, Status: "PASS",
			Detail: fmt.Sprintf("skipped: this checkout is %d commit(s) ahead of %s, so it is a working copy rather than a deployment", ahead, up)}
	}

	if code := installAutoUpdate(defaultAutoUpdateInterval); code != 0 {
		return installStep{Name: name, Status: "WARN",
			Detail:     "could not register the scheduled job",
			NextAction: "run `thesun upgrade --track --auto=on` and read the error"}
	}
	return installStep{Name: name, Status: "PASS",
		Detail: fmt.Sprintf("tracking %s every %s (off: `thesun upgrade --track --auto=off`)", up, defaultAutoUpdateInterval)}
}
