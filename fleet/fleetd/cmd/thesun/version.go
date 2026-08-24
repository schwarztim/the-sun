package main

import "fmt"

// version is the thesun CLI's own semver, stamped at release build time via
// `.goreleaser.yml`'s `ldflags: -X main.version={{.Version}}`. A dev checkout
// (`go build ./cmd/thesun`) gets "dev" — `thesun upgrade`/`thesun upgrade
// --check` treat "dev" as always-outdated relative to any tagged release, so
// the command is still exercisable from a source checkout.
var version = "dev"

func versionCmd(_ []string) int {
	fmt.Println("thesun " + version)
	return 0
}
