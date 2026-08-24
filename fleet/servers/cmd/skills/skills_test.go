package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Every credential-shaped string in this file is SYNTHETIC. None of these
// values authenticates against anything; they exist only to exercise the
// detector shapes. Never paste a real credential into a fixture.

// fixtureRoot materializes every catalogued skill under a temp root with benign
// content, points skillsRoot at it, and runs the startup validation. Tests then
// exercise the gates against a corpus they fully control, so a result never
// depends on what happens to be in the operator's ~/.claude today.
func fixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, s := range catalogue {
		p := filepath.Join(root, s.Rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(p), err)
		}
		body := "---\nname: " + s.Name + "\n---\n\n# " + s.Name + "\n\nBenign fixture body for " + s.Name + ".\n"
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	skillsRoot = root
	available = map[string]bool{}
	validateCatalogue()
	if len(available) != len(catalogue) {
		t.Fatalf("fixture setup: %d of %d catalogued skills available, want all", len(available), len(catalogue))
	}
	return root
}

// callGet runs the get tool and returns (text, isError).
func callGet(t *testing.T, name string) (string, bool) {
	t.Helper()
	res, _, err := getSkill(context.Background(), nil, getIn{Name: name})
	if err != nil {
		t.Fatalf("getSkill(%q) returned a transport error, want a graceful tool result: %v", name, err)
	}
	if len(res.Content) == 0 {
		t.Fatalf("getSkill(%q) returned no content", name)
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("getSkill(%q) returned %T, want *mcp.TextContent", name, res.Content[0])
	}
	return tc.Text, res.IsError
}

