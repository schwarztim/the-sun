// Command skills-mcp serves the operator's Claude Code skills as on-demand
// knowledge over MCP. Its consumer is a chat client (chiefly the Teams bot),
// which is not Claude Code: it has no filesystem, no shell, and no local CLI,
// so a skill is reachable to it only as text plus whatever gateway tools it can
// already call.
//
// Why a tool rather than prompt injection. The consumer's system prompt is
// already ~16.5K characters, and its tool loop runs up to nine model calls per
// turn, so every character added to that prompt is paid up to nine times within
// a single turn. The Dynatrace skill family alone is ~208KB. Always-on
// injection is not affordable; the gateway is already the on-demand loader for
// 500+ tools that cannot fit in context, and skills are the same problem, so
// this reuses that seam. Two READ tools:
//
//	list  ->  the compact catalogue a model reads BEFORE choosing
//	get   ->  the full body of exactly one skill
//
// Exposed through the gateway as skills_list and skills_get (the gateway
// namespaces a tool as <namespace>_<tool>, and this backend's namespace is
// "skills"). The bare tool names here are what make those exposed names read
// correctly; do not rename them without changing the namespace to match.
//
// Transport: streamable-HTTP ONLY, via the shared mcptemplate harness. Never
// stdio, never SSE.
//
// Access control is three gates, all in this package: an explicit never-serve
// list (catalogue.go), a deny-by-default allowlist (catalogue.go), and a
// runtime secret scan on the body immediately before it is returned (scan.go).
//
// What this server deliberately does NOT do is enforce owner-only access. The
// gateway carries no viewer identity, so this process cannot know who is
// asking; every read looks identical to it. Skills whose procedures write to or
// touch infrastructure are published with an owner_only flag so the calling
// dispatch layer, which does know the asker, can gate them. See the note in
// gateway/manifests/skills-go.json.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"mcp-fleet/servers/internal/mcptemplate"
)

const serverName = "skills-mcp"

// version is stamped at build time via -ldflags="-X main.version=...".
var version = "dev"

// skillsRoot is the directory the catalogue's relative paths resolve against.
// Overridable via SKILLS_ROOT so the tests can run against a fixture tree.
var skillsRoot string

// available is the subset of the catalogue whose file was present and clean at
// startup. An entry that failed either check is omitted from the catalogue
// rather than advertised and then refused.
var available = map[string]bool{}

// maxBodyBytes bounds a single skills_get response. The largest served skill is
// ~43KB; this is a guard against a file that grows without anyone noticing, not
// a working limit.
const maxBodyBytes = 256 << 10

// listIn and getIn are the typed argument structs. Exported fields plus their
// jsonschema tags derive each tool's JSON Schema; a field without omitempty is
// required.
type listIn struct {
	// IncludeOwnerOnly adds the skills flagged owner_only to the listing. It
	// defaults to FALSE, which is the fail-closed direction: a caller that
	// forgets to set it shows fewer skills than it could, never more than it
	// should.
	//
	// This server has no viewer identity, so it cannot verify the claim and
	// does not try. The calling dispatch layer, which does know the asker, must
	// SET this value itself and override whatever the model put in the
	// arguments; treating a model-supplied true as authorization would make the
	// flag decorative.
	IncludeOwnerOnly bool `json:"include_owner_only,omitempty" jsonschema:"include the skills flagged owner_only; the calling dispatch layer must set this from the asker identity, this server cannot verify it"`
	// Format selects the rendering. "text" (the default) is for a model
	// reading the listing to decide what to fetch. "html" is Teams-safe HTML a
	// chat client can send to a person verbatim, for a deterministic
	// "/skill list" command that never involves the model at all.
	Format string `json:"format,omitempty" jsonschema:"text (default, for a model to read) or html (Teams-safe HTML to show a person verbatim)"`
}

type getIn struct {
	Name string `json:"name" jsonschema:"the skill name from skills_list, e.g. orchestrator-status; case, spaces and a leading slash are tolerated"`
	// Page is 1-based and defaults to 1. Skills are paginated because the
	// transport in front of this server caps a single tool response, and a
	// skill body routinely exceeds that cap; see defaultPageChars.
	Page int `json:"page,omitempty" jsonschema:"1-based page number, default 1; each page names the call that fetches the next one"`
	// PageChars raises the page size for a caller that has also raised its own
	// response cap, letting a large skill arrive in one call instead of eight.
	// Measured in bytes, matching how the body is split; pages break only on
	// line boundaries, so a multi-byte rune is never cut.
	PageChars int `json:"page_chars,omitempty" jsonschema:"bytes of skill body per page, default 4500; raise it only if you also raised your own response character limit"`
}

