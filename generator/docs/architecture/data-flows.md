# Data Flow Diagrams

> **Scope:** Data paths, transformations, and trust boundaries
> **Sensitivity:** Classification of data elements

## High-Level Data Flow

```mermaid
flowchart TB
    subgraph Inputs
        DEV[Developer Command]
        APIS[Target API Specs]
        ENT[Enterprise Knowledge]
        AUTH[Auth Credentials]
    end

    subgraph Processing
        ORCH[Orchestrator]
        BOB[Bob Instances]
        CLAUDE[Claude API]
    end

    subgraph Outputs
        CODE[Generated MCP]
        DOCS[Documentation]
        METRICS[Metrics/Logs]
    end

    DEV --> ORCH
    APIS --> BOB
    ENT --> BOB
    AUTH --> BOB

    ORCH --> BOB
    BOB <--> CLAUDE

    BOB --> CODE
    BOB --> DOCS
    ORCH --> METRICS
```

## Build Data Flow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Plugin as Plugin
    participant Orch as Orchestrator
    participant Bob as Bob Instance
    participant Disc as Discovery
    participant Gen as Generator
    participant Claude as Claude API
    participant Target as Target API
    participant Output as Output Dir

    Dev->>Plugin: /mcp dynatrace
    Plugin->>Orch: queueBuild(spec)
    Orch->>Bob: createInstance()

    rect rgb(200, 220, 240)
        Note over Bob,Target: Discovery Phase
        Bob->>Disc: startDiscovery()
        Disc->>Target: GET /openapi.json
        Target-->>Disc: OpenAPI spec
        Disc->>Claude: Analyze spec
        Claude-->>Disc: Endpoint analysis
        Disc-->>Bob: DiscoveryResult
    end

    rect rgb(220, 240, 200)
        Note over Bob,Claude: Generation Phase
        Bob->>Gen: generateMCP(discovery)
        Gen->>Claude: Generate tools
        Claude-->>Gen: Tool implementations
        Gen->>Claude: Generate tests
        Claude-->>Gen: Test suites
        Gen-->>Bob: GeneratedCode
    end

    rect rgb(240, 220, 200)
        Note over Bob,Output: Output Phase
        Bob->>Output: Write MCP code
        Bob->>Output: Write tests
        Bob->>Output: Write docs
    end

    Bob-->>Orch: buildComplete
    Orch-->>Plugin: success
    Plugin-->>Dev: MCP ready
```

## Data Classification

### Sensitivity Levels

| Level | Description | Examples | Handling |
|-------|-------------|----------|----------|
| **PUBLIC** | No restrictions | Generated code, docs | Can be published |
| **INTERNAL** | Company internal | Jira issues, patterns | Not published externally |
| **CONFIDENTIAL** | Restricted access | API keys, tokens | Encrypted, never logged |
| **SECRET** | Highest protection | OAuth secrets | Vault only, never in memory |

### Data Elements by Sensitivity

| Data Element | Classification | Storage | Transmission |
|--------------|----------------|---------|--------------|
| Generated MCP code | PUBLIC | Workspace | Git push |
| OpenAPI specs | PUBLIC | Cache | HTTPS |
| Build logs | INTERNAL | File | Local only |
| Jira content | INTERNAL | Memory/Cache | HTTPS (authenticated) |
| API keys | CONFIDENTIAL | Env vars | HTTPS |
| OAuth tokens | SECRET | Memory only | HTTPS |
| Refresh tokens | SECRET | Secure store | Never |

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DEVELOPER TRUST BOUNDARY                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Plugin (User Interface)                    │    │
│  │  - Receives commands                                         │    │
│  │  - Displays status                                           │    │
│  │  - No sensitive data storage                                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    COMMAND VALIDATION
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                    ORCHESTRATOR TRUST BOUNDARY                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Orchestrator (Coordinator)                 │    │
│  │  - Validates all inputs                                      │    │
│  │  - Enforces quotas                                           │    │
│  │  - No direct API access                                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    ISOLATION BOUNDARY
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                    BOB INSTANCE TRUST BOUNDARY                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Bob Instance (Isolated)                    │    │
│  │  - Has target API credentials                                │    │
│  │  - Isolated filesystem                                       │    │
│  │  - Isolated environment                                      │    │
│  │  - Generated code is UNTRUSTED until validated              │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    NETWORK BOUNDARY (TLS)
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                    EXTERNAL TRUST BOUNDARY                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Claude  │  │  GitHub  │  │  Target  │  │Enterprise│           │
│  │   API    │  │          │  │  APIs    │  │ Sources  │           │
│  │ TRUSTED  │  │ TRUSTED  │  │ VARIABLE │  │ TRUSTED  │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

## Credential Flow

```mermaid
flowchart LR
    subgraph Developer
        ENV[Environment Variables]
    end

    subgraph Orchestrator
        VAL[Credential Validator]
    end

    subgraph Bob["Bob Instance"]
        ISO[Isolated Env]
        REQ[API Requests]
    end

    subgraph External
        API[Target API]
        IDP[Identity Provider]
    end

    ENV -->|Read| VAL
    VAL -->|Copy to isolated env| ISO
    ISO -->|Inject headers| REQ
    REQ -->|Bearer/API-Key| API
    REQ -->|OAuth| IDP

    style ENV fill:#f9f,stroke:#333
    style ISO fill:#ff9,stroke:#333
