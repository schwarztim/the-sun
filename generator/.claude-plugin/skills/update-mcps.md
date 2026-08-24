---
name: update-mcps
description: Proactively search the web to improve and update MCP servers with new features, security fixes, and best practices
---

# Update MCPs Skill

Automatically search the web to find improvements for MCP servers and apply updates. Keeps MCPs current with:
- New API features and endpoints
- Security vulnerabilities and patches
- Best practices from other MCP implementations
- Breaking changes in APIs

## When to Use

- "Update my MCPs with latest features"
- "Check for MCP security updates"
- "Are there any new features for the {tool} API?"
- "Keep my MCPs up to date"
- "Find improvements for {tool} MCP"
- Run periodically (weekly/monthly) as maintenance

## What It Does

### 0. Performance Analysis Phase (NEW - Critical)
Analyzes HOW the MCP is implemented to find optimization opportunities:

| Anti-Pattern | Problem | Fix |
|--------------|---------|-----|
| **Shell spawning** | Spawning curl/bash creates process overhead | Use native HTTP client (axios, fetch) |
| **No connection pooling** | New TCP connection per request | Reuse connections with keep-alive |
| **No auth caching** | Re-authenticate on every call | Cache tokens, refresh only when expired |
| **No response caching** | Re-fetch static data repeatedly | Cache with TTL for stable data |
| **Sequential calls** | Operations run one at a time | Batch with Promise.all() |
| **No retry logic** | Fails on transient errors | Add exponential backoff |
| **Recreating clients** | New client instance on every tool call | Singleton/lazy initialization |

**Real Example**: Akamai MCP went from **8 minutes to 30 seconds** by:
- Replacing shell spawning with native axios client
- Adding connection pooling with keep-alive
- Caching authentication tokens
- Batching parallel API calls

### 1. Discovery Phase
Searches multiple sources for updates:

| Source | What We Look For |
|--------|------------------|
| **API Changelogs** | New endpoints, deprecated features, breaking changes |
| **GitHub** | Popular MCP repos, new implementations, issues/discussions |
| **Security Advisories** | CVEs affecting API clients, dependency vulnerabilities |
| **Vendor Docs** | Updated OpenAPI specs, new authentication methods |
| **MCP Community** | Best practices, patterns from other implementations |
| **npm/PyPI** | Updated SDK versions, new client libraries |

### 2. Analysis Phase
For each finding:
- Assess relevance to existing MCPs
- Prioritize by impact (security > features > optimization)
- Check compatibility with current implementation
- Estimate effort to implement

### 3. Update Phase
Apply improvements:
- Add new API endpoints/tools
- Fix security vulnerabilities
- Update dependencies
- Improve error handling patterns
- Add missing functionality from reference implementations

### 4. Documentation Phase
Document all changes:
- Update Confluence with changelog
- Create/update GitHub release notes
- Update README with new features
- Log changes in CHANGELOG.md

## Invocation

### Update All MCPs (Parallel Execution)

**CRITICAL**: Run agents IN PARALLEL, not sequentially.

```
# Step 1: Get list of all MCPs
mcps=$(cat ~/.claude/user-mcps.json | jq -r '.mcpServers | keys[]')

# Step 2: Spawn parallel agents (one message, multiple Task calls)
For EACH MCP, spawn in the SAME message:

<Task subagent_type="mcp-updater" run_in_background="true">
Analyze and update {mcp_1}...
</Task>

<Task subagent_type="mcp-updater" run_in_background="true">
Analyze and update {mcp_2}...
</Task>

<Task subagent_type="mcp-updater" run_in_background="true">
Analyze and update {mcp_3}...
</Task>

# Step 3: Wait for all agents to complete
# Step 4: Aggregate results
```