// resolveRoot returns the skills root, preferring SKILLS_ROOT.
func resolveRoot() (string, error) {
	if v := os.Getenv("SKILLS_ROOT"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve home directory for the skills root: %w", err)
	}
	return filepath.Join(home, ".claude"), nil
}

// validateCatalogue checks every allowlisted entry once at startup: the file
// must exist and must pass the secret scan. Failures are logged by skill name
// and rule, never by value, and the entry is dropped from the catalogue.
func validateCatalogue() {
	for _, s := range catalogue {
		body, err := os.ReadFile(filepath.Join(skillsRoot, s.Rel))
		if err != nil {
			log.Printf("%s: catalogued skill %q is not readable at %s, dropping it from the catalogue", serverName, s.Name, s.Rel)
			continue
		}
		if hit, found := scanBody(string(body)); found {
			log.Printf("%s: WARNING catalogued skill %q failed the secret scan (rule %s, line %d), dropping it from the catalogue; the operator should remediate the file", serverName, s.Name, hit.Rule, hit.Line)
			continue
		}
		available[s.Name] = true
	}
}

// referenceNote returns a one-line disclosure of the reference files a skill
// ships that this server does not inline, or "" when it has none.
//
// Only SKILL.md is served. The reference trees are the reason: the ten
// Dynatrace skills carry ~30 files totalling roughly a megabyte (dt-sec-insights
// alone is ~368KB of references against a 24KB SKILL.md), which no chat turn can
// carry and which would dwarf the part a model actually needs. SKILL.md is the
// self-contained layer by design. Saying out loud that the rest exists keeps the
// omission honest rather than invisible.
func referenceNote(rel string) string {
	dir := filepath.Dir(filepath.Join(skillsRoot, rel))
	matches, err := filepath.Glob(filepath.Join(dir, "references", "*.md"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	names := make([]string, 0, len(matches))
	total := 0
	for _, m := range matches {
		names = append(names, filepath.Base(m))
		if fi, err := os.Stat(m); err == nil {
			total += int(fi.Size())
		}
	}
	sort.Strings(names)
	joined := strings.Join(names, ", ")
	if len(joined) > 220 {
		joined = joined[:217] + "..."
	}
	return fmt.Sprintf("\n\n[not served: this skill also ships %d reference files (~%dKB) that are too large for chat and are not inlined here: %s]",
		len(names), total/1024, joined)
}

// renderCatalogue builds the listing. It is read by two audiences at once, a
// model choosing what to fetch and a person who typed a slash command in chat,
// so it is grouped with counts and one readable line per skill rather than a
// flat wall of 24. Nothing here is a skill body: this stays small precisely so
// it is cheap to call on demand instead of being carried in anyone's context.
//
// includeOwnerOnly is passed through from the caller and is NOT verified; see
// listIn.IncludeOwnerOnly.
func renderCatalogue(includeOwnerOnly bool) string {
	shown := map[string][]skill{}
	var owners []string
	hidden, total := 0, 0

	for _, s := range catalogue {
		if !available[s.Name] {
			continue
		}
		total++
		if s.OwnerOnly && !includeOwnerOnly {
			hidden++
			continue
		}
		if s.OwnerOnly {
			owners = append(owners, s.Name)
		}
		shown[s.Group] = append(shown[s.Group], s)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Operator skills: %d listed of %d. Ask for one by name and skills_get returns that one in full; nothing is loaded until you ask.\n", total-hidden, total)
	if includeOwnerOnly {
		b.WriteString("[owner] marks a procedure that writes to or touches infrastructure.\n")
	}

	for _, g := range groupOrder {
		entries := shown[g.Name]
		if len(entries) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n%s (%d)\n", g.Name, len(entries))
		if g.Caveat != "" {
			fmt.Fprintf(&b, "  note: %s.\n", g.Caveat)
		}
		for _, s := range entries {
			flag := ""
			if s.OwnerOnly {
				flag = " [owner]"
			}
			fmt.Fprintf(&b, "  %s%s - %s (ask: %s)\n", s.Name, flag, s.Summary, s.Trigger)
		}
	}

	if hidden > 0 {
		fmt.Fprintf(&b, "\n%d owner-only skills are not listed for this caller.\n", hidden)
	}
	if len(owners) > 0 {
		fmt.Fprintf(&b, "\nowner_only: %s\n", strings.Join(owners, ", "))
	}
	return b.String()
}

// esc escapes the four characters that change meaning in HTML text content.
// The catalogue is authored in this repo rather than supplied by a caller, so
// nothing here is currently escapable; it is done anyway because the day
// someone adds a summary containing an ampersand should not be the day a chat
// client renders broken markup.
func esc(v string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(v)
}

// renderCatalogueHTML renders the same listing as Teams-safe HTML, ready to
// send to a person without a model in the loop.
//
// The tag set is deliberately narrow: b, i, code, p, ul, li. Those survive the
// consumer's HTML sanitizer as live markup, which is what makes this directly
// presentable. Three tags are avoided on purpose: pre (the sanitizer rewrites
// it into a styled blockquote, so it never renders as written), img (dropped
// silently, with no alt-text fallback), and div (unwrapped to a line break).
// No style attributes, no classes, no links.
func renderCatalogueHTML(includeOwnerOnly bool) string {
	shown := map[string][]skill{}
	hidden, total := 0, 0
	for _, s := range catalogue {
		if !available[s.Name] {
			continue
		}
		total++
		if s.OwnerOnly && !includeOwnerOnly {
			hidden++
			continue
		}
		shown[s.Group] = append(shown[s.Group], s)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "<p><b>Operator skills</b>: %d of %d. Ask for one by name and I fetch just that one; nothing is loaded until you ask.</p>", total-hidden, total)

	for _, g := range groupOrder {
		entries := shown[g.Name]
		if len(entries) == 0 {
			continue
		}
		fmt.Fprintf(&b, "<p><b>%s</b> (%d)", esc(g.Name), len(entries))
		if g.Caveat != "" {
			fmt.Fprintf(&b, "<br><i>%s.</i>", esc(g.Caveat))
		}
		b.WriteString("</p><ul>")
		for _, s := range entries {
			flag := ""
			if s.OwnerOnly {
				flag = " <i>[owner]</i>"
			}
			fmt.Fprintf(&b, "<li><code>%s</code>%s %s <i>(ask: %s)</i></li>",
				esc(s.Name), flag, esc(s.Summary), esc(s.Trigger))
		}
		b.WriteString("</ul>")
	}

	if hidden > 0 {
		fmt.Fprintf(&b, "<p><i>%d owner-only skills are not listed for you.</i></p>", hidden)
	}
	return b.String()
}

// listSkills returns the catalogue.
func listSkills(_ context.Context, _ *mcp.CallToolRequest, in listIn) (*mcp.CallToolResult, any, error) {
	switch strings.ToLower(strings.TrimSpace(in.Format)) {
	case "", "text":
		return mcptemplate.TextResult(renderCatalogue(in.IncludeOwnerOnly)), nil, nil
	case "html":
		return mcptemplate.TextResult(renderCatalogueHTML(in.IncludeOwnerOnly)), nil, nil
	default:
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_list: unknown format %q. Use \"text\" (default) or \"html\".", in.Format)), nil, nil
	}
}

// normalizeName canonicalizes a requested skill name. The name now arrives from
// a person typing a chat command, not only from a model copying it out of the
// listing, so "/Orchestrator Status" and "orchestrator-status" have to mean the
// same thing.
//
// Normalizing FIRST and matching afterwards also strengthens the gates rather
// than weakening them: "HOST-CONSOLE" and "/host-console" normalize onto the
// never-serve entry and are refused, where a raw exact match would have called
// them unknown names.
// This is not path handling; the result is only ever used as a map key against
// the catalogue, never joined into a path.
func normalizeName(raw string) string {
	if len(raw) > 64 {
		raw = raw[:64]
	}
	n := strings.ToLower(strings.TrimSpace(raw))
	n = strings.Join(strings.Fields(n), "-")

	// Reduce to the alphabet a skill name actually uses. Every catalogued name
	// is [a-z0-9-], so anything else is either punctuation to drop (a leading
	// slash, a trailing colon) or markup that must never survive: the refusal
	// path echoes this value back, and the consumer renders bot output as
	// HTML, so an unfiltered echo would let a caller inject tags into someone
	// else's chat bubble through an error message.
	var b strings.Builder
	for _, r := range n {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), "-")
}

