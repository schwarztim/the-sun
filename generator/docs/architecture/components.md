# Component Diagram (C4 Level 3)

> **Scope:** Internal structure of key containers
> **Primary Elements:** Classes, modules, and their relationships

## Orchestrator Components

```mermaid
C4Component
    title Component Diagram - Orchestrator

    Container_Boundary(orch, "Orchestrator") {
        Component(entry, "Entry Point", "index.ts", "Main orchestrator API, event handlers")
        Component(sm, "State Machine", "state-machine.ts", "XState-based build lifecycle")
        Component(sched, "Scheduler", "scheduler.ts", "Parallel build scheduling, resource limits")
        Component(persist, "Persistence", "persistence.ts", "SQLite state storage, checkpoints")
        Component(events, "Event Bus", "events.ts", "Internal pub/sub for coordination")
    }

    Rel(entry, sm, "Controls lifecycle")
    Rel(entry, sched, "Queues builds")
    Rel(sm, persist, "Persists state")
    Rel(sched, events, "Emits events")
    Rel(sm, events, "State transitions")
```

### State Machine States

```
                    ┌─────────────────┐
                    │     QUEUED      │
                    └────────┬────────┘
                             │ startBuild()
                    ┌────────▼────────┐
                    │   DISCOVERY     │◄────────┐
                    └────────┬────────┘         │
                             │ discoveryComplete │
                    ┌────────▼────────┐         │
                    │   GENERATION    │         │ loopBack
                    └────────┬────────┘         │
                             │ generationComplete│
                    ┌────────▼────────┐         │
                    │    TESTING      │─────────┘
                    └────────┬────────┘
                             │ testsPass
                    ┌────────▼────────┐
                    │   OPTIMIZATION  │
                    └────────┬────────┘
                             │ optimized
                    ┌────────▼────────┐
                    │    COMPLETE     │
                    └─────────────────┘
```

## Bob Instance Manager Components

```mermaid
C4Component
    title Component Diagram - Bob Instance Manager

    Container_Boundary(bob, "Bob Instance Manager") {
        Component(mgr, "Instance Manager", "instance-manager.ts", "Create, track, destroy instances")
        Component(worktree, "Worktree Manager", "instance-manager.ts", "Git worktree isolation for parallel builds")
        Component(inherit, "Inheritance Handler", "instance-manager.ts", "MCP server and plugin inheritance")
        Component(store, "Session Store", "session-store.ts", "Active session tracking, env vars")
        Component(iso, "Isolation", "isolation.ts", "Filesystem, env, process isolation")
        Component(orch_bob, "Bob Orchestrator", "bob-orchestrator.ts", "Parent-child hierarchy, plugin refresh")
    }

    Rel(mgr, worktree, "Creates worktrees")
    Rel(mgr, inherit, "Configures inheritance")
    Rel(mgr, store, "Tracks sessions")
    Rel(mgr, iso, "Enforces isolation")
    Rel(orch_bob, mgr, "Manages hierarchy")
    Rel(orch_bob, store, "Sub-bob tracking")
```

### Git Worktree Support (Parallel Builds)

Each bob instance can use a dedicated git worktree for true parallel isolation:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Git Worktree Architecture                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Main Repo (/tmp/thesun/builds)                                     │
│       │                                                              │
│       ├── .git/worktrees/                                           │
│       │       ├── build-tesla-1234/                                 │
│       │       ├── build-stripe-5678/                                │
│       │       └── build-jira-9012/                                  │
│       │                                                              │
│       └── (main branch files)                                       │
│                                                                      │
│  Worktree Directories (isolated):                                   │
│       /tmp/thesun/worktrees/bob-tesla-abc/  ← Bob Instance A       │
│       /tmp/thesun/worktrees/bob-stripe-def/ ← Bob Instance B       │
│       /tmp/thesun/worktrees/bob-jira-ghi/   ← Bob Instance C       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### MCP Server Inheritance

Bob instances can inherit user's MCP servers for knowledge access:

