package main

// registry.go wires the thesun MCP Store into the CLI: the pull side
// (search / add / remove / update) and the author side (keygen / publish).
//
// The trust model is fail-closed. A curated install requires, all of:
//   1. the entry is not revoked,
//   2. the version's lab_report.passed == true,
//   3. the downloaded binary's sha256 matches the index, and
//   4. the version's Ed25519 signature verifies against a trusted public key.
// Any single failure REFUSES the install and writes nothing to the manifest.
// A community install is allowed only with an explicit --community flag (it is
// self-attested, not conformance-proven); it still enforces sha256, and when a
// signature is present it must verify.
//
// The pull verb is `thesun add <name>` when the leading argument resolves to a
// registry entry and no manual `--bin`/`--cmd` flag is present; otherwise `add`
// falls through to the existing manual `cli.Fleet("add", ...)` behavior. See
// interceptAddIsRegistryPull and the dispatch note in main.go.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/hermes"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/paths"
	"mcp-fleet/fleetd/internal/registry"
)

// defaultRegistryIndex is the compiled-in index reference. The resolution logic
// lives in internal/registry so the doctor check reuses it; this alias keeps the
// name available to package main.
const defaultRegistryIndex = registry.DefaultIndex

// curatedPubKeyB64 is the compiled-in trusted public key for the curated tier.
// This is the thesun-servers release-signing key (Ed25519, base64). A curated
// `thesun add` verifies the release signature against this key and fails closed
// if it does not match. Operator-provided trusted keys (trustedKeys below) are
// additive, used for local publishing and community keys. The matching private
// key lives only in THESUN_HOME/keys/author.key on the release machine and in CI
// secrets; it is never committed.
const curatedPubKeyB64 = "Ng2oTDDvkx5b9gY46OUVq8htyA23tdsw8Ut6IZu7P40="

// The store-client resolution (index ref, Stash host/cred, bearer) lives in
// internal/registry so the doctor check reuses the exact same logic. These thin
// wrappers keep the package-main names the CLI call sites already use.

// registryIndexRef resolves the index reference: --index flag > env >
// store.toml > compiled default.
func registryIndexRef(flagVal string) string { return registry.IndexRef(flagVal) }

// stashHost is the internal Bitbucket host that requires a bearer PAT (env >
// store.toml; empty disables authenticated pull).
func stashHost() string { return registry.StashHost() }

// stashCredRef is the Hermes reference that resolves to the Stash PAT.
func stashCredRef() string { return registry.StashCredRef() }

// stashAuthApplies reports whether rawURL may carry the Stash PAT (https + exact
// host match). This is a security boundary; see registry.StashAuthApplies.
func stashAuthApplies(rawURL, host string) bool { return registry.StashAuthApplies(rawURL, host) }

// bearerForURL returns a bearer token for rawURL when it targets the internal
// Stash host, resolved from Hermes; "" for any other host. A resolution failure
// is surfaced as a warning and returns "" (never the token value), so an
// unauthenticated attempt yields a clear HTTP 401 instead of a silent hang.
func bearerForURL(ctx context.Context, rawURL string) string {
	tok, err := registry.BearerForURL(ctx, rawURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not resolve Stash credential (%v); trying unauthenticated\n", err)
		return ""
	}
	return tok
}