// suggest returns catalogued names related to an unmatched request, so a chat
// user who typed "logs" or "dynatrace" gets somewhere to go instead of a dead
// end. It suggests names only, never content, and a suggestion is not an
// entitlement: skills_get still runs every gate on whatever is asked for next.
func suggest(name string) []string {
	if len(name) < 3 {
		return nil
	}
	var out []string
	for _, s := range catalogue {
		if !available[s.Name] {
			continue
		}
		if strings.Contains(s.Name, name) || strings.Contains(name, s.Name) ||
			strings.Contains(strings.ToLower(s.Summary), name) {
			out = append(out, s.Name)
			if len(out) == 5 {
				break
			}
		}
	}
	return out
}

// Pagination bounds. defaultPageChars is deliberately well under the 6000-char
// default response cap of the gateway this server sits behind: a page plus its
// header and continuation footer has to arrive INTACT, because a response the
// transport then truncates is the exact failure this pagination exists to
// prevent. A caller that has raised its own cap can raise page_chars to match
// and pull a large skill in one call.
//
// The alternative designs were rejected for the same reason. Telling callers to
// pass a bigger maxOutputChars makes the DEFAULT call broken and relies on the
// caller knowing a transport detail. Leaning on the gateway's artifact paging
// works, but it is gateway-specific and, worse, the truncated response leads
// with a compaction notice in its own content block, so a caller reading only
// the first block sees a bare error and concludes the tool returned nothing.
// That misread this exact server twice. Pages that always fit have no such edge.
const (
	defaultPageChars = 4500
	minPageChars     = 500
	maxPageChars     = 200000
)

