package main

// upgrade_auto.go registers (and removes) the scheduled job that runs
// `thesun upgrade --auto-run` on an interval.
//
// This is deliberately a SEPARATE OS job rather than a ticker inside fleetd. An
// update rebuilds the gateway and restarts the supervisor, so a timer living
// inside the process being restarted would be tearing down its own scheduler
// mid-run. A external job that invokes the CLI has no such problem, and it also
// keeps the supervisor's failure modes independent of the updater's.
//
// The interval jobs are user-scoped on every platform (no root, no sudo), to
// match how `thesun service install` registers the supervisor itself.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/paths"
)

// autoUpdateLabel is the job identifier, distinct from the supervisor's own
// "thesun" label so neither command can disturb the other's registration.
const autoUpdateLabel = "thesun-auto-update"

// defaultAutoUpdateInterval is what `thesun install` schedules. Six hours is a
// compromise: frequent enough that a security fix reaches a machine the same
// working day, infrequent enough that a fleet of them does not hammer the git
// remote or restart the stack under someone mid-task more than a few times a
// day.
const defaultAutoUpdateInterval = 6 * time.Hour

// autoUpdateCmd turns the scheduled updater on or off.
func autoUpdateCmd(mode, every string) int {
	switch strings.ToLower(mode) {
	case "on", "true", "enable":
		d, err := time.ParseDuration(every)
		if err != nil || d < time.Minute {
			fmt.Fprintf(os.Stderr, "thesun upgrade --auto=on: --every must be a duration of at least 1m (got %q)\n", every)
			return 2
		}
		return installAutoUpdate(d)
	case "off", "false", "disable":
		return removeAutoUpdate()
	default:
		fmt.Fprintf(os.Stderr, "thesun upgrade --auto: expected `on` or `off`, got %q\n", mode)
		return 2
	}
}

// installAutoUpdate registers the interval job for this platform.
//
// It refuses on a non-checkout install rather than registering a job that can
// only ever fail: there is no branch to track, and a scheduled task that logs an
// error every six hours forever is worse than no task.
func installAutoUpdate(every time.Duration) int {
	root := bundleRoot()
	if !isGitCheckout(root) {
		fmt.Fprintf(os.Stderr, "thesun upgrade --auto=on: %s is not a git checkout, so there is no branch to track.\n", root)
		fmt.Fprintln(os.Stderr, "Release-based updates use `thesun upgrade` and do not need a schedule.")
		return 1
	}
	up, err := upstreamRef(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade --auto=on: %v\n", err)
		return 1
	}

	// mustExe, not os.Executable: the scheduled job runs unattended for months,
	// so it must record the REAL binary path. A symlink recorded here breaks the
	// job the first time that link is repointed or removed, and the failure shows
	// up only in a log nobody is watching.
	exe := mustExe()
	if exe == "" {
		fmt.Fprintln(os.Stderr, "thesun upgrade --auto=on: cannot resolve this binary")
		return 1
	}

	if err := writeAutoUpdateJob(exe, root, every); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade --auto=on: %v\n", err)
		return 1
	}

	fmt.Printf("automatic updates ON: checking %s every %s.\n", up, every)
	fmt.Printf("   log:  %s\n", autoLogPath())
	fmt.Println("   off:  thesun upgrade --track --auto=off")
	fmt.Println()
	fmt.Println("Each run fast-forwards only, refuses to touch a dirty or diverged checkout,")
	fmt.Println("rebuilds, and restarts only if the build succeeded. A failed build is rolled")
	fmt.Println("back and the running stack is left as it was.")
	return 0
}

func removeAutoUpdate() int {
	if err := removeAutoUpdateJob(); err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade --auto=off: %v\n", err)
		return 1
	}
	fmt.Println("automatic updates OFF.")
	return 0
}

// ---- platform job registration ----

// launchAgentPath is the user-scoped plist location on macOS.
func launchAgentPath() string {
	return filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", autoUpdateLabel+".plist")
}

func systemdUnitDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "systemd", "user")
}

