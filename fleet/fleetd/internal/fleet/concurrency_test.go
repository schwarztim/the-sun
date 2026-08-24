package fleet

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
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
	dir := filepath.Join("/tmp", "fleetd-race-test")
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
	out := filepath.Join(dir, "stub")
	// The module root is two levels up from internal/fleet.
	cmd := exec.Command("go", "build", "-o", out, "mcp-fleet/fleetd/cmd/stub")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build stub: %v", err)
	}
	return out
}

func writeManifest(t *testing.T, path, bin string, servers map[string]int) {
	t.Helper()
	var b []byte
	for name, port := range servers {
		b = append(b, []byte(
			"[[server]]\nname = \""+name+"\"\nbin = \""+bin+"\"\nport = "+itoa(port)+"\nmax_restarts = 5\n\n")...)
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

func killPort(port int) {
	// best-effort: find and SIGKILL whatever holds the port (test cleanup only)
	out, err := exec.Command("lsof", "-ti", "tcp:"+itoa(port)).Output()
	if err != nil {
		return
	}
	for _, pidStr := range splitLines(string(out)) {
		if pidStr == "" {
			continue
		}
		_ = exec.Command("kill", "-9", pidStr).Run()
	}
}

func splitLines(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '\n' || r == '\r' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