```

### Credential Rules

1. **Never logged**: Credentials filtered from all log output
2. **Never in code**: Generated MCPs use env var references
3. **Never cached**: Tokens held in memory only, cleared on completion
4. **Never shared**: Each bob instance gets isolated credentials
5. **Validated early**: Credentials checked before build starts

## Context Data Flow

```mermaid
flowchart TB
    subgraph Sources
        JIRA[Jira Issues]
        CONF[Confluence Docs]
        SNOW[ServiceNow Incidents]
        WEB[Web Search]
    end

    subgraph Filtering
        REL[Relevance Evaluator]
        CTX[Context Manager]
    end

    subgraph Usage
        PROMPT[Claude Prompt]
        GEN[Code Generation]
    end

    JIRA --> REL
    CONF --> REL
    SNOW --> REL
    WEB --> REL

    REL -->|Score < 0.3| DISCARD[Discard]
    REL -->|Score 0.3-0.5| EXTRACT[Extract Facts]
    REL -->|Score 0.5-0.7| COMPRESS[Compress]
    REL -->|Score > 0.7| KEEP[Keep Full]

    EXTRACT --> CTX
    COMPRESS --> CTX
    KEEP --> CTX

    CTX -->|Budget Managed| PROMPT
    PROMPT --> GEN
```

### Token Budget Enforcement

| Budget Type | Limit | Purpose |
|-------------|-------|---------|
| Per-search | 10,000 tokens | Limit individual queries |
| Total context | 50,000 tokens | All accumulated context |
| Reserved | 20,000 tokens | Reasoning space |
| Warning | 80% | Trigger pruning |

## Generated Output Data Flow

```mermaid
flowchart LR
    subgraph Generation
        GEN[Generator]
    end

    subgraph Validation
        LINT[ESLint]
        TEST[Tests]
        SEC[Security Scan]
    end

    subgraph Output
        CODE[MCP Code]
        TESTS[Test Suite]
        DOCS[Documentation]
        ENV[.env.example]
    end

    subgraph Publish
        GIT[GitHub PR]
        CONF[Confluence]
    end

    GEN --> LINT
    LINT --> TEST
    TEST --> SEC

    SEC -->|Pass| CODE
    SEC -->|Pass| TESTS
    SEC -->|Pass| DOCS
    SEC -->|Pass| ENV

    CODE --> GIT
    DOCS --> CONF
```

### Output Sanitization

All generated output is sanitized before writing:

| Check | Action |
|-------|--------|
| Hardcoded secrets | Block build, alert |
| Internal URLs | Replace with env vars |
| API keys | Replace with env vars |
| IP addresses | Replace with env vars |
| Email addresses | Replace with placeholders |

## Logging Data Flow

```mermaid
flowchart TB
    subgraph Sources
        ORCH_LOG[Orchestrator Events]
        BOB_LOG[Bob Instance Logs]
        GOV_LOG[Governance Alerts]
    end

    subgraph Processing
        FILTER[Sensitive Data Filter]
        FORMAT[JSON Formatter]
        CORR[Correlation ID Injection]
    end

    subgraph Destinations
        FILE[Log Files]
        CONSOLE[Console]
        METRICS[Metrics]
    end

    ORCH_LOG --> FILTER
    BOB_LOG --> FILTER
    GOV_LOG --> FILTER

    FILTER --> FORMAT
    FORMAT --> CORR

    CORR --> FILE
    CORR --> CONSOLE
    CORR --> METRICS
```

### Log Filtering Rules

| Pattern | Action |
|---------|--------|
| `*_API_KEY=*` | Redact value |
| `Authorization:*` | Redact value |
| `Bearer *` | Redact token |
| `password*` | Redact value |
| `secret*` | Redact value |
| `token*` | Redact value |

## State Persistence Data Flow

```mermaid
flowchart LR
    subgraph Runtime
        SM[State Machine]
        SCHED[Scheduler]
        WATCH[Watchers]
    end

    subgraph Persistence
        PERSIST[Persistence Layer]
        SQLITE[(SQLite)]
    end

    subgraph Recovery
        RESTORE[State Restore]
        RESUME[Build Resume]
    end

    SM -->|State changes| PERSIST
    SCHED -->|Job queue| PERSIST
    WATCH -->|Checkpoints| PERSIST

    PERSIST -->|Write| SQLITE
    SQLITE -->|Read| RESTORE
    RESTORE --> RESUME
```

### Persisted Data

| Table | Data | Retention |
|-------|------|-----------|
| `builds` | Build metadata, status | 90 days |
| `checkpoints` | Progress snapshots | Until build complete |
| `metrics` | Cost, duration stats | 1 year |
| `errors` | Failure patterns | 1 year |
