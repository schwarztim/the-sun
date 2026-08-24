// onboard.go is the `thesun onboard` walkthrough: the step that takes a machine
// from "the stack builds and runs" to "the tools this person actually needs are
// authenticated and answering".
//
// It exists because the gap between those two states was undocumented tribal
// knowledge. A bundled backend ships DISABLED on purpose, because a backend that
// starts without a credential fails its health check and makes a working fleet
// look broken. So the honest first-run experience was: everything reports
// healthy, and nothing useful is reachable, with no prompt explaining why.
//
// Two design points worth stating, because both were tempting to get wrong:
//
//   - One sign-in, many services. These tools sit behind the same corporate
//     SSO, so onboarding calls Hermes once per service it enrols and Hermes
//     reuses the live SSO session, rather than sending the person round a fresh
//     sign-in for each one. The loop below is per backend; the interactive
//     prompt is not.
//   - Secrets never touch this process. `thesun acquire` hands the terminal to
//     Hermes, which owns the vault. Nothing here reads, prints, logs, or stores
//     a credential value; it only ever asks Hermes whether one exists.
package cli

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"mcp-fleet/fleetd/internal/paths"
)

// onboardBackend is one bundled server the walkthrough can turn on.
//
// Description is written for someone who does not already know what the backend
// is; "incidents, changes, CMDB" tells them whether they want it, where
// "servicenow-go" does not.
type onboardBackend struct {
	Name        string
	Service     string // Hermes service name, when it differs from Name
	Description string
	Auth        string // how the credential is obtained, in one phrase
	Requires    []string
}

// hermesService is the name to authenticate against.
func (b onboardBackend) hermesService() string {
	if b.Service != "" {
		return b.Service
	}
	return b.Name
}

// bundledBackends is the catalogue the walkthrough offers. It is deliberately
// the SHIPPED set, not whatever the operator's own config happens to carry: a
// coworker's onboarding should not depend on the packager's machine.
var bundledBackends = []onboardBackend{
	{
		Name:        "servicenow-go",
		Service:     "servicenow",
		Description: "incidents, changes, and the CMDB",
		Auth:        "corporate SSO",
	},
	{
		Name:        "atlassian-go",
		Service:     "atlassian",
		Description: "Confluence and Jira, as one server",
		Auth:        "corporate SSO",
	},
	{
		Name:        "stash-go",
		Service:     "stash",
		Description: "Stash/Bitbucket repositories and pull requests",
		Auth:        "corporate SSO",
	},
	{
		Name:        "github-go",
		Service:     "github",
		Description: "GitHub repositories, pull requests, issues, and Actions",
		Auth:        "GitHub sign-in",
	},
	{
		Name:        "ms365",
		Description: "Outlook mail and calendar, Excel, OneNote, OneDrive",
		Auth:        "device-code sign-in (no Azure app registration needed)",
	},
	{
		Name:        "az-teams",
		Description: "Microsoft Teams in depth, plus Planner and SharePoint",
		Auth:        "your own Azure app registration",
	},
}

// toolDependency is an external program a backend needs at RUNTIME.
//
// Deliberately short. The bundled servers are static Go binaries, so most need
// nothing beyond what install.sh already bootstrapped; listing speculative
// dependencies would mean installing software nobody uses. Anything added here
// must be something a backend genuinely fails without.
type toolDependency struct {
	Name   string
	Probe  string // executable to look for on PATH
	Why    string
	Brew   string
	Winget string
	// Install is a non-package-manager install command, when that is the real
	// route. It is run through the shell, so it may be a pipeline.
	Install string
	// Present overrides the PATH probe for a dependency that is not an
	// executable. Node modules and browser binaries are both invisible to
	// exec.LookPath, and Hermes' SSO needs one of each.
	Present func() bool
	// ForBackend names the server that wants it, when the dependency is not
	// needed by the stack itself. Empty means everything needs it.
	ForBackend string
}

// runtimeDependencies are checked for every install, because they are what the
// stack itself runs on.
var runtimeDependencies = []toolDependency{
	{Name: "node", Probe: "node", Why: "the gateway, generator, and Hermes are TypeScript", Brew: "node", Winget: "OpenJS.NodeJS.LTS"},
	{Name: "git", Probe: "git", Why: "fetching servers from the registry", Brew: "git", Winget: "Git.Git"},
}

