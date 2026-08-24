package fleet

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mcp-fleet/fleetd/internal/manifest"
)

// TestSplitStartupOrder proves the ordering half of the parallel-start ->
// reload-cascade fix: system infra (hermes, then gateway) must be scheduled
// before any MCP server, regardless of the servers' alphabetical/manifest
// order. This is what Run() walks in sequence, health-gating each one before
// moving to the next (see startAndAwaitHealthy).
func TestSplitStartupOrder(t *testing.T) {
	m := &manifest.Manifest{Servers: []manifest.Server{
		{Name: "zzz-mcp", Kind: manifest.KindMCP, Bin: "/bin/true", Port: 42200, Health: "/healthz", MaxRestarts: 5},
		{Name: "aaa-mcp", Kind: manifest.KindMCP, Bin: "/bin/true", Port: 42201, Health: "/healthz", MaxRestarts: 5},
		// Deliberately out of hermes-first order and alphabetically reversed
		// ("gateway" < "hermes") to prove the split does NOT rely on sort order.
		{Name: "gateway", Kind: manifest.KindSystem, Bin: "/bin/true", Port: 3100, Health: "/healthz", MaxRestarts: 5},
		{Name: "hermes", Kind: manifest.KindSystem, Bin: "/bin/true", Port: 9876, Health: "/healthz", MaxRestarts: 5},
	}}
	sup := New(m, log.New(io.Discard, "", 0))

	// Run() sorts names alphabetically before splitting; reproduce that input.
	names := []string{"aaa-mcp", "gateway", "hermes", "zzz-mcp"}
	sys, mcp := sup.splitStartupOrder(names)

	if len(sys) != 2 || sys[0] != "hermes" || sys[1] != "gateway" {
		t.Fatalf("system startup order = %v, want [hermes gateway] (hermes before gateway, both before any mcp server)", sys)
	}
	if len(mcp) != 2 || mcp[0] != "aaa-mcp" || mcp[1] != "zzz-mcp" {
		t.Fatalf("mcp startup order = %v, want [aaa-mcp zzz-mcp]", mcp)
	}
}

// TestPublishConfigDebounce proves the coalescing half of the fix: a burst of
// rapid publishConfig() triggers — exactly what happens when N servers all
// turn healthy within the same startup window and each calls publishConfig()
// on its own — must collapse into a small, bounded number of actual publishes
// (immediate + one trailing catch-up), never one publish per trigger.
func TestPublishConfigDebounce(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FLEETD_ROOT", dir)
	t.Setenv("FLEETD_PUBLISH_PATH", filepath.Join(dir, "pub.json"))
	t.Setenv("FLEETD_SKIP_RELOAD", "1") // never disturb a real gateway from a test

	m := &manifest.Manifest{Servers: []manifest.Server{
		{Name: "s1", Bin: "/bin/true", Port: 42101, Health: "/healthz", MaxRestarts: 5},
	}}
	sup := New(m, log.New(os.Stderr, "", 0))

	const bursts = 25
	var wg sync.WaitGroup
	for i := 0; i < bursts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sup.publishConfig()
		}()
	}
	wg.Wait()

	// Give the immediate publish time to land, but stay well under the
	// debounce window — at this point exactly one write should have happened,
	// never one per trigger.
	time.Sleep(300 * time.Millisecond)
	if got := atomic.LoadInt64(&sup.publishCount); got == 0 || got >= bursts {
		t.Fatalf("publishCount = %d after %d rapid triggers within one debounce window; want >=1 and < %d (coalesced, not one-per-trigger)",
			got, bursts, bursts)
	}

	// Cross the debounce window to let the trailing catch-up fire, then
	// confirm the count has settled (no further growth) — proving the burst
	// drained to a bounded total instead of continuing to grow.
	time.Sleep(publishDebounce + 500*time.Millisecond)
	settled := atomic.LoadInt64(&sup.publishCount)
	if settled < 1 || settled > 3 {
		t.Fatalf("settled publishCount = %d after %d rapid triggers; want a small bounded number (<=3), not %d", settled, bursts, bursts)
	}
	time.Sleep(300 * time.Millisecond)
	if got := atomic.LoadInt64(&sup.publishCount); got != settled {
		t.Fatalf("publishCount grew from %d to %d after settling — debounce did not converge", settled, got)
	}
	t.Logf("bursts=%d actual publishes=%d (coalesced)", bursts, settled)
}
