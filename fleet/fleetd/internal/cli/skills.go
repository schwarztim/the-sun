package cli

// skills.go implements `thesun skills install` and `thesun skills status` — the
// distributor for thesun's MCP-generation Agent Skill. All four supported coding
// agents (Claude Code, OpenAI Codex CLI, GitHub Copilot CLI, OpenCode) read the
// SAME "Agent Skills" standard: a directory <skills-root>/<name>/SKILL.md with
// YAML frontmatter. So there is ONE canonical packaged file
// (packaging/skills/thesun/SKILL.md) that is copied VERBATIM into each detected
// client's skills root — no per-client transform.
//
// It mirrors hooks.go's discipline exactly: per-client detected()/install()/
// status(), a --client all|claude|copilot|codex|opencode filter, an idempotent
// byte-compare write (write only when the bytes differ), a one-time `.bak` when a
// FOREIGN file already occupies the path, a skip+hint for undetected clients, and
// a SkillsDoctorCheck analog. It reuses wire.go's helpers (writeFileAtomic,
// fileExists, dirExists) — same package — so the write/detection discipline is
// identical to hooks and client MCP wiring.
//
// A single client's failure never aborts the others: each is attempted
// independently and its outcome collected into the returned table.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/paths"
)

// skillName is the skill's directory + frontmatter name. It is lowercase and
// hyphen-free so it satisfies every client's naming rule (including Copilot's
// lowercase-hyphen constraint). The same name is used for every client.
const skillName = "thesun"

// skillSubpath is the packaged skill file relative to the bundle root — the
// analog of hooks.go's hookScriptSubpath.
var skillSubpath = filepath.Join("packaging", "skills", skillName, "SKILL.md")

// bundleSkillFile resolves the absolute path to the packaged SKILL.md, using the
// SAME bundle-root logic hooks.go uses for packaging/hooks (paths.BundleRoot of
// this binary's path, honoring THESUN_BUNDLE).
func bundleSkillFile() string {
	exe, _ := os.Executable()
	return filepath.Join(paths.BundleRoot(exe), skillSubpath)
}

// skillClientResult reports one client's install/status outcome (JSON-friendly),
// mirroring hookClientResult.
type skillClientResult struct {
	Client string `json:"client"`
	Path   string `json:"path"`
	Status string `json:"status"` // install: wired|already-wired|not-detected|error ; status: installed|drift|not-installed|not-detected|error
	Detail string `json:"detail"`
}

// ─── client target definitions ──────────────────────────────────────────────

type skillTarget struct {
	client   string
	path     string // the <skills-root>/thesun/SKILL.md destination
	detected func() bool
	install  func(src string) (bool, error)
	status   func(src string) (string, string)
}

// skillTargets builds the per-client target list for the given home. home is a
// parameter (not os.UserHomeDir) so tests point it at a temp dir. Every path is
// built with filepath.Join so Windows (%USERPROFILE% under the same ~/.claude
// etc.) resolves correctly.
func skillTargets(home string) []skillTarget {
	claudeDir := filepath.Join(home, ".claude")
	claudeGlobal := filepath.Join(home, ".claude.json")
	claudeSkill := filepath.Join(claudeDir, "skills", skillName, "SKILL.md")

	// Codex CLI reads Agent Skills from ~/.agents/skills; it is detected by the
	// presence of its own ~/.codex config dir.
	codexDir := filepath.Join(home, ".codex")
	codexSkill := filepath.Join(home, ".agents", "skills", skillName, "SKILL.md")

	copilotDir := filepath.Join(home, ".copilot")
	copilotSkill := filepath.Join(copilotDir, "skills", skillName, "SKILL.md")

	opencodeDir := filepath.Join(home, ".config", "opencode")
	opencodeSkill := filepath.Join(opencodeDir, "skills", skillName, "SKILL.md")

	return []skillTarget{
		{
			client:   "Claude Code",
			path:     claudeSkill,
			detected: func() bool { return dirExists(claudeDir) || fileExists(claudeGlobal) },
			install:  func(src string) (bool, error) { return copySkillFile(src, claudeSkill) },
			status:   func(src string) (string, string) { return skillFileStatus(claudeSkill, src) },
		},
		{
			client:   "OpenAI Codex CLI",
			path:     codexSkill,
			detected: func() bool { return dirExists(codexDir) },
			install:  func(src string) (bool, error) { return copySkillFile(src, codexSkill) },
			status:   func(src string) (string, string) { return skillFileStatus(codexSkill, src) },
		},
		{
			client:   "GitHub Copilot CLI",
			path:     copilotSkill,
			detected: func() bool { return dirExists(copilotDir) },
			install:  func(src string) (bool, error) { return copySkillFile(src, copilotSkill) },
			status:   func(src string) (string, string) { return skillFileStatus(copilotSkill, src) },
		},
		{
			client:   "OpenCode",
			path:     opencodeSkill,
			detected: func() bool { return dirExists(opencodeDir) },
			install:  func(src string) (bool, error) { return copySkillFile(src, opencodeSkill) },
			status:   func(src string) (string, string) { return skillFileStatus(opencodeSkill, src) },
		},
	}
}