### Per-MCP Agent Instructions
```
<Task subagent_type="mcp-updater" run_in_background="true">
Analyze and update {tool} MCP at {path}.

Run these checks IN PARALLEL:
1. Performance analysis (anti-patterns, optimization)
2. Security vulnerability search
3. New API feature discovery
4. Community best practices search

After parallel analysis:
1. Prioritize findings (Critical > High > Medium > Low)
2. Apply fixes in priority order
3. Validate (build, test, startup)
4. Document changes

Report findings even if no changes applied.
</Task>
```

### Update Specific MCP
```
<Task subagent_type="mcp-updater">
Search for updates for the {tool} MCP at {path}.

Focus on:
1. New API endpoints since last update
2. Security advisories
3. Better implementations in other MCPs
4. Updated SDK/client libraries

Apply improvements and document.
</Task>
```

### Security-Only Update
```
<Task subagent_type="mcp-updater">
Security audit for all MCP servers.

Search for:
1. CVEs affecting API clients
2. Dependency vulnerabilities (npm audit)
3. Authentication/authorization issues
4. Data exposure risks

Fix critical/high severity issues immediately.
Document in security changelog.
</Task>
```

### Performance Optimization (Critical)
```
<Task subagent_type="mcp-updater">
Performance analysis and optimization for {tool} MCP at {path}.

Analyze the codebase for:
1. Shell spawning (child_process) - replace with native HTTP
2. Connection handling - add pooling with keep-alive
3. Authentication - cache tokens, lazy refresh
4. Repeated operations - add caching with TTL
5. Sequential calls - batch with Promise.all()
6. Client instantiation - use singleton pattern

For each anti-pattern found:
- Measure current performance
- Implement optimized version
- Measure improvement
- Document the change

Target: Sub-second response times for common operations.
</Task>
```

## Search Queries Used

The updater uses these search patterns:

```
# API Updates
"{tool} API changelog 2025"
"{tool} API new features"
"{tool} API deprecation notice"
"{tool} OpenAPI spec"

# Security
"{tool} API vulnerability CVE"
"{tool} security advisory"
"{tool} authentication bypass"

# Community
"MCP server {tool}" site:github.com
"{tool} model context protocol"
"best {tool} API client"

# Dependencies
"{tool} SDK release notes"
"{tool} client library update"
```

## Update Categories

### 🔴 Critical (Apply Immediately)
- Security vulnerabilities (CVE)
- Authentication bypasses
- Data exposure risks
- Breaking API changes
- **Performance anti-patterns** (shell spawning, no connection reuse)

### 🟠 High Priority
- New major API features
- Deprecated endpoint replacements
- **Connection pooling / caching**
- Error handling fixes

### 🟡 Medium Priority
- New minor endpoints
- Documentation improvements
- Code quality enhancements
- Test coverage gaps

### 🟢 Low Priority
- Cosmetic improvements
- Optional features
- Optimization opportunities

## Documentation Output

### Confluence Page
Creates/updates page at: `Engineering/MCP Servers/{tool}/Changelog`

```markdown
# {Tool} MCP Changelog

## [1.2.0] - 2025-01-16

### Added
- New endpoint: `{tool}_new_feature` - Description

### Security
- Fixed CVE-2025-XXXX - Description

### Changed
- Updated {tool} SDK from 2.0 to 2.1

### Deprecated
- `{tool}_old_endpoint` - Use `{tool}_new_endpoint` instead
```

### GitHub Release
Creates release with:
- Version tag
- Changelog summary
- Migration notes if breaking changes
- Security advisory references

### Local Publish Tracking (MANDATORY - DO NOT SKIP)

**Every deployment MUST be tracked. Execute these commands:**

```bash
MCP_DIR="/path/to/mcp"  # Replace with actual path

# 1. Create tracking directory
mkdir -p "$MCP_DIR/.thesun"

# 2. CRITICAL: Add to gitignore BEFORE any commits
grep -q "^\.thesun/$" "$MCP_DIR/.gitignore" 2>/dev/null || echo ".thesun/" >> "$MCP_DIR/.gitignore"

# 3. Create or update publish-history.md
cat >> "$MCP_DIR/.thesun/publish-history.md" << EOF

## Update - $(date -Iseconds)

### Deployment Status
| Platform | Status | URL |
|----------|--------|-----|
| Confluence | [✅/⬜] | [url] |
| GitHub | [✅/⬜] | [url] |

### Changes Applied
- [List changes]

EOF
```

