# thesun Integration Plan

## Current Auth Generation Architecture

thesun generates authentication code using a **unified, multi-method approach** that gets inlined into each generated MCP. The architecture consists of five coordinated auth generation modules plus a unified orchestrator:

### Key Files and Their Roles

1. **`src/security/unified-auth-generator.ts`** (Main Entry Point)
   - Orchestrates all auth code generation for a single MCP
   - Implements multi-method fallback strategy: Primary method → HAR → Interactive login
   - Generates:
     - TypeScript auth module code (inlined into the MCP)
     - `.env.example` with all auth options documented
     - README sections explaining authentication setup
   - Supports 7 auth methods: `oauth`, `api_key`, `bearer`, `basic`, `har`, `azure_ad_sso`, `auto`

2. **`src/security/auth-manager.ts`** (OAuth 2.1 / Generic Framework)
   - Generates OAuth 2.1-compliant code for resource servers
   - Implements audience validation (RFC 8707) to prevent token misuse
   - Supports multiple identity providers: Entra ID, Okta, Auth0, Keycloak, generic OIDC
   - Generates code that validates tokens but NEVER stores them
   - Implements On-Behalf-Of (OBO) flow for downstream service access
   - Exports `generateAuthCodeSnippet(config)` → returns ~60 lines of TypeScript

3. **`src/security/azure-ad-sso-auth.ts`** (Browser-Based Enterprise SSO)
   - Enterprise-grade browser automation for Azure AD / Entra ID / Microsoft SSO
   - **Generates two modules:**
     - `generateRobustAuthModule()` → ~500 lines of auth code covering:
       - Headless and visible Playwright browser automation
       - Multi-selector resilience for Azure AD form fields
       - Cookie caching with expiration detection
       - MFA/TOTP support with script injection
       - Network interception to capture CSRF tokens and API headers
     - `generateSetupWizardModule()` → interactive setup tool
   - Also generates README section with Azure AD setup instructions
   - Battle-tested against real Azure AD production flows

4. **`src/security/api-key-auth.ts`** (Simple Key-Based Auth)
   - Generates API key authentication code
   - Supports 4 placement strategies: header, basic_auth, query, bearer
   - Includes predefined patterns for popular services (Stripe, Twilio, DataDog, etc.)
   - Exports `generateApiKeyAuthSnippet()` → ~80 lines of code
   - Includes optional rate limiting and IP allowlist logic

5. **`src/security/har-auth.ts`** (Network Capture Based Auth)
   - Generates code to extract authentication from HAR (HTTP Archive) files
   - Captures tokens, cookies, CSRF headers from recorded network traffic
   - Fallback method when APIs don't have official access mechanisms
   - Firefox DevTools: user records login flow → right-click → "Save all as HAR with content"
   - Exports `generateHARAuthCodeSnippet()` and `generateHARAuthEnvDocs()`

6. **`src/security/hardening.ts`** (Security Posture)
   - Code hardening utilities (not fully examined, but name suggests):
     - CORS policy generation
     - Rate limiting setup
     - Input validation templates
     - Secret redaction for logs

7. **`src/security/global-sso-store.ts`** (Credential Sharing)
   - Stores credentials captured from browser flows for reuse across generated MCPs
   - Singleton pattern for centralized credential management
   - Reduces redundant browser logins when multiple MCPs need same service

### Generation Flow in `unified-auth-generator.ts`

```typescript
export function generateUnifiedAuthCode(config: UnifiedAuthConfig): string {
  // 1. Detect auth method: azure_ad_sso, har, oauth, api_key, or auto
  if (primaryMethod === "azure_ad_sso" && config.azureAdSsoConfig) {
    return generateRobustAuthModule(config.azureAdSsoConfig);  // ~500 lines
  }
  
  if (primaryMethod === "har" || primaryMethod === "auto") {
    return harAuthCode + getAuthHeaders() + initializeAuth();  // ~200 lines
  }
  
  // 2. Build primary auth snippet (OAuth or API key)
  let primaryAuthCode = "";
  if (config.oauthConfig) {
    primaryAuthCode = generateAuthCodeSnippet(config.oauthConfig);  // ~60 lines
  } else if (config.apiKeyConfig) {
    primaryAuthCode = generateApiKeyAuthSnippet(config.apiKeyConfig);  // ~80 lines
  }
  
  // 3. Add HAR fallback (optional)
  return primaryAuthCode + harAuthCode + fallbackGetAuthHeaders();  // Total: 200-350 lines
}
```

