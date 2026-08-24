package main

// The served catalogue. This file is the whole access-control surface for
// skills-mcp, and it is deliberately a deny-by-default allowlist: a skill is
// serveable only because it is named in `catalogue` below. Nothing walks
// ~/.claude/skills at runtime, so a new skill dropped on disk is invisible to
// this server until an operator adds it here on purpose.
//
// Two gates sit in front of every read, in this order:
//
//  1. denied  — an explicit refusal list, checked FIRST. Every entry is a skill
//     that must never leave this machine. It is redundant with the allowlist
//     today (nothing in `denied` is in `catalogue`), and that redundancy is the
//     point: if someone later adds one of these to the catalogue by mistake,
//     the refusal still holds.
//  2. catalogue — the allowlist itself.
//
// A third gate, the runtime secret scan in scan.go, runs on the file contents
// at serve time and can refuse a skill that both gates admitted.

// skill is one serveable entry. Rel is resolved against the skills root
// (SKILLS_ROOT, default ~/.claude), and it is a fixed literal, never built from
// caller input: skills_get looks a name up in this table by exact match, so
// there is no path a caller can traverse.
type skill struct {
	Name string
	Rel  string
	// Summary is one line describing what the skill is. Trigger is one line
	// describing when a model should reach for it. Both are held here rather
	// than parsed out of each file's front matter because the catalogue is what
	// a model reads BEFORE choosing, so it has to stay small and uniform; the
	// upstream descriptions run to 300+ characters each.
	Summary string
	Trigger string
	// Group is the display heading this skill is listed under. Groups exist
	// because skills_list is read by a person in a chat bubble as well as by a
	// model, and 24 undifferentiated lines is a wall of text to a human.
	Group string
	// OwnerOnly marks a skill whose procedure writes to or touches
	// infrastructure. This server CANNOT enforce it (see the note in
	// gateway/manifests/skills-go.json): the gateway carries no viewer
	// identity, so skills-mcp never knows who is asking. The flag is published
	// so the calling dispatch layer, which does know, can gate on it.
	OwnerOnly bool
}

// Display groups, in render order. A group carries an optional caveat printed
// under its heading; the Dynatrace one exists because no Dynatrace backend is
// connected to this gateway, so a model reading those skills must not offer to
// run a query it has no way to execute.
type group struct {
	Name   string
	Caveat string
}

var groupOrder = []group{
	{Name: "Orchestration"},
	{Name: "Code, repos and PRs"},
	{Name: "Security and certificates"},
	{Name: "Docs and handoffs"},
	{Name: "Platform and identity"},
	{
		Name:   "Dynatrace knowledge",
		Caveat: "no Dynatrace backend is connected here, so these teach DQL and the signal models but CANNOT run a query; do not offer to",
	},
}

