---
name: sun
description: Generate MCP servers autonomously. Accepts natural language, structured args, or any mix.
arguments:
  - name: input
    description: Natural language request, target name, or structured args. Anything after /sun is the input.
    required: true
---

# /sun — Generate MCP Server

Routes through the `optimize-mcp-creation` skill for fully autonomous, intelligence-driven MCP generation.

**Accepts natural language.** Everything after `/sun` is your input — say whatever you want.

## Usage

All of these work:

```
# Simple target
/sun stripe
/sun crowdstrike

# Target + context file
/sun stripe ./stripe-openapi.yaml
/sun venafi ~/docs/venafi-requirements.md

# Natural language
/sun I want you to look at ~/tools-list.md and create MCPs for all of the tools listed in that file
/sun create an MCP for datadog but only the metrics and events APIs, skip logs
/sun look at the crowdstrike falcon API docs at ~/Downloads/falcon-docs.pdf and build me an MCP
/sun rebuild the servicenow MCP from scratch, it's broken
/sun I need MCPs for tufin, venafi, and akamai — here's my requirements: ~/reqs/security-tools.md

# Batch
/sun stripe, datadog, crowdstrike
/sun create MCPs for all the tools in ~/my-tools.txt
```

## Input Parsing

Claude parses the natural language input to extract:

| Extract             | How                                               | Examples                                                                |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| **Target(s)**       | Named API/service, or read from a referenced file | "stripe", "crowdstrike", tools listed in a file                         |
| **Context file(s)** | Any file/dir path or URL in the input             | `~/docs/spec.yaml`, `./reqs.md`, `https://api.example.com/openapi.json` |
| **Constraints**     | Natural language qualifiers                       | "only metrics API", "skip logs", "read-only tools only"                 |
| **Intent**          | Create new, rebuild, fix, or batch                | "rebuild from scratch", "fix the broken MCP", "create MCPs for all"     |

### Parsing Rules

1. **File paths** — Anything that looks like a path (`~/`, `./`, `/`, or ends in a file extension) is a context file. Read it.

2. **Target extraction from files** — If the input says "create MCPs for all tools in {file}" or similar, read the file and extract target names. The file can be:
   - A plain list (one target per line)
   - A markdown table with a "Tool" or "Name" column
   - A CSV with tool names
   - A JSON array of strings
   - Prose that mentions tool/API names (extract them)

3. **Constraints** — Natural language constraints become hard requirements passed to the optimizer:
   - "only the metrics API" → Restrict endpoint coverage to metrics
   - "skip logs" → Exclude log-related endpoints
   - "read-only tools only" → No write/mutate tools
   - "focus on security operations" → Prioritize security-related endpoints

4. **Intent mapping**:
   - "create", "build", "make", "generate" → CREATE mode
   - "fix", "repair", "broken" → FIX mode (requires existing MCP)
   - "rebuild from scratch" → CREATE mode (overwrite existing)
   - "update", "improve", "upgrade" → FIX mode
   - Multiple targets → BATCH mode

5. **Ambiguity** — If you can't determine the target, ask. For everything else, make the best decision and proceed.

## After Parsing

Once targets, context, and constraints are extracted, activate the `optimize-mcp-creation` skill:

```
INPUT: {target} (or comma-separated targets for batch)
CONTEXT: {path to context file/dir, or "none"}
CONSTRAINTS: {any natural language constraints, or "none"}
INTENT: {CREATE / FIX / REBUILD / BATCH}
```

**For multiple targets from a file**, run as BATCH — each target goes through the full pipeline.

**For targets with per-target context**, run each target sequentially with its own context:

```
Target 1: stripe (context: ./stripe-spec.yaml) → full pipeline
Target 2: datadog (context: none) → full pipeline
Target 3: crowdstrike (context: ~/falcon-docs.pdf) → full pipeline
```

Follow the skill's pipeline instructions exactly. Do not ask for confirmation between phases. Run to completion.

---

## Context File

The context file/directory is read FIRST, before any research. It enriches or overrides the optimizer's intelligence:

### Supported Input Types

| Input                                              | What the Optimizer Does With It                         |
| -------------------------------------------------- | ------------------------------------------------------- |
| OpenAPI/Swagger spec (`.yaml`, `.json`)            | Uses as primary API source. Skips spec discovery.       |
| API documentation (`.md`, `.txt`, `.pdf`, `.html`) | Supplements web research with authoritative details.    |
| Requirements document (with `## Tools Required`)   | Implements exactly these tools. Skips auto tool design. |
| Tool list file (plain text, one per line)          | Extracts target names. Triggers BATCH mode.             |
| Existing code directory                            | Uses as reference template for patterns.                |
| URL (starts with `http`)                           | Fetches and classifies as above.                        |
| Directory path                                     | Reads all files. Merges context.                        |

### Context File Format (for requirements/tool designs)

```markdown
# {Target} MCP Requirements

## Auth

- Type: OAuth2 client credentials
- Token endpoint: https://api.example.com/oauth/token
- Scopes needed: read, write, admin

## Tools Required

| Tool              | Purpose                               | Priority  |
| ----------------- | ------------------------------------- | --------- |
| investigate_host  | Get host details + detections + vulns | must-have |
| quarantine_host   | Isolate host from network             | must-have |
| search_indicators | Find IOCs across environment          | must-have |

## Gotchas

- Token expires in 30 minutes, cache with 29-min TTL
- Regional base URLs: us-1, us-2, eu-1

## Notes

- Use official SDK if available
- Prefer composite tools over thin wrappers
```

### Tool List File Format (for batch from file)

```
# ~/my-tools.txt — one target per line, comments with #
stripe
datadog
crowdstrike
# venafi  (commented out = skip)
tufin
akamai
```

Or as markdown table:

```markdown
| Tool        | Priority | Notes              |
| ----------- | -------- | ------------------ |
| stripe      | high     | payment processing |
| datadog     | high     | monitoring         |
| crowdstrike | medium   | endpoint security  |
```

---

## What Happens

The pipeline runs end-to-end autonomously:

1. **Parse Input** — Extract targets, context files, constraints, and intent from natural language.
2. **Read Context** — If context files provided, read and classify them.
3. **Intelligence Gathering** — Spawns `mcp-optimizer` agent (PRE mode). Research subagents skip what context already covers.
4. **Generation** — Calls `thesun({ target })` MCP tool. Builder reads blueprint + context.
5. **Quality Gate** — Scores 0-100 base + 20-point tool design bonus.
6. **Auto-Fix** — If score 60-74, fix and re-score (max 2x).
7. **Report** — Final score, tool list, auth method, capabilities.

## Fix Mode

If the target MCP already exists at `~/Scripts/mcp-servers/{target}-mcp`, the optimizer auto-selects CREATE vs FIX based on quality score. No separate fix command needed.
