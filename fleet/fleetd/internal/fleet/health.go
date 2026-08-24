package fleet

import (
	"errors"
	"math/rand"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// probeVerdict distinguishes the two very different ways a health probe fails.
// Treating them alike is what turned a latency problem into an availability
// problem: a server under load, or in a long GC pause, that answered slower
// than the probe timeout three times in about six seconds was killed and
// restarted even though it was alive and serving.
type probeVerdict int

const (
	probeHealthy   probeVerdict = iota // reachable and 200
	probeRefused                       // nothing is listening: definitive death
	probeUnhealthy                     // connected but slow, hung, or non-200: maybe just busy
)

// Monitor tuning. monitorInterval is the nominal gap between health checks;
// the real gap is jittered so a fleet of servers does not synchronize its
// probes (and so a periodic workload inside a server cannot stay in lockstep
// with the prober). The two budgets say how many CONSECUTIVE failures of each
// kind justify killing a process that is still alive: a refused connection is
// definitive, so react quickly, while a slow or hung answer gets a much wider
// window before fleetd concludes the process is wedged rather than busy.
const (
	monitorInterval       = 2 * time.Second
	refusedStrikeBudget   = 3 // about 6s of nothing listening
	unhealthyStrikeBudget = 8 // about 16s of slow/hung/non-200 before a kill
	probeDialTimeout      = 1500 * time.Millisecond
	probeHTTPTimeout      = 3 * time.Second
)

// probeHealth returns true when the port is BOTH reachable (TCP connect) AND
// GET http://127.0.0.1:<port><path> returns HTTP 200. Both conditions are
// required — a bound socket that 500s or hangs is not healthy.
func probeHealth(port int, path string) bool {
	return probeHealthVerdict(port, path) == probeHealthy
}

// probeHealthVerdict is probeHealth with the failure reason preserved, so
// callers can tell "nothing is listening" from "answered too slowly".
func probeHealthVerdict(port int, path string) probeVerdict {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, probeDialTimeout)
	if err != nil {
		// A refused connection means the socket is genuinely gone. Any other
		// dial failure (timeout, transient resource exhaustion) is ambiguous and
		// must not be treated as proof of death.
		if errors.Is(err, syscall.ECONNREFUSED) {
			return probeRefused
		}
		return probeUnhealthy
	}
	conn.Close()

	client := &http.Client{Timeout: probeHTTPTimeout}
	url := "http://" + addr + path
	resp, err := client.Get(url)
	if err != nil {
		return probeUnhealthy // hung or timed out after connecting: alive but not answering
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return probeHealthy
	}
	return probeUnhealthy
}

// strikeBudget returns how many consecutive failures of this kind justify
// killing a process that is otherwise alive.
func strikeBudget(v probeVerdict) int {
	if v == probeRefused {
		return refusedStrikeBudget
	}
	return unhealthyStrikeBudget
}

// jittered spreads a nominal interval by up to +/-25% so probes across the
// fleet do not synchronize into bursts.
func jittered(d time.Duration) time.Duration {
	spread := int64(d) / 2 // full width of the jitter window (25% either side)
	if spread <= 0 {
		return d
	}
	return time.Duration(int64(d) - spread/2 + rand.Int63n(spread))
}

// portListening reports whether anything is accepting TCP on the loopback port.
// Used to refuse a spawn that would collide (EADDRINUSE) with a live process.
func portListening(port int) bool {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, 750*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// PortListening reports whether anything is accepting TCP on 127.0.0.1:<port>.
// Exported for `thesun doctor` so it can reuse the exact reachability check the
// supervisor uses (no duplicated dialer logic).
func PortListening(port int) bool { return portListening(port) }

// ProbeHealth reports whether GET http://127.0.0.1:<port><path> returns 200 AND
// the port is reachable — the same authoritative signal the supervisor uses.
func ProbeHealth(port int, path string) bool { return probeHealth(port, path) }

// pidAlive is provided per-OS in proc_unix.go / proc_windows.go.

func writePidFile(name string, pid int) error {
	if err := os.MkdirAll(RunDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(pidFile(name), []byte(strconv.Itoa(pid)+"\n"), 0o600)
}

func readPidFile(name string) int {
	b, err := os.ReadFile(pidFile(name))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return pid
}

func removePidFile(name string) { _ = os.Remove(pidFile(name)) }

// backoff returns an exponential delay for the Nth consecutive failure (0-based),
// capped so restarts never busy-spin nor stall indefinitely.
func backoff(attempt int) time.Duration {
	const base = 500 * time.Millisecond
	const max = 30 * time.Second
	d := base
	for i := 0; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	return d
}

// verdictName renders a probe verdict for logs.
func verdictName(v probeVerdict) string {
	switch v {
	case probeHealthy:
		return "healthy"
	case probeRefused:
		return "connection refused (nothing listening)"
	default:
		return "unhealthy (slow, hung, or non-200)"
	}
}
