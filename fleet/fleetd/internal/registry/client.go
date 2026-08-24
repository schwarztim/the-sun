package registry

// client.go holds the store-client resolution shared by the CLI (cmd/thesun) and
// the doctor check (internal/cli): where the index lives, whether a URL needs the
// internal Stash bearer, and how the bearer is resolved. Keeping it here (rather
// than in package main) lets the doctor reuse the exact same resolution instead
// of duplicating it, so the two can never drift.

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"

	"mcp-fleet/fleetd/internal/hermes"
	"mcp-fleet/fleetd/internal/paths"
)

// DefaultIndex is the compiled-in index reference used when neither --index nor
// $THESUN_REGISTRY_INDEX nor store.toml sets one. It points at the raw index.toml
// on the public registry repo's main branch.
const DefaultIndex = "https://raw.githubusercontent.com/schwarztim/thesun-registry/main/index.toml"

// StoreConfig is the machine-local store config at THESUN_HOME/store.toml. It
// carries a deployment's registry index URL, Stash host, and Stash cred ref so an
// internal (e.g. Stash-hosted) deployment persists that wiring once instead of
// exporting env vars into every interactive shell. Env vars still win; this file
// is only the fallback. It is machine-local and never committed, so a
// site-specific hostname lives here, not in the toolchain source. It carries no
// secret: the PAT itself is resolved from Hermes via StashCred, never stored here.
type StoreConfig struct {
	Index     string `toml:"index"`
	StashHost string `toml:"stash_host"`
	StashCred string `toml:"stash_cred"`
}

// LoadStoreConfig reads THESUN_HOME/store.toml. A missing or unreadable file
// leaves the zero value, so env vars and compiled defaults still apply. The CLI
// is short-lived and this is called only a handful of times per invocation, so it
// reads on demand rather than caching.
func LoadStoreConfig() StoreConfig {
	var c StoreConfig
	_, _ = toml.DecodeFile(filepath.Join(paths.Home(), "store.toml"), &c)
	return c
}

// IndexRef resolves the index reference: --index flag > env > store.toml >
// compiled default.
func IndexRef(flagVal string) string {
	if strings.TrimSpace(flagVal) != "" {
		return flagVal
	}
	if v := os.Getenv("THESUN_REGISTRY_INDEX"); v != "" {
		return v
	}
	if v := strings.TrimSpace(LoadStoreConfig().Index); v != "" {
		return v
	}
	return DefaultIndex
}

// StashHost is the internal Bitbucket host that requires a bearer PAT: env >
// store.toml. It has no compiled-in default (the toolchain carries no
// site-specific hostname). Empty means the authenticated-pull path is inactive
// and every URL is treated as public.
func StashHost() string {
	if h := strings.TrimSpace(os.Getenv("THESUN_STASH_HOST")); h != "" {
		return h
	}
	return strings.TrimSpace(LoadStoreConfig().StashHost)
}

// StashCredRef is the Hermes reference that resolves to the Stash PAT: env >
// store.toml > compiled default.
func StashCredRef() string {
	if r := strings.TrimSpace(os.Getenv("THESUN_STASH_CRED")); r != "" {
		return r
	}
	if r := strings.TrimSpace(LoadStoreConfig().StashCred); r != "" {
		return r
	}
	return "hermescred://stash/pat"
}

// StashAuthApplies reports whether rawURL should carry the Stash bearer: it must
// be https and its host must exactly match the configured Stash host. Any other
// host (public GitHub, a local file) gets no token, so the public path is
// unchanged and a token never leaks to an unexpected host over plaintext.
func StashAuthApplies(rawURL, host string) bool {
	if host == "" {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Scheme, "https") && strings.EqualFold(u.Hostname(), host)
}

// BearerForURL resolves the Stash PAT for rawURL from Hermes when the URL is an
// authenticated-Stash URL, else returns "" with no error. A resolution failure
// returns ("", err) so the caller can decide whether to warn or fail; the CLI
// warns and proceeds unauthenticated, the doctor names it.
func BearerForURL(ctx context.Context, rawURL string) (string, error) {
	if !StashAuthApplies(rawURL, StashHost()) {
		return "", nil
	}
	tok, err := hermes.NewResolver().Resolve(ctx, StashCredRef())
	if err != nil {
		return "", fmt.Errorf("resolve Stash credential %s from Hermes: %w", StashCredRef(), err)
	}
	return tok, nil
}