**Verification (REQUIRED before completing):**
```bash
# Must pass both checks
grep "\.thesun" "$MCP_DIR/.gitignore" && echo "✓ Gitignored"
test -f "$MCP_DIR/.thesun/publish-history.md" && echo "✓ Tracking exists"
```

**Why this matters:**
- Allows thesun to know where to update documentation next time
- Tracks history of all publish operations
- Creates audit trail for compliance
- **NEVER commits tracking to public repos** (gitignored)

### Skill Regeneration (MANDATORY)

**Every MCP update MUST regenerate its Claude skill.**

```bash
MCP_DIR="/path/to/mcp"
MCP_NAME=$(basename "$MCP_DIR" | sed 's/-mcp$//')
SKILL_FILE="$MCP_DIR/.claude-skill.md"

# Update or create skill
if [ -f "$SKILL_FILE" ]; then
  echo "Updating existing skill..."
  # Append new tools section if any
  # Update examples with new features
  # Add troubleshooting for new issues
else
  echo "Creating new skill..."
  # Generate skill following thesun PHASE 5.8 template
fi

# Install globally
cp "$SKILL_FILE" ~/.claude/skills/$MCP_NAME.md

echo "✓ Skill regenerated: ~/.claude/skills/$MCP_NAME.md"

# Track in publish history
echo "| $(date -Iseconds) | [version] | Skill updated | Local |" >> "$MCP_DIR/.thesun/publish-history.md"
```

**What to update in skills:**
- Add new tools to "Available Tools" section
- Create examples for new features
- Update authentication instructions if changed
- Add troubleshooting for new error patterns
- Update best practices based on improvements

**Why regenerate:**
- Claude needs current tool documentation
- New features need examples
- API changes need reflected in usage patterns
- Security updates need troubleshooting guides

## Scope

### Local MCPs (~/Scripts/mcp-servers/)
- Full update capability
- Can modify source code
- Run tests after changes
- Commit and push to GitHub

### Non-Local MCPs
- Report findings only
- Create issues on GitHub repo
- Suggest PRs for improvements
- Document in Confluence

## Configuration

Set these environment variables for documentation:

```bash
# Confluence integration
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
CONFLUENCE_SPACE_KEY=ENG
CONFLUENCE_PARENT_PAGE_ID=12345

# GitHub integration (for non-local MCPs)
GITHUB_TOKEN=ghp_xxx
```

## Scheduling

Recommended schedule:
- **Weekly**: Security-only scans
- **Monthly**: Full feature updates
- **On-demand**: After major API announcements

## Example Output

```json
{
  "mcps_checked": 10,
  "updates_found": 7,
  "updates_applied": 5,
  "performance_optimizations": 4,
  "security_fixes": 2,
  "new_features": 3,
  "performance_summary": {
    "total_time_saved": "47 minutes per typical workflow",
    "mcps_optimized": 4,
    "average_improvement": "12x faster"
  },
  "documentation": {
    "confluence_pages": 5,
    "github_releases": 3
  },
  "skipped": {
    "low_priority": 2,
    "non_local": 0
  },
  "details": [
    {
      "mcp": "akamai-mcp",
      "performance": {
        "before": "8 min",
        "after": "30 sec",
        "improvement": "16x",
        "changes": ["Connection pooling", "Token caching", "Parallel batching"]
      }
    }
  ]
}
```

## Related Skills

- `generate-mcp` - Create new MCP servers
- `fix-mcp` - Fix issues in existing MCPs
- `validate-mcp` - Validate MCP quality
- `research-api` - Research APIs before updating