---

## Auth Type Detection

### Decision Tree (in `src/discovery/api-researcher.ts`)

**Step 1: Discover Authentication Schemes**
```typescript
async research(toolSpec): DiscoveryResult {
  const endpoints = await this.fetchAndParseSpecs(toolSpec, webResearch);
  result.authSchemes = await this.extractAuthSchemes(toolSpec, webResearch);
  // Returns: [{ type: 'bearer' }, { type: 'api_key' }, ...]
}
```

**Step 2: Pattern Matching** (in `src/patterns/default-patterns.ts`)

Pre-defined patterns for 20+ popular services. Example:
```typescript
stripe: {
  auth: { type: "bearer", header: "Authorization" }
},
github: {
  auth: { type: "bearer", header: "Authorization" }
},
shopify: {
  auth: { type: "api-key", header: "X-Shopify-Access-Token" }
}
```

**Step 3: API Research Fallback**

If no pattern exists:
1. Fetch OpenAPI spec and parse `securitySchemes`
2. Look for official documentation on auth
3. Check existing MCP implementations
4. Fall back to HAR or interactive browser capture

**Step 4: User Override** (via thesun input)

```typescript
// User can force auth method:
thesun({ target: "myapp", authMethod: "sso" })  // Force Azure AD SSO
thesun({ target: "myapp", authMethod: "api_key" })  // Force API key
thesun({ target: "myapp", authMethod: "auto" })  // Auto-detect
```

---

## Code Emission Pattern

### Method 1: String Template Literals
Most auth code is generated using **string template literals** with variable substitution:

```typescript
export function generateAuthCodeSnippet(config: OAuthConfig): string {
  return `
// OAuth 2.1 Configuration for MCP Server
import { AuthManager } from '@thesun/security';

const authConfig = {
  provider: '${config.provider}',
  issuer: process.env.OAUTH_ISSUER || '${config.issuer}',
  clientId: process.env.OAUTH_CLIENT_ID!,
  audience: '${config.audience}',
  scopes: ${JSON.stringify(config.scopes)},
};

export const authManager = new AuthManager(authConfig);
`;
}
```

**Output Characteristics:**
- ~60-500 lines per snippet
- Mixed hardcoded values (from API spec) + environment variable references
- Preserves TypeScript/Node.js idioms
- Ready to paste into MCP server code

### Method 2: File Assembly
For complex auth flows (Azure AD SSO):

```typescript
// In generateRobustAuthModule():
// 1. Generate azure-ad-automator.ts (~400 lines)
// 2. Generate logger module (~50 lines)
// 3. Generate utils module (~80 lines)
// 4. Return concatenated code with imports
```

### Method 3: Config Abstraction
Environment variables are managed separately via `src/generator/config-abstraction.ts`:

```typescript
AUTH_CONFIG_TEMPLATES: {
  api_key: [{ envVar: '{TOOL}_API_KEY', ... }],
  oauth2: [
    { envVar: '{TOOL}_CLIENT_ID', ... },
    { envVar: '{TOOL}_CLIENT_SECRET', ... }
  ],
  azure_ad_sso: [{ envVar: '{TOOL}_INSTANCE_URL', ... }]
}
```

---

## The Orchestrator Flow

Location: `src/orchestrator/index.ts`

### Where Auth Code Gets Generated

**Phase Execution in `executeBuild()`:**

```
pending
  ↓
discovering → [ApiResearcher.research() discovers auth schemes]
  ↓
generating → [Auth code generated here via unified-auth-generator.ts]
  ↓
testing → [Generated auth code validated]
  ↓
security_scan
  ↓
optimizing
  ↓
validating → [4-phase validation including auth endpoints]
  ↓
completed
```

**Key Entry Point for Auth:**

During the `GENERATING` phase, the orchestrator calls Bob (isolated Claude instance) with instructions that include:

```
# Phase: Code Generation
Generate complete MCP server including:
1. Tool definitions from OpenAPI spec
2. Authentication code [← unified-auth-generator called here]
3. Request/response handling
4. Error recovery
```

---

## FIX Mode Changes

Location: `src/mcp-server/index.ts` → `handleFixMode(fixPath, target, mcpConfigPath, spec)`

### Current Behavior
FIX mode:
1. Scans existing MCP code for issues
2. Identifies broken auth (bad env vars, missing handlers)
3. Regenerates the entire MCP

### For Hermes Integration
FIX mode should be enhanced to:

