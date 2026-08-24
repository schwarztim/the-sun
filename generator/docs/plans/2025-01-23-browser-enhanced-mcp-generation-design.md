# Browser-Enhanced MCP Generation Design

**Date:** 2025-01-23
**Status:** Approved
**Author:** Claude + Timothy Schwarz

## Overview

Enhancement to thesun that enables autonomous, browser-assisted MCP generation with:

- Parallel discovery (web research + browser testing)
- Automatic authentication handling via chrome-devtools-mcp
- Self-healing MCPs with health monitoring
- Perfect first-run validation
- Zero-config user experience

## Goals

1. **Zero-Config Experience** - Single command generates complete, working MCP
2. **Perfect First Run** - All tools validated against live API before done
3. **Automatic Auth** - Browser-based auth capture with token refresh
4. **Complete Coverage** - All API endpoints discovered and implemented
5. **Self-Healing** - MCPs detect and recover from API changes

---

## Architecture

### Pre-flight Dependency Check

Before any generation, verify:

1. `chrome-devtools-mcp` installed → prompt install if missing
2. `~/.thesun/.env` exists → create with template if missing
3. Chrome browser available → prompt installation if missing

All dependencies must pass before generation begins.

### Command Interface

```bash
# Zero-config (recommended)
thesun stripe

# Shortcuts
thesun stripe --har ~/Downloads/stripe.har  # Skip browser discovery
thesun stripe --update                       # Refresh existing MCP
thesun stripe --fix                          # Quick patch broken MCP
thesun stripe --no-cache                     # Force full regeneration
```

Auto-detected options:

- Auth type (OAuth, API key, session, none)
- API style (REST, GraphQL, WebSocket)
- Pagination pattern (cursor, offset, page)
- Rate limits (from headers or docs)
- Base URL (prod vs sandbox)

---

## Parallel Discovery Architecture

```
┌─────────────────┐          ┌─────────────────┐
│  WEB RESEARCH   │          │ BROWSER TESTING │
│    (Agent 1)    │          │    (Agent 2)    │
└────────┬────────┘          └────────┬────────┘
         │                            │
• Search existing MCPs       • Launch chrome-devtools
• Find official API docs     • Navigate to target site
• Check OpenAPI/Swagger      • Capture network requests
• Read GitHub repos          • Click through UI features
• Find SDK examples          • Trigger all API calls
         │                            │
         └──────────┬─────────────────┘
                    ▼
         ┌─────────────────────┐
         │   MERGE & DEDUPE    │
         │                     │
         │ • Combine endpoints │
         │ • Resolve conflicts │
         │ • Flag undocumented │
         │ • Validate schemas  │
         └─────────────────────┘
```

**Key insight:** If existing high-quality MCP found → skip generation, install & configure instead.

---

## Existing MCP Detection & Upgrade Path

### Search Sources (in order)

1. User's installed MCPs (`~/.claude/user-mcps.json`)
2. npm registry (`@*/mcp`, `*-mcp` packages)
3. Smithery registry
4. GitHub (topic:mcp-server + target name)
5. MCP official registry

### Quality Scoring

| Metric       | Weight | Description                               |
| ------------ | ------ | ----------------------------------------- |
| Coverage     | 30%    | Percentage of known endpoints implemented |
| Maintenance  | 25%    | Last commit date, issue response time     |
| Security     | 25%    | No vulnerabilities, proper auth handling  |
| Auth Support | 20%    | Supports required auth methods            |

### Decision Matrix

- Score 90+ → Install existing, configure, done
- Score 70-89 → Install + generate missing endpoints
- Score <70 → Generate from scratch

---

## Credential Wizard & Auto-Auth

### Detection Phase

1. Analyze API docs for auth requirements
2. Check network requests for auth headers
3. Identify auth type:
   - OAuth 2.0 + PKCE → Browser flow
   - API Key → Prompt or check existing credentials
   - Session/Cookie → Browser capture
   - None → Skip auth

### Browser Auth Flow

```
┌─────────────────────────────────────┐
│  🔐 Authentication Required         │
│                                     │
│  Target: stripe.com                 │
│  Detected: OAuth 2.0 + PKCE         │
│                                     │
│  Opening browser for login...       │
│  [=========>                  ] 45% │
│                                     │
│  ⏳ Waiting for authentication...   │
└─────────────────────────────────────┘
```