// httpGetToFile streams url to dest, sending a bearer token when non-empty. Used
// for authenticated binary downloads from the internal Stash Downloads area. It
// shares upgradeHTTPClient (upgrade.go) so timeouts and transport are consistent.
func httpGetToFile(url, dest, bearer string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := upgradeHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

// trustedKeysPath is the operator-managed file of additional trusted public
// keys (one base64 key per line), under THESUN_HOME.
func trustedKeysPath() string { return filepath.Join(paths.Home(), "trusted_keys") }

// trustedKeys returns every trusted Ed25519 public key: the compiled-in curated
// key (when non-empty) plus each valid line of THESUN_HOME/trusted_keys.
func trustedKeys() [][]byte {
	var keys [][]byte
	if strings.TrimSpace(curatedPubKeyB64) != "" {
		if k, err := registry.DecodeKey(curatedPubKeyB64); err == nil {
			keys = append(keys, k)
		}
	}
	raw, err := os.ReadFile(trustedKeysPath())
	if err != nil {
		return keys
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, err := registry.DecodeKey(line); err == nil {
			keys = append(keys, k)
		}
	}
	return keys
}

// verifyVersionSig reports whether v's Ed25519 signature verifies against any
// trusted key. An empty signature never verifies here (the caller decides
// whether an unsigned community build is acceptable).
func verifyVersionSig(entryName string, v *registry.Version, trusted [][]byte) bool {
	if strings.TrimSpace(v.Ed25519Sig) == "" {
		return false
	}
	msg := registry.CanonicalBytes(entryName, v)
	for _, k := range trusted {
		if registry.Verify(k, msg, v.Ed25519Sig) {
			return true
		}
	}
	return false
}

// splitLeadingPositionals peels the leading non-flag tokens off args so a
// command can be written positional-first (e.g. `thesun publish <dir> --flag`)
// as well as flags-first. Go's flag package stops parsing at the first
// positional, so without this the flags after a leading positional would be
// silently ignored. The returned rest is safe to hand to flag.Parse; combine
// pos with fs.Args() afterward to recover every positional.
func splitLeadingPositionals(args []string) (pos, rest []string) {
	i := 0
	for i < len(args) && !strings.HasPrefix(args[i], "-") {
		i++
	}
	return args[:i], args[i:]
}

// pickFreePort loads the live manifest, collects the ports already in use, and
// returns the lowest free port in the static MCP window [PortMin, PortMax].
func pickFreePort(m *manifest.Manifest) (int, error) {
	used := map[int]bool{}
	for _, s := range m.Servers {
		used[s.Port] = true
	}
	for p := manifest.PortMin; p <= manifest.PortMax; p++ {
		if !used[p] {
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free port available in the %d-%d window", manifest.PortMin, manifest.PortMax)
}

// ---- search -------------------------------------------------------------

func registrySearch(args []string) int {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	index := fs.String("index", "", "index reference (URL, file path, or file:// URL); default $THESUN_REGISTRY_INDEX or the compiled-in URL")
	tier := fs.String("tier", "", "filter by tier: curated | community")
	pos, rest := splitLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	query := strings.ToLower(strings.Join(append(pos, fs.Args()...), " "))

	searchRef := registryIndexRef(*index)
	idx, warnings, err := registry.FetchIndexAuth(context.Background(), searchRef, bearerForURL(context.Background(), searchRef))
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun search: %v\n", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}

	var matched []*registry.Entry
	for i := range idx.Entries {
		e := &idx.Entries[i]
		if e.Revoked {
			continue // revoked entries are delisted from search
		}
		if *tier != "" && e.Tier != *tier {
			continue
		}
		if query != "" && !entryMatches(e, query) {
			continue
		}
		matched = append(matched, e)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].Name < matched[j].Name })

	if len(matched) == 0 {
		fmt.Println("no matching servers.")
		return 0
	}
	fmt.Printf("%-14s %-9s %-32s %s\n", "NAME", "TIER", "TRUST", "DETAILS")
	for _, e := range matched {
		v := e.Latest()
		trust := "community (self-attested, unverified)"
		if e.Curated() {
			trust = "curated (lab-verified)"
		}
		details := "no version"
		if v != nil {
			details = fmt.Sprintf("tools=%d write=%v auth=%s", v.LabReport.ToolCount, v.GatewayManifest.HasWrite, authLabel(v.Auth))
		}
		fmt.Printf("%-14s %-9s %-32s %s\n", e.Name, e.Tier, trust, details)
		fmt.Printf("               %s\n", e.Description)
	}
	return 0
}

func entryMatches(e *registry.Entry, q string) bool {
	if strings.Contains(strings.ToLower(e.Name), q) ||
		strings.Contains(strings.ToLower(e.Description), q) ||
		strings.Contains(strings.ToLower(e.Category), q) {
		return true
	}
	for _, t := range e.Tags {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

func authLabel(a registry.Auth) string {
	if a.AuthScheme == "" || a.AuthScheme == "none" {
		return "none"
	}
	return a.AuthScheme
}

// ---- add ----------------------------------------------------------------

func registryAdd(args []string) int {
	fs := flag.NewFlagSet("add", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	index := fs.String("index", "", "index reference (URL, file path, or file:// URL)")
	community := fs.Bool("community", false, "allow installing a community (self-attested, unverified) entry")
	pos, rest := splitLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	positionals := append(pos, fs.Args()...)
	if len(positionals) < 1 {
		fmt.Fprintln(os.Stderr, "usage: thesun add <name>[@version] [--community] [--index ref]")
		return 2
	}
	name, semver := splitNameVersion(positionals[0])
	if !registry.ValidName(name) {
		fmt.Fprintf(os.Stderr, "thesun add: refusing unsafe server name %q (allowed: [a-z0-9][a-z0-9_-]{0,62})\n", name)
		return 1
	}

	// Refuse a duplicate install: a legacy "-go" fleet server backs a bare index
	// entry (e.g. "shodan-go" is entry "shodan"), so adding "shodan" again would
	// create a second server on a new port. installedServers() resolves either
	// form to the real manifest name; if present, this entry is already installed.
	if installed, _ := installedServers(); len(installed) > 0 {
		if real, ok := installed[name]; ok {
			fmt.Fprintf(os.Stderr, "thesun add: %q is already installed (as %q). Use `thesun update %s` to upgrade or `thesun remove %s` first.\n", name, real, name, real)
			return 1
		}
	}

	addRef := registryIndexRef(*index)
	idx, warnings, err := registry.FetchIndexAuth(context.Background(), addRef, bearerForURL(context.Background(), addRef))
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: %v\n", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}

	entry := idx.Find(name)
	if entry == nil {
		fmt.Fprintf(os.Stderr, "thesun add: no server %q in the registry index\n", name)
		return 1
	}
	if entry.Revoked {
		fmt.Fprintf(os.Stderr, "thesun add: %q is REVOKED (delisted) — refusing to install\n", name)
		return 1
	}
	if !entry.Curated() && !*community {
		fmt.Fprintf(os.Stderr, "thesun add: %q is a COMMUNITY entry (self-attested, NOT conformance-proven).\n", name)
		fmt.Fprintf(os.Stderr, "It has not passed the Conformance Lab and is not maintainer-verified. Re-run to accept the risk:\n")
		fmt.Fprintf(os.Stderr, "  thesun add %s --community\n", positionals[0])
		return 1
	}

	v := entry.Version(semver)
	if v == nil {
		fmt.Fprintf(os.Stderr, "thesun add: %q has no version %q\n", name, semver)
		return 1
	}

	// Curated installs REQUIRE a passing Lab report. Fail closed.
	if entry.Curated() && !v.LabReport.Passed {
		fmt.Fprintf(os.Stderr, "thesun add: curated %q version %s has lab_report.passed=false — refusing\n", name, v.Version)
		return 1
	}

	plat := v.PlatformFor(runtime.GOOS, runtime.GOARCH)
	if plat == nil || strings.TrimSpace(plat.URL) == "" {
		fmt.Fprintf(os.Stderr, "thesun add: no published %s/%s binary for %q@%s.\n", runtime.GOOS, runtime.GOARCH, name, v.Version)
		fmt.Fprintf(os.Stderr, "Build it from source instead: clone %s and run `thesun generate`/`go build`, then `thesun add <name> --bin <path> --port N`.\n", entry.Source)
		return 1
	}

	// Download to a temp file, then verify BEFORE it lands in servers/.
	dl, cleanup, err := verifiedDownload(entry, v, plat, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: %v\n", err)
		return 1
	}
	defer cleanup()

	// Verified. Install the binary into THESUN_HOME/servers/<name>/<name>-mcp.
	destDir := filepath.Join(paths.ServersDir(), name)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: %v\n", err)
		return 1
	}
	destBin := filepath.Join(destDir, name+"-mcp")
	if err := installBinary(dl, destBin); err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: install binary: %v\n", err)
		return 1
	}

	// Allocate a port and build the manifest entry.
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: read manifest: %v\n", err)
		return 1
	}
	port, err := pickFreePort(m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: %v\n", err)
		return 1
	}
	spec := manifest.AddSpec{
		Name:   name,
		Kind:   manifest.KindMCP,
		Bin:    destBin,
		Port:   port,
		Health: manifest.DefaultHealthPath,
		Env:    addEnv(name, port, v.Auth),
	}
	if err := manifest.Append(fleet.ManifestPath(), spec); err != nil {
		fmt.Fprintf(os.Stderr, "thesun add: %v\n", err)
		return 1
	}
	fmt.Printf("added %q (port %d, %s tier) to %s\n", name, port, entry.Tier, fleet.ManifestPath())
	reloadFleet()

	// Print (never run) the credential enrollment instruction.
	if v.Auth.HermesService != "" && v.Auth.AuthScheme != "" && v.Auth.AuthScheme != "none" {
		fmt.Printf("\nThis server needs a credential. Enroll it in Hermes (interactive, operator-only):\n")
		fmt.Printf("  thesun acquire %s\n", v.Auth.HermesService)
	}
	return 0
}

// verifiedDownload fetches the platform binary for (entry, v) into a temp dir
// and runs the fail-closed verification chain against it: sha256 against the
// index, then the Ed25519 signature. It installs nothing and mutates no state,
// which is what lets `thesun update` use it as a preflight and only then swap
// the running server. Returns the verified temp path and a cleanup func; on any
// failure it cleans up itself and returns an error.
//
// Curated entries MUST verify. A community entry still enforces sha256, and a
// signature that is present must verify; an unsigned community build is allowed
// (the operator accepted that risk with --community) but flagged.
func verifiedDownload(entry *registry.Entry, v *registry.Version, plat *registry.Platform, name string) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "thesun-add-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.RemoveAll(tmpDir) }
	dl := filepath.Join(tmpDir, name+"-mcp")
	fmt.Printf("downloading %s@%s (%s/%s) …\n", name, v.Version, runtime.GOOS, runtime.GOARCH)
	if err := fetchBinary(plat.URL, dl, bearerForURL(context.Background(), plat.URL)); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("download failed: %w", err)
	}

	// 1) sha256 must match the index (catches a swapped/corrupt binary).
	got, err := sha256File(dl)
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	if !strings.EqualFold(got, plat.SHA256) {
		cleanup()
		return "", func() {}, fmt.Errorf("REFUSED — sha256 mismatch for %q (got %s, index says %s)", name, got, plat.SHA256)
	}

	// 2) Ed25519 signature.
	sigOK := verifyVersionSig(entry.Name, v, trustedKeys())
	if entry.Curated() {
		if !sigOK {
			cleanup()
			return "", func() {}, fmt.Errorf("REFUSED — curated %q signature did not verify against any trusted key", name)
		}
	} else {
		if strings.TrimSpace(v.Ed25519Sig) != "" && !sigOK {
			cleanup()
			return "", func() {}, fmt.Errorf("REFUSED — community %q carries a signature that did not verify against any trusted key", name)
		}
		fmt.Fprintf(os.Stderr, "warning: community %q is unsigned; integrity is sha256-only against an unverified index.\n", name)
	}
	return dl, cleanup, nil
}