```typescript
async handleFixMode(target: string, fixPath: string, ...) {
  // 1. Analyze existing MCP's auth code
  const existingAuth = extractAuthModule(fixPath);
  
  // 2. Check if already using @hermes/auth-core
  if (existingAuth.imports.includes("@hermes/auth-core")) {
    console.log("Already using Hermes auth. Updating to latest version...");
    return updateHermesVersion(fixPath);
  }
  
  // 3. Check if HERMES_URL env var is set
  const hermesUrl = process.env.HERMES_URL;
  if (hermesUrl) {
    console.log("HERMES_URL detected. Converting to @hermes/client mode...");
    return retrofitHermesClient(fixPath, hermesUrl);
  }
  
  // 4. Fall back to regenerating with unified-auth-generator
  return regenerateWithAuth(target, fixPath);
}
```

---

## Exact Changes Needed

### 1. **unified-auth-generator.ts** Changes

**Current:**
- Returns full auth code (500-2000 lines) inlined in MCP

**New:** Add conditional mode selection
```typescript
interface UnifiedAuthConfig {
  // ... existing fields
  hermesMode?: 'standalone' | 'client' | 'auto';  // NEW
  hermesUrl?: string;                             // NEW
  dependencyCheckMode?: 'strict' | 'soft';        // NEW for version checking
}

export function generateUnifiedAuthCode(config: UnifiedAuthConfig): string {
  // NEW: Check for Hermes
  if (config.hermesMode === 'client' || (config.hermesMode === 'auto' && process.env.HERMES_URL)) {
    return generateHermesClientAuth(config);  // Uses @hermes/client
  }
  
  if (config.hermesMode === 'standalone' || config.hermesMode === 'auto') {
    // Check if @hermes/auth-core is available (for standalone mode)
    try {
      return generateHermesStandaloneAuth(config);  // Uses @hermes/auth-core
    } catch (e) {
      // Fallback to old inlined approach
      return generateLegacyInlinedAuth(config);
    }
  }
  
  // Default: old behavior
  return generateLegacyInlinedAuth(config);
}

// NEW FUNCTION: Generate auth using @hermes/client
function generateHermesClientAuth(config: UnifiedAuthConfig): string {
  return `
import { HermesAuthClient } from '@hermes/client';

export const hermesAuth = new HermesAuthClient({
  hermesUrl: process.env.HERMES_URL,
  serviceName: '${config.toolName}',
  fallbackAuth: ${getFallbackAuthConfig(config)},
});

export async function getAuthHeaders(): Promise<Record<string, string>> {
  return hermesAuth.getHeaders();
}
`;
}

// NEW FUNCTION: Generate auth using @hermes/auth-core (standalone)
function generateHermesStandaloneAuth(config: UnifiedAuthConfig): string {
  return `
import { StandaloneAuthCore } from '@hermes/auth-core';

const authCore = new StandaloneAuthCore({
  method: '${config.primaryMethod}',
  config: ${JSON.stringify(getAuthCoreConfig(config))},
});

export async function getAuthHeaders(): Promise<Record<string, string>> {
  return authCore.getHeaders();
}
`;
}
```

**Why:** Allows runtime switching between Hermes broker and standalone mode based on `HERMES_URL` env var.

---

### 2. **azure-ad-sso-auth.ts** Changes

**Current:**
- `generateRobustAuthModule()` returns 500+ lines of browser automation code

**New:** Make browser automation optional
```typescript
export function generateRobustAuthModule(
  config: AzureAdSsoConfig,
  hermesMode?: 'client' | 'standalone' | 'inline'  // NEW
): string {
  // If using Hermes client mode, delegate to Hermes
  if (hermesMode === 'client') {
    return `
import { HermesAuthClient } from '@hermes/client';

export const azureAuth = new HermesAuthClient({
  hermesUrl: process.env.HERMES_URL,
  serviceName: '${config.toolName}',
  method: 'azure_ad_sso',
});

export async function authenticate(): Promise<void> {
  return azureAuth.authenticate();
}
`;
  }
  
  // If standalone with @hermes/auth-core, use it
  if (hermesMode === 'standalone') {
    return `
import { AzureAdAuthCore } from '@hermes/auth-core';

const azureAuth = new AzureAdAuthCore({
  loginUrl: process.env.AZURE_LOGIN_URL,
  successPatterns: ${JSON.stringify(config.successUrlPatterns)},
});