// writeAutoUpdateJob installs the interval job. Each platform gets its native
// mechanism rather than a shared cron-alike, because a user-scoped job that
// survives reboot is spelled differently on each and getting that wrong means
// the updater silently stops running after the first restart.
func writeAutoUpdateJob(exe, root string, every time.Duration) error {
	switch runtime.GOOS {
	case "darwin":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string><string>upgrade</string><string>--track</string><string>--auto-run</string>
  </array>
  <key>WorkingDirectory</key><string>%s</string>
  <key>EnvironmentVariables</key>
  <dict><key>%s</key><string>%s</string><key>%s</key><string>%s</string></dict>
  <key>StartInterval</key><integer>%d</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, autoUpdateLabel, exe, root,
			paths.EnvHome, paths.Home(), paths.EnvBundle, root,
			int(every.Seconds()), autoLogPath(), autoLogPath())

		p := launchAgentPath()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(autoLogPath()), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, []byte(plist), 0o644); err != nil {
			return err
		}
		// bootout first so a changed interval actually takes effect; a plain
		// bootstrap over an already-loaded label is an error, not an update.
		domain := "gui/" + strconv.Itoa(os.Getuid())
		_ = exec.Command("launchctl", "bootout", domain+"/"+autoUpdateLabel).Run()
		if out, err := exec.Command("launchctl", "bootstrap", domain, p).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootstrap failed: %s", strings.TrimSpace(string(out)))
		}
		return nil

	case "linux":
		dir := systemdUnitDir()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		unit := fmt.Sprintf(`[Unit]
Description=thesun automatic branch update

[Service]
Type=oneshot
WorkingDirectory=%s
Environment=%s=%s
Environment=%s=%s
ExecStart=%s upgrade --track --auto-run
`, root, paths.EnvHome, paths.Home(), paths.EnvBundle, root, exe)
		timer := fmt.Sprintf(`[Unit]
Description=thesun automatic branch update timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=%ds
Persistent=true

[Install]
WantedBy=timers.target
`, int(every.Seconds()))
		if err := os.WriteFile(filepath.Join(dir, autoUpdateLabel+".service"), []byte(unit), 0o644); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, autoUpdateLabel+".timer"), []byte(timer), 0o644); err != nil {
			return err
		}
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		if out, err := exec.Command("systemctl", "--user", "enable", "--now", autoUpdateLabel+".timer").CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl enable failed: %s", strings.TrimSpace(string(out)))
		}
		return nil

	case "windows":
		// schtasks takes minutes, and its minimum is 1.
		mins := int(every.Minutes())
		if mins < 1 {
			mins = 1
		}
		args := []string{
			"/Create", "/F", "/TN", autoUpdateLabel,
			"/SC", "MINUTE", "/MO", strconv.Itoa(mins),
			"/TR", fmt.Sprintf(`"%s" upgrade --track --auto-run`, exe),
		}
		if out, err := exec.Command("schtasks", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks /Create failed: %s", strings.TrimSpace(string(out)))
		}
		return nil
	}
	return fmt.Errorf("automatic updates are not supported on %s", runtime.GOOS)
}

func removeAutoUpdateJob() error {
	switch runtime.GOOS {
	case "darwin":
		domain := "gui/" + strconv.Itoa(os.Getuid())
		_ = exec.Command("launchctl", "bootout", domain+"/"+autoUpdateLabel).Run()
		if err := os.Remove(launchAgentPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", autoUpdateLabel+".timer").Run()
		for _, f := range []string{autoUpdateLabel + ".timer", autoUpdateLabel + ".service"} {
			if err := os.Remove(filepath.Join(systemdUnitDir(), f)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		return nil
	case "windows":
		if out, err := exec.Command("schtasks", "/Delete", "/F", "/TN", autoUpdateLabel).CombinedOutput(); err != nil {
			if strings.Contains(string(out), "cannot find") {
				return nil // already absent
			}
			return fmt.Errorf("schtasks /Delete failed: %s", strings.TrimSpace(string(out)))
		}
		return nil
	}
	return fmt.Errorf("automatic updates are not supported on %s", runtime.GOOS)
}

// autoUpdateInstalled reports whether the scheduled job exists, for `doctor`.
func autoUpdateInstalled() bool {
	switch runtime.GOOS {
	case "darwin":
		return exists(launchAgentPath())
	case "linux":
		return exists(filepath.Join(systemdUnitDir(), autoUpdateLabel+".timer"))
	case "windows":
		return exec.Command("schtasks", "/Query", "/TN", autoUpdateLabel).Run() == nil
	}
	return false
}
