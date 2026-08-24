# TOGAF Architecture Mapping

> **Scope:** Enterprise architecture alignment with TOGAF ADM
> **Framework:** TOGAF 10

## Architecture Development Method (ADM) Mapping

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TOGAF ADM Phases                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│              ┌─────────────────────────────────┐                    │
│              │      Preliminary Phase          │                    │
│              │   (Architecture Capability)     │                    │
│              └────────────────┬────────────────┘                    │
│                               │                                      │
│              ┌────────────────▼────────────────┐                    │
│              │     Phase A: Architecture       │                    │
│              │           Vision                │                    │
│              └────────────────┬────────────────┘                    │
│                               │                                      │
│     ┌─────────────────────────┼─────────────────────────┐          │
│     │                         │                         │          │
│     ▼                         ▼                         ▼          │
│ ┌────────┐              ┌────────┐              ┌────────┐         │
│ │Phase B │              │Phase C │              │Phase D │         │
│ │Business│              │  Info  │              │  Tech  │         │
│ │ Arch   │              │Systems │              │  Arch  │         │
│ └────┬───┘              └────┬───┘              └────┬───┘         │
│      └──────────────┬────────┴──────────────────────┘              │
│                     │                                               │
│              ┌──────▼──────┐                                       │
│              │   Phase E   │                                       │
│              │ Opportunities│                                       │
│              │& Solutions  │                                       │
│              └──────┬──────┘                                       │
│                     │                                               │
│              ┌──────▼──────┐                                       │
│              │   Phase F   │                                       │
│              │  Migration  │                                       │
│              │  Planning   │                                       │
│              └──────┬──────┘                                       │
│                     │                                               │
│              ┌──────▼──────┐                                       │
│              │   Phase G   │                                       │
│              │Implementation│                                       │
│              │ Governance  │                                       │
│              └──────┬──────┘                                       │
│                     │                                               │
│              ┌──────▼──────┐                                       │
│              │   Phase H   │                                       │
│              │Architecture │                                       │
│              │Change Mgmt  │                                       │
│              └─────────────┘                                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Phase Mapping

### Phase A: Architecture Vision

| Element | thesun Implementation |
|---------|----------------------|
| **Stakeholders** | Developers, Security/Ops, Platform Teams |
| **Business Goals** | Reduce MCP development time from weeks to hours |
| **Architecture Vision** | Autonomous MCP generation with security-first design |
| **Constraints** | OAuth 2.1 compliance, enterprise IdP integration |

**Vision Statement:**
> Enable near-zero-involvement MCP server generation by combining AI-powered code generation with exhaustive API discovery, automated testing, and enterprise-grade security controls.

### Phase B: Business Architecture

| Business Capability | thesun Component |
|--------------------|------------------|
| Tool Integration | MCP Server Generation |
| API Management | Discovery Module |
| Developer Experience | Claude Code Plugin |
| Compliance | Security Module |
| Operations | Governance Layer |

**Business Process:**
```
Request → Discovery → Generation → Testing → Security → Release
   │                                                      │
   └──────────────────── Feedback Loop ───────────────────┘
```

### Phase C: Information Systems Architecture

#### Data Architecture

| Data Entity | Owner | Storage | Classification |
|-------------|-------|---------|----------------|
| Build State | Orchestrator | SQLite | Internal |
| API Specs | Discovery | Cache | Public |
| Generated Code | Generator | Filesystem | Public |
| Auth Tokens | Security | Memory | Secret |
| Metrics | Observability | Database | Internal |

#### Application Architecture

| Application | Function | Integration |
|-------------|----------|-------------|
| Plugin | User interface | Claude Code |
| Orchestrator | Coordination | Internal |
| Bob Manager | Isolation | Internal |
| Knowledge Aggregator | Context | Jira, Confluence, ServiceNow |

### Phase D: Technology Architecture

| Technology Component | Product/Framework |
|---------------------|-------------------|
| Runtime | Node.js 18+ |
| Language | TypeScript |
| Protocol | MCP (Model Context Protocol) |
| Database | SQLite |
| Validation | Zod |
| Testing | Vitest |
| Logging | Winston |

**Technology Standards:**
- TLS 1.3 for all external connections
- OAuth 2.1 for authentication
- REST/JSON for API integration
- ESM modules for code organization

### Phase E: Opportunities and Solutions

| Opportunity | Solution | Priority |
|-------------|----------|----------|
| Reduce development time | Autonomous MCP generation | High |
| Ensure API coverage | Exhaustive discovery | High |
| Maintain security | Automated scanning | High |
| Learn from failures | Self-improvement system | Medium |
| Scale operations | Horizontal scaling | Low |

### Phase F: Migration Planning