// catalogue is the allowlist. Render order comes from groupOrder, not from this
// slice, so reordering entries here cannot silently move a skill out from under
// its group's caveat.
var catalogue = []skill{
	{
		Name: "orchestrator-status", Rel: "skills/orchestrator-status/SKILL.md",
		Group:   "Orchestration",
		Summary: "active Orchestrator jobs and why each blocked one is stuck",
		Trigger: `"orchestrator status", "what's running", job overview`,
	},
	{
		Name: "orchestrator", Rel: "skills/orchestrator/SKILL.md",
		Group:     "Orchestration",
		Summary:   "which orchestrator_* tool to call for durable governed work",
		Trigger:   "jobs, projects, handoffs, memory",
		OwnerOnly: true,
	},
	{
		Name: "orchestrator-alerts", Rel: "skills/orchestrator-alerts/SKILL.md",
		Group:     "Orchestration",
		Summary:   "Orchestrator notification channels, severity, quiet hours, mute",
		Trigger:   `"mute orchestrator", "alert me on Teams"`,
		OwnerOnly: true,
	},
	{
		Name: "handoff-notes", Rel: "commands/handoff-notes.md",
		Group:     "Docs and handoffs",
		Summary:   "eight-section synthesis turning a conversation into a project handoff brief",
		Trigger:   "hand this thread off, write it up",
		OwnerOnly: true,
	},
	{
		Name: "incident-response", Rel: "commands/incident-response.md",
		Group:     "Security and certificates",
		Summary:   "Cybersecurity Architecture Decision Record: verify in ServiceNow and Jira, publish to SARC",
		Trigger:   "security review write-up",
		OwnerOnly: true,
	},
	{
		Name: "confluence-creator", Rel: "commands/confluence-creator.md",
		Group:     "Docs and handoffs",
		Summary:   "publish a Confluence page with embedded draw.io diagrams",
		Trigger:   "document this on the wiki",
		OwnerOnly: true,
	},
	{
		Name: "tufin", Rel: "skills/tufin.md",
		Group:     "Security and certificates",
		Summary:   "firewall policy and rule lookups via the tufin MCP",
		Trigger:   "is this traffic allowed, which zone",
		OwnerOnly: true,
	},
	{
		Name: "stash", Rel: "skills/stash.md",
		Group:     "Code, repos and PRs",
		Summary:   "Bitbucket Server projects, repos and PRs via the stash MCP",
		Trigger:   "find a repo or a PR",
		OwnerOnly: true,
	},
	{
		Name: "stash-push-rejections", Rel: "skills/stash-push-rejections/SKILL.md",
		Group:     "Code, repos and PRs",
		Summary:   "Bitbucket Server push rejections: ref restrictions, secret scanner, PR-by-REST",
		Trigger:   "push rejected",
		OwnerOnly: true,
	},
	{
		Name: "entra-app-reg", Rel: "skills/entra-app-reg/SKILL.md",
		Group:     "Platform and identity",
		Summary:   "Entra ID app registration, redirect URIs, app roles, JWT validation",
		Trigger:   "register an app, validate a token",
		OwnerOnly: true,
	},
	{
		Name: "venafi", Rel: "skills/venafi.md",
		Group:     "Security and certificates",
		Summary:   "certificates on the org's Venafi TPP via the venafi MCP",
		Trigger:   "when does this cert expire",
		OwnerOnly: true,
	},
	{
		Name: "bulk-pr-triage", Rel: "skills/bulk-pr-triage.md",
		Group:     "Code, repos and PRs",
		Summary:   "auto-merge clean Dependabot bumps on schwarztim repos, never human PRs",
		Trigger:   "dependabot backlog",
		OwnerOnly: true,
	},
	{
		Name: "build-pipeline", Rel: "commands/build-pipeline.md",
		Group:   "Platform and identity",
		Summary: "onboarding an app to the org's Kubernetes CI/CD platform",
		Trigger: "build-pipeline secrets, clusters, failing pipeline",
	},
	{
		Name: "microsoft-365-outlook", Rel: "skills/microsoft-365-outlook.md",
		Group:   "Platform and identity",
		Summary: "Outlook mail, calendar and OneDrive via the M365 MCP",
		Trigger: "search my mail, find a meeting",
	},

	// ── Dynatrace knowledge family. Rendered under dynatraceCaveat. ──
	{
		Name: "dt-dql-essentials", Rel: "skills/dt-dql-essentials/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "DQL syntax, data model and cost tuning",
		Trigger: "write, fix or optimize a query",
	},
	{
		Name: "dt-obs-logs", Rel: "skills/dt-obs-logs/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "log search, error rates, patterns",
		Trigger: "find errors in logs",
	},
	{
		Name: "dt-obs-problems", Rel: "skills/dt-obs-problems/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "Davis problems: root cause, impact, blast radius",
		Trigger: "what caused P-12345",
	},
	{
		Name: "dt-obs-hosts", Rel: "skills/dt-obs-hosts/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "host and process metrics: CPU, memory, disk, network",
		Trigger: "high CPU, disk filling up",
	},
	{
		Name: "dt-obs-services", Rel: "skills/dt-obs-services/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "service RED metrics and runtime signals (JVM, .NET, Node, Go)",
		Trigger: "p95 latency, GC pauses",
	},
	{
		Name: "dt-obs-tracing", Rel: "skills/dt-obs-tracing/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "traces, spans and service dependencies",
		Trigger: "slow requests, failed spans",
	},
	{
		Name: "dt-obs-kubernetes", Rel: "skills/dt-obs-kubernetes/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "K8s clusters, nodes, pods and workloads",
		Trigger: "pod restarts, OOMKill, capacity",
	},
	{
		Name: "dt-obs-genai", Rel: "skills/dt-obs-genai/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "LLM and agent telemetry: tokens, cost by model, tool-call failures",
		Trigger: "token spend, runaway agents",
	},
	{
		Name: "dt-sec-insights", Rel: "skills/dt-sec-insights/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "security.events: vulnerabilities, detections, compliance posture",
		Trigger: "open critical CVEs",
	},
	{
		Name: "dt-alerting", Rel: "skills/dt-alerting/SKILL.md",
		Group:   "Dynatrace knowledge",
		Summary: "anomaly detectors, alert storage, problem grouping, routing",
		Trigger: "set up an alert",
	},
}

// denied is the never-serve list, checked before the allowlist. Each entry
// records WHY, because the reason is the only thing that can justify keeping a
// name here after the file changes.
var denied = map[string]string{
	// Credential material inline in the file. Reported to the operator as a
	// remediation item; never read, copied, or echoed by this server.
	"host-console": "contains plaintext credentials inline",

	// Instructs copying the encrypted vault and its master key to another host.
	"vault-mirror": "procedure copies vault and master key material off-host",

	// Real customer authentication data.
	"customer-auth-db":          "touches production customer authentication data",
	"account-takeover-analysis": "touches production customer authentication data",

	// Live captured session material and credential storage instructions.
	"session-capture": "ingests captured browser session tokens",
	"codex":           "instructs storing API keys",
	"apk-to-mcp":      "instructs storing API keys",

	// Drives a local binary and names a credential; impossible in chat anyway.
	"tts": "local audio binary and names a credential",
}

// bySkillName indexes the catalogue for exact-match lookup.
var bySkillName = func() map[string]skill {
	m := make(map[string]skill, len(catalogue))
	for _, s := range catalogue {
		m[s.Name] = s
	}
	return m
}()