| Inherited MCP | Purpose |
|---------------|---------|
| **Confluence** | Search documentation, patterns, runbooks |
| **Jira** | Find related issues, solutions |
| **Akamai** | CDN/security config knowledge |
| **Teams** | Communication context |
| **Elastic** | Log analysis patterns |

### Instance Lifecycle

| State | Description | Transitions |
|-------|-------------|-------------|
| **CREATED** | Instance initialized, workspace/worktree allocated | → RUNNING |
| **RUNNING** | Claude Code session active | → PAUSED, COMPLETED, FAILED |
| **PAUSED** | Suspended for human review | → RUNNING, TERMINATED |
| **COMPLETED** | Build finished successfully | → DESTROYED |
| **FAILED** | Build failed after retries | → DESTROYED |
| **DESTROYED** | Resources cleaned up, worktree removed | Terminal |

## Governance Components

```mermaid
C4Component
    title Component Diagram - Governance Layer

    Container_Boundary(gov, "Governance Layer") {
        Component(watch, "Job Watcher", "job-watcher.ts", "Per-job monitoring, limits, checkpoints")
        Component(super, "Supervisor", "supervisor.ts", "Global oversight, emergency stop")
        Component(metrics, "Metrics Collector", "metrics.ts", "Cost, time, API usage tracking")
        Component(alerts, "Alert Manager", "alerts.ts", "Threshold notifications")
    }

    Rel(super, watch, "Monitors all watchers")
    Rel(watch, metrics, "Reports metrics")
    Rel(metrics, alerts, "Triggers alerts")
    Rel(super, alerts, "Emergency broadcasts")
```

### Watcher Responsibilities

| Responsibility | Implementation | Threshold |
|----------------|----------------|-----------|
| **Progress Tracking** | Checkpoint system | Every phase completion |
| **Time Limits** | Phase timeout timers | 10 min per phase |
| **Cost Control** | API call cost aggregation | $50 per job |
| **Loop Detection** | Iteration counter | 5 max retries |
| **Context Monitoring** | Token usage tracking | 80% budget warning |

## Security Module Components

```mermaid
C4Component
    title Component Diagram - Security Module

    Container_Boundary(sec, "Security Module") {
        Component(auth, "Auth Manager", "auth-manager.ts", "OAuth 2.1, PKCE, token validation")
        Component(apikey, "API Key Auth", "api-key-auth.ts", "Header, basic auth, bearer patterns")
        Component(hard, "Hardening", "hardening.ts", "Input sanitization, scope minimization")
        Component(threat, "Threat Model", "threat-model.ts", "Auto-generated threat analysis")
    }

    Rel(auth, hard, "Validates input")
    Rel(apikey, hard, "Validates input")
    Rel(auth, threat, "Informs model")
    Rel(apikey, threat, "Informs model")
```

### Auth Manager Flow

```
┌───────────────────────────────────────────────────────────────────┐
│                        OAuth 2.1 Flow                              │
├───────────────────────────────────────────────────────────────────┤
│  1. Client requests authorization                                  │
│  2. Auth Manager generates PKCE challenge (S256)                  │
│  3. Redirect to IdP (Entra ID, Okta, Auth0, Keycloak)            │
│  4. User authenticates at IdP                                     │
│  5. IdP returns auth code                                         │
│  6. Auth Manager exchanges code + verifier for tokens             │
│  7. Validate token audience (RFC 8707)                            │
│  8. Store refresh token securely                                  │
│  9. Return access token (15-30 min lifetime)                      │
└───────────────────────────────────────────────────────────────────┘
```

## Discovery Module Components

```mermaid
C4Component
    title Component Diagram - Discovery Module

    Container_Boundary(disc, "Discovery Module") {
        Component(web, "Web Research", "web-research.ts", "Search for docs, existing MCPs")
        Component(spec, "OpenAPI Fetcher", "openapi-fetcher.ts", "Download and validate specs")
        Component(mapper, "Endpoint Mapper", "endpoint-mapper.ts", "Enumerate all endpoints")
        Component(gap, "Gap Analyzer", "gap-analyzer.ts", "Compare against references")
    }

    Rel(web, spec, "Finds spec URLs")
    Rel(spec, mapper, "Provides specs")
    Rel(mapper, gap, "Endpoint list")
    Rel(gap, web, "Research gaps")
```