| Capability | Current State | Target State | Gap |
|------------|---------------|--------------|-----|
| MCP Development | Manual | Autonomous | Large |
| API Discovery | Ad-hoc | Systematic | Large |
| Security Testing | Optional | Required | Medium |
| Knowledge Reuse | None | Integrated | Large |

**Migration Path:**
1. Deploy core platform
2. Integrate with Claude Code
3. Connect knowledge sources
4. Enable self-improvement

### Phase G: Implementation Governance

| Governance Control | Implementation |
|-------------------|----------------|
| Build Quality | Security gates |
| Cost Control | Watcher limits |
| Resource Limits | Supervisor oversight |
| Compliance | OAuth 2.1 enforcement |

### Phase H: Architecture Change Management

| Change Type | Process |
|-------------|---------|
| API Spec Updates | Automatic drift detection |
| Security Patches | Dependency scanning |
| Feature Additions | Self-improvement system |
| Bug Fixes | Feedback loop learning |

## Architecture Building Blocks (ABBs)

### Business ABBs

| ABB | Description |
|-----|-------------|
| MCP Generation | Create MCP servers from API specs |
| API Discovery | Find and catalog API endpoints |
| Quality Assurance | Automated testing and validation |
| Security Compliance | Enforce security standards |

### Application ABBs

| ABB | Component |
|-----|-----------|
| User Interface | Claude Code Plugin |
| Workflow Engine | Orchestrator |
| Execution Environment | Bob Manager |
| Knowledge Base | Knowledge Aggregator |
| Security Services | Security Module |

### Technology ABBs

| ABB | Technology |
|-----|------------|
| Runtime Platform | Node.js |
| Data Storage | SQLite |
| API Protocol | REST/HTTP |
| Message Format | JSON |
| Authentication | OAuth 2.1 |

## Solution Building Blocks (SBBs)

| SBB | Implementation |
|-----|----------------|
| Plugin Interface | `src/.claude-plugin/` |
| State Machine | `src/orchestrator/state-machine.ts` |
| Instance Isolation | `src/bob/isolation.ts` |
| OAuth Handler | `src/security/auth-manager.ts` |
| API Key Handler | `src/security/api-key-auth.ts` |
| Input Validation | `src/security/hardening.ts` |

## Architecture Repository

| Artifact | Location | Purpose |
|----------|----------|---------|
| Context Diagram | `docs/architecture/context.md` | C4 Level 1 |
| Container Diagram | `docs/architecture/containers.md` | C4 Level 2 |
| Component Diagram | `docs/architecture/components.md` | C4 Level 3 |
| Data Flows | `docs/architecture/data-flows.md` | DFD |
| Security Model | `docs/architecture/security.md` | Threat model |
| Decisions | `docs/architecture/decisions.md` | ADRs |

## Enterprise Continuum

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Enterprise Continuum                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Foundation         Common          Industry        Organization    │
│  Architecture       Systems         Architecture    Specific        │
│                     Architecture                                     │
│                                                                      │
│  ┌─────────┐       ┌─────────┐     ┌─────────┐    ┌─────────┐     │
│  │  MCP    │  ──►  │  OAuth  │ ──► │  API    │ ──►│ thesun  │     │
│  │Protocol │       │  2.1    │     │  Mgmt   │    │Platform │     │
│  └─────────┘       └─────────┘     └─────────┘    └─────────┘     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Capability Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                    thesun Capability Model                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Level 1: Strategic                                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │              Autonomous Tool Integration                     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│  Level 2: Core               │                                       │
│  ┌──────────┬────────────────┼────────────────┬──────────────┐     │
│  │ Discovery│   Generation   │    Testing     │   Security   │     │
│  └──────────┴────────────────┴────────────────┴──────────────┘     │
│                              │                                       │
│  Level 3: Supporting         │                                       │
│  ┌──────────┬────────────────┼────────────────┬──────────────┐     │
│  │Knowledge │   Orchestration│   Governance   │ Observability│     │
│  └──────────┴────────────────┴────────────────┴──────────────┘     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Stakeholder Concerns

| Stakeholder | Concerns | Addressed By |
|-------------|----------|--------------|
| **Developers** | Speed, quality, usability | Plugin UX, automated testing |
| **Security** | Compliance, vulnerabilities | Security gates, OAuth 2.1 |
| **Operations** | Cost, reliability, monitoring | Governance layer, observability |
| **Architecture** | Standards, maintainability | TOGAF alignment, ADRs |
| **Management** | ROI, risk | Cost controls, audit trail |

## Architecture Principles

| Principle | Rationale | Implications |
|-----------|-----------|--------------|
| **Security First** | Trust is foundational | All code passes security gates |
| **Isolation** | Prevent cross-contamination | Each build in separate bob instance |
| **Configuration Abstraction** | Enable reuse | No hardcoded company data |
| **Observability** | Enable operations | Structured logging, metrics |
| **Self-Improvement** | Continuous learning | Feedback loops, pattern capture |