export async function authenticate(): Promise<void> {
  return azureAuth.authenticate();
}
`;
  }
  
  // Fallback: old inlined browser automation
  return generateAzureAdAutomatorModule(config);  // 500+ lines
}
```

**Why:** Azure AD SSO is the most complex auth type (browser automation). Offloading to Hermes reduces generated code by 80%.

---

### 3. **api-key-auth.ts** Changes

**Current:**
- `generateApiKeyAuthSnippet()` returns ~80 lines of code

**New:** Minimal change needed
```typescript
export function generateApiKeyAuthSnippet(
  config: ApiKeyConfig,
  hermesMode?: 'client' | 'standalone'
): string {
  if (hermesMode === 'client') {
    return `
import { HermesAuthClient } from '@hermes/client';

export const apiKeyAuth = new HermesAuthClient({
  hermesUrl: process.env.HERMES_URL,
  serviceName: '${config.envVar.split('_')[0].toLowerCase()}',
});

export async function getApiKey(): Promise<string> {
  const headers = await apiKeyAuth.getHeaders();
  return headers.Authorization || headers['X-Api-Key'] || '';
}
`;
  }
  
  // Existing 80-line snippet for standalone
  return generateApiKeySnippetLegacy(config);
}
```

**Why:** API key auth is already simple. Hermes wrapper saves only ~30 lines, but provides consistency.

---

### 4. **auth-manager.ts** Changes

**Current:**
- Generates OAuth 2.1 code for resource servers

**New:** Support Hermes as identity provider
```typescript
export const PROVIDER_DEFAULTS: Record<IdentityProvider, ...> = {
  // ... existing providers
  hermes: {  // NEW
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenLifetimeSeconds: 900,
    useOnBehalfOf: true,
  },
};

// NEW FUNCTION: Generate auth code when Hermes is the identity provider
export function generateHermesAsIdpAuth(config: OAuthConfig): string {
  return `
import { HermesIdpClient } from '@hermes/client';

const idpClient = new HermesIdpClient({
  hermesUrl: process.env.HERMES_URL,
  resource: '${config.resource}',
});

export async function validateToken(token: string) {
  return idpClient.validateToken(token);
}

export async function getOnBehalfOfToken(userToken: string, downstreamResource: string) {
  return idpClient.getOnBehalfOfToken(userToken, downstreamResource);
}
`;
}
```

**Why:** Enables MCPs to accept Hermes-issued tokens when Hermes runs as central IdP.

---

### 5. **har-auth.ts** Changes

**Current:**
- ~250 lines for HAR capture and extraction

**New:** No changes needed
```typescript
// HAR-based auth is already lightweight and doesn't benefit from Hermes
// Leave as-is for offline/disconnected scenarios
```

**Why:** HAR auth works offline and is already minimal. Only use Hermes for SSO/OAuth methods.

---

### 6. **hardening.ts** Changes

**Suggested Addition:**

```typescript
// NEW FUNCTION: Validate Hermes dependency
export function validateHermesDependency(packageJson: object): {
  available: boolean;
  version?: string;
  error?: string;
} {
  const pkg = packageJson as Record<string, any>;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  
  if (deps['@hermes/auth-core'] || deps['@hermes/client']) {
    const version = deps['@hermes/auth-core'] || deps['@hermes/client'];
    return { available: true, version };
  }
  
  return { available: false, error: 'Hermes not in dependencies' };
}

// NEW FUNCTION: Generate dependency check code
export function generateHermesDepCheck(mode: 'client' | 'standalone'): string {
  if (mode === 'client') {
    return `
import type { HermesAuthClient } from '@hermes/client';

let hermesAuth: HermesAuthClient | null = null;

function ensureHermesAvailable() {
  if (!hermesAuth) {
    throw new Error(
      '@hermes/client not installed. Install with: npm install @hermes/client'
    );
  }
}
`;
  }
  
  return `
import type { StandaloneAuthCore } from '@hermes/auth-core';

let authCore: StandaloneAuthCore | null = null;

function ensureAuthCoreAvailable() {
  if (!authCore) {
    throw new Error(
      '@hermes/auth-core not installed. Install with: npm install @hermes/auth-core'
    );
  }
}
`;
}
```

**Why:** Generated MCPs should gracefully handle missing Hermes dependency and provide clear error messages.

---

## FIX Mode Changes

### Location: `src/mcp-server/index.ts` → `handleFixMode()`

