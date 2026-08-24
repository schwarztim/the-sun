// Command stub is a throwaway MCP-server stand-in used only by fleetd's proofs.
// It serves /healthz -> 200 on $MCP_PORT (or -port) and otherwise sleeps.
//
// Modes (env FLEETD_STUB_MODE):
//
//	""      normal: serve /healthz 200 forever
//	"crash" exit(1) immediately after startup (drives the circuit breaker)
//
// It also exposes /whoami reporting whether a named secret env var is PRESENT
// (never its value) so the "no secrets on disk" proof can confirm injection
// without leaking the secret into a log.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	port := flag.String("port", envOr("MCP_PORT", "42099"), "listen port")
	flag.Parse()

	if os.Getenv("FLEETD_STUB_MODE") == "crash" {
		fmt.Fprintln(os.Stderr, "stub: crash mode — exiting 1")
		os.Exit(1)
	}

	secretVar := envOr("FLEETD_STUB_SECRET_VAR", "STUB_SECRET")

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		fmt.Fprintln(w, "ok")
	})
	// Report PRESENCE only — never echo the secret value (would land in the log).
	mux.HandleFunc("/whoami", func(w http.ResponseWriter, _ *http.Request) {
		_, present := os.LookupEnv(secretVar)
		fmt.Fprintf(w, "pid=%d secret_present=%t\n", os.Getpid(), present)
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		fmt.Fprintln(w, `{"jsonrpc":"2.0","result":"stub"}`)
	})

	addr := "127.0.0.1:" + *port
	fmt.Fprintf(os.Stderr, "stub: listening on %s (pid=%d)\n", addr, os.Getpid())
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "stub: server error: %v\n", err)
		os.Exit(1)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