### Discovery Process

1. **Web Research** → Search for existing MCPs, vendor documentation
2. **Spec Fetching** → Download OpenAPI/Swagger from official sources
3. **Endpoint Mapping** → Parse specs, enumerate ALL endpoints
4. **Gap Analysis** → Compare against reference implementations
5. **Validation** → Test discovered endpoints with live API

## Generator Module Components

```mermaid
C4Component
    title Component Diagram - Generator Module

    Container_Boundary(gen, "Generator Module") {
        Component(tool, "Tool Generator", "tool-generator.ts", "Generate MCP tools from operations")
        Component(auth_gen, "Auth Generator", "auth-generator.ts", "Generate auth handlers")
        Component(test_gen, "Test Generator", "test-generator.ts", "Generate test suites")
        Component(tmpl, "Templates", "templates/", "TypeScript MCP server templates")
    }

    Rel(tool, tmpl, "Uses templates")
    Rel(auth_gen, tmpl, "Uses templates")
    Rel(test_gen, tool, "Tests generated tools")
```

## Knowledge Aggregator Components

```mermaid
C4Component
    title Component Diagram - Knowledge Aggregator

    Container_Boundary(know, "Knowledge Aggregator") {
        Component(jira, "Jira Client", "", "Issues, solutions, patterns")
        Component(conf, "Confluence Client", "", "Docs, runbooks, architecture")
        Component(snow, "ServiceNow Client", "", "Incidents, problems, changes")
        Component(search, "Web Search Client", "", "External documentation")
        Component(cache, "Result Cache", "", "Reduces duplicate queries")
    }

    Rel(jira, cache, "Caches results")
    Rel(conf, cache, "Caches results")
    Rel(snow, cache, "Caches results")
    Rel(search, cache, "Caches results")
```

## Context Manager Components

```mermaid
C4Component
    title Component Diagram - Context Manager

    Container_Boundary(ctx, "Context Manager") {
        Component(budget, "Token Budget", "", "Track and enforce limits")
        Component(relevance, "Relevance Evaluator", "relevance-evaluator.ts", "Haiku-based scoring")
        Component(filter, "Content Filter", "", "Compress, extract, evict")
        Component(store_ctx, "Context Store", "", "Priority queue of context items")
    }

    Rel(relevance, filter, "Scores inform filtering")
    Rel(filter, store_ctx, "Adds filtered content")
    Rel(budget, store_ctx, "Enforces limits")
    Rel(budget, filter, "Triggers eviction")
```

### Relevance Scoring

| Score Range | Action | Example |
|-------------|--------|---------|
| **< 0.3** | Discard | Unrelated search results |
| **0.3 - 0.5** | Extract key facts | Tangentially related docs |
| **0.5 - 0.7** | Compress | Relevant but verbose |
| **> 0.7** | Keep full | Directly applicable |

## Component Dependencies

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Dependency Graph                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    Plugin ──────► Orchestrator ──────► Bob Manager                  │
│                        │                    │                        │
│                        ▼                    ▼                        │
│                   Governance ◄──────── Discovery                    │
│                        │                    │                        │
│                        ▼                    ▼                        │
│                   Knowledge ◄──────── Generator                     │
│                        │                    │                        │
│                        ▼                    ▼                        │
│                    Context ◄──────── Security                       │
│                        │                    │                        │
│                        ▼                    ▼                        │
│                   Observability ◄──── Testing                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Technology Implementation

| Component | Library | Purpose |
|-----------|---------|---------|
| State Machine | XState | Build lifecycle management |
| Validation | Zod | Runtime type safety |
| Logging | Winston | Structured logging |
| Database | better-sqlite3 | Embedded persistence |
| HTTP | node-fetch | API calls |
| MCP | @modelcontextprotocol/sdk | Protocol implementation |