// addEnv builds the AddSpec env for an installed server. MCP_HOST/MCP_PORT are
// always set (the generated server refuses to start without MCP_PORT). When the
// entry declares a credential contract, a hermescred:// reference is injected
// under the generated-server credential env var (<NAME>_API_KEY), which is the
// convention thesun-generated Go servers read as their env fallback; fleetd
// resolves the hermescred:// ref from the Hermes broker at spawn time.
func addEnv(name string, port int, a registry.Auth) map[string]string {
	env := map[string]string{
		"MCP_HOST": "127.0.0.1",
		"MCP_PORT": strconv.Itoa(port),
	}
	if a.HermesService != "" && a.AuthScheme != "" && a.AuthScheme != "none" {
		scheme := a.HermesScheme
		if scheme == "" {
			scheme = a.AuthScheme
		}
		key := strings.ToUpper(strings.ReplaceAll(name, "-", "_")) + "_API_KEY"
		env[key] = fmt.Sprintf("hermescred://%s/%s", a.HermesService, scheme)
	}
	return env
}

func splitNameVersion(s string) (name, semver string) {
	if i := strings.LastIndex(s, "@"); i > 0 {
		return s[:i], s[i+1:]
	}
	return s, ""
}

// fetchBinary retrieves a platform binary from its URL into dest. https URLs go
// through the shared downloadToFile helper; a file:// URL or a bare local path
// is copied directly (so a locally-published release, whose platform URLs use
// file://, installs fully offline for testing and air-gapped use).
func fetchBinary(url, dest, bearer string) error {
	// Plaintext http is refused for remote hosts. An unsigned community entry
	// pulled over http has no integrity guarantee at all: the same attacker who
	// can rewrite the bytes in flight can rewrite the sha256 in the index they
	// also served. Loopback is exempt; file:// and bare paths are unaffected.
	if !registry.PlaintextHTTPAllowed(url) {
		return fmt.Errorf("refusing plaintext http download %q: use https (plaintext is allowed only for loopback)", url)
	}
	switch {
	case strings.HasPrefix(url, "https://"), strings.HasPrefix(url, "http://"):
		return httpGetToFile(url, dest, bearer)
	case strings.HasPrefix(url, "file://"):
		return copyFileTo(strings.TrimPrefix(url, "file://"), dest)
	default:
		return copyFileTo(url, dest)
	}
}