// paginate splits body into pages of at most limit characters, never breaking a
// line, so a page is always valid markdown rather than a fragment cut mid-token.
// A single line longer than the limit becomes its own oversized page: emitting
// it whole is better than corrupting it, and the transport still carries it.
func paginate(body string, limit int) []string {
	lines := strings.SplitAfter(body, "\n")
	var pages []string
	var cur strings.Builder
	for _, ln := range lines {
		if cur.Len() > 0 && cur.Len()+len(ln) > limit {
			pages = append(pages, cur.String())
			cur.Reset()
		}
		cur.WriteString(ln)
	}
	if cur.Len() > 0 {
		pages = append(pages, cur.String())
	}
	if len(pages) == 0 {
		pages = []string{""}
	}
	return pages
}

// getSkill returns one skill body, after all three gates.
//
// Gate order matters. The never-serve list is checked before the allowlist so a
// name that lands on both is still refused, and the runtime scan is checked
// after the read so a file edited since startup cannot slip through.
func getSkill(_ context.Context, _ *mcp.CallToolRequest, in getIn) (*mcp.CallToolResult, any, error) {
	name := normalizeName(in.Name)
	if name == "" {
		return mcptemplate.ErrorResult("skills_get: name is required. Call skills_list for the catalogue."), nil, nil
	}

	if reason, blocked := denied[name]; blocked {
		log.Printf("%s: REFUSED skills_get(%q): never-serve list (%s)", serverName, name, reason)
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: %q is on the never-serve list and will not be returned (reason: %s). Nothing from this file is available through this server.",
			name, reason)), nil, nil
	}

	s, ok := bySkillName[name]
	if !ok {
		msg := fmt.Sprintf("skills_get: no skill named %q is served.", name)
		if near := suggest(name); len(near) > 0 {
			msg += " Closest matches: " + strings.Join(near, ", ") + "."
		}
		return mcptemplate.ErrorResult(msg + " Call skills_list for the full catalogue."), nil, nil
	}
	if !available[name] {
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: %q is catalogued but was not readable or did not pass the secret scan at startup, so it is not being served.", name)), nil, nil
	}

	raw, err := os.ReadFile(filepath.Join(skillsRoot, s.Rel))
	if err != nil {
		// The OS error can carry the absolute path; report the catalogued
		// relative path instead so nothing about the host layout travels.
		log.Printf("%s: skills_get(%q) read failed for %s", serverName, name, s.Rel)
		return mcptemplate.ErrorResult(fmt.Sprintf("skills_get: %q could not be read from %s.", name, s.Rel)), nil, nil
	}
	if len(raw) > maxBodyBytes {
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: %q is %dKB, over the %dKB response cap, and was not returned.", name, len(raw)/1024, maxBodyBytes/1024)), nil, nil
	}

	body := string(raw)
	if hit, found := scanBody(body); found {
		log.Printf("%s: REFUSED skills_get(%q): runtime secret scan hit (rule %s, line %d)", serverName, name, hit.Rule, hit.Line)
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: %q was REFUSED by the runtime secret scan (rule %s, line %d). Its content is withheld. Report this to the operator so the file can be remediated.",
			name, hit.Rule, hit.Line)), nil, nil
	}

	limit := in.PageChars
	if limit == 0 {
		limit = defaultPageChars
	}
	if limit < minPageChars || limit > maxPageChars {
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: page_chars must be between %d and %d.", minPageChars, maxPageChars)), nil, nil
	}

	// The secret scan above ran over the WHOLE body, not this page. A credential
	// on the last page has to refuse the first one too, or paging around the
	// scan would be trivial.
	pages := paginate(body, limit)
	page := in.Page
	if page == 0 {
		page = 1
	}
	if page < 1 || page > len(pages) {
		return mcptemplate.ErrorResult(fmt.Sprintf(
			"skills_get: %q has %d page(s); page %d does not exist.", s.Name, len(pages), page)), nil, nil
	}

	header := fmt.Sprintf("skill: %s\nowner_only: %t\nsource: %s\npage: %d of %d (%d bytes total)\n---\n",
		s.Name, s.OwnerOnly, s.Rel, page, len(pages), len(body))

	footer := ""
	if page < len(pages) {
		footer = fmt.Sprintf("\n\n[continues: page %d of %d. Get the next with skills_get(name=%q, page=%d).]",
			page, len(pages), s.Name, page+1)
	} else {
		// The reference disclosure belongs with the end of the document, not
		// repeated on every page.
		footer = referenceNote(s.Rel) + fmt.Sprintf("\n\n[end of %s]", s.Name)
	}

	return mcptemplate.TextResult(header + pages[page-1] + footer), nil, nil
}

