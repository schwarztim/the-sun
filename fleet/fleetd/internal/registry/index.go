// Package registry models the thesun MCP Store index (index.toml, schema
// "thesun-registry/v1") and the trust primitives (Ed25519 sign/verify) that
// gate a `thesun add` pull. It is intentionally free of any CLI or network
// concerns beyond FetchIndex: the structs and lookup helpers here are pure and
// unit-testable, and the CLI layer (cmd/thesun/registry.go) drives them.
//
// The struct shape mirrors ~/Projects/thesun-registry/SCHEMA.md exactly; the
// toml tags are the contract. A schema-version mismatch is a non-fatal warning
// (the CLI surfaces it) rather than a hard error, so a newer index still parses
// on an older client for everything it understands.
package registry

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

// SchemaVersion is the index schema this client was written against.
const SchemaVersion = "thesun-registry/v1"

// nameRe constrains a server (entry) name so it is always a single safe path
// component. This is a security boundary: `thesun add <name>` uses the name as a
// directory under paths.ServersDir(), so a hostile index entry named "../x" or
// "a/b" must never be resolvable (path traversal). The pattern also matches the
// fleet manifest's lowercase server-name convention.
var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ValidName reports whether name is a safe, well-formed server name (a single
// path component in the lowercase convention). Any caller that turns a name into
// a filesystem path MUST gate on this and fail closed when it returns false.
func ValidName(name string) bool { return nameRe.MatchString(name) }

// Index is the whole store catalog (index.toml).
type Index struct {
	Schema  string  `toml:"schema"`
	Entries []Entry `toml:"entry"`
}

// Entry is one server in the catalog (one upstream API wrapped as an MCP server).
type Entry struct {
	Name        string    `toml:"name"`
	Description string    `toml:"description"`
	Category    string    `toml:"category"`
	Tags        []string  `toml:"tags"`
	Tier        string    `toml:"tier"`
	Maintainer  string    `toml:"maintainer"`
	Source      string    `toml:"source"`
	Revoked     bool      `toml:"revoked"`
	Versions    []Version `toml:"version"`
}

// Version is one published (or seeded) release of an entry.
type Version struct {
	Version    string `toml:"version"`
	Status     string `toml:"status"`
	Ed25519Sig string `toml:"ed25519_sig"`
	Camouflage bool   `toml:"camouflage"`
	RateLimit  bool   `toml:"rate_limit"`

	LabReport       LabReport       `toml:"lab_report"`
	GatewayManifest GatewayManifest `toml:"gateway_manifest"`
	Auth            Auth            `toml:"auth"`
	Platforms       []Platform      `toml:"platform"`
}

// LabReport mirrors the Conformance Lab summary (lab-report.json).
type LabReport struct {
	Passed                    bool     `toml:"passed"`
	Gates                     []string `toml:"gates"`
	ToolCount                 int      `toml:"tool_count"`
	Transport                 string   `toml:"transport"`
	ResidualUnverifiedSurface []string `toml:"residual_unverified_surface"`
}

// GatewayManifest is the derived read/write safety summary (from coverage.json).
type GatewayManifest struct {
	ReadCount     int      `toml:"read_count"`
	WriteCount    int      `toml:"write_count"`
	HasWrite      bool     `toml:"has_write"`
	SafetyClasses []string `toml:"safety_classes"`
}

// Auth is the credential contract summary (derived from .env.example).
type Auth struct {
	AuthScheme    string `toml:"auth_scheme"`
	HermesService string `toml:"hermes_service"`
	HermesScheme  string `toml:"hermes_scheme"`
}

// Platform is one OS/arch signed binary (populated at publish time only).
type Platform struct {
	OS     string `toml:"os"`
	Arch   string `toml:"arch"`
	URL    string `toml:"url"`
	SHA256 string `toml:"sha256"`
}

// Parse unmarshals raw index bytes. It returns a fatal error only when the TOML
// itself is unparseable; a schema-version mismatch or a structurally odd entry
// (no versions) is reported as a non-fatal warning so the caller can surface it
// without failing the whole fetch.
func Parse(raw []byte) (*Index, []string, error) {
	var idx Index
	if err := toml.Unmarshal(raw, &idx); err != nil {
		return nil, nil, fmt.Errorf("parse index: %w", err)
	}

	var warnings []string
	if idx.Schema != SchemaVersion {
		warnings = append(warnings, fmt.Sprintf("index schema %q does not match this client's %q (parsing best-effort)", idx.Schema, SchemaVersion))
	}
	for i := range idx.Entries {
		e := &idx.Entries[i]
		if strings.TrimSpace(e.Name) == "" {
			warnings = append(warnings, fmt.Sprintf("entry #%d has no name (skipped by lookups)", i+1))
			continue
		}
		if !ValidName(e.Name) {
			warnings = append(warnings, fmt.Sprintf("entry %q has an unsafe name (rejected; lookups will skip it)", e.Name))
			continue
		}
		if len(e.Versions) == 0 {
			warnings = append(warnings, fmt.Sprintf("entry %q has no versions", e.Name))
		}
	}
	return &idx, warnings, nil
}

// Find returns the entry with the given name (exact match), or nil.
func (ix *Index) Find(name string) *Entry {
	name = strings.TrimSpace(name)
	// Fail closed: never resolve an unsafe query or a hostile stored name into an
	// entry (the caller uses the name as a filesystem path component).
	if !ValidName(name) {
		return nil
	}
	for i := range ix.Entries {
		if ValidName(ix.Entries[i].Name) && ix.Entries[i].Name == name {
			return &ix.Entries[i]
		}
	}
	return nil
}

// Version returns the version matching semver, or the latest when semver is
// empty. Returns nil when no version matches (or the entry has no versions).
func (e *Entry) Version(semver string) *Version {
	semver = strings.TrimSpace(semver)
	if semver == "" {
		return e.Latest()
	}
	want := strings.TrimPrefix(semver, "v")
	for i := range e.Versions {
		if strings.TrimPrefix(e.Versions[i].Version, "v") == want {
			return &e.Versions[i]
		}
	}
	return nil
}

// Latest returns the highest-semver version, or nil when the entry has none.
func (e *Entry) Latest() *Version {
	if len(e.Versions) == 0 {
		return nil
	}
	best := &e.Versions[0]
	for i := 1; i < len(e.Versions); i++ {
		if compareSemver(e.Versions[i].Version, best.Version) > 0 {
			best = &e.Versions[i]
		}
	}
	return best
}

// Curated reports whether the entry is in the conformance-proven tier.
func (e *Entry) Curated() bool { return e.Tier == "curated" }

// compareSemver returns -1 if a<b, 0 if a==b, 1 if a>b. It mirrors the tiny
// comparator in cmd/thesun/upgrade.go; it is duplicated here (rather than
// imported) because that one lives in package main, which an internal package
// cannot import. Non-numeric or missing components parse as 0.
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
			continue
		}
		out[i] = n
	}
	return out
}

// sortedPlatforms returns v's platforms sorted by os then arch (deterministic
// order for signing and display).
func (v *Version) sortedPlatforms() []Platform {
	out := make([]Platform, len(v.Platforms))
	copy(out, v.Platforms)
	sort.Slice(out, func(i, j int) bool {
		if out[i].OS != out[j].OS {
			return out[i].OS < out[j].OS
		}
		return out[i].Arch < out[j].Arch
	})
	return out
}

// PlatformFor returns the platform binary matching goos/goarch, or nil.
func (v *Version) PlatformFor(goos, goarch string) *Platform {
	for i := range v.Platforms {
		if v.Platforms[i].OS == goos && v.Platforms[i].Arch == goarch {
			return &v.Platforms[i]
		}
	}
	return nil
}