// copyFileTo copies src to dest (0644), overwriting dest.
func copyFileTo(src, dest string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dest, data, 0o644)
}

// installBinary copies src to dest (0755) atomically via a temp file + rename in
// dest's directory, so a running server binary is never partially overwritten.
func installBinary(src, dest string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".thesun-bin-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, dest); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// isRegistryPull reports whether a `thesun add` invocation is a registry pull
// rather than a manual add. A manual add REQUIRES --cmd (and --port); if no
// --cmd/--bin flag is present but a positional name is, it can only be a store
// pull. This classification is purely lexical (no index fetch), so it never
// slows down or breaks an offline manual add.
func isRegistryPull(args []string) bool {
	hasName := false
	for _, a := range args {
		if a == "--cmd" || a == "-cmd" || strings.HasPrefix(a, "--cmd=") || strings.HasPrefix(a, "-cmd=") ||
			a == "--bin" || a == "-bin" || strings.HasPrefix(a, "--bin=") || strings.HasPrefix(a, "-bin=") {
			return false
		}
		if !strings.HasPrefix(a, "-") {
			hasName = true
		}
	}
	return hasName
}

// ---- update -------------------------------------------------------------

func registryUpdate(args []string) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	index := fs.String("index", "", "index reference (URL, file path, or file:// URL)")
	community := fs.Bool("community", false, "allow updating to a community (unverified) version")
	pos, rest := splitLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	positionals := append(pos, fs.Args()...)

	ref := registryIndexRef(*index)
	idx, warnings, err := registry.FetchIndexAuth(context.Background(), ref, bearerForURL(context.Background(), ref))
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun update: %v\n", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}

	// No name: just refresh the index cache (re-fetch proved it is reachable).
	if len(positionals) < 1 {
		fmt.Printf("registry index refreshed from %s (%d entries).\n", ref, len(idx.Entries))
		return 0
	}

	name := positionals[0]
	if !registry.ValidName(name) {
		fmt.Fprintf(os.Stderr, "thesun update: refusing unsafe server name %q\n", name)
		return 1
	}
	entry := idx.Find(name)
	if entry == nil {
		fmt.Fprintf(os.Stderr, "thesun update: no server %q in the registry index\n", name)
		return 1
	}
	latest := entry.Latest()
	if latest == nil {
		fmt.Fprintf(os.Stderr, "thesun update: %q has no versions\n", name)
		return 1
	}

	installed, ok := installedVersion(name)
	realName := name
	if !ok {
		// A legacy "-go" fleet server may back the bare index entry ("shodan-go"
		// backs "shodan"). Resolve through installedServers() and retry with the
		// real manifest name so the update migrates the legacy block to the
		// store-managed bare name.
		if real, rok := resolveInstalledName(name); rok && real != name {
			realName = real
			installed, ok = installedVersion(realName)
		}
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "thesun update: %q is not installed; run `thesun add %s` first\n", name, name)
		return 1
	}
	if compareSemver(installed, latest.Version) >= 0 {
		fmt.Printf("%q is up to date (installed %s, latest %s).\n", name, installed, latest.Version)
		return 0
	}

	fmt.Printf("updating %q: %s -> %s\n", name, installed, latest.Version)
	if realName != name {
		fmt.Printf("note: replacing legacy %q with store-managed %q\n", realName, name)
	}
	// Verify FIRST, swap second. Removing the manifest entry before the new
	// version is proven installable drops the server from the fleet entirely on
	// any failure downstream, so every check that can refuse the upgrade runs
	// while the running server is still untouched.
	//
	// A missing platform binary is the likeliest refusal (legacy "-go" servers
	// are local builds with no store binary), but a sha256 mismatch, a signature
	// failure, or a transient network error must be just as non-destructive.
	plat := latest.PlatformFor(runtime.GOOS, runtime.GOARCH)
	if plat == nil || strings.TrimSpace(plat.URL) == "" {
		fmt.Fprintf(os.Stderr, "thesun update: no %s/%s binary published for %q %s; leaving the installed server in place\n", runtime.GOOS, runtime.GOARCH, name, latest.Version)
		return 1
	}
	if entry.Curated() && !latest.LabReport.Passed {
		fmt.Fprintf(os.Stderr, "thesun update: curated %q version %s has lab_report.passed=false; leaving the installed server in place\n", name, latest.Version)
		return 1
	}
	if _, cleanup, err := verifiedDownload(entry, latest, plat, name); err != nil {
		fmt.Fprintf(os.Stderr, "thesun update: %v; leaving the installed server in place\n", err)
		return 1
	} else {
		// The bytes are proven good. registryAdd re-fetches them through the same
		// verified path below; this preflight exists so a failure cannot happen
		// after the running server has already been removed from the manifest.
		cleanup()
	}
	// The verified download+swap is exactly registryAdd's path. Remove the old
	// manifest entry first so Append does not collide on name, then re-add.
	if _, err := manifest.Remove(fleet.ManifestPath(), []string{realName}); err != nil {
		fmt.Fprintf(os.Stderr, "thesun update: %v\n", err)
		return 1
	}
	addArgs := []string{name + "@" + latest.Version, "--index", ref}
	if *community {
		addArgs = append(addArgs, "--community")
	}
	return registryAdd(addArgs)
}

