package main

// upgrade.go implements `thesun upgrade` — self-update against a GitHub
// Releases feed. It checks the feed for a newer tagged version than this
// binary's own `version` (see version.go), and when one exists, downloads the
// matching-OS/arch archive `.goreleaser.yml` produces (thesun-<os>-<arch>.tar.gz
// / .zip on Windows), verifies it against the release's `checksums.txt`,
// atomically swaps it in for the current bundle, and restarts the service.
//
// Self-replace pattern (download -> temp dir -> verify -> rename into place)
// mirrors how `gh` and `hugo` self-update: never write over a running
// executable in place; always land the new bytes on the same filesystem
// first, then rename. A directory-tree bundle (unlike a single static binary)
// can't be swapped with one rename, so replaceBundle does two: the live
// bundle is renamed aside as a `.old` backup, then the newly-extracted bundle
// is renamed into the live path. Either rename is atomic on its own; if the
// second one fails, the backup is renamed back so the tool never ends up
// bundle-less.
//
// SC-4 framing: `thesun upgrade` is itself the informed-consent action —
// an operator (or agent under existing authorization) invoking it IS the
// explicit request to replace the running bundle and restart the service.
// `--check` performs zero writes.

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/svc"
)

// defaultUpdateRepo is the GitHub "owner/repo" this build checks by default.
// Override per-build via `-ldflags -X main.defaultUpdateRepo=...`, or at
// runtime via THESUN_UPDATE_REPO / `thesun upgrade --repo owner/repo`.
var defaultUpdateRepo = "synman/thesun"

// githubAPIBase is a var (not a const) so tests can point it at an
// httptest.Server instead of the real GitHub API.
var githubAPIBase = "https://api.github.com"

var upgradeHTTPClient = &http.Client{Timeout: 30 * time.Second}

// errNoReleases and errFeedUnreachable classify the two "self-update simply
// isn't available right now" cases so upgradeCmd can report them cleanly and
// exit 0 (a script or doctor calling `thesun upgrade --check` must not see a
// hard error just because no release has been published yet, or the machine is
// offline). Any other failure (a malformed feed, an unexpected HTTP status)
// stays a real error.
var (
	errNoReleases      = errors.New("no releases published yet")
	errFeedUnreachable = errors.New("release feed unreachable")
)

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Assets  []ghAsset `json:"assets"`
}

// updateRepo resolves the repo to check: --repo flag > THESUN_UPDATE_REPO env
// > compiled-in default.
func updateRepo(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv("THESUN_UPDATE_REPO"); v != "" {
		return v
	}
	return defaultUpdateRepo
}

// fetchLatestRelease GETs the repo's latest release from the GitHub Releases
// API (or feed override).
func fetchLatestRelease(repo string) (*ghRelease, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", githubAPIBase, repo)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/vnd.github+json")
	resp, err := upgradeHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errFeedUnreachable, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		// 404 covers both "repo has no releases" and "repo not found" — either
		// way there is nothing to upgrade to; treat it as the no-releases case.
		return nil, fmt.Errorf("%w for %s", errNoReleases, repo)
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("release feed returned %d: %s", resp.StatusCode, string(body))
	}
	var rel ghRelease
	if err := json.Unmarshal(body, &rel); err != nil {
		return nil, fmt.Errorf("parse release feed response: %w", err)
	}
	return &rel, nil
}

// parseSemver splits a (optionally "v"-prefixed) semver-ish string into up to
// three numeric components, ignoring any "-prerelease"/"+build" suffix.
// Non-numeric or missing components parse as 0 — good enough for "is there a
// newer tag" comparisons without pulling in a semver dependency (KISS: this
// tool only ever compares its own goreleaser-emitted tags).
func parseSemver(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.SplitN(v, ".", 3)
	var out [3]int
	for i := 0; i < len(parts) && i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			continue // non-numeric component -> 0, don't fail the whole comparison
		}
		out[i] = n
	}
	return out
}