### Credential Storage

```
~/.thesun/
└── credentials/
    ├── stripe.env          # API keys, tokens
    ├── stripe.refresh      # Refresh token (encrypted)
    └── stripe.meta.json    # Expiry, scopes, last refresh
```

### Auto-Refresh Logic

1. Check token expiry before each MCP tool call
2. If expired + refresh token exists → silent refresh
3. If refresh fails → auto-launch browser, notify user
4. Update .env with new tokens automatically

---

## Pattern Detection Engine

### Known Pattern Library

```
~/.thesun/patterns/
├── stripe.pattern.json      # Pagination, errors, idempotency
├── github.pattern.json      # GraphQL + REST, rate limits
├── shopify.pattern.json     # Cursor pagination, webhooks
├── aws.pattern.json         # Signature v4, regions
└── oauth2.pattern.json      # Standard OAuth flows
```

### Pattern Matching

Analyze discovered API for:

- Error response format
- Pagination style (cursor/offset/page/link-header)
- Auth header format (Bearer, X-API-Key, custom)
- Rate limit headers (X-RateLimit-\*, Retry-After)
- Idempotency support (Idempotency-Key header)
- Webhook signature format (HMAC, timestamp)

### Pattern Application

- Use pattern's error handling strategy
- Apply pagination helper matching the style
- Include rate limit handling from pattern
- Generate webhook validation using pattern's approach

---

## Self-Healing MCPs

### Built Into Every Generated MCP

#### 1. Health Check on Startup

- Ping 3 core endpoints on MCP initialization
- Verify auth still valid
- Check API version matches expected

#### 2. Runtime Monitoring

- Track success/failure rate per endpoint
- Detect new error codes (breaking changes)
- Monitor response schema drift

#### 3. Auto-Recovery Actions

| Issue Detected        | Auto-Recovery         |
| --------------------- | --------------------- |
| 401 Unauthorized      | Trigger auth refresh  |
| 429 Rate Limited      | Backoff + retry       |
| 404 on known endpoint | Flag for regeneration |
| Schema mismatch       | Log + warn user       |
| New required field    | Notify user           |

#### 4. Deprecation Detection

```
⚠️  API Change Detected

Stripe API v2024-01 deprecated
3 endpoints returning different schemas
2 endpoints returning 404

Run: thesun stripe --update
Or:  thesun stripe --fix (quick patch)
```

#### 5. Metrics Storage

```
~/.thesun/health/
└── stripe/
    ├── health.log         # Success/failure log
    ├── schema-drift.json  # Detected changes
    └── last-check.json    # Last health check result
```

---

## Smart Caching System

### Cache Structure

```
~/.thesun/cache/
└── stripe/
    ├── openapi.json        # Downloaded API spec
    ├── openapi.hash        # SHA256 for change detection
    ├── discovered.json     # Browser-discovered endpoints
    ├── har-captures/       # Saved HAR files
    │   └── 2025-01-23.har
    └── generated/          # Last generated MCP source
        └── v1.2.0/
```

### Cache Decision Flow

1. Fetch current API spec
2. Compare hash to cached hash
3. If unchanged → use cached MCP
4. If changed → diff and regenerate only affected endpoints

### Incremental Updates

- Diff old spec vs new spec
- Only regenerate changed/new endpoints
- Preserve custom modifications user made
- Merge incrementally, don't overwrite

### Cache Commands

```bash
thesun stripe --no-cache     # Force full regeneration
thesun cache clear stripe    # Clear all cached data
thesun cache list            # Show cache usage
```

---

## Post-Generation Validation Gate

### Phase 1: Build Validation

- TypeScript compiles without errors
- All imports resolve
- MCP server starts without crash
- All tools register correctly

### Phase 2: Endpoint Testing

For each generated tool:

- Auth works?
- Request format correct?
- Response parses?
- Pagination works?
- Error handling works?

### Phase 3: Auth Flow Validation

- Initial auth succeeds
- Token stored correctly
- Refresh flow works (if applicable)
- Re-auth browser flow triggers on expiry

### Phase 4: Integration Test

- Full workflow test (create → read → update → delete)
- Rate limiting respects API limits
- Error responses handled gracefully

### Failure Handling

1. Diagnose failure automatically
2. Fix and regenerate affected tools
3. Re-run validation
4. Loop until all pass (max 3 iterations)
5. If still failing → detailed error report to user