// copySkillFile copies the packaged SKILL.md to dst verbatim. It is idempotent
// (a byte-identical dst is left untouched, changed=false) and takes a one-time
// `.bak` when a FOREIGN file (different bytes) already occupies the path, so an
// operator's hand-placed skill is recoverable. Mirrors hooks.go's
// writeJSONDocIfChanged / installOpencodePlugin discipline.
func copySkillFile(src, dst string) (bool, error) {
	data, err := os.ReadFile(src)
	if err != nil {
		return false, fmt.Errorf("read packaged skill %s: %w", src, err)
	}
	if cur, err := os.ReadFile(dst); err == nil {
		if reflect.DeepEqual(cur, data) {
			return false, nil // already current — no write, no churn
		}
		// A different file occupies the path — back it up once before overwrite.
		bak := dst + ".bak"
		if !fileExists(bak) {
			_ = writeFileAtomic(bak, cur, 0o644)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false, fmt.Errorf("create skills dir for %s: %w", dst, err)
	}
	return true, writeFileAtomic(dst, data, 0o644)
}

// skillFileStatus reports installed|drift|not-installed for one client's skill
// file against the packaged source.
func skillFileStatus(dst, src string) (string, string) {
	if !fileExists(dst) {
		return "not-installed", "no skill at " + dst
	}
	cur, err := os.ReadFile(dst)
	if err != nil {
		return "error", err.Error()
	}
	data, err := os.ReadFile(src)
	if err != nil {
		// Can't compare — report installed but unverifiable.
		return "installed", "present (" + dst + "); packaged source unreadable for drift check"
	}
	if reflect.DeepEqual(cur, data) {
		return "installed", "current (" + dst + ")"
	}
	return "drift", "installed skill differs from packaged version — re-run `thesun skills install`"
}

// ─── CLI front-end ────────────────────────────────────────────────────────────

// Skills dispatches `thesun skills <install|status>`.
func Skills(args []string) int {
	if len(args) == 0 {
		return skillsUsage()
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "install":
		return skillsInstall(rest)
	case "status":
		return skillsStatus(rest)
	case "-h", "--help", "help":
		return skillsUsage()
	default:
		fmt.Fprintf(os.Stderr, "thesun skills: unknown subcommand %q\n\n", sub)
		return skillsUsage()
	}
}

func skillsUsage() int {
	fmt.Fprint(os.Stderr, `thesun skills — distribute the MCP-generation Agent Skill into your coding agents

  install [--client all|claude|copilot|codex|opencode]
                     copy the packaged thesun skill (packaging/skills/thesun/
                     SKILL.md) into each detected client's skills root
                     (idempotent; a .bak is taken before overwriting a foreign
                     file at the path)
  status  [--json]   per-client installed / drift / not-installed report

All four clients read the same Agent Skills standard (<skills-root>/thesun/
SKILL.md with YAML frontmatter); the file is copied verbatim, no per-client
transform.
`)
	return 2
}

// skillClientKeyToName maps a --client value to the matching skillTarget.client.
var skillClientKeyToName = map[string]string{
	"claude":   "Claude Code",
	"copilot":  "GitHub Copilot CLI",
	"codex":    "OpenAI Codex CLI",
	"opencode": "OpenCode",
}

func resolveSkillTargets(clientFlag string) ([]skillTarget, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home dir: %w", err)
	}
	all := skillTargets(home)
	if clientFlag == "" || clientFlag == "all" {
		return all, nil
	}
	name, ok := skillClientKeyToName[clientFlag]
	if !ok {
		return nil, fmt.Errorf("unknown client %q (want: all|claude|copilot|codex|opencode)", clientFlag)
	}
	for _, t := range all {
		if t.client == name {
			return []skillTarget{t}, nil
		}
	}
	return nil, fmt.Errorf("no target for client %q", clientFlag)
}

