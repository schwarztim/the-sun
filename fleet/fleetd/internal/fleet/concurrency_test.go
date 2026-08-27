package fleet

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"mcp-fleet/fleetd/internal/manifest"
)

// TestConcurrentControlNoRace drives the control plane (start/stop/restart/
// reload/status) concurrently against live supervise goroutines. Run with
// `go test -race` to catch data races on the per-server lifecycle channels and
// spec fields. It self-builds a tiny HTTP stub child so it needs no external
// fixtures.
func TestConcurrentControlNoRace(t *testing.T) {
	// Short root: the unix control socket path must fit macOS's 104-char
	// sun_path limit, so t.TempDir() (deep under /var/folders) is unusable here.
	// Windows has no such limit (its control channel is TCP loopback), and a
	// drive-relative "\tmp" there is both needless and shared between runs, so
	// use the normal per-test dir on that platform.
	dir := filepath.Join("/tmp", "fleetd-race-test")
	if runtime.GOOS == "windows" {
		dir = t.TempDir()
	}
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	stub := buildStub(t, dir)

	// Isolated runtime + never touch the gateway.
	t.Setenv("FLEETD_ROOT", filepath.Join(dir, "state"))
	t.Setenv("FLEETD_PUBLISH_PATH", filepath.Join(dir, "state", "pub.json"))
	t.Setenv("FLEETD_SKIP_RELOAD", "1")

	manPath := filepath.Join(dir, "state", "fleet.toml")
	if err := os.MkdirAll(filepath.Dir(manPath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, manPath, stub, map[string]int{"s1": 42093, "s2": 42094})

	m, err := manifest.Load(manPath)
	if err != nil {
		t.Fatalf("load manifest: %v", err)
	}
	logw := io.Discard
	if testing.Verbose() {
		logw = os.Stderr
	}
	sup := New(m, log.New(logw, "", log.LstdFlags))

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	runDone := make(chan struct{})
	go func() { runErr <- sup.Run(ctx); close(runDone) }()

	// Wait until at least one server is healthy so supervise goroutines are live.
	if !waitCond(8*time.Second, func() bool { return probeHealth(42093, "/healthz") }) {
		select {
		case err := <-runErr:
			t.Fatalf("s1 never became healthy; Run returned early: %v", err)
		default:
			t.Fatal("s1 never became healthy")
		}
	}

	// Concurrent control storm. dispatch is the same entry point the unix socket
	// uses; calling it directly exercises the real code path in-process.
	ops := []Request{
		{Cmd: "status"},
		{Cmd: "reload"},
		{Cmd: "stop", Server: "s1"},
		{Cmd: "start", Server: "s1"},
		{Cmd: "restart", Server: "s2"},
		{Cmd: "status"},
	}
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < len(ops); i++ {
				_ = sup.dispatch(ops[(seed+i)%len(ops)])
			}
		}(g)
	}
	wg.Wait()

	// Bring everything back up, then shut down cleanly.
	sup.dispatch(Request{Cmd: "start", Server: "s1"})
	sup.dispatch(Request{Cmd: "start", Server: "s2"})
	cancel()
	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	// Detached children survive Run() by design; kill them so the test leaves no
	// orphans on the fixed ports.
	killPort(42093)
	killPort(42094)
}

func buildStub(t *testing.T, dir string) string {
	t.Helper()
	// Windows will not start a file without an executable extension, so a stub
	// built as bare "stub" spawned fine on POSIX and never came up on Windows,
	// surfacing only as "s1 never became healthy".
	name := "stub"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(dir, name)
	// The module root is two levels up from internal/fleet.
	cmd := exec.Command("go", "build", "-o", out, "mcp-fleet/fleetd/cmd/stub")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build stub: %v", err)
	}
	return out
}

// tomlBasicStr escapes s for a TOML basic (double-quoted) string. The bin path
// below is absolute, so on Windows it carries backslashes, and TOML reads those
// as escapes: a raw path made the manifest unparseable ("invalid escape in
// string '\s'") long before anything about concurrency was exercised.
func tomlBasicStr(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

func writeManifest(t *testing.T, path, bin string, servers map[string]int) {
	t.Helper()
	var b []byte
	for name, port := range servers {
		b = append(b, []byte(
			"[[server]]\nname = \""+name+"\"\nbin = \""+tomlBasicStr(bin)+"\"\nport = "+itoa(port)+"\nmax_restarts = 5\n\n")...)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func waitCond(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cond()
}

// killPort terminates whatever LISTENS on port (test cleanup only).
//
// It reuses the supervisor's own helpers rather than shelling out, which fixes
// two separate bugs at once:
//
// Plain `lsof -ti tcp:<port>` also reports every process merely holding a
// CLIENT socket to that port, and this test binary is one of them, since the
// supervisor under test health-checks its children over HTTP on exactly these
// ports. Killing that list SIGKILLed the test process itself, which `go test`
// reports as a bare "signal: killed" with no failing test to point at.
// portOwnerPIDs asks for LISTENING sockets only.
//
// lsof and kill also do not exist on Windows, so the old cleanup was silently a
// no-op there: the detached children survived, kept their log files open, and
// the temp-dir cleanup then failed because Windows cannot unlink an open file.
// portOwnerPIDs and killTree are both build-tagged per platform (lsof/process
// group on unix, netstat/taskkill on Windows).
func killPort(port int) {
	self := os.Getpid()
	grace := time.Now().Add(2 * time.Second)
	for _, pid := range portOwnerPIDs(port) {
		if pid == self {
			continue // belt and braces: never signal the test process
		}
		killTree(pid, grace)
	}
}