// TestAllowlistDeniesUnlistedName is the deny-by-default property: a name that
// is not in the catalogue is refused even though the file exists on disk and
// the name appears on no denylist.
func TestAllowlistDeniesUnlistedName(t *testing.T) {
	root := fixtureRoot(t)

	// A real, readable file that is simply not catalogued.
	uncatalogued := filepath.Join(root, "skills", "not-catalogued", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(uncatalogued), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(uncatalogued, []byte("# not catalogued\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"not-catalogued", "session-manager", "recover", "sitebuilder", "../../etc/passwd"} {
		text, isErr := callGet(t, name)
		if !isErr {
			t.Errorf("getSkill(%q) succeeded, want refusal: deny-by-default means only catalogued names are served", name)
		}
		if !strings.Contains(text, "no skill named") {
			t.Errorf("getSkill(%q) refusal text = %q, want the not-served message", name, text)
		}
	}
}

// TestNeverServeListDeniesKvmAndTts covers the explicit refusal list. It is
// checked before the allowlist, so these names are refused with the never-serve
// message rather than the generic not-catalogued one.
func TestNeverServeListDeniesKvmAndTts(t *testing.T) {
	fixtureRoot(t)

	for _, name := range []string{"host-console", "tts", "vault-mirror", "customer-auth-db", "account-takeover-analysis", "session-capture", "codex", "apk-to-mcp"} {
		text, isErr := callGet(t, name)
		if !isErr {
			t.Errorf("getSkill(%q) succeeded, want refusal", name)
		}
		if !strings.Contains(text, "never-serve list") {
			t.Errorf("getSkill(%q) refusal text = %q, want the never-serve message", name, text)
		}
	}
}

// TestNeverServeNamesAreNotCatalogued guards the two lists against drifting
// into contradiction.
func TestNeverServeNamesAreNotCatalogued(t *testing.T) {
	for name := range denied {
		if _, ok := bySkillName[name]; ok {
			t.Errorf("%q is on both the never-serve list and the catalogue", name)
		}
	}
}

// TestRuntimeSecretScanRefusesCredential is the runtime property: the file is
// clean when the server starts, gains a credential afterwards, and the very
// next read is refused without a restart. A build-time-only check would serve
// it.
func TestRuntimeSecretScanRefusesCredential(t *testing.T) {
	root := fixtureRoot(t)

	victim := catalogue[0]
	if text, isErr := callGet(t, victim.Name); isErr {
		t.Fatalf("getSkill(%q) was refused before the fixture was poisoned: %s", victim.Name, text)
	}

	poisoned := "# " + victim.Name + "\n\nRun the job with:\n\n    export SERVICE_PASSWORD=Zq7mKp2wRt9xVb\n"
	if err := os.WriteFile(filepath.Join(root, victim.Rel), []byte(poisoned), 0o644); err != nil {
		t.Fatal(err)
	}

	text, isErr := callGet(t, victim.Name)
	if !isErr {
		t.Fatalf("getSkill(%q) served a body containing a credential-shaped string", victim.Name)
	}
	if !strings.Contains(text, "runtime secret scan") {
		t.Errorf("refusal text = %q, want the secret-scan message", text)
	}
	if strings.Contains(text, "Zq7mKp2wRt9xVb") {
		t.Error("the refusal echoed the matched value; a refusal must never carry the secret it withheld")
	}
}

// TestSecretScanDetects covers the detector shapes. Every value here is
// synthetic.
func TestSecretScanDetects(t *testing.T) {
	cases := []struct {
		name string
		body string
		rule string
	}{
		{"pem private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n", "pem_private_key"},
		{"aws access key id", "aws_access_key_id " + "AKIA" + strings.Repeat("Q", 4) + strings.Repeat("W", 4) + strings.Repeat("E", 4) + strings.Repeat("R", 4) + "\n", "aws_access_key_id"},
		{"github token", "use " + "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" + " to push\n", "github_token"},
		{"slack token", "hook: " + "xoxb-" + "1111111111-2222222222-AbCdEfGhIjKlMnOpQrSt" + "\n", "slack_token"},
		{"jwt", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.QWxwaGFCcmF2bw\n", "jwt"},
		{"url embedded credential", "psql postgres://svcuser:Nn4Tp8Qz2Lk@db.internal:5432/app\n", "url_embedded_credential"},
		{"sshpass inline", "sshpass -p Xk9Rm3Vt7Qw ssh pi@target\n", "inline_password_flag"},
		{"assigned credential", "password: Zq7mKp2wRt9xVb\n", "assigned_credential"},
		{"prose credential", "The password is Zq7mKp2wRt9xVb, do not share it.\n", "prose_credential"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hit, found := scanBody(tc.body)
			if !found {
				t.Fatalf("scanBody did not flag a %s", tc.name)
			}
			if hit.Rule != tc.rule {
				t.Errorf("rule = %q, want %q", hit.Rule, tc.rule)
			}
		})
	}
}

// TestSecretScanAllowsDocumentation is the other half of the contract. These
// are the forms the real corpus uses to TALK about credentials; flagging them
// would refuse legitimate skills and make the gate untrustworthy.
func TestSecretScanAllowsDocumentation(t *testing.T) {
	clean := []string{
		"Set `password: <your-password>` in the config.\n",
		"export GITHUB_TOKEN=$(secrets.py get github)\n",
		"api_key = ${AKAMAI_API_KEY}\n",
		"TUFIN_TOKEN = \"hermes://tufin/session\"\n",
		"Header `X-Atlassian-Token: nocheck` is required for attachments.\n",
		"orchestrator_alerts { action: \"enable\", secretKey: \"teams-alert-webhook\" }\n",
		"The client secret is stored in the vault; never paste it here.\n",
		"mkdir -p ~/Projects && cp -p file dest\n",
		"password: REDACTED\n",
		"Use `--password=$DB_PASSWORD` so the value never reaches the process list.\n",
	}
	for _, body := range clean {
		if hit, found := scanBody(body); found {
			t.Errorf("scanBody flagged documentation as a secret (rule %s): %q", hit.Rule, body)
		}
	}
}

// TestCatalogueOutput checks the shape a model actually reads: the owner_only
// marker, the single authoritative owner_only line a dispatch layer parses, and
// the Dynatrace caveat.
func TestCatalogueOutput(t *testing.T) {
	fixtureRoot(t)
	out := renderCatalogue(true)

	if !strings.Contains(out, "orchestrator-status - active Orchestrator jobs") {
		t.Error("catalogue is missing orchestrator-status")
	}
	if strings.Contains(out, "orchestrator-status [owner]") {
		t.Error("orchestrator-status is read-only and must not be flagged owner_only")
	}
	for _, name := range []string{"handoff-notes", "orchestrator", "orchestrator-alerts", "venafi", "stash-push-rejections", "bulk-pr-triage", "incident-response", "confluence-creator", "stash", "entra-app-reg", "tufin"} {
		if !strings.Contains(out, name+" [owner]") {
			t.Errorf("%s must carry the owner_only marker", name)
		}
	}
	if !strings.Contains(out, "no Dynatrace backend is connected here") {
		t.Error("the Dynatrace block must state that no Dynatrace backend is connected")
	}

	// The trailing owner_only line is the single field a dispatch layer parses.
	idx := strings.LastIndex(out, "\nowner_only: ")
	if idx < 0 {
		t.Fatal("catalogue is missing the trailing owner_only line")
	}
	line := strings.TrimSpace(out[idx+len("\nowner_only: "):])
	got := strings.Split(line, ", ")
	if len(got) != 11 {
		t.Errorf("owner_only line lists %d skills, want 11: %q", len(got), line)
	}

	// No skill may be listed without a name that resolves back to the catalogue.
	for _, name := range got {
		if _, ok := bySkillName[name]; !ok {
			t.Errorf("owner_only line names %q, which is not in the catalogue", name)
		}
	}
}

// TestGetReturnsBodyWithHeader checks the served shape: a small header carrying
// the owner_only flag and the root-relative source path (never an absolute
// path, which would disclose the host layout), then the body.
func TestGetReturnsBodyWithHeader(t *testing.T) {
	root := fixtureRoot(t)

	text, isErr := callGet(t, "orchestrator-status")
	if isErr {
		t.Fatalf("getSkill(orchestrator-status) was refused: %s", text)
	}
	for _, want := range []string{"skill: orchestrator-status", "owner_only: false", "source: skills/orchestrator-status/SKILL.md", "Benign fixture body"} {
		if !strings.Contains(text, want) {
			t.Errorf("response is missing %q", want)
		}
	}
	if strings.Contains(text, root) {
		t.Error("response leaked the absolute skills root path")
	}

	text, isErr = callGet(t, "handoff-notes")
	if isErr {
		t.Fatalf("getSkill(handoff-notes) was refused: %s", text)
	}
	if !strings.Contains(text, "owner_only: true") {
		t.Error("handoff-notes must report owner_only: true in its response header")
	}
}

// TestReferenceNoteDisclosesUninlinedFiles covers the SKILL.md-only decision:
// references are not inlined, and the omission is stated rather than silent.
func TestReferenceNoteDisclosesUninlinedFiles(t *testing.T) {
	root := fixtureRoot(t)

	refDir := filepath.Join(root, "skills", "dt-obs-tracing", "references")
	if err := os.MkdirAll(refDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"http-spans.md", "db-spans.md"} {
		if err := os.WriteFile(filepath.Join(refDir, n), []byte(strings.Repeat("x", 2048)), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	text, isErr := callGet(t, "dt-obs-tracing")
	if isErr {
		t.Fatalf("getSkill(dt-obs-tracing) was refused: %s", text)
	}
	if !strings.Contains(text, "not served: this skill also ships 2 reference files") {
		t.Errorf("response does not disclose the uninlined reference files: %q", text)
	}
	if !strings.Contains(text, "db-spans.md, http-spans.md") {
		t.Error("the disclosure should name the reference files, sorted")
	}
}

// TestMissingFileIsDroppedNotAdvertised covers the startup validation: a
// catalogued skill whose file is absent is omitted from the catalogue instead
// of being listed and then failing on read.
func TestMissingFileIsDroppedNotAdvertised(t *testing.T) {
	root := fixtureRoot(t)

	if err := os.Remove(filepath.Join(root, "skills", "orchestrator-status", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	available = map[string]bool{}
	validateCatalogue()

	if available["orchestrator-status"] {
		t.Fatal("orchestrator-status has no file but was marked available")
	}
	if strings.Contains(renderCatalogue(true), "orchestrator-status - active Orchestrator jobs") {
		t.Error("the catalogue advertises a skill whose file is missing")
	}
	if text, isErr := callGet(t, "orchestrator-status"); !isErr {
		t.Errorf("getSkill(orchestrator-status) succeeded with no file on disk: %s", text)
	}
}

// TestOwnerOnlyExcludedByDefault is the fail-closed direction of the listing
// filter: a caller that says nothing about identity gets the non-owner view.
// The calling dispatch layer opts in explicitly when it knows the asker is the
// owner; this server never verifies that claim.
func TestOwnerOnlyExcludedByDefault(t *testing.T) {
	fixtureRoot(t)

	out := renderCatalogue(false)
	for _, name := range []string{"handoff-notes", "orchestrator ", "orchestrator-alerts", "venafi", "stash-push-rejections", "bulk-pr-triage", "incident-response", "confluence-creator", "stash", "entra-app-reg", "tufin"} {
		if strings.Contains(out, name+" - ") {
			t.Errorf("default listing includes owner-only skill %q", strings.TrimSpace(name))
		}
	}
	if strings.Contains(out, "[owner]") {
		t.Error("default listing shows an owner marker, so an owner-only skill leaked into it")
	}
	if !strings.Contains(out, "11 owner-only skills are not listed") {
		t.Error("default listing must say how many entries it withheld")
	}
	if !strings.Contains(out, "orchestrator-status - ") {
		t.Error("default listing dropped a non-owner skill")
	}
	if strings.Contains(out, "owner_only:") {
		t.Error("the machine-readable owner_only line must not appear when nothing owner-only was listed")
	}
}

// TestExcludedSkillsNeverListed covers the hard rule that a never-serve skill
// is invisible, not merely unreadable. It must not appear in either view of the
// listing, in any form, including the human-readable one a person sees in chat.
func TestExcludedSkillsNeverListed(t *testing.T) {
	fixtureRoot(t)

	for _, includeOwner := range []bool{false, true} {
		out := renderCatalogue(includeOwner)
		for name := range denied {
			if strings.Contains(out, name) {
				t.Errorf("listing (include_owner_only=%t) names never-serve skill %q", includeOwner, name)
			}
		}
	}
}

// TestListingIsGrouped checks the shape a person reads in a chat bubble: named
// groups carrying their own counts, rather than one flat run of 24 lines.
func TestListingIsGrouped(t *testing.T) {
	fixtureRoot(t)
	out := renderCatalogue(true)

	for _, want := range []string{
		"Orchestration (3)", "Code, repos and PRs (3)", "Security and certificates (3)",
		"Docs and handoffs (2)", "Platform and identity (3)", "Dynatrace knowledge (10)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("listing is missing the group heading %q", want)
		}
	}

	// Every catalogued skill must belong to a declared group, or it renders
	// nowhere and silently disappears from the listing.
	declared := map[string]bool{}
	for _, g := range groupOrder {
		declared[g.Name] = true
	}
	for _, s := range catalogue {
		if !declared[s.Group] {
			t.Errorf("skill %q declares group %q, which is not in groupOrder", s.Name, s.Group)
		}
	}
}

// TestNameNormalization covers the chat-command path: a person types the name,
// so case, spaces, a leading slash and a trailing colon all have to resolve to
// the same skill. Normalizing before the gates run also means an evasive
// spelling of a never-serve name lands on the refusal rather than on "unknown".
func TestNameNormalization(t *testing.T) {
	fixtureRoot(t)

	for _, raw := range []string{"orchestrator-status", "Orchestrator-Status", " orchestrator status ", "/orchestrator-status", "orchestrator-status:", "ORCHESTRATOR STATUS"} {
		text, isErr := callGet(t, raw)
		if isErr {
			t.Errorf("getSkill(%q) was refused, want it to resolve to orchestrator-status: %s", raw, text)
		}
	}

	for _, raw := range []string{"HOST-CONSOLE", "/host-console", " host-console ", "TTS"} {
		text, isErr := callGet(t, raw)
		if !isErr {
			t.Errorf("getSkill(%q) succeeded, want the never-serve refusal", raw)
		}
		if !strings.Contains(text, "never-serve list") {
			t.Errorf("getSkill(%q) = %q, want the never-serve message; normalization must run before the gates", raw, text)
		}
	}
}

// TestUnknownNameSuggests checks that a near miss points somewhere instead of
// dead-ending, which matters because the caller may be a person typing in chat.
// A suggestion names a skill; it never returns content and confers nothing.
func TestUnknownNameSuggests(t *testing.T) {
	fixtureRoot(t)

	text, isErr := callGet(t, "logs")
	if !isErr {
		t.Fatal("getSkill(logs) succeeded, want a refusal: it is not a catalogued name")
	}
	if !strings.Contains(text, "dt-obs-logs") {
		t.Errorf("refusal for a near miss should suggest dt-obs-logs, got %q", text)
	}

	// A suggestion must never surface a never-serve skill. Only the suggestion
	// segment is inspected: the refusal also quotes the requested name back, and
	// "host-console-hid" trivially contains "host-console" without that being a
	// suggestion.
	for _, probe := range []string{"host", "host-console-hid", "tts-voice", "mirror"} {
		text, _ := callGet(t, probe)
		i := strings.Index(text, "Closest matches: ")
		if i < 0 {
			continue
		}
		segment := text[i:]
		for name := range denied {
			if strings.Contains(segment, name) {
				t.Errorf("suggestion for %q named never-serve skill %q: %s", probe, name, segment)
			}
		}
	}

	// Markup in a requested name must not survive into the echoed refusal: the
	// consumer renders bot output as HTML.
	text, isErr = callGet(t, "<b>orchestrator</b><script>x</script>")
	if !isErr {
		t.Error("a markup-laden name resolved to a skill")
	}
	// Only the structural characters matter. Letters left over from a stripped
	// tag are inert text; an angle bracket or an ampersand is not.
	for _, bad := range []string{"<", ">", "&", "\"orchestrator\"", "'"} {
		if strings.Contains(text, bad) {
			t.Errorf("refusal echoed %q from the requested name: %s", bad, text)
		}
	}
}

// TestHTMLListingIsTeamsSafe covers the format=html path, which exists so a
// chat client can show the listing to a person verbatim, with no model in the
// loop. The consumer's sanitizer preserves an allowlisted tag set and quietly
// mangles or drops everything else, so emitting a tag outside that set would
// fail silently at render time rather than loudly here.
func TestHTMLListingIsTeamsSafe(t *testing.T) {
	fixtureRoot(t)
	out := renderCatalogueHTML(true)

	allowed := map[string]bool{"p": true, "b": true, "i": true, "code": true, "ul": true, "li": true, "br": true}
	for _, m := range regexp.MustCompile(`</?([a-zA-Z0-9]+)[^>]*>`).FindAllStringSubmatch(out, -1) {
		if !allowed[strings.ToLower(m[1])] {
			t.Errorf("listing emits <%s>, which is outside the Teams-safe set this renderer commits to", m[1])
		}
	}
	// pre is rewritten by the sanitizer, img is dropped with no fallback, div
	// collapses to a line break. None of them may appear.
	for _, bad := range []string{"<pre", "<img", "<div", "<span", "style=", "class=", "<script", "<a "} {
		if strings.Contains(out, bad) {
			t.Errorf("listing emits %q, which does not survive the consumer's sanitizer intact", bad)
		}
	}
	for _, want := range []string{"<code>orchestrator-status</code>", "<b>Orchestration</b> (3)", "<ul>", "</li>"} {
		if !strings.Contains(out, want) {
			t.Errorf("HTML listing is missing %q", want)
		}
	}
}

// TestHTMLListingHonoursGates checks that switching format does not switch off
// the owner filter or the never-serve rule. A second rendering path is a second
// chance to leak, so it is tested against the same rules as the first.
func TestHTMLListingHonoursGates(t *testing.T) {
	fixtureRoot(t)

	nonOwner := renderCatalogueHTML(false)
	if strings.Contains(nonOwner, "[owner]") {
		t.Error("non-owner HTML listing shows an owner marker, so an owner-only skill leaked in")
	}
	for _, name := range []string{"handoff-notes", "venafi", "stash-push-rejections", "incident-response", "tufin"} {
		if strings.Contains(nonOwner, "<code>"+name+"</code>") {
			t.Errorf("non-owner HTML listing includes owner-only skill %q", name)
		}
	}
	if !strings.Contains(nonOwner, "11 owner-only skills are not listed") {
		t.Error("non-owner HTML listing must say how many entries it withheld")
	}

	for _, out := range []string{nonOwner, renderCatalogueHTML(true)} {
		for name := range denied {
			if strings.Contains(out, name) {
				t.Errorf("HTML listing names never-serve skill %q", name)
			}
		}
	}
}

// TestListFormatSelection covers the dispatch, including the refusal on an
// unknown value rather than a silent fall back to some default.
func TestListFormatSelection(t *testing.T) {
	fixtureRoot(t)

	call := func(f string) (string, bool) {
		t.Helper()
		res, _, err := listSkills(context.Background(), nil, listIn{IncludeOwnerOnly: true, Format: f})
		if err != nil {
			t.Fatalf("listSkills(format=%q) errored: %v", f, err)
		}
		return res.Content[0].(*mcp.TextContent).Text, res.IsError
	}

	for _, f := range []string{"", "text", "TEXT", " text "} {
		out, isErr := call(f)
		if isErr || strings.Contains(out, "<li>") {
			t.Errorf("format=%q should render the plain text listing", f)
		}
	}
	for _, f := range []string{"html", "HTML", " html "} {
		out, isErr := call(f)
		if isErr || !strings.Contains(out, "<li>") {
			t.Errorf("format=%q should render the HTML listing", f)
		}
	}
	out, isErr := call("markdown")
	if !isErr {
		t.Error("an unknown format silently rendered something instead of being refused")
	}
	if !strings.Contains(out, "unknown format") {
		t.Errorf("refusal text = %q, want it to name the problem", out)
	}
}

// bigBody builds a realistic multi-section skill body of roughly n characters.
func bigBody(n int) string {
	var b strings.Builder
	i := 0
	for b.Len() < n {
		fmt.Fprintf(&b, "## Section %d\n\nSome procedure text for section %d that runs on a bit so the body reaches a realistic size.\n\n", i, i)
		i++
	}
	return b.String()
}

// TestGetPaginatesLargeSkill is the regression for the defect that made this
// tool useless: a skill body larger than the transport's response cap came back
// as a truncation notice instead of content. Every page must fit the budget,
// and the pages must reassemble into the original body exactly, or "paginated"
// would just be a nicer word for "still lossy".
func TestGetPaginatesLargeSkill(t *testing.T) {
	root := fixtureRoot(t)

	victim := bySkillName["dt-dql-essentials"]
	body := bigBody(32000)
	if err := os.WriteFile(filepath.Join(root, victim.Rel), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	var assembled strings.Builder
	seen := 0
	for page := 1; page <= 50; page++ {
		text, isErr := callGetPage(t, victim.Name, page, 0)
		if isErr {
			t.Fatalf("page %d was refused: %s", page, text)
		}
		// The whole response, header and footer included, must fit the
		// transport budget with room to spare.
		if len(text) >= 6000 {
			t.Errorf("page %d is %d chars, at or over the 6000-char response cap it must fit under", page, len(text))
		}
		if !strings.Contains(text, fmt.Sprintf("page: %d of ", page)) {
			t.Errorf("page %d does not report its own position: %q", page, text[:120])
		}

		payload := text[strings.Index(text, "\n---\n")+len("\n---\n"):]
		if cut := strings.Index(payload, "\n\n[continues:"); cut >= 0 {
			assembled.WriteString(payload[:cut])
			seen = page
			continue
		}
		cut := strings.Index(payload, "\n\n[end of ")
		if cut < 0 {
			t.Fatalf("page %d has neither a continuation marker nor an end marker", page)
		}
		assembled.WriteString(payload[:cut])
		seen = page
		break
	}

	if seen < 2 {
		t.Fatalf("a 32000-char body produced %d page(s); it should paginate", seen)
	}
	if assembled.String() != body {
		t.Errorf("reassembled pages do not equal the original body (got %d chars, want %d)", assembled.Len(), len(body))
	}
}

// callGetPage is callGet with the pagination arguments.
func callGetPage(t *testing.T, name string, page, pageChars int) (string, bool) {
	t.Helper()
	res, _, err := getSkill(context.Background(), nil, getIn{Name: name, Page: page, PageChars: pageChars})
	if err != nil {
		t.Fatalf("getSkill(%q, page=%d) errored: %v", name, page, err)
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError
}

// TestGetPaginationBounds covers the edges around the page argument.
func TestGetPaginationBounds(t *testing.T) {
	root := fixtureRoot(t)
	victim := bySkillName["dt-dql-essentials"]
	if err := os.WriteFile(filepath.Join(root, victim.Rel), []byte(bigBody(20000)), 0o644); err != nil {
		t.Fatal(err)
	}

	// Omitted page means page 1, not an error.
	first, isErr := callGetPage(t, victim.Name, 0, 0)
	if isErr || !strings.Contains(first, "page: 1 of ") {
		t.Errorf("an omitted page should default to page 1, got %q", first[:120])
	}

	for _, bad := range []int{-1, 9999} {
		text, isErr := callGetPage(t, victim.Name, bad, 0)
		if !isErr {
			t.Errorf("page=%d was served instead of refused", bad)
		}
		if !strings.Contains(text, "does not exist") {
			t.Errorf("page=%d refusal should name the valid range, got %q", bad, text)
		}
	}

	for _, bad := range []int{10, 999999} {
		if _, isErr := callGetPage(t, victim.Name, 1, bad); !isErr {
			t.Errorf("page_chars=%d was accepted, outside the documented bounds", bad)
		}
	}

	// A raised page size pulls the whole body in one call.
	whole, isErr := callGetPage(t, victim.Name, 1, 100000)
	if isErr {
		t.Fatalf("a raised page_chars was refused: %s", whole)
	}
	if !strings.Contains(whole, "page: 1 of 1") {
		t.Error("page_chars large enough for the whole body should yield a single page")
	}
}

// TestGetSmallSkillIsOnePage keeps the common case free of pagination noise.
func TestGetSmallSkillIsOnePage(t *testing.T) {
	fixtureRoot(t)

	text, isErr := callGet(t, "orchestrator-status")
	if isErr {
		t.Fatalf("orchestrator-status was refused: %s", text)
	}
	if !strings.Contains(text, "page: 1 of 1") {
		t.Error("a small skill should report a single page")
	}
	if strings.Contains(text, "[continues:") {
		t.Error("a single-page skill must not advertise a next page")
	}
	if !strings.Contains(text, "[end of orchestrator-status]") {
		t.Error("the last page should be marked as the end")
	}
}

// TestSecretOnLaterPageRefusesEveryPage: the scan covers the whole body, so a
// credential further in cannot be paged around by asking for page 1.
func TestSecretOnLaterPageRefusesEveryPage(t *testing.T) {
	root := fixtureRoot(t)
	victim := bySkillName["dt-dql-essentials"]
	poisoned := bigBody(20000) + "\n\nexport SERVICE_PASSWORD=Zq7mKp2wRt9xVb\n"
	if err := os.WriteFile(filepath.Join(root, victim.Rel), []byte(poisoned), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, page := range []int{1, 2, 3} {
		text, isErr := callGetPage(t, victim.Name, page, 0)
		if !isErr {
			t.Errorf("page %d was served from a body carrying a credential further in", page)
		}
		if strings.Contains(text, "Zq7mKp2wRt9xVb") {
			t.Error("the refusal echoed the matched value")
		}
	}
}

// TestPaginateNeverSplitsALine guards the chunker itself.
func TestPaginateNeverSplitsALine(t *testing.T) {
	body := "alpha\nbravo\ncharlie\ndelta\necho\n"
	pages := paginate(body, 12)
	if len(pages) < 2 {
		t.Fatalf("expected several pages, got %d", len(pages))
	}
	if strings.Join(pages, "") != body {
		t.Error("pages do not reassemble into the original body")
	}
	for i, p := range pages {
		if p != "" && !strings.HasSuffix(p, "\n") {
			t.Errorf("page %d ends mid-line: %q", i+1, p)
		}
	}

	// A single line longer than the limit is emitted whole rather than cut.
	long := strings.Repeat("x", 50) + "\n"
	pages = paginate(long, 10)
	if len(pages) != 1 || pages[0] != long {
		t.Errorf("an over-long line should be emitted whole, got %d page(s)", len(pages))
	}
}