// installedVersion returns the version string a server was installed at. There
// is no version field in the manifest, so this is best-effort: a server present
// in the manifest is reported as installed at "0.0.0" (an unknown-but-older
// sentinel) so any real published version compares as newer. Presence is the
// signal that matters for `thesun update`.
func installedVersion(name string) (string, bool) {
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		return "", false
	}
	for _, s := range m.Servers {
		if s.Name == name {
			return "0.0.0", true
		}
	}
	return "", false
}

// resolveInstalledName maps a registry index name to the manifest server name
// backing it, using installedServers()'s "-go"-aware lookup (index entry
// "shodan" resolves to legacy fleet server "shodan-go"; a bare server resolves
// to itself). ok=false means no installed server backs the name.
func resolveInstalledName(name string) (string, bool) {
	names, _ := installedServers()
	real, ok := names[name]
	return real, ok
}

// ---- keygen -------------------------------------------------------------

func keygenCmd(args []string) int {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	pub, priv, err := registry.GenerateKeypair()
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun keygen: %v\n", err)
		return 1
	}
	keyDir := filepath.Join(paths.Home(), "keys")
	if err := os.MkdirAll(keyDir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "thesun keygen: %v\n", err)
		return 1
	}
	privPath := filepath.Join(keyDir, "author.key")
	pubPath := filepath.Join(keyDir, "author.pub")
	// The private key is written 0600 and NEVER printed.
	if err := os.WriteFile(privPath, []byte(registry.EncodeKey(priv)+"\n"), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "thesun keygen: write private key: %v\n", err)
		return 1
	}
	pubB64 := registry.EncodeKey(pub)
	if err := os.WriteFile(pubPath, []byte(pubB64+"\n"), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "thesun keygen: write public key: %v\n", err)
		return 1
	}
	fmt.Printf("wrote keypair:\n  private: %s (0600, never share)\n  public:  %s\n\n", privPath, pubPath)
	fmt.Printf("public key (base64):\n  %s\n\n", pubB64)
	fmt.Printf("To trust this key for local installs, append it to %s (one key per line).\n", trustedKeysPath())
	fmt.Printf("To make it the curated key, paste it into curatedPubKeyB64 in cmd/thesun/registry.go.\n")
	return 0
}