// optionalDependencies are needed only by particular servers, so each names the
// server that wants it and nothing is installed "just in case".
//
// patchright is the one that actually bites. It is a Playwright fork and it is a
// PEER dependency of @hermes/auth-core, so no package manager guarantees it, and
// managed-browser.ts loads it with a bare `await import("patchright")` inside the
// SSO flow. A machine without it fails browser sign-in with ERR_MODULE_NOT_FOUND
// from inside a broker call, which reads as "auth is broken", not "install a
// browser". Its chromium build is a SEPARATE download from the module, so both
// are checked: having the package and not the browser fails just as hard.
var optionalDependencies = []toolDependency{
	{
		Name:       "patchright",
		Why:        "browser-based corporate SSO sign-in (Hermes drives a real browser)",
		ForBackend: "any backend that signs in through corporate SSO",
		Present:    patchrightReady,
		Install:    patchrightInstallCmd(),
	},
}

// authCoreDir is where patchright must resolve from: Hermes loads it from
// @hermes/auth-core, and a copy hoisted somewhere else on the machine is not the
// one that import will find.
func authCoreDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	root := paths.BundleRoot(exe)
	if root == "" || root == string(filepath.Separator) {
		// The binary is not sitting in a bundle layout (<bundle>/bin/thesun),
		// so joining would produce a confident-looking path rooted at "/". A
		// wrong absolute path in an install command is worse than no path.
		return ""
	}
	dir := filepath.Join(root, "hermes", "packages", "auth-core")
	if _, err := os.Stat(dir); err != nil {
		return ""
	}
	return dir
}

// patchrightReady reports whether BOTH halves are present: the node module, and
// the chromium build it launches. Checking only the module is how a green
// dependency report is followed by a failed sign-in.
func patchrightReady() bool {
	dir := authCoreDir()
	if dir == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "patchright")); err != nil {
		return false
	}
	return browserCacheHasChromium()
}

// browserCacheHasChromium looks for a chromium build in the shared Playwright
// browser cache that patchright also uses. PLAYWRIGHT_BROWSERS_PATH wins when
// the operator has redirected it.
func browserCacheHasChromium() bool {
	root := os.Getenv("PLAYWRIGHT_BROWSERS_PATH")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		switch runtime.GOOS {
		case "darwin":
			root = filepath.Join(home, "Library", "Caches", "ms-playwright")
		case "windows":
			root = filepath.Join(home, "AppData", "Local", "ms-playwright")
		default:
			root = filepath.Join(home, ".cache", "ms-playwright")
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	for _, e := range entries {
		// "chromium-<rev>" is the full browser; "chromium_headless_shell-<rev>"
		// is a headless-only shell and cannot run a visible sign-in window.
		if strings.HasPrefix(e.Name(), "chromium-") {
			return true
		}
	}
	return false
}

// patchrightInstallCmd installs the module into auth-core and then downloads its
// chromium build. Both steps, in that order, because the CLI that downloads the
// browser ships inside the module.
func patchrightInstallCmd() string {
	dir := authCoreDir()
	if dir == "" {
		// Keep the command runnable and self-describing rather than printing a
		// path we could not verify: an unset variable fails loudly and says so,
		// where a wrong absolute path installs into the wrong place silently.
		dir = "$THESUN_BUNDLE/hermes/packages/auth-core"
		return "THESUN_BUNDLE=<your thesun install> ; cd \"" + dir +
			"\" && npm install patchright@^1.61.1 && npx patchright install chromium"
	}
	return fmt.Sprintf("cd %q && npm install patchright@^1.61.1 && npx patchright install chromium", dir)
}

// dependencyStatus is the result of probing one dependency.
type dependencyStatus struct {
	toolDependency
	Present bool
	Version string
}

// probeDependency looks for the executable and, when present, its version. A
// missing version is not a failure: the point is presence, and not every tool
// answers --version the same way.
func probeDependency(d toolDependency) dependencyStatus {
	st := dependencyStatus{toolDependency: d}
	if d.Present != nil {
		st.Present = d.Present()
		return st
	}
	path, err := exec.LookPath(d.Probe)
	if err != nil {
		return st
	}
	st.Present = true
	out, err := exec.Command(path, "--version").Output()
	if err == nil {
		st.Version = strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	}
	return st
}

// installHint renders the exact command for this platform. Printing the command
// rather than running it unattended is deliberate for anything that reaches the
// network as an installer; `install.sh` already bootstraps the required
// toolchains, so reaching this text at all means something unusual happened.
func installHint(d toolDependency) string {
	if d.Install != "" {
		return d.Install
	}
	switch runtime.GOOS {
	case "darwin":
		if d.Brew != "" {
			return "brew install " + d.Brew
		}
	case "windows":
		if d.Winget != "" {
			return "winget install --id " + d.Winget + " -e --accept-package-agreements --accept-source-agreements"
		}
	default:
		if d.Brew != "" {
			return "your package manager: " + d.Brew
		}
	}
	return "see " + d.Name + "'s own installation instructions"
}

// installDependency runs the platform install command for one dependency,
// streaming its output so a long download does not look like a hang.
//
// The command is run through the shell because several of these are pipelines
// (install the module, THEN download its browser), and it inherits stdio so a
// package manager that needs to ask something can. It returns the shell's own
// failure, since that is more useful than anything this could paraphrase.
func installDependency(d toolDependency) error {
	cmdline := installHint(d)
	if cmdline == "" || strings.HasPrefix(cmdline, "see ") {
		return fmt.Errorf("no automatic install is available for %s on %s", d.Name, runtime.GOOS)
	}

	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/C", cmdline)
	} else {
		c = exec.Command("sh", "-c", cmdline)
	}
	c.Stdout, c.Stderr, c.Stdin = os.Stdout, os.Stderr, os.Stdin
	return c.Run()
}