// compareSemver returns -1 if a<b, 0 if a==b, 1 if a>b. "dev" (or any
// non-numeric-leading string) parses as 0.0.0 — always older than a real tag.
func compareSemver(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// assetName is the goreleaser-emitted archive name for a given OS/arch —
// kept in exact lockstep with .goreleaser.yml's `archives[].name_template`
// (`thesun-{{ .Os }}-{{ .Arch }}`, extension `.zip` on Windows else `.tar.gz`).
func assetName(goos, goarch string) string {
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("thesun-%s-%s.%s", goos, goarch, ext)
}

func findAsset(rel *ghRelease, name string) *ghAsset {
	for i := range rel.Assets {
		if rel.Assets[i].Name == name {
			return &rel.Assets[i]
		}
	}
	return nil
}

// checkForUpdate is the pure(ish) core of `thesun upgrade [--check]`: fetch
// the feed, compare versions, and report. It performs no writes — both the
// `--check` path and the real-upgrade path call this first.
func checkForUpdate(repo, current string) (rel *ghRelease, hasUpdate bool, err error) {
	rel, err = fetchLatestRelease(repo)
	if err != nil {
		return nil, false, err
	}
	return rel, compareSemver(current, rel.TagName) < 0, nil
}

func upgradeCmd(args []string) int {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	checkOnly := fs.Bool("check", false, "report whether a newer version is available; make no changes")
	repoFlag := fs.String("repo", "", "GitHub owner/repo to check (default: "+defaultUpdateRepo+", or $THESUN_UPDATE_REPO)")
	// Branch tracking is a different trust model from release upgrades (see
	// upgrade_track.go), so it is an explicit opt-in flag rather than a fallback
	// when no release exists.
	track := fs.Bool("track", false, "update from this checkout's upstream BRANCH instead of a tagged release")
	noRestart := fs.Bool("no-restart", false, "with --track, rebuild but do not restart the stack")
	auto := fs.String("auto", "", "with --track: `on <interval>` or `off` to manage the scheduled updater (e.g. --auto=on --every=6h)")
	every := fs.String("every", "6h", "with --auto=on, how often to check (e.g. 30m, 6h, 24h)")
	autoRun := fs.Bool("auto-run", false, "internal: one unattended tracking run, invoked by the scheduled job")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, "usage: thesun upgrade [--check] [--repo owner/repo]")
		fmt.Fprintln(os.Stderr, "       thesun upgrade --track [--check] [--no-restart]")
		fmt.Fprintln(os.Stderr, "       thesun upgrade --track --auto=on [--every 6h] | --auto=off")
		return 2
	}

	if *autoRun {
		return runAutoUpdate()
	}
	if *auto != "" {
		return autoUpdateCmd(*auto, *every)
	}
	if *track {
		return trackCmd(*checkOnly, *noRestart)
	}

	repo := updateRepo(*repoFlag)
	rel, hasUpdate, err := checkForUpdate(repo, version)
	if err != nil {
		// No releases yet, or the feed is unreachable, is not a failure of the
		// tool: self-update just isn't available right now. Report it plainly
		// and exit 0 so `thesun upgrade --check` in a script or doctor run does
		// not surface an error stack for everyone before the first release ships.
		if errors.Is(err, errNoReleases) {
			fmt.Printf("thesun %s: no releases available yet (repo: %s) — nothing to upgrade to.\n", version, repo)
			return 0
		}
		if errors.Is(err, errFeedUnreachable) {
			fmt.Printf("thesun %s: release feed unreachable (repo: %s) — offline? try again later.\n", version, repo)
			return 0
		}
		fmt.Fprintf(os.Stderr, "thesun upgrade: %v\n", err)
		return 1
	}

	if !hasUpdate {
		fmt.Printf("thesun %s is up to date (latest: %s, repo: %s)\n", version, rel.TagName, repo)
		return 0
	}

	fmt.Printf("update available: %s -> %s (repo: %s)\n", version, rel.TagName, repo)
	if *checkOnly {
		fmt.Println("run `thesun upgrade` (without --check) to install it")
		return 0
	}

	name := assetName(runtime.GOOS, runtime.GOARCH)
	asset := findAsset(rel, name)
	if asset == nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: release %s has no asset named %q (this platform may not be published)\n", rel.TagName, name)
		return 1
	}
	sumsAsset := findAsset(rel, "checksums.txt")
	if sumsAsset == nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: release %s has no checksums.txt — refusing to install an unverifiable archive\n", rel.TagName)
		return 1
	}

	tmpDir, err := os.MkdirTemp("", "thesun-upgrade-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: %v\n", err)
		return 1
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, name)
	fmt.Printf("downloading %s …\n", name)
	if err := downloadToFile(asset.BrowserDownloadURL, archivePath); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: download failed: %v\n", err)
		return 1
	}

	fmt.Println("verifying checksum …")
	if err := verifyChecksum(sumsAsset.BrowserDownloadURL, archivePath, name); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: checksum verification failed: %v\n", err)
		return 1
	}

	extractDir := filepath.Join(tmpDir, "extracted")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: %v\n", err)
		return 1
	}
	fmt.Println("extracting …")
	if strings.HasSuffix(name, ".zip") {
		err = extractZip(archivePath, extractDir)
	} else {
		err = extractTarGz(archivePath, extractDir)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: extract failed: %v\n", err)
		return 1
	}

	live := bundleRoot()
	if live == "" {
		fmt.Fprintln(os.Stderr, "thesun upgrade: cannot resolve the current bundle root (os.Executable failed) — aborting before touching anything")
		return 1
	}
	fmt.Printf("installing into %s …\n", live)
	if err := replaceBundle(extractDir, live); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade: %v\n", err)
		return 1
	}

	fmt.Println("restarting service …")
	restartAfterUpgrade()

	fmt.Printf("upgraded %s -> %s\n", version, rel.TagName)
	return 0
}

