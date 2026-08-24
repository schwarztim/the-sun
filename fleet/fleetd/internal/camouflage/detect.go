package camouflage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// detectTimeout bounds every external command Detect() shells out to
// (defaults read / <browser> --version) so a hung or missing tool can never
// stall onboarding.
const detectTimeout = 3 * time.Second

// hostOSName maps runtime.GOOS to the Profile.OS vocabulary ("macos",
// "linux", "windows").
func hostOSName() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

// Detect builds a Profile describing the current machine and its primary
// browser. Browser detection is best-effort and never returns an error on
// its own account — a browser that can't be found or versioned simply
// yields Browser="unknown" with an OS-matched fallback profile. The returned
// error is reserved for conditions that would make the Profile meaningless
// (there are currently none — Detect() always succeeds), kept for API
// stability so a future stricter check can fail closed without a signature
// change.
func Detect() (Profile, error) {
	osName := hostOSName()
	browser, version := detectBrowser(osName)
	return buildProfile(osName, browser, version), nil
}

// detectBrowser dispatches to the per-OS detector. Returns ("", "") when
// nothing usable was found — buildProfile treats that as "unknown".
func detectBrowser(osName string) (browser, version string) {
	switch osName {
	case "macos":
		return detectMacOSBrowser()
	case "windows":
		return detectWindowsBrowser()
	default:
		return detectLinuxBrowser()
	}
}

// --- macOS -------------------------------------------------------------

// macAppBundle maps a browser identity to its /Applications bundle name and
// LaunchServices bundle identifier (the latter used for default-browser
// resolution below).
type macAppBundle struct {
	browser  string
	appName  string // e.g. "Google Chrome.app"
	bundleID string // e.g. "com.google.Chrome"
}

var macBrowsers = []macAppBundle{
	{"chrome", "Google Chrome.app", "com.google.chrome"},
	{"edge", "Microsoft Edge.app", "com.microsoft.edgemac"},
	{"safari", "Safari.app", "com.apple.safari"},
}

// detectMacOSBrowser first tries to resolve the operator's actual default
// browser via the LaunchServices handler registry (accurate — reflects
// System Settings > Desktop & Dock > Default web browser), then falls back
// to a fixed-priority /Applications presence scan (chrome > edge > safari)
// when the default handler is unset or is a browser this package can't
// impersonate (e.g. Firefox or a Firefox-derived browser). Presence-only
// scanning is a real fallback path, not just a comment — many machines have
// no explicit LSHandlers override.
func detectMacOSBrowser() (browser, version string) {
	if id := defaultBrowserBundleID(); id != "" {
		for _, b := range macBrowsers {
			if strings.EqualFold(id, b.bundleID) {
				return b.browser, macAppVersion(b.appName)
			}
		}
		// Default browser is installed but not one we can impersonate
		// (Firefox, a Chromium fork we don't recognize, etc). Fall through
		// to the presence scan rather than trusting an unmappable bundle ID.
	}
	for _, b := range macBrowsers {
		if _, err := os.Stat(filepath.Join("/Applications", b.appName)); err == nil {
			return b.browser, macAppVersion(b.appName)
		}
	}
	return "", ""
}

// defaultBrowserBundleID reads the operator's registered default handler for
// the "http" URL scheme from the LaunchServices secure preferences plist.
// Returns "" on any failure (missing tool, unparsable plist, no handler
// registered) — callers must treat that as "unknown," not an error.
func defaultBrowserBundleID() string {
	ctx, cancel := context.WithTimeout(context.Background(), detectTimeout)
	defer cancel()
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	plist := filepath.Join(home, "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist")
	out, err := exec.CommandContext(ctx, "plutil", "-convert", "json", "-o", "-", plist).Output()
	if err != nil {
		return ""
	}
	return parseDefaultHTTPHandler(out)
}

// macAppVersion reads CFBundleShortVersionString from <appName>'s Info.plist
// via `defaults read`. Returns "" on any failure (app missing, key absent).
func macAppVersion(appName string) string {
	ctx, cancel := context.WithTimeout(context.Background(), detectTimeout)
	defer cancel()
	infoPlist := filepath.Join("/Applications", appName, "Contents", "Info")
	out, err := exec.CommandContext(ctx, "defaults", "read", infoPlist, "CFBundleShortVersionString").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// --- Linux ---------------------------------------------------------------

// linuxBrowserCandidates lists binary names to probe via `which`, in
// priority order, each mapped to the browser family it reports as.
var linuxBrowserCandidates = []struct {
	bin     string
	browser string
}{
	{"google-chrome", "chrome"},
	{"google-chrome-stable", "chrome"},
	{"microsoft-edge", "edge"},
	{"microsoft-edge-stable", "edge"},
	{"chromium", "chrome"},
	{"chromium-browser", "chrome"},
}

// detectLinuxBrowser probes PATH for a known browser binary and shells out to
// `<bin> --version` for the version string (typically "Google Chrome
// 120.0.6099.129" or "Chromium 118.0.5993.88").
func detectLinuxBrowser() (browser, version string) {
	for _, c := range linuxBrowserCandidates {
		path, err := exec.LookPath(c.bin)
		if err != nil {
			continue
		}
		return c.browser, linuxBinVersion(path)
	}
	return "", ""
}

func linuxBinVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), detectTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	for _, f := range fields {
		if len(f) > 0 && (f[0] >= '0' && f[0] <= '9') {
			return strings.TrimSpace(f)
		}
	}
	return ""
}

// --- Windows ---------------------------------------------------------------

// windowsBrowserCandidates lists the standard per-machine install roots for
// Chrome and Edge. Each browser's installer lays down a versioned
// subdirectory next to the executable (e.g.
// `...\Application\131.0.6778.109\`) — reading that directory name is a
// reliable, dependency-free stand-in for parsing the exe's PE version
// resource, which the Go stdlib has no support for.
var windowsBrowserCandidates = []struct {
	dir     string
	browser string
}{
	{`C:\Program Files\Google\Chrome\Application`, "chrome"},
	{`C:\Program Files (x86)\Google\Chrome\Application`, "chrome"},
	{`C:\Program Files (x86)\Microsoft\Edge\Application`, "edge"},
	{`C:\Program Files\Microsoft\Edge\Application`, "edge"},
}

// detectWindowsBrowser is best-effort per the spec: if no versioned
// subdirectory is found, it still reports the browser family (install
// detected) with an empty version, or "", "" if nothing is found at all —
// either way Detect() always falls back to an OS-matched profile.
func detectWindowsBrowser() (browser, version string) {
	for _, c := range windowsBrowserCandidates {
		entries, err := os.ReadDir(c.dir)
		if err != nil {
			continue
		}
		if v := latestVersionDir(entries); v != "" {
			return c.browser, v
		}
		return c.browser, "" // install root exists but no versioned subdir found
	}
	return "", ""
}

// latestVersionDir returns the lexicographically-largest all-numeric
// (dot-separated) directory name, which for Chrome/Edge's Application dir is
// the newest installed version.
func latestVersionDir(entries []os.DirEntry) string {
	var versions []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if isVersionLike(name) {
			versions = append(versions, name)
		}
	}
	if len(versions) == 0 {
		return ""
	}
	sort.Strings(versions)
	return versions[len(versions)-1]
}

func isVersionLike(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r != '.' && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}