// resolveDependencies reports what is missing and, when a human is present,
// offers to install each one.
//
// Printing a command and exiting was the previous behaviour, and it is the wrong
// default for the one moment the tool exists to help with: someone who has just
// run install and does not yet know what any of these are. Non-interactive runs
// still only print, because there is nobody to approve reaching the network.
//
// It re-probes after each install rather than trusting the exit code: a package
// manager can succeed while putting the result somewhere this will not find it,
// and a dependency reported as resolved that is not resolved just moves the
// failure somewhere less obvious.
func resolveDependencies(in *bufio.Scanner, interactive bool) int {
	still := 0
	for _, d := range checkDependencies() {
		if d.Present {
			detail := d.Version
			if detail == "" {
				detail = "found"
			}
			fmt.Printf("   ok       %-12s %s\n", d.Name, detail)
			continue
		}

		fmt.Printf("   MISSING  %-12s %s\n", d.Name, d.Why)
		if d.ForBackend != "" {
			fmt.Printf("            needed by: %s\n", d.ForBackend)
		}
		cmdline := installHint(d.toolDependency)
		fmt.Printf("            install: %s\n", cmdline)

		if !interactive {
			still++
			continue
		}
		if !askYesNo(in, "            install it now?") {
			still++
			fmt.Println("            left alone.")
			continue
		}
		if err := installDependency(d.toolDependency); err != nil {
			still++
			fmt.Printf("            install failed: %v\n", err)
			fmt.Println("            run the command above by hand, then re-run `thesun onboard`.")
			continue
		}
		if !probeDependency(d.toolDependency).Present {
			still++
			fmt.Printf("            the installer succeeded but %s is still not detectable.\n", d.Name)
			fmt.Println("            open a NEW terminal so PATH changes take effect, then re-run.")
			continue
		}
		fmt.Printf("            %s installed.\n", d.Name)
	}
	return still
}

// checkDependencies probes everything and reports what is missing.
func checkDependencies() []dependencyStatus {
	out := make([]dependencyStatus, 0, len(runtimeDependencies)+len(optionalDependencies))
	for _, d := range runtimeDependencies {
		out = append(out, probeDependency(d))
	}
	for _, d := range optionalDependencies {
		out = append(out, probeDependency(d))
	}
	return out
}