### Success Output

```
✅ MCP Generation Complete

stripe-mcp v1.0.0
├─ 47 tools generated
├─ 47/47 validated against live API
├─ Auth: OAuth 2.0 + PKCE (token saved)
├─ Rate limiting: 100 req/sec configured
└─ Self-healing: enabled

Registered in ~/.claude/user-mcps.json
Ready to use: restart Claude Code
```

---

## Complete Generation Flow

```
thesun stripe
     │
     ▼
1. DEPENDENCY CHECK
   ✓ chrome-devtools-mcp installed
   ✓ Chrome browser available
   ✓ ~/.thesun/ directory ready
     │
     ▼
2. EXISTING MCP CHECK
   Search npm, Smithery, GitHub...
   → Found: @stripe/mcp (85/100 score)
   → Decision: Extend with missing endpoints
     │
     ▼
3. PARALLEL DISCOVERY (if needed)
   Web Search + Browser Test simultaneously
   Merge & Pattern Match
     │
     ▼
4. AUTHENTICATION
   Detected: OAuth 2.0 + PKCE
   → Launch browser via chrome-devtools-mcp
   → User logs in
   → Capture & store tokens
     │
     ▼
5. GENERATE MCP
   • Apply detected patterns (Stripe-style)
   • Generate all tools with rate limiting
   • Include self-healing health checks
   • Bundle auth refresh logic
     │
     ▼
6. VALIDATION GATE
   ✓ Build passes
   ✓ All 47 tools tested against live API
   ✓ Auth flow validated
   ✓ Integration test passes
     │
     ▼
7. AUTO-REGISTER
   • Add to ~/.claude/user-mcps.json
   • Store credentials in ~/.thesun/credentials/
   • Cache spec for future updates
   • Prompt: "Restart Claude Code to load new MCP"
```

---

## Feature Summary

| Feature                | Description                                         |
| ---------------------- | --------------------------------------------------- |
| **Zero-Config**        | Single command, everything auto-detected            |
| **Dependency Check**   | Prompts for chrome-devtools-mcp if missing          |
| **Existing MCP Reuse** | Search registries, score quality, extend if needed  |
| **Parallel Discovery** | Web research + browser testing simultaneously       |
| **Pattern Detection**  | Apply Stripe/GitHub/etc patterns for reliability    |
| **Credential Wizard**  | Browser auth, auto-store, auto-refresh tokens       |
| **Self-Healing**       | Health checks, deprecation detection, auto-recovery |
| **Smart Caching**      | Incremental updates, skip unchanged endpoints       |
| **Validation Gate**    | Test every tool before declaring done               |
| **Auto-Register**      | Add to user-mcps.json automatically                 |

---

## Implementation Priority

### Phase 1: Core Infrastructure

1. Dependency checker (chrome-devtools-mcp detection)
2. Directory structure setup (~/.thesun/)
3. Credential storage system

### Phase 2: Discovery

4. Existing MCP search & scoring
5. Parallel discovery architecture
6. Pattern detection engine

### Phase 3: Generation

7. Auth wizard with browser flow
8. Enhanced MCP generator with patterns
9. Self-healing code injection

### Phase 4: Validation

10. Post-generation validation gate
11. Auto-registration system
12. Smart caching

---

## Dependencies

- `chrome-devtools-mcp` - Browser automation for auth & discovery
- `thesun-har` - HAR file parsing (existing)
- Chrome browser - Required for browser-based discovery

## Files to Create/Modify

### New Files

- `src/dependency-checker.ts` - Pre-flight checks
- `src/mcp-registry-search.ts` - Search npm/Smithery/GitHub
- `src/parallel-discovery.ts` - Orchestrate agents
- `src/credential-wizard.ts` - Auth flow handling
- `src/pattern-engine.ts` - Pattern matching
- `src/self-healing.ts` - Health check generation
- `src/validation-gate.ts` - Post-gen testing
- `src/smart-cache.ts` - Caching system

### Modified Files

- `src/mcp-server/index.ts` - Add new tool entry point
- `src/generator/` - Integrate patterns & self-healing

---

## Success Criteria

1. `thesun stripe` works with zero additional config
2. All generated tools pass validation against live API
3. Auth tokens auto-refresh without user intervention
4. API changes detected and user notified
5. Existing high-quality MCPs reused when available
