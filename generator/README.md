# thesun

**Autonomous MCP Server Generation Platform**

thesun generates production-ready Model Context Protocol (MCP) servers from any REST API with zero configuration. Point it at an OpenAPI spec, a live API endpoint, or a captured HAR traffic file — thesun discovers the API surface, generates a fully typed TypeScript MCP server, validates it against the real API, and delivers a deployable artifact. No scaffolding, no templates to fill in, no manual tool authoring.

---

## How It Works

Generation proceeds through a structured pipeline of autonomous phases:

**Phase 1 — Target Resolution**
Accepts a target identifier (URL, OpenAPI spec path, HAR file, or natural language description). Resolves authentication requirements and API reachability.

**Phase 2 — API Discovery**
Crawls the API surface using three complementary strategies: OpenAPI/Swagger spec parsing, browser-enhanced HAR traffic capture (authenticated sessions, SPAs, undocumented endpoints), and pattern inference from observed request/response pairs.

**Phase 3 — Schema Extraction**
Normalizes discovered endpoints into a typed internal schema. Infers parameter types, required vs. optional fields, enum values, and ID relationships between endpoints.

**Phase 4 — Code Generation**
Generates a complete TypeScript MCP server. Each tool receives a structured 3-part description (purpose, prerequisites, next steps), behavioral annotations derived from HTTP semantics, and parameter documentation with format examples.

**Phase 4.5 — Tool Instrumentation**
Post-generation enrichment pass. Builds a cross-tool dependency graph, synthesizes multi-step workflow patterns, generates a `{target}_help` tool with domain-specific guidance, and injects anti-pattern warnings for destructive or high-cardinality operations.

**Phase 5 — Self-Healing Test Loop (Ralph Loop)**
Executes the generated MCP against the real API. On failure, diagnoses the root cause, patches the generated code, and retries. Loops until all tests pass or the maximum retry budget is exhausted. This loop handles auth edge cases, undocumented error responses, pagination quirks, and API inconsistencies without human intervention.

**Phase 6 — Security Scan**
Runs SAST analysis, dependency vulnerability scan, and secret detection on every build. Blocks delivery of servers with high-severity findings.

**Phase 7 — Validation Gate**
Structural validation of the final artifact: tool schema compliance, description format completeness, annotation consistency, prerequisite reference integrity, and help tool correctness.

---

## Key Features

### Zero-Configuration Generation

No input beyond the target is required. thesun resolves auth, discovers endpoints, infers schemas, and generates working code without configuration files or user prompts during the build.

### Self-Healing Builds (Ralph Loops)

The test-diagnose-fix-retry loop runs autonomously until the generated server passes against the live API. Build failures are treated as inputs to the next generation attempt, not as terminal errors.

### Parallel Builds via Git Worktrees

Multiple targets can be built simultaneously using isolated git worktrees. Each build gets its own working directory, dependency set, and test environment. No cross-contamination between concurrent generations.

### Browser-Enhanced API Discovery

For APIs without OpenAPI documentation — SPAs, internal tools, authentication-gated endpoints — thesun captures real browser traffic via HAR interception. Discovered endpoints are reverse-engineered from observed request/response pairs, including inferred field types and enum values.

### Security-First Pipeline

Every build runs three security passes before delivery: static analysis (SAST), dependency vulnerability scanning, and secret detection. High-severity findings block the build. There is no option to skip security scanning.

### Tool Instrumentation Quality

Generated MCP tools are not minimal stubs. Every tool includes structured descriptions with prerequisite chaining, MCP behavioral annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and a generated `{target}_help` tool that encodes domain-specific workflow patterns for the target API.

### HAR-Sourced API Support

APIs without any formal documentation are first-class targets. thesun infers tool semantics from URL path segments, HTTP methods, and observed payload shapes. Inferred fields are annotated with their source (`inferredFrom: "har"`) for transparency.

---

## Dependencies

- **[Hermes](https://github.com/schwarztim/hermes)** — Authentication broker. Manages OAuth2/SSO token acquisition, refresh, and serving for this MCP server.
- **[ToolHive](https://github.com/stacklok/toolhive)** — Container runtime. Hosts this server as a Docker container with streamable HTTP transport.
- **[MCP Gateway](http://127.0.0.1:3100/mcp)** — Aggregation layer. Provides unified tool access across all MCP backends.
- **Vendored credential store** (`src/security/vault-store.ts`) — AES-256-GCM encrypted file vault (replaces macOS Keychain/keytar). Vendored rather than an external dependency, so the generator installs from a clean checkout.

## Architecture

thesun runs as a ToolHive-managed MCP backend behind MCP Gateway, and it generates new MCP servers from OpenAPI specifications, live API surfaces, and captured HAR traffic.

1. **Container** — Built from the local Dockerfile and published as `localhost:5555/thesun:latest`
2. **Transport** — thesun itself is exposed over streamable HTTP via ToolHive; generated servers use stdio transport by default unless you containerize them later
3. **Authentication** — Hermes brokers authentication for thesun and generated servers integrate with Hermes-managed auth flows
4. **Discovery** — thesun is exposed through MCP Gateway at `http://127.0.0.1:3100/mcp`
5. **Credentials** — Generated servers carry their own emitted `src/vault-store.ts` (AES-256-GCM), not keytar

### State Machine

Build state transitions:

```
discovering → generating → instrumenting → testing → security_scan → optimizing → validating → validate_requirements → completed
```

Each phase is resumable. Failed phases record structured diagnostics in `BuildState` for use by the self-healing loop.

### Build State Schema

All build metadata is tracked in a versioned `BuildStateSchema` (Zod). Includes discovered endpoints, generated artifacts, test results, security scan output, instrumentation stats, and phase history. State is persisted to disk — builds survive process restarts.

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js
- **Schema validation:** Zod
- **MCP protocol:** `@modelcontextprotocol/sdk`
- **Test runner:** Vitest
- **Browser automation:** Playwright (HAR capture)
- **Security scanning:** SAST via AST analysis, `npm audit` for dependencies, pattern-based secret detection
- **Parallelism:** Git worktrees, worker threads

---

## Output

thesun produces a deployable MCP server directory containing:

- Complete TypeScript source with all tools implemented
- `package.json` with pinned dependencies
- `README.md` documenting each tool, its parameters, and workflow patterns
- Security scan report
- Build state log

Generated servers are compatible with any MCP host (Claude Desktop, claude-cli, Copilot extensions, custom integrations).

---

## Usage

thesun is accessed as an MCP tool through MCP Gateway:

```json
{
  "server": "thesun",
  "tool": "generate",
  "args": { "target": "https://api.example.com" }
}
```

For fixing an existing generated server:

```json
{
  "server": "thesun",
  "tool": "generate",
  "args": {
    "target": "example",
    "fix": "/path/to/existing-mcp"
  }
}
```

Output is written to `~/Scripts/mcp-servers/{target}-mcp/`. Generated servers default to stdio transport, integrate with Hermes for authentication, and carry an emitted `src/vault-store.ts` for credential storage before optional MCP Gateway registration.

---

## Performance

Autonomous generation completes in minutes for well-documented APIs. The 234x efficiency figure reflects wall-clock time from target specification to deployable artifact compared to manual MCP authoring for equivalently sized APIs (measured across internal targets with 15-80 endpoints).

---

## Security Notes

- Secret detection runs on every build. Generated servers that contain hardcoded credentials fail the security gate and are not delivered.
- Dependency scans use the npm advisory database. High and critical severity findings block delivery.
- Browser-captured credentials (used for authenticated HAR capture) are not persisted in the build artifact.
- All generated servers use TLS-verified connections by default.
