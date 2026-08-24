package cli

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/fleet"
)

func runLogs(args []string) int {
	// Pull the server name (the first bare positional) out so flags may appear
	// on either side of it — `fleetd logs NAME -n 5` and `fleetd logs -n 5 NAME`
	// both work despite stdlib flag stopping at the first non-flag token.
	name, rest := extractName(args)

	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	follow := fs.Bool("f", false, "follow (tail -f) the log as it grows")
	n := fs.Int("n", 50, "print the last N lines")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: fleetd logs <name> [-f] [-n N]")
	}
	_ = fs.Parse(rest)

	if name == "" {
		fs.Usage()
		return 2
	}
	path := fleet.LogFile(name)

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "fleetd: no log for %q (expected %s)\n", name, path)
		} else {
			fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		}
		return 1
	}
	defer f.Close()

	// Print the last N lines.
	lines, err := lastLines(f, *n)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: read log: %v\n", err)
		return 1
	}
	for _, ln := range lines {
		fmt.Println(ln)
	}

	if !*follow {
		return 0
	}

	// Follow: seek to EOF and stream new bytes. Ctrl-C exits.
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: seek: %v\n", err)
		return 1
	}
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			fmt.Print(line)
			continue
		}
		if err == io.EOF {
			time.Sleep(400 * time.Millisecond)
			continue
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "fleetd: follow: %v\n", err)
			return 1
		}
	}
}

// extractName pulls the first bare positional (the server name) out of args so
// flags may sit on either side of it. It is aware that -n / --n consume the
// following token as their value, so `logs -n 5 NAME` doesn't mistake "5" for
// the name. The returned rest holds every remaining token (all flags) for
// flag.Parse.
func extractName(args []string) (name string, rest []string) {
	valueFlags := map[string]bool{"-n": true, "--n": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			rest = append(rest, a)
			if valueFlags[a] && !strings.Contains(a, "=") && i+1 < len(args) {
				i++
				rest = append(rest, args[i])
			}
			continue
		}
		if name == "" {
			name = a
			continue
		}
		rest = append(rest, a)
	}
	return name, rest
}

// lastLines returns the final n lines of r. It reads the whole file (log files
// are size-capped at 50MB by the rotating writer, so this is bounded).
func lastLines(r io.Reader, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	ring := make([]string, 0, n)
	for sc.Scan() {
		if len(ring) == n {
			ring = ring[1:]
		}
		ring = append(ring, sc.Text())
	}
	return ring, sc.Err()
}