// ---- publish ------------------------------------------------------------

// labReportJSON mirrors the fields of a server's lab-report.json we consume.
type labReportJSON struct {
	Passed    bool   `json:"passed"`
	ToolCount int    `json:"toolCount"`
	Transport string `json:"transport"`
	Gates     []struct {
		Gate   string `json:"gate"`
		Passed bool   `json:"passed"`
	} `json:"gates"`
	ResidualUnverifiedSurface []string `json:"residualUnverifiedSurface"`
}

// coverageJSON mirrors the op-method list we derive read/write counts from.
type coverageJSON struct {
	Ops []struct {
		Method string `json:"method"`
	} `json:"ops"`
}

func publishCmd(args []string) int {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	community := fs.Bool("community", false, "publish as a community (self-attested) entry")
	index := fs.String("index", "", "local index file to append/update the entry into (optional)")
	releaseDir := fs.String("release-dir", "./dist", "directory to write cross-compiled release binaries into")
	downloadBase := fs.String("download-base", "", "base URL where the release binaries will be hosted (e.g. https://<host>/thesun-servers/<version>); each platform URL becomes <base>/<binary>. Empty emits file:// URLs for a local/offline release.")
	name := fs.String("name", "", "server name (default: the directory base name)")
	version := fs.String("version", "0.1.0", "semver to publish")
	category := fs.String("category", "uncategorized", "catalog category for `thesun store` grouping (e.g. security, itsm, networking, pki, devops)")
	upload := fs.Bool("upload", false, "after building, HTTP PUT the binaries (to their --download-base URLs) and, with --index-url, the index, using a Hermes-resolved write token. The artifact store is read anonymously, so only publishing needs the credential.")
	uploadCred := fs.String("upload-cred", "hermescred://artifactory/token", "Hermes reference resolving to the artifact-store write token used by --upload")
	indexURL := fs.String("index-url", "", "with --upload, the URL to PUT the finalized index file (--index) to, i.e. the anonymous-readable distribution index")
	pos, rest := splitLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	positionals := append(pos, fs.Args()...)
	if len(positionals) < 1 {
		fmt.Fprintln(os.Stderr, "usage: thesun publish <dir> [--community] [--index localfile] [--release-dir dir] [--download-base url] [--name n] [--version v] [--category cat] [--upload [--upload-cred hermesref] [--index-url url]]")
		return 2
	}
	dir, err := filepath.Abs(positionals[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun publish: %v\n", err)
		return 1
	}
	srvName := *name
	if srvName == "" {
		srvName = filepath.Base(dir)
	}

	// HARD GATE: a machine-verifiable Lab PASS is required to publish. A full
	// build should re-run `thesun verify <dir>` first and this reads the report
	// it emits; here we read the on-disk lab-report.json as that check.
	lab, err := readLabReport(filepath.Join(dir, "lab-report.json"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun publish: REFUSED — cannot read lab-report.json in %s: %v\n", dir, err)
		return 1
	}
	if !lab.Passed {
		fmt.Fprintf(os.Stderr, "thesun publish: REFUSED — lab-report.json reports passed=false for %q\n", srvName)
		return 1
	}
	tier := "curated"
	if *community {
		tier = "community"
	}

	// Load the author signing key.
	priv, err := loadAuthorKey()
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun publish: %v (run `thesun keygen` first)\n", err)
		return 1
	}

	// Cross-compile the platform matrix into --release-dir.
	if err := os.MkdirAll(*releaseDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "thesun publish: %v\n", err)
		return 1
	}
	absRel, _ := filepath.Abs(*releaseDir)
	targets := []struct{ OS, Arch string }{
		{"darwin", "amd64"}, {"darwin", "arm64"},
		{"linux", "amd64"}, {"linux", "arm64"},
		{"windows", "amd64"},
	}
	var platforms []registry.Platform
	for _, t := range targets {
		outName := fmt.Sprintf("%s-%s-%s", srvName, t.OS, t.Arch)
		if t.OS == "windows" {
			outName += ".exe"
		}
		outPath := filepath.Join(absRel, outName)
		fmt.Printf("building %s/%s …\n", t.OS, t.Arch)
		if err := crossCompile(dir, outPath, t.OS, t.Arch); err != nil {
			fmt.Fprintf(os.Stderr, "thesun publish: build %s/%s failed: %v\n", t.OS, t.Arch, err)
			return 1
		}
		sum, err := sha256File(outPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun publish: %v\n", err)
			return 1
		}
		// URL: a hosted https base (Artifactory, Bitbucket, a release host) when
		// --download-base is set, else a file:// URL for a local/offline release.
		// The signature covers os/arch/sha256, NOT the URL, so a later host move
		// does not invalidate it; the sha256 still pins the exact bytes.
		url := "file://" + outPath
		if b := strings.TrimRight(*downloadBase, "/"); b != "" {
			url = b + "/" + outName
		}
		platforms = append(platforms, registry.Platform{
			OS:     t.OS,
			Arch:   t.Arch,
			URL:    url,
			SHA256: sum,
		})
	}

	// Assemble the version and sign it.
	v := registry.Version{
		Version:         *version,
		Status:          "released",
		LabReport:       labToRegistry(lab),
		GatewayManifest: deriveGatewayManifest(dir),
		Auth:            deriveAuth(dir, srvName),
		Platforms:       platforms,
	}
	v.Ed25519Sig = registry.Sign(priv, registry.CanonicalBytes(srvName, &v))

	entry := registry.Entry{
		Name:        srvName,
		Description: fmt.Sprintf("%s (published %s).", srvName, tier),
		Category:    *category,
		Tags:        []string{srvName},
		Tier:        tier,
		Maintainer:  "thesun",
		Source:      "https://github.com/schwarztim/thesun-servers",
		Versions:    []registry.Version{v},
	}

	// Emit the entry TOML to stdout.
	tomlText, err := encodeEntryTOML(entry)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun publish: %v\n", err)
		return 1
	}
	fmt.Println("---- index entry (schema thesun-registry/v1) ----")
	fmt.Print(tomlText)
	fmt.Println("---- end entry ----")

	// If --index points at a local file, append/update the entry there.
	if *index != "" {
		if err := upsertLocalIndex(*index, entry); err != nil {
			fmt.Fprintf(os.Stderr, "thesun publish: update %s: %v\n", *index, err)
			return 1
		}
		fmt.Printf("wrote entry %q into %s\n", srvName, *index)
	}

	// --upload: push the built binaries (and, with --index-url, the index) to the
	// artifact store over HTTP PUT, authenticated with a Hermes-resolved write
	// token. Reads stay anonymous; only publishing carries the credential. This
	// keeps the toolchain portable (any HTTP artifact store that accepts PUT) and
	// free of an external CLI dependency.
	if *upload {
		tok, err := hermes.NewResolver().Resolve(context.Background(), *uploadCred)
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun publish: resolve upload credential %s: %v\n", *uploadCred, err)
			return 1
		}
		for _, p := range platforms {
			outName := fmt.Sprintf("%s-%s-%s", srvName, p.OS, p.Arch)
			if p.OS == "windows" {
				outName += ".exe"
			}
			localPath := filepath.Join(absRel, outName)
			if err := httpPutFile(p.URL, localPath, tok); err != nil {
				fmt.Fprintf(os.Stderr, "thesun publish: upload %s: %v\n", outName, err)
				return 1
			}
			fmt.Printf("uploaded %s -> %s\n", outName, p.URL)
		}
		if *indexURL != "" {
			if *index == "" {
				fmt.Fprintln(os.Stderr, "thesun publish: --index-url requires --index (the file to upload)")
				return 1
			}
			if err := httpPutFile(*indexURL, *index, tok); err != nil {
				fmt.Fprintf(os.Stderr, "thesun publish: upload index: %v\n", err)
				return 1
			}
			fmt.Printf("uploaded index -> %s\n", *indexURL)
		}
	}
	return 0
}

