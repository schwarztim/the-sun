# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**thesun** is an autonomous MCP (Model Context Protocol) server generation platform. Given an API/service name, it researches, generates, validates, and registers a complete MCP server with near-zero human intervention.

### Core Flow

```
Target API → Preflight → Discovery → Pattern Detection → Auth → Generate → Validate → Register
```

### Three Modes

| Mode   | Trigger                                 | Purpose                               |
| ------ | --------------------------------------- | ------------------------------------- |
| CREATE | `thesun({ target: "stripe" })`          | Generate new MCP from scratch         |
| FIX    | `thesun({ target: "x", fix: "/path" })` | Fix existing broken MCP               |
| BATCH  | `thesun({ target: "a, b, c" })`         | Parallel generation via bob instances |

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode compilation
npm test             # Run all tests (vitest)
npm test -- src/auth # Run tests in specific directory
npm run test:watch   # Interactive test mode
npm run test:coverage # Coverage report
npm run lint         # ESLint
npm run format       # Prettier
npm run mcp          # Start MCP server (stdio)
```

## Architecture

### Entry Points

- **`src/mcp-server/index.ts`** - Main MCP server, exposes single `thesun` tool
- **`src/cli/index.ts`** - CLI entry point (not fully implemented)

### Module Structure (Actual Implementation)

```
src/
├── mcp-server/         # MCP server entry point
├── preflight/          # DependencyChecker - validates Playwright MCP + Firefox browser
├── discovery/          # McpRegistrySearch - searches npm, GitHub, Smithery for existing MCPs
├── auth/               # CredentialWizard - browser-based OAuth/API key capture
├── patterns/           # PatternEngine - applies known API patterns (Stripe, GitHub, AWS)
├── health/             # SelfHealingModule - health monitoring, auto-recovery
├── validation/         # ValidationGate - 4-phase validation (build, endpoints, auth, integration)
├── cache/              # SmartCache - incremental updates, spec caching
├── context/            # ContextManager - relevance filtering for search results
├── security/           # Auth generators, hardening utilities
├── tracking/           # RequirementTracker, DiscoveryLogger
├── governance/         # JobWatcher, Supervisor for parallel builds
├── bob/                # BobOrchestrator - isolated Claude Code session management
├── orchestrator/       # StateMachine for build lifecycle
├── types/              # Zod schemas for all types
├── utils/              # Platform utilities, cross-platform helpers
└── observability/      # Winston logger
```

### Plugin Structure

```
.claude-plugin/
├── plugin.json          # Plugin manifest with skills and agents
├── skills/              # User-invocable skills (generate-mcp, fix-mcp, etc.)
└── agents/              # Autonomous agents (mcp-builder, api-researcher)
```

### Key Design Patterns

**1. Browser-Enhanced Discovery**
The system uses **Playwright MCP with `--browser firefox`** to capture API traffic and tokens when OpenAPI specs aren't available. This provides:

- `page.evaluate()` for localStorage/sessionStorage/cookie access
- `page.context().cookies()` for all cookies including HttpOnly
- Network interception for Authorization headers
- Full browser automation without Google dependency

DependencyChecker validates both Playwright MCP and Firefox browser are available before starting.

**2. Module Composition**
All modules follow singleton pattern with factory functions:

```typescript
// Pattern used throughout
import { getDependencyChecker } from "../preflight/dependency-checker.js";
import { getMcpRegistrySearch } from "../discovery/mcp-registry-search.js";
import { CredentialWizard } from "../auth/credential-wizard.js";
import { PatternEngine } from "../patterns/pattern-engine.js";
import { SelfHealingModule } from "../health/self-healing.js";
import { ValidationGate } from "../validation/validation-gate.js";
import { SmartCache } from "../cache/smart-cache.js";
```

**3. Prompt-Based Orchestration**
The MCP server returns detailed instruction prompts that guide Claude through the generation phases. See `handleTheSun()`, `handleFixMode()`, and `handleBatchMode()` in `src/mcp-server/index.ts`.

**4. Zod Schemas**
All types are defined with Zod in `src/types/index.ts`. Key schemas:

- `BuildStateSchema` - Build lifecycle state machine
- `ToolSpecSchema` - Tool specification
- `ValidationGateResultSchema` - 4-phase validation results
- `StoredCredentialSchema` - Credential storage

## Key Constants

```typescript
// Central output directory for all generated MCPs
const MCP_OUTPUT_BASE = join(homedir(), "Scripts", "mcp-servers");

// MCP registration file (auto-loaded by Claude)
const mcpConfigPath = join(homedir(), ".claude", "user-mcps.json");
```

## Testing Patterns

Tests are co-located with source files (`*.test.ts`). Use `nock` for HTTP mocking:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";

describe("ModuleName", () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it("should do something", async () => {
    nock("https://api.example.com")
      .get("/endpoint")
      .reply(200, { data: "value" });
    // ... test code
  });
});
```

## State Machine Phases

Build lifecycle defined in `src/types/index.ts`:

```
pending → discovering → generating → testing → security_scan → optimizing → validating → validate_requirements → completed
                                                                                                              ↓
                                                                                                           failed
```

## Configuration

Environment variables (optional):

```bash
THESUN_DATA_DIR      # Persistent state storage (default: ~/.thesun)
LOG_LEVEL            # error, warn, info, debug
```

Generated MCPs store credentials in `~/.thesun/credentials/<target>.env`.

## Cross-Platform Requirements

- Use `path.join()` for all file paths
- Use `src/utils/platform.ts` for shell command differences
- Avoid Unix-specific commands - use Node.js APIs

## Model Selection (for Sub-Agents)

| Task                             | Model  | Rationale                |
| -------------------------------- | ------ | ------------------------ |
| Planning, architecture, security | Opus   | Critical decisions       |
| Code generation, testing         | Sonnet | Cost-efficient bulk work |
| Simple validation                | Haiku  | Fast and cheap           |

## Ralph Loops

When validation fails, the system enters iterative fix loops:

1. Analyze failure → Fix → Re-test → Repeat
2. Maximum 5 iterations per issue type
3. Must exhaust web search, Confluence, Jira before escalating to user

## Security Requirements for Generated MCPs

- NO token passthrough to downstream APIs
- PKCE required for OAuth flows
- Token audience validation (RFC 8707)
- Graceful startup without credentials (tools list, error on invocation)
