# Architecture Decision Records (ADRs)

> **Scope:** Key architectural decisions and their rationale
> **Format:** Lightweight ADR (Michael Nygard style)

## ADR Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-001 | Use Bob Instances for Build Isolation | Accepted | 2025-01 |
| ADR-002 | Model Selection Strategy | Accepted | 2025-01 |
| ADR-003 | OAuth 2.1 for Authentication | Accepted | 2025-01 |
| ADR-004 | SQLite for State Persistence | Accepted | 2025-01 |
| ADR-005 | Per-Job Watchers for Governance | Accepted | 2025-01 |
| ADR-006 | Configuration Abstraction | Accepted | 2025-01 |
| ADR-007 | Support API Key Authentication | Accepted | 2025-01 |
| ADR-008 | Haiku-Based Relevance Scoring | Accepted | 2025-01 |

---

## ADR-001: Use Bob Instances for Build Isolation

**Status:** Accepted

### Context

When generating MCP servers for multiple tools, we need to prevent:
- Cross-contamination of credentials between builds
- Cache pollution from previous builds
- State leakage that could affect build reproducibility

### Decision

Each tool build runs in its own isolated "bob" instance - a separate Claude Code session with:
- Isolated filesystem workspace
- Isolated environment variables
- Independent caches and state
- No shared memory between instances

### Consequences

**Positive:**
- Complete isolation prevents credential leaks
- Builds are reproducible
- Failures don't cascade to other builds
- Easy to reason about state

**Negative:**
- Higher resource usage (memory per instance)
- Startup overhead for each build
- Cannot share cached data between builds

**Risks:**
- Memory exhaustion with many concurrent builds
- Mitigated by: Global supervisor limiting concurrent instances

---

## ADR-002: Model Selection Strategy

**Status:** Accepted

### Context

Claude API offers multiple models (Opus, Sonnet, Haiku) with different cost/capability trade-offs. Using the most capable model for all tasks is wasteful; using the cheapest might produce poor results.

### Decision

Select model based on task type:

| Task Type | Model | Rationale |
|-----------|-------|-----------|
| Planning, architecture, security review | **Opus** | Critical decisions need maximum capability |
| Initial code generation, discovery | **Sonnet** | Good balance of quality and cost |
| Test iterations, bug fixes (pass 2+) | **Sonnet** | Bulk of work, cost-efficient |
| Simple validation, lookups | **Haiku** | Fast and cheap for simple tasks |

### Consequences

**Positive:**
- Significant cost reduction (est. 60-70%)
- Appropriate capability for each task
- Faster response for simple tasks

**Negative:**
- Added complexity in model selection logic
- Potential for incorrect model choice

**Risks:**
- Haiku may fail on edge cases
- Mitigated by: Automatic escalation to Sonnet on failure

---

## ADR-003: OAuth 2.1 for Authentication

**Status:** Accepted

### Context

Generated MCP servers need authentication. Options:
1. Pass client tokens through to APIs (simple but insecure)
2. Static API keys (common but no user context)
3. OAuth 2.1 with PKCE (secure, standard)

### Decision

Implement OAuth 2.1 following MCP Authorization Specification:
- PKCE (S256) required for all auth code flows
- Token audience validation (RFC 8707)
- NO token passthrough (architectural constraint)
- Support for Entra ID, Okta, Auth0, Keycloak

### Consequences

**Positive:**
- Industry standard security
- User context in tokens
- Token rotation and expiry
- Enterprise IdP compatibility

**Negative:**
- More complex than API keys
- Requires IdP configuration
- Not all APIs support OAuth

**Risks:**
- APIs that only support API keys
- Mitigated by: ADR-007 (Support API Key Authentication)

---

## ADR-004: SQLite for State Persistence

**Status:** Accepted

### Context

The orchestrator needs to persist:
- Build state and progress
- Checkpoints for recovery
- Metrics and cost tracking

Options: PostgreSQL, MongoDB, Redis, SQLite, File-based

### Decision

Use SQLite (via better-sqlite3):
- Embedded, zero-config database
- Single file for easy backup
- ACID compliant
- Sufficient for expected scale

### Consequences

**Positive:**
- No external database dependency
- Easy deployment and backup
- Good performance for single-node
- Portable across platforms

**Negative:**
- Single-node only (no replication)
- Not suitable for high concurrency
- Limited to ~100 concurrent writes

