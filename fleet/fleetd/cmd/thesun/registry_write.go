package main

// registry_write.go holds the TOML emit/upsert helpers for `thesun publish`
// and the manifest-reload shim shared by add/remove/update. The index structs
// carry the schema's toml tags, so encoding is a straight toml.Encode of the
// registry types (no bespoke serializer).

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"

	"mcp-fleet/fleetd/internal/cli"
	"mcp-fleet/fleetd/internal/registry"
)

// entryDoc wraps a single entry so toml.Encode emits it as a top-level
// [[entry]] table array (matching the index schema).
type entryDoc struct {
	Entries []registry.Entry `toml:"entry"`
}

// encodeEntryTOML renders one entry as the [[entry]] / [[entry.version]] TOML
// block a publisher pastes into (or CI appends to) index.toml.
func encodeEntryTOML(e registry.Entry) (string, error) {
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(entryDoc{Entries: []registry.Entry{e}}); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// upsertLocalIndex appends entry to a local index file, replacing any existing
// entry of the same name. The whole index is re-encoded (it is a generated
// local file for testing/CI, not the hand-commented canonical index), so the
// schema line is preserved and the file stays parseable by FetchIndex.
func upsertLocalIndex(path string, entry registry.Entry) error {
	idx := &registry.Index{Schema: registry.SchemaVersion}
	if raw, err := os.ReadFile(path); err == nil {
		parsed, _, perr := registry.Parse(raw)
		if perr != nil {
			return fmt.Errorf("existing index is unparseable: %w", perr)
		}
		idx = parsed
		if idx.Schema == "" {
			idx.Schema = registry.SchemaVersion
		}
	}

	replaced := false
	for i := range idx.Entries {
		if idx.Entries[i].Name == entry.Name {
			idx.Entries[i] = entry
			replaced = true
			break
		}
	}
	if !replaced {
		idx.Entries = append(idx.Entries, entry)
	}

	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(idx); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".thesun-index-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// reloadFleet asks a running daemon to re-read the manifest after an add/remove/
// update edit. It delegates to the same `reload` path `thesun reload` uses; when
// the daemon is down the file edit still stands and applies on next start.
func reloadFleet() {
	_ = cli.Fleet("reload", nil)
}