**Current:**
```typescript
async handleFixMode(target: string, fixPath: string, ...): Promise<any> {
  // 1. Parse existing MCP
  // 2. Detect issues
  // 3. Regenerate entire MCP
  return this.handleTheSun({ target, output: fixPath });
}
```

**New:** Add Hermes retrofit capability
```typescript
async handleFixMode(target: string, fixPath: string, ...): Promise<any> {
  // NEW: Check if this is a Hermes retrofit operation
  const hermesUrl = process.env.HERMES_URL;
  const authCodePath = join(fixPath, 'src', 'auth.ts');
  
  if (hermesUrl && existsSync(authCodePath)) {
    // Try to retrofit existing MCP to use Hermes
    console.log(`[FIX] Hermes URL detected (${hermesUrl})`);
    console.log(`[FIX] Attempting to retrofit ${target} MCP to use @hermes/client...`);
    
    try {
      return await this.retrofitToHermes(fixPath, target, hermesUrl);
    } catch (e) {
      console.log(`[FIX] Retrofit failed: ${e}. Falling back to regeneration...`);
    }
  }
  
  // OLD: Standard FIX mode (regenerate)
  return this.handleTheSun({ target, output: fixPath });
}

// NEW FUNCTION: Retrofit existing MCP to use Hermes
async retrofitToHermes(mcpPath: string, target: string, hermesUrl: string): Promise<any> {
  const authPath = join(mcpPath, 'src', 'auth.ts');
  const existingAuth = readFileSync(authPath, 'utf-8');
  
  // Check if already uses Hermes
  if (existingAuth.includes('@hermes/client') || existingAuth.includes('@hermes/auth-core')) {
    console.log('[FIX] Already using Hermes. Checking version...');
    // Update package.json to latest Hermes version
    // Update auth code to use new API if version mismatch
    return { status: 'updated', message: 'Hermes dependencies updated' };
  }
  
  // Extract current auth method from existing code
  const detectedMethod = detectAuthMethod(existingAuth);
  
  // Generate new auth code using Hermes
  const newAuth = generateUnifiedAuthCode({
    toolName: target,
    primaryMethod: detectedMethod,
    hermesMode: 'client',
    hermesUrl,
  });
  
  // Backup old auth code
  writeFileSync(`${authPath}.bak`, existingAuth);
  
  // Write new auth code
  writeFileSync(authPath, newAuth);
  
  // Update package.json to include @hermes/client
  const pkgPath = join(mcpPath, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.dependencies['@hermes/client'] = 'latest';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  
  console.log('[FIX] Retrofit complete. New auth code uses @hermes/client.');
  console.log(`[FIX] Backup of old auth saved to ${authPath}.bak`);
  
  return { status: 'retrofitted', message: 'MCP converted to use Hermes' };
}

function detectAuthMethod(authCode: string): string {
  if (authCode.includes('oauth') || authCode.includes('OAuthConfig')) return 'oauth';
  if (authCode.includes('api_key') || authCode.includes('API_KEY')) return 'api_key';
  if (authCode.includes('bearer') || authCode.includes('Bearer')) return 'bearer';
  if (authCode.includes('BasicAuth') || authCode.includes('basic')) return 'basic';
  if (authCode.includes('har') || authCode.includes('HAR')) return 'har';
  if (authCode.includes('AzureAD') || authCode.includes('azure') || authCode.includes('sso')) return 'azure_ad_sso';
  return 'auto';
}
```

---

## Implementation Order (Recommended Sequence)

### Phase 1: Foundation (Week 1)
1. **Add `hermesMode` parameter** to `UnifiedAuthConfig` in `unified-auth-generator.ts`
2. **Create helper functions**:
   - `generateHermesClientAuth()` (50 lines)
   - `generateHermesStandaloneAuth()` (50 lines)
3. **Add to `hardening.ts`**:
   - `validateHermesDependency()` (20 lines)
   - `generateHermesDepCheck()` (40 lines)

### Phase 2: Auth Method Updates (Week 2)
4. **Update `azure-ad-sso-auth.ts`**: Add mode parameter to `generateRobustAuthModule()`
5. **Update `api-key-auth.ts`**: Add mode parameter to `generateApiKeyAuthSnippet()`
6. **Update `auth-manager.ts`**: Add Hermes as identity provider
7. **Update `har-auth.ts`**: No changes needed (test existing behavior)

### Phase 3: FIX Mode (Week 3)
8. **Implement `retrofitToHermes()`** in `src/mcp-server/index.ts`
9. **Update `handleFixMode()`** to detect and handle Hermes operations
10. **Add `detectAuthMethod()`** utility