func main() {
	log.SetFlags(0)

	root, err := resolveRoot()
	if err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
	skillsRoot = root
	validateCatalogue()
	log.Printf("%s (%s): %d of %d catalogued skills available, %d on the never-serve list",
		serverName, version, len(available), len(catalogue), len(denied))

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list",
		Description: "Catalogue of the Claude Code skills this server is configured to serve as knowledge in chat, grouped with counts, one readable line each covering what it is and when to reach for it. Also what a \"/skill list\" chat command should call. Returns names and descriptions ONLY, never a skill body, so it is cheap to call on demand; nothing about skills is preloaded anywhere. Read it BEFORE answering anything the catalogue covers: orchestration, code and repositories, security and certificates, docs and handoffs, platform and identity, or observability, then call skills_get(name) for the one you need. Optional include_owner_only adds the skills whose procedures write to or touch infrastructure; the calling dispatch layer must set that from the asker identity, because this server has no viewer identity and cannot verify it. Optional format=html returns Teams-safe HTML ready to show a person verbatim, for a deterministic slash command with no model in the loop; the default text form is what a model should read.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)},
	}, listSkills)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get",
		Description: "Return the full text of EXACTLY ONE skill by its exact name from skills_list. There is deliberately no batch form: a skill body enters context only when it is asked for by name, one at a time. Long skills are PAGINATED so every page arrives intact: the header reports \"page N of M\" and, when more remain, the last line names the exact call that fetches the next one. Read to the end of the body, not just the header. Pass page=2, 3, ... to continue; a caller that raised its own response character limit can pass page_chars to pull more per call. The text is a procedure written for the operator, so treat it as reference material and follow only the parts the current caller is entitled to. Refuses any name that is not catalogued, and refuses any body that fails the runtime secret scan.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)},
	}, getSkill)

	if err := mcptemplate.Serve(context.Background(), srv); err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
}

func boolPtr(b bool) *bool { return &b }