// OnboardCmd implements `thesun onboard`.
func OnboardCmd(args []string) int {
	fs := flag.NewFlagSet("onboard", flag.ExitOnError)
	checkOnly := fs.Bool("check", false, "report dependency and backend state, then exit without changing anything")
	nonInteractive := fs.Bool("non-interactive", false, "never prompt; report what an interactive run would offer")
	_ = fs.Parse(args)

	fmt.Println("thesun onboarding")
	fmt.Println()

	in := bufio.NewScanner(os.Stdin)
	interactive := !*checkOnly && !*nonInteractive

	// ---- 1. dependencies ----
	fmt.Println("Dependencies")
	missing := resolveDependencies(in, interactive)
	if missing > 0 {
		fmt.Println()
		fmt.Printf("%d dependency/dependencies still missing.\n", missing)
		if !interactive {
			fmt.Println("Install them, open a NEW terminal so PATH changes take effect, then")
			fmt.Println("re-run `thesun onboard`.")
			return 1
		}
		// Interactively, a missing OPTIONAL dependency is not fatal: it only
		// costs the backends that need it, and refusing to continue would block
		// someone from enrolling the ones that work fine without it.
		fmt.Println("Continuing; the servers that need them will fail to sign in until they")
		fmt.Println("are installed.")
	}
	fmt.Println()

	// ---- 2. the credential ceremony ----
	fmt.Println("Credentials")
	fmt.Println("   These tools sit behind the same corporate sign-in, so you authenticate")
	fmt.Println("   once and each server is enrolled from that session. Credentials are held")
	fmt.Println("   by Hermes in an encrypted vault; they are never written into a config")
	fmt.Println("   file, and no command here ever prints one.")
	fmt.Println()

	if *checkOnly || *nonInteractive {
		fmt.Println("Servers available to enable")
		for _, b := range bundledBackends {
			fmt.Printf("   %-14s %s\n", b.Name, b.Description)
			fmt.Printf("   %-14s auth: %s\n", "", b.Auth)
		}
		fmt.Println()
		fmt.Println("Re-run `thesun onboard` without a flag to enable them interactively.")
		return 0
	}

	enabled, skipped, failed := 0, 0, 0

	for _, b := range bundledBackends {
		fmt.Printf("%s: %s\n", b.Name, b.Description)
		fmt.Printf("   sign-in: %s\n", b.Auth)
		if !askYesNo(in, "   enable it?") {
			skipped++
			fmt.Println("   skipped. `thesun onboard` again whenever you want it.")
			fmt.Println()
			continue
		}

		fmt.Printf("   authenticating %s through Hermes...\n", b.hermesService())
		if code := runAcquire([]string{b.hermesService()}); code != 0 {
			failed++
			fmt.Printf("   could not authenticate %s; leaving it disabled.\n", b.Name)
			fmt.Println("   Nothing was half-configured: a server is only enabled after its")
			fmt.Println("   credential is in the vault, so a failure here changes nothing.")
			fmt.Println()
			continue
		}
		cfg := gatewayConfigPath()
		changed, err := setBackendEnabled(cfg, b.Name, true)
		switch {
		case err != nil:
			failed++
			fmt.Printf("   authenticated, but could not enable it: %v\n", err)
			fmt.Printf("   Set `enabled: true` for %s in %s by hand, then run\n", b.Name, cfg)
			fmt.Println("   `thesun gateway reload`.")
		case changed:
			enabled++
			fmt.Printf("   %s authenticated and enabled.\n", b.Name)
		default:
			enabled++
			fmt.Printf("   %s authenticated; it was already enabled.\n", b.Name)
		}
		fmt.Println()
	}

	fmt.Printf("%d enabled, %d skipped, %d failed.\n", enabled, skipped, failed)
	if enabled > 0 {
		// The gateway, not fleetd. Enabling a backend edited config.fleet.yaml,
		// and only the gateway re-reads that file; fleetd's reload re-reads the
		// suite manifest and would leave the new backend unrouted while this
		// command cheerfully reported it enabled.
		fmt.Println("Reloading the gateway so the newly enabled servers are routed...")
		if err := reloadGatewayConfig(); err != nil {
			fmt.Printf("   reload did not succeed: %v\n", err)
			fmt.Println("   The config is correct; the running gateway just has not re-read it.")
			fmt.Println("   Run `thesun gateway reload` (or `thesun up`) to finish.")
		}
	}
	fmt.Println()
	fmt.Println("Next:")
	fmt.Println("   thesun status          per-server health")
	fmt.Println("   thesun doctor          full readiness check, including client wiring")
	fmt.Println("   thesun wire --report   every MCP server your AI clients are registered against")
	if failed > 0 {
		return 1
	}
	return 0
}

// askYesNo prompts until it gets something it understands. Defaulting a blank
// answer to "no" is the safe direction: onboarding should never turn a backend
// on because someone pressed enter to get through the prompts.
func askYesNo(in *bufio.Scanner, prompt string) bool {
	for {
		fmt.Printf("%s [y/N] ", prompt)
		if !in.Scan() {
			return false
		}
		switch strings.ToLower(strings.TrimSpace(in.Text())) {
		case "y", "yes":
			return true
		case "", "n", "no":
			return false
		default:
			fmt.Println("   please answer y or n.")
		}
	}
}
