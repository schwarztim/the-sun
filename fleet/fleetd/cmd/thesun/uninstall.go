package main

// uninstall.go implements `thesun uninstall` — the reverse of `thesun install`:
// bring the stack down, deregister the OS service, and (with confirmation)
// remove THESUN_HOME (thesun.toml, logs, run state, the Hermes credential
// vault, and every standing grant).
//
// Removing THESUN_HOME is destructive and irreversible — it deletes the
// encrypted vault and all grants — so it NEVER happens without an explicit
// interactive "yes" (or a --yes/--force flag), and the exact paths are printed
// first. --dry-run prints the whole plan and changes nothing. --keep-home tears
// the stack down without touching THESUN_HOME.

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"mcp-fleet/fleetd/internal/paths"
	"mcp-fleet/fleetd/internal/svc"
)

func uninstallCmd(args []string) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
		uninstallUsage()
		return 0
	}

	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	yes := fs.Bool("yes", false, "skip the confirmation prompt before removing THESUN_HOME")
	force := fs.Bool("force", false, "alias for --yes")
	dryRun := fs.Bool("dry-run", false, "print exactly what would be done; change nothing")
	keepHome := fs.Bool("keep-home", false, "tear down the stack + service but keep THESUN_HOME (config/vault/grants)")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintf(os.Stderr, "thesun uninstall: %v\n", err)
		uninstallUsage()
		return 2
	}
	assumeYes := *yes || *force
	home := paths.Home()

	fmt.Println("thesun uninstall — reverse of `thesun install`")
	fmt.Println()

	// 1. bring the stack down (best effort; a down failure must not block teardown).
	if *dryRun {
		fmt.Println("  would stop the stack (thesun down)")
	} else {
		fmt.Println("▶ stopping the stack …")
		stackDown(nil)
	}

	// 2. deregister the OS service if it is registered.
	if svc.Installed() {
		if *dryRun {
			fmt.Println("  would deregister the OS service (thesun service uninstall)")
		} else {
			fmt.Println("▶ deregistering the OS service …")
			if err := svc.Control("uninstall"); err != nil {
				fmt.Fprintf(os.Stderr, "  ! service uninstall failed: %v (continuing)\n", err)
			} else {
				fmt.Println("  ✓ OS service deregistered")
			}
		}
	} else {
		fmt.Println("  – OS service not registered (nothing to deregister)")
	}

	fmt.Println()

	// 3. THESUN_HOME removal (destructive) — unless --keep-home.
	if *keepHome {
		fmt.Printf("kept THESUN_HOME at %s (--keep-home).\n", home)
		printClientHooksNote()
		return 0
	}
	rc := removeHome(home, assumeYes, *dryRun, os.Stdin, os.Stdout)
	printClientHooksNote()
	return rc
}

// removeHome prints exactly what will be deleted, then removes THESUN_HOME
// unless this is a dry run or the operator declines the confirmation. It is
// split out from uninstallCmd (which also stops the stack and deregisters the
// service) so the confirm/dry-run decision is unit-testable without touching
// the OS service manager or the running stack. The confirmation is read from
// `in`; on a non-interactive/closed stdin it reads as an empty line and the
// deletion is CANCELLED (fail-safe: a script that forgot --yes never wipes the
// vault). Returns the process exit code.
func removeHome(home string, assumeYes, dryRun bool, in io.Reader, out io.Writer) int {
	fmt.Fprintln(out, "The following will be PERMANENTLY removed:")
	fmt.Fprintf(out, "  %s\n", home)
	fmt.Fprintf(out, "      %s  (thesun.toml: server manifest)\n", paths.Config())
	fmt.Fprintf(out, "      %s  (per-server logs)\n", paths.LogDir())
	fmt.Fprintf(out, "      %s  (control socket, pid files, published gateway config)\n", paths.RunDir())
	fmt.Fprintf(out, "      %s  (generated MCP server binaries)\n", paths.ServersDir())
	fmt.Fprintf(out, "      %s  (Hermes credential vault + standing grants)\n", paths.VaultDir())
	fmt.Fprintln(out, "This deletes the encrypted credential vault and every stored grant; it cannot be undone.")

	if dryRun {
		fmt.Fprintln(out, "--dry-run: nothing was removed.")
		return 0
	}
	if !exists(home) {
		fmt.Fprintf(out, "%s does not exist; nothing to remove.\n", home)
		return 0
	}
	if !assumeYes {
		fmt.Fprint(out, "Remove THESUN_HOME? Type 'yes' to confirm: ")
		ans := ""
		sc := bufio.NewScanner(in)
		if sc.Scan() {
			ans = strings.TrimSpace(sc.Text())
		}
		if ans != "yes" {
			fmt.Fprintln(out, "cancelled; THESUN_HOME left in place.")
			return 0
		}
	}
	if err := os.RemoveAll(home); err != nil {
		fmt.Fprintf(out, "failed to remove %s: %v\n", home, err)
		return 1
	}
	fmt.Fprintf(out, "removed %s\n", home)
	return 0
}

// printClientHooksNote reminds the operator that client-side policy hooks live
// in each AI client's own config (outside THESUN_HOME) and are not removed by
// uninstall. `thesun hooks` has no uninstall path today, so this is a pointer
// rather than an action.
func printClientHooksNote() {
	fmt.Println()
	fmt.Println("note: client-side policy hooks (if installed) live in each AI client's own config,")
	fmt.Println("      outside THESUN_HOME, and are left in place. Remove them via that client's config.")
}

func uninstallUsage() {
	fmt.Fprint(os.Stderr, `thesun uninstall — reverse of `+"`thesun install`"+`: stop the stack, deregister the
service, and (with confirmation) remove THESUN_HOME.

  thesun uninstall              stop stack, deregister service, then PROMPT before
                                removing THESUN_HOME (config/logs/vault/grants)
  thesun uninstall --yes        same, without the confirmation prompt (also: --force)
  thesun uninstall --dry-run    print exactly what would happen; change nothing
  thesun uninstall --keep-home  stop stack + deregister service, but KEEP THESUN_HOME

Removing THESUN_HOME deletes the encrypted Hermes credential vault and every
standing grant. It is irreversible; the paths are always printed first, and the
prompt requires typing 'yes'. Client-side policy hooks live in each AI client's
own config and are left in place.
`)
}
