// Package mcptemplate is the reusable transport harness for mcp-fleet servers.
//
// Every server in the fleet serves the Model Context Protocol over
// **streamable-HTTP** on a single TCP port — never stdio, never SSE. stdio
// deadlocks the MCP gateway (a proven fleet outage), so it is forbidden across
// the fleet. This package centralizes the one correct way to stand a server up
// so no individual server can get the transport wrong:
//
//   - mounts the MCP server on mcp.NewStreamableHTTPHandler at POST /mcp,
//     configured Stateless so a supervisor/gateway restart never strands a
//     session (mirrors the gateway's own stateless contract);
//   - adds a GET /healthz liveness endpoint returning 200;
//   - binds MCP_HOST (default 127.0.0.1, loopback only) : MCP_PORT (REQUIRED —
//     there is no safe default port, so Serve errors out if it is unset rather
//     than guessing a port and colliding with a sibling);
//   - shuts the HTTP server down gracefully on SIGTERM / os.Interrupt.
//
// How a thesun-generated server maps onto this harness:
//
//	func main() {
//	    srv := mcp.NewServer(&mcp.Implementation{Name: "<svc>-mcp", Version: version}, nil)
//	    // one mcp.AddTool(...) per generated tool — the typed In struct
//	    // auto-derives the tool's JSON Schema (diffable vs the Python original).
//	    _ = mcptemplate.Serve(context.Background(), srv) // transport handled here
//	}
//
// Auth for a generated server's outbound calls comes from the sibling
// hermesauth package (env-injected credentials); this package is transport only.
package mcptemplate

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// shutdownGrace bounds how long Serve waits for in-flight requests to drain
// after a shutdown signal before giving up.
const shutdownGrace = 10 * time.Second

// EnvOr returns os.Getenv(key), or def when that value is empty.
func EnvOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// TextResult builds a successful tool result carrying a single text block.
func TextResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}
}

// ErrorResult builds a graceful tool error (IsError=true) carrying a text block.
// The message is surfaced to the caller, so it MUST NOT contain secrets — pass a
// sanitized, human-readable description only. Returning this (instead of a Go
// error/panic) keeps every tool call a valid MCP round-trip.
func ErrorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
	}
}

// Serve mounts srv on a stateless streamable-HTTP handler at /mcp, adds
// /healthz, binds MCP_HOST:MCP_PORT on the loopback interface, and blocks until
// ctx is cancelled or a SIGTERM/Interrupt arrives — then drains connections with
// a bounded graceful shutdown.
//
// MCP_PORT is REQUIRED. Serve returns an error (it does not pick a port) when it
// is unset, so a misconfigured unit fails loudly instead of colliding on a
// guessed port.
func Serve(ctx context.Context, srv *mcp.Server) error {
	host := EnvOr("MCP_HOST", "127.0.0.1")
	port := os.Getenv("MCP_PORT")
	if port == "" {
		return errors.New("MCP_PORT is required and has no default; set MCP_PORT in the environment")
	}
	addr := net.JoinHostPort(host, port)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{Stateless: true},
	))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// signal.NotifyContext derives a context that is cancelled on SIGTERM or
	// Interrupt (or when the parent ctx is cancelled).
	sigCtx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer stop()

	// Buffered so the goroutine never blocks if we've already returned.
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("mcptemplate: serving streamable-http on http://%s/mcp (health: /healthz)", addr)
		err := httpSrv.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil // clean shutdown
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		// ListenAndServe returned before any signal — typically a bind failure.
		return err
	case <-sigCtx.Done():
		log.Printf("mcptemplate: shutdown signal received, draining %s", addr)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}