// downloadToFile streams url to dest. Kept separate from checksum
// verification so a partial/corrupt download is caught by the checksum step
// rather than silently accepted.
func downloadToFile(url, dest string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
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

// sha256File returns the lowercase-hex sha256 of the file at path.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// verifyChecksum downloads the release's checksums.txt, finds the line for
// assetName, and compares it against the actual sha256 of archivePath.
func verifyChecksum(checksumsURL, archivePath, assetNameStr string) error {
	req, err := http.NewRequest(http.MethodGet, checksumsURL, nil)
	if err != nil {
		return err
	}
	resp, err := upgradeHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("checksums.txt fetch returned HTTP %d", resp.StatusCode)
	}
	want, err := parseChecksumLine(string(body), assetNameStr)
	if err != nil {
		return err
	}
	got, err := sha256File(archivePath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("sha256 mismatch for %s: got %s, want %s", assetNameStr, got, want)
	}
	return nil
}

// parseChecksumLine finds `<hex>  <name>` (goreleaser's checksums.txt format,
// two-space separated, one per line) for name.
func parseChecksumLine(checksums, name string) (string, error) {
	for _, line := range strings.Split(checksums, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[len(fields)-1] == name {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no checksum entry for %s", name)
}

// extractTarGz extracts a .tar.gz archive into destDir, rejecting any entry
// whose cleaned path would escape destDir (defense in depth against a
// malicious/corrupt archive — even though the checksum step already gates
// this to exactly what the release published).
func extractTarGz(archivePath, destDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(destDir, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode&0o777))
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		default:
			// symlinks/devices/etc — a goreleaser archive of this tool never
			// contains them; skip rather than fail the whole install.
		}
	}
}

// extractZip extracts a .zip archive into destDir with the same path-escape
// guard as extractTarGz.
func extractZip(archivePath, destDir string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		target, err := safeJoin(destDir, f.Name)
		if err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// safeJoin joins destDir and name, rejecting any result that escapes destDir.
func safeJoin(destDir, name string) (string, error) {
	target := filepath.Join(destDir, name)
	if !strings.HasPrefix(target, filepath.Clean(destDir)+string(os.PathSeparator)) && target != filepath.Clean(destDir) {
		return "", fmt.Errorf("archive entry %q escapes extraction root", name)
	}
	return target, nil
}

// replaceBundle swaps extractDir in for the live bundle at liveDir via two
// renames (see file header for the atomicity rationale). Both extractDir and
// liveDir must be resolvable to the same filesystem as liveDir's parent for
// the renames to be atomic (true for the standard single-volume install this
// tool assumes); a cross-device rename fails loudly rather than silently
// falling back to a non-atomic copy.
func replaceBundle(extractDir, liveDir string) error {
	// The archive's top-level entries land directly under extractDir/thesun-<os>-<arch>/... would be one layer down.
	// Descend to the first (and only expected) top-level directory in the archive, if present.
	src, err := resolveArchiveRoot(extractDir)
	if err != nil {
		return err
	}

	backup := liveDir + ".old-upgrade"
	_ = os.RemoveAll(backup) // best-effort: clear any stale backup from a prior failed attempt

	if err := os.Rename(liveDir, backup); err != nil {
		return fmt.Errorf("rename current bundle aside: %w", err)
	}
	if err := os.Rename(src, liveDir); err != nil {
		// Roll back — the tool must never end up bundle-less.
		if rbErr := os.Rename(backup, liveDir); rbErr != nil {
			return fmt.Errorf("install failed (%v) AND rollback failed (%v) — bundle is at %s, restore it to %s manually", err, rbErr, backup, liveDir)
		}
		return fmt.Errorf("install new bundle: %w (rolled back — old bundle restored)", err)
	}
	_ = os.RemoveAll(backup) // best-effort cleanup; a leftover .old-upgrade dir is harmless
	return nil
}

// resolveArchiveRoot returns the directory whose contents ARE the bundle
// (bin/, fleet/, gateway/, hermes/, generator/, ...). goreleaser archives are
// created with `wrap_in_directory: false` by this project's .goreleaser.yml,
// so extractDir itself already IS the bundle root; this only descends one
// level if a wrapping directory is present (defensive, in case that setting
// ever changes).
func resolveArchiveRoot(extractDir string) (string, error) {
	if _, err := os.Stat(filepath.Join(extractDir, "bin")); err == nil {
		return extractDir, nil
	}
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return "", err
	}
	if len(entries) == 1 && entries[0].IsDir() {
		nested := filepath.Join(extractDir, entries[0].Name())
		if _, err := os.Stat(filepath.Join(nested, "bin")); err == nil {
			return nested, nil
		}
	}
	return "", fmt.Errorf("extracted archive at %s does not look like a thesun bundle (no bin/ found)", extractDir)
}

// restartAfterUpgrade triggers `thesun service restart` when the OS service
// is installed, else falls back to down+up (mirrors stackUp/stackDown's own
// installed-vs-detached branching in stack.go).
func restartAfterUpgrade() {
	if svc.Installed() {
		if err := svc.Control("restart"); err != nil {
			fmt.Fprintf(os.Stderr, "thesun upgrade: service restart failed: %v (run `thesun up` manually)\n", err)
		}
		return
	}
	stackDown(nil)
	stackUp(nil)
}
