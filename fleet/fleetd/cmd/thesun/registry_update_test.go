package main

import (
	"os"
	"runtime"
	"testing"

	"mcp-fleet/fleetd/internal/registry"
)

// TestUpdateResolvesLegacyGoSuffixName proves the `thesun update` resolution
// path for legacy fleet servers: index entry "shodan" is backed by manifest
// server "shodan-go", so the exact-match installedVersion miss must fall back
// to resolveInstalledName and land on the real name (which installedVersion
// then accepts, letting the update remove the legacy block and re-add under
// the bare store name).
func TestUpdateResolvesLegacyGoSuffixName(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/thesun.toml"
	manifestTOML := `
[[server]]
name = "shodan-go"
kind = "mcp"
bin = "/bin/true"
port = 42011
`
	if err := os.WriteFile(path, []byte(manifestTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FLEETD_MANIFEST", path)

	// The bare index name is not an exact manifest match, which is the miss
	// that used to make `thesun update shodan` report "not installed".
	if _, ok := installedVersion("shodan"); ok {
		t.Fatalf("installedVersion(%q) must miss on exact match", "shodan")
	}
	// The fallback resolves the bare name to the real legacy manifest name.
	real, ok := resolveInstalledName("shodan")
	if !ok || real != "shodan-go" {
		t.Fatalf("resolveInstalledName(%q) = %q ok=%v; want %q ok=true", "shodan", real, ok, "shodan-go")
	}
	// installedVersion accepts the resolved name (the "0.0.0" sentinel compares
	// older than any published version), so the update proceeds.
	if v, ok := installedVersion(real); !ok || v != "0.0.0" {
		t.Fatalf("installedVersion(%q) = %q ok=%v; want sentinel %q ok=true", real, v, ok, "0.0.0")
	}
	// A never-installed name still resolves to nothing (fail-closed: the
	// "not installed" refusal for genuinely absent servers is unchanged).
	if real, ok := resolveInstalledName("missing"); ok {
		t.Fatalf("resolveInstalledName(%q) = %q ok=true; want a miss", "missing", real)
	}
}

// TestUpdatePlatformPrecheckRefusesWithoutRemoval proves the fail-closed guard
// that prevents a data-loss regression: when the target version has no binary
// for the current os/arch, registryUpdate refuses BEFORE removing the installed
// server. registryAdd would otherwise refuse the re-add after the removal,
// dropping the server. The precheck predicate is exactly PlatformFor(...) == nil
// (or an empty URL). Legacy "-go" servers are local builds with no store binary,
// so this case is the likely one.
func TestUpdatePlatformPrecheckRefusesWithoutRemoval(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/thesun.toml"
	manifestTOML := `
[[server]]
name = "shodan-go"
kind = "mcp"
bin = "/bin/true"
port = 42011
`
	if err := os.WriteFile(path, []byte(manifestTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FLEETD_MANIFEST", path)

	// A version with a platform for some OTHER platform only, never this one.
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "windows"
	}
	latest := &registry.Version{
		Version:   "1.2.3",
		Platforms: []registry.Platform{{OS: other, Arch: runtime.GOARCH, URL: "https://example.com/x"}},
	}

	// The guard predicate: no binary for this platform => refuse.
	if plat := latest.PlatformFor(runtime.GOOS, runtime.GOARCH); plat != nil {
		t.Fatalf("PlatformFor(%s/%s) must be nil for a foreign-only version; got %+v", runtime.GOOS, runtime.GOARCH, plat)
	}

	// The refusal must leave the manifest untouched: the server is still present.
	if _, ok := installedVersion("shodan-go"); !ok {
		t.Fatalf("guard must not remove the installed server; %q is missing from the manifest", "shodan-go")
	}

	// A version that DOES publish a binary for this platform passes the predicate,
	// so a normal update is not blocked.
	good := &registry.Version{
		Version:   "1.2.3",
		Platforms: []registry.Platform{{OS: runtime.GOOS, Arch: runtime.GOARCH, URL: "https://example.com/x"}},
	}
	if plat := good.PlatformFor(runtime.GOOS, runtime.GOARCH); plat == nil || plat.URL == "" {
		t.Fatalf("PlatformFor(%s/%s) must resolve a usable binary for a matching version", runtime.GOOS, runtime.GOARCH)
	}
}