// httpPutFile streams the file at path to url with an HTTP PUT, sending a bearer
// token when non-empty. Used by `thesun publish --upload` to deploy binaries and
// the index to an artifact store (for example Artifactory, which accepts a PUT to
// the artifact path). Any 2xx is success; a non-2xx surfaces the store's message.
func httpPutFile(url, path, bearer string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPut, url, f)
	if err != nil {
		return err
	}
	req.ContentLength = fi.Size()
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := upgradeHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("PUT returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func readLabReport(path string) (*labReportJSON, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var lr labReportJSON
	if err := json.Unmarshal(raw, &lr); err != nil {
		return nil, err
	}
	return &lr, nil
}

func labToRegistry(lr *labReportJSON) registry.LabReport {
	transport := lr.Transport
	if transport == "" {
		transport = "streamable-http"
	}
	var gates []string
	for _, g := range lr.Gates {
		gates = append(gates, g.Gate)
	}
	return registry.LabReport{
		Passed:                    lr.Passed,
		Gates:                     gates,
		ToolCount:                 lr.ToolCount,
		Transport:                 transport,
		ResidualUnverifiedSurface: lr.ResidualUnverifiedSurface,
	}
}

// deriveGatewayManifest reads coverage.json (if present) and classifies each op:
// GET/HEAD count as READ, every other method counts as WRITE.
func deriveGatewayManifest(dir string) registry.GatewayManifest {
	raw, err := os.ReadFile(filepath.Join(dir, "coverage.json"))
	if err != nil {
		return registry.GatewayManifest{}
	}
	var cov coverageJSON
	if err := json.Unmarshal(raw, &cov); err != nil {
		return registry.GatewayManifest{}
	}
	read, write := 0, 0
	for _, op := range cov.Ops {
		switch strings.ToUpper(op.Method) {
		case "GET", "HEAD":
			read++
		default:
			write++
		}
	}
	gm := registry.GatewayManifest{ReadCount: read, WriteCount: write, HasWrite: write > 0}
	if read > 0 {
		gm.SafetyClasses = append(gm.SafetyClasses, "READ")
	}
	if write > 0 {
		gm.SafetyClasses = append(gm.SafetyClasses, "WRITE")
	}
	return gm
}

