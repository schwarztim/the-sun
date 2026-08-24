package camouflage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"mcp-fleet/fleetd/internal/paths"
)

// FileName is the camouflage profile's filename under its directory
// (normally THESUN_HOME — see DefaultDir).
const FileName = "camouflage.json"

// DefaultDir resolves the directory WriteConfig/LoadConfig/Verify should use
// when the caller has no more specific location in mind: THESUN_HOME,
// resolved exactly the way every other fleetd runtime path is (see
// internal/paths — same env override, same per-OS default).
func DefaultDir() string { return paths.Home() }

// Path returns the full camouflage.json path for a given directory.
func Path(dir string) string { return filepath.Join(dir, FileName) }

// WriteConfig persists p as dir/camouflage.json. The write is atomic
// (tempfile in the same directory + rename) so a concurrent LoadConfig/
// Verify never observes a partial file. dir is created (0o700, matching
// paths.EnsureDirs) if it doesn't already exist.
func WriteConfig(dir string, p Profile) error {
	if dir == "" {
		return fmt.Errorf("camouflage: WriteConfig: dir must not be empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("camouflage: creating %s: %w", dir, err)
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("camouflage: marshaling profile: %w", err)
	}
	final := Path(dir)
	tmp, err := os.CreateTemp(dir, ".camouflage.json.tmp-*")
	if err != nil {
		return fmt.Errorf("camouflage: creating temp file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("camouflage: writing temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("camouflage: closing temp file: %w", err)
	}
	if err := os.Rename(tmpName, final); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("camouflage: renaming into place: %w", err)
	}
	return nil
}

// LoadConfig reads and parses dir/camouflage.json.
func LoadConfig(dir string) (Profile, error) {
	var p Profile
	data, err := os.ReadFile(Path(dir))
	if err != nil {
		return p, fmt.Errorf("camouflage: reading %s: %w", Path(dir), err)
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, fmt.Errorf("camouflage: parsing %s: %w", Path(dir), err)
	}
	return p, nil
}
