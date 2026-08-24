# thesun Architecture Documentation

> **Last Updated:** January 2025
> **Version:** 0.1.0
> **Status:** Production-ready framework

## Overview

**thesun** is a security-first autonomous platform for generating, testing, and operating MCP (Model Context Protocol) servers with near-zero human involvement.

## Documentation Index

| Document | Description |
|----------|-------------|
| [System Context](context.md) | C4 Level 1 - External systems and actors |
| [Containers](containers.md) | C4 Level 2 - High-level technology choices |
| [Components](components.md) | C4 Level 3 - Internal module structure |
| [Deployment](deployment.md) | Environment configurations and infrastructure |
| [Data Flows](data-flows.md) | Data paths, trust boundaries, sensitive data |
| [Security](security.md) | Threat model, controls, compliance |
| [TOGAF Mapping](togaf-mapping.md) | Enterprise architecture alignment |
| [Decisions](decisions.md) | Architecture Decision Records (ADRs) |

## Quick Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                         thesun Platform                              │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Claude     │  │  Orchestrator │  │  Governance  │              │
│  │   Plugin     │──│  + State      │──│  (Watchers)  │              │
│  │  Interface   │  │   Machine     │  │              │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│         │                 │                  │                      │
│  ┌──────▼─────────────────▼──────────────────▼──────────────────┐  │
│  │                    Bob Instance Manager                       │  │
│  │            (Isolated Claude Code Sessions)                    │  │
│  └───────────────────────┬──────────────────────────────────────┘  │
│                          │                                          │
│  ┌───────────┬───────────┼───────────┬───────────┬────────────┐   │
│  │ Discovery │ Generator │  Testing  │ Security  │ Knowledge  │   │
│  │  Module   │  Module   │  Module   │  Module   │ Aggregator │   │
│  └───────────┴───────────┴───────────┴───────────┴────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌───────────┐        ┌───────────┐        ┌───────────┐
  │  Target   │        │ Enterprise│        │  Output   │
  │   APIs    │        │  Sources  │        │   MCPs    │
  │(Dynatrace,│        │(Jira, SNOW│        │ (GitHub)  │
  │ Stripe..) │        │Confluence)│        │           │
  └───────────┘        └───────────┘        └───────────┘
```

## Key Architectural Decisions

1. **Isolated Build Environments** - Each MCP build runs in a separate "bob" instance (Claude Code session) to prevent cross-contamination
2. **Security-First Design** - OAuth 2.1 compliance, input sanitization, no token passthrough
3. **Governance Layer** - Per-job watchers with cost/time limits prevent runaway processes
4. **Model Selection Strategy** - Opus for planning, Sonnet for implementation, Haiku for validation
5. **Configuration Abstraction** - Generated MCPs are generic and publishable (no hardcoded secrets)

## Technology Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 18+ |
| Protocol | MCP (Model Context Protocol) |
| Testing | Vitest |
| Validation | Zod |
| Logging | Winston |
| Build | TSC with ESM modules |

## Getting Started

```bash
# Install and build
npm install && npm run build

# Use as Claude Code plugin
/mcp dynatrace

# Check status
/sun-status
```

## Contact

- **Maintainer:** Tim Schwarz
- **Repository:** [github.com/schwarztim/thesun](https://github.com/schwarztim/thesun)