// deriveAuth parses .env.example for a hermescred:// reference to fill the auth
// summary. When none is found, the server is treated as unauthenticated.
func deriveAuth(dir, name string) registry.Auth {
	raw, err := os.ReadFile(filepath.Join(dir, ".env.example"))
	if err != nil {
		return registry.Auth{AuthScheme: "none", HermesService: name}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		i := strings.Index(line, "hermescred://")
		if i < 0 {
			continue
		}
		ref := line[i+len("hermescred://"):]
		ref = strings.Trim(strings.TrimSpace(ref), "\"'")
		parts := strings.SplitN(ref, "/", 2)
		svc := parts[0]
		scheme := ""
		if len(parts) == 2 {
			scheme = parts[1]
		}
		return registry.Auth{AuthScheme: schemeToAuth(scheme), HermesService: svc, HermesScheme: scheme}
	}
	return registry.Auth{AuthScheme: "none", HermesService: name}
}

func schemeToAuth(scheme string) string {
	switch scheme {
	case "basic", "bearer", "token", "session", "oauth":
		return scheme
	case "api_key", "apikey", "api-key":
		return "apikey"
	case "":
		return "none"
	default:
		return "apikey"
	}
}

// crossCompile builds the Go server in dir for goos/goarch into outPath with
// CGO disabled (fully static, portable release binaries).
func crossCompile(dir, outPath, goos, goarch string) error {
	cmd := exec.Command("go", "build", "-o", outPath, ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func loadAuthorKey() ([]byte, error) {
	path := filepath.Join(paths.Home(), "keys", "author.key")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read author key %s: %w", path, err)
	}
	return registry.DecodeKey(string(raw))
}