**Risks:**
- Scaling beyond single node
- Mitigated by: Future ADR for PostgreSQL migration path

---

## ADR-005: Per-Job Watchers for Governance

**Status:** Accepted

### Context

Autonomous builds can run away, consuming excessive:
- API costs (Claude API is charged per token)
- Time (stuck in infinite loops)
- Resources (memory, disk)

Need governance without bottlenecking builds.

### Decision

Implement two-tier governance:

1. **Per-Job Watcher** - One watcher per active build
   - Maintains full context for its job
   - Enforces phase timeouts (10 min default)
   - Tracks cost ($50 per job limit)
   - Can pause for human review

2. **Global Supervisor** - Watches all watchers
   - Enforces global limits ($200/hr, 10 concurrent)
   - System health monitoring
   - Emergency stop capability

### Consequences

**Positive:**
- Fine-grained control per build
- Global safety limits
- Cost predictability
- Human oversight when needed

**Negative:**
- Resource overhead for watchers
- Added complexity in coordination

**Risks:**
- Watcher itself could fail
- Mitigated by: Supervisor health-checks watchers

---

## ADR-006: Configuration Abstraction

**Status:** Accepted

### Context

Generated MCPs should be:
- Reusable across organizations
- Publishable as open source
- Safe to commit to public repos

### Decision

Enforce strict configuration abstraction:
- ALL company-specific data via environment variables
- NEVER hardcode URLs, domains, API keys, IPs
- Generate `.env.example` with documentation
- Validate config on startup with Zod schemas
- Secrets never logged (marked in schema)

### Consequences

**Positive:**
- MCPs are truly reusable
- Safe for public repositories
- Clear configuration documentation
- Runtime validation catches misconfig

**Negative:**
- More setup required for users
- Environment variable proliferation

**Risks:**
- Developers accidentally hardcode values
- Mitigated by: Automated scanning in security gates

---

## ADR-007: Support API Key Authentication

**Status:** Accepted

### Context

While OAuth 2.1 is preferred (ADR-003), many enterprise APIs only provide API keys:
- Dynatrace (Api-Token header)
- Datadog (DD-API-KEY header)
- Stripe (Basic Auth)
- PagerDuty (Token header)

### Decision

Support API key authentication alongside OAuth:
- Header-based (X-Api-Key, custom headers)
- Basic Auth (username:key or key:password patterns)
- Bearer tokens (static)
- Query parameters (least secure, but required by some)

Pre-configured patterns for common services.

### Consequences

**Positive:**
- Works with real-world APIs
- Simple to configure
- Covers most enterprise use cases

**Negative:**
- Less secure than OAuth (no expiry, no rotation)
- No user context
- If leaked, valid until manually revoked

**Risks:**
- API key exposure
- Mitigated by: Environment variables, log filtering, secret scanning

---

## ADR-008: Haiku-Based Relevance Scoring

**Status:** Accepted

### Context

Knowledge aggregation pulls from multiple sources (Jira, Confluence, ServiceNow, web search). Not all results are relevant, and including everything:
- Wastes context window
- Dilutes signal with noise
- Increases costs

### Decision

Use Claude Haiku to score search result relevance:
- Fast and cheap (~$0.001 per evaluation)
- Returns 0.0-1.0 relevance score
- Thresholds determine action:
  - < 0.3: Discard
  - 0.3-0.5: Extract key facts
  - 0.5-0.7: Compress
  - > 0.7: Keep full

### Consequences

**Positive:**
- Efficient context usage
- Reduced costs from irrelevant content
- Better signal-to-noise ratio

**Negative:**
- API call for each evaluation
- Latency in aggregation pipeline

**Risks:**
- Haiku misjudges relevance
- Mitigated by: Conservative thresholds, important items always kept

---

## Template for New ADRs

```markdown
## ADR-XXX: [Title]

**Status:** [Proposed | Accepted | Deprecated | Superseded]

### Context

[Describe the issue motivating this decision]

### Decision

[Describe the decision and its rationale]

### Consequences

**Positive:**
- [Benefit 1]
- [Benefit 2]

**Negative:**
- [Drawback 1]
- [Drawback 2]

**Risks:**
- [Risk and mitigation]
```

---

## Decision Log

| Date | Decision | Participants |
|------|----------|--------------|
| 2025-01 | Initial architecture established | Tim Schwarz |
| 2025-01 | Security module added | Tim Schwarz |
| 2025-01 | API key auth support | Tim Schwarz |