func skillsInstall(args []string) int {
	fs := flag.NewFlagSet("skills install", flag.ExitOnError)
	client := fs.String("client", "all", "which client(s): all|claude|copilot|codex|opencode")
	asJSON := fs.Bool("json", false, "emit results as JSON")
	_ = fs.Parse(args)

	targets, err := resolveSkillTargets(*client)
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun skills install:", err)
		return 2
	}

	src := bundleSkillFile()
	if !fileExists(src) {
		fmt.Fprintf(os.Stderr, "thesun skills install: packaged skill not found at %s\n", src)
		return 2
	}

	results := make([]skillClientResult, 0, len(targets))
	anyErr := false
	for _, t := range targets {
		r := skillClientResult{Client: t.client, Path: t.path}
		if !t.detected() {
			r.Status = "not-detected"
			r.Detail = "client not installed on this machine"
			results = append(results, r)
			continue
		}
		// A single client's failure must not abort the others: collect + report.
		changed, err := t.install(src)
		if err != nil {
			r.Status = "error"
			r.Detail = err.Error()
			anyErr = true
		} else if changed {
			r.Status = "wired"
			r.Detail = "skill installed/updated"
		} else {
			r.Status = "already-wired"
			r.Detail = "skill already current"
		}
		results = append(results, r)
	}

	renderSkillResults("install", results, *asJSON)
	if anyErr {
		return 1
	}
	return 0
}

func skillsStatus(args []string) int {
	fs := flag.NewFlagSet("skills status", flag.ExitOnError)
	client := fs.String("client", "all", "which client(s): all|claude|copilot|codex|opencode")
	asJSON := fs.Bool("json", false, "emit results as JSON")
	_ = fs.Parse(args)

	targets, err := resolveSkillTargets(*client)
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun skills status:", err)
		return 2
	}

	src := bundleSkillFile()
	results := make([]skillClientResult, 0, len(targets))
	for _, t := range targets {
		r := skillClientResult{Client: t.client, Path: t.path}
		if !t.detected() {
			r.Status = "not-detected"
			r.Detail = "client not installed"
			results = append(results, r)
			continue
		}
		status, detail := t.status(src)
		r.Status = status
		r.Detail = detail
		results = append(results, r)
	}
	renderSkillResults("status", results, *asJSON)
	return 0
}

func renderSkillResults(action string, results []skillClientResult, asJSON bool) {
	if asJSON {
		b, _ := json.MarshalIndent(results, "", "  ")
		fmt.Println(string(b))
		return
	}
	fmt.Printf("thesun skills %s:\n", action)
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, r := range results {
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", r.Client, r.Status, r.Detail)
	}
	_ = tw.Flush()
}

// SkillsDoctorCheck runs a read-only skills summary for `thesun doctor`. Skills
// are opt-in distribution, so "not installed" is PASS; only a detected drift is
// worth a WARN. This mirrors HooksDoctorCheck's informational shape.
func SkillsDoctorCheck(add func(name, status, detail string)) {
	home, err := os.UserHomeDir()
	if err != nil {
		add("client skills", statusWarn, "cannot resolve home dir: "+err.Error())
		return
	}
	src := bundleSkillFile()
	targets := skillTargets(home)
	installed, detected, drift := 0, 0, 0
	var driftClients []string
	for _, t := range targets {
		if !t.detected() {
			continue
		}
		detected++
		st, _ := t.status(src)
		switch st {
		case "installed":
			installed++
		case "drift":
			drift++
			driftClients = append(driftClients, t.client)
		}
	}
	if drift > 0 {
		add("client skills", statusWarn,
			fmt.Sprintf("%d/%d detected clients have the thesun skill; DRIFT on: %s — run `thesun skills install`",
				installed, detected, strings.Join(driftClients, ", ")))
		return
	}
	add("client skills", statusPass,
		fmt.Sprintf("%d/%d detected clients have the thesun skill (`thesun skills install` to add)", installed, detected))
}