### Phase 4: Testing & Documentation (Week 4)
11. Write tests for each new function
12. Update CLAUDE.md with Hermes integration flow
13. Create integration tests: old MCP → Hermes retrofit → verify

---

## Risk Assessment

### What Could Go Wrong

| Risk | Mitigation |
|------|-----------|
| **Backward Compatibility** | Old MCPs using inlined auth must still work. Solution: Keep `generateLegacyInlinedAuth()` as fallback. Default mode = 'auto' tries Hermes first, falls back to legacy. |
| **Hermes Not Installed** | Generated MCPs fail if @hermes/client/@hermes/auth-core not in dependencies. Solution: `validateHermesDependency()` check at startup, clear error message. |
| **Env Var Mismatch** | HERMES_URL set but MCP was generated without Hermes. Solution: FIX mode detects this and retrofits automatically. |
| **Token Validation Bypass** | If Hermes validation is disabled, old code path is used. Solution: audit `hermesAuth.validateToken()` implementation before use. |
| **Circular Dependency** | Hermes depends on some MCPs which depend on @hermes/client. Solution: Separate @hermes/auth-core as standalone module (no reverse dependencies). |
| **Version Mismatch** | MCP expects @hermes/client v2 but v3 installed. Solution: `validateHermesDependency()` checks version range, warns if incompatible. |

### Breaking Changes

**None expected** if implemented correctly:
- Existing inlined auth continues to work
- FIX mode is opt-in (only when `HERMES_URL` is set)
- New `hermesMode` parameter is optional (defaults to 'auto')

### Backwards Compatibility Strategy

```typescript
// For every auth generation function:
// 1. Check HERMES_URL environment variable
// 2. Check if Hermes modules are installed
// 3. If both true AND hermesMode allows it, use Hermes
// 4. Otherwise, fall back to legacy inlined approach

function shouldUseHermes(config: { hermesMode?: string }): boolean {
  if (config.hermesMode === 'standalone' && !process.env.HERMES_URL) {
    // User explicitly wants standalone Hermes, but Hermes not configured
    console.warn('[WARN] hermesMode=standalone but HERMES_URL not set. Falling back to legacy auth.');
    return false;
  }
  
  if (config.hermesMode === 'none' || config.hermesMode === 'inline') {
    return false;  // User explicitly wants legacy
  }
  
  if (config.hermesMode === 'client' && !process.env.HERMES_URL) {
    console.warn('[WARN] hermesMode=client but HERMES_URL not set. Falling back to legacy auth.');
    return false;
  }
  
  if (config.hermesMode === 'auto') {
    // Auto mode: use Hermes only if both env var and modules present
    return !!process.env.HERMES_URL && canImportHermes();
  }
  
  return false;
}
```

---

## Summary: Generation Codepath Changes

### Before (Current)
```
thesun({ target: "stripe" })
  ↓ Discover auth: bearer
  ↓ unified-auth-generator.ts
  ↓ generateAuthCodeSnippet(oauthConfig)
  ↓ Returns 2000-line MCP with inlined auth code
  ↓ Register at ~/.claude/user-mcps.json
```

### After (Hermes Integrated)
```
thesun({ target: "stripe" })
  ↓ Discover auth: bearer
  ↓ Check HERMES_URL environment variable
  ↓ unified-auth-generator.ts
  ↓ hermesMode === 'auto' → try Hermes client first
  ↓ generateHermesClientAuth() → 50 lines
     └─ Falls back to generateAuthCodeSnippet() if no Hermes
  ↓ Returns MCP with either:
     • @hermes/client-based auth (50 lines)
     • Legacy inlined auth (2000 lines)
  ↓ Register at ~/.claude/user-mcps.json
```

### FIX Mode Path (New)
```
handleFixMode("/path/to/mcp", "stripe", ..., HERMES_URL="https://hermes.internal")
  ↓ Check if existing MCP auth can be retrofitted
  ↓ existingAuth uses old inlined code
  ↓ retrofitToHermes()
  ↓ detectAuthMethod() → "bearer"
  ↓ generateUnifiedAuthCode({ hermesMode: 'client', ... })
  ↓ generateHermesClientAuth()
  ↓ Replace src/auth.ts with Hermes-based version
  ↓ Add @hermes/client to package.json
  ↓ Report: "MCP retrofitted to use Hermes"
```

