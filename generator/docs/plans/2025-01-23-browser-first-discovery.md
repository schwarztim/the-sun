# Browser-First Discovery Design

**Date:** 2025-01-23
**Status:** Draft
**Priority:** Critical
**Author:** Claude + Timothy Schwarz

## Problem Statement

The current MCP generation approach tries to _infer_ authentication from documentation and response headers. This fails for:

- Portal sites with multi-step auth flows
- SSO redirects (SAML, OIDC)
- Sites where API keys are revealed in the UI after login
- Combination auth (session cookies + API keys)
- Custom OAuth implementations
- Hidden/undocumented auth requirements
- CAPTCHA and 2FA gates

**The solution:** Don't guess. Watch.

---

## Core Principle

> **"See it working before generating code."**

Before writing a single line of MCP code, thesun must:

1. Launch a real browser session
2. Navigate to the target site
3. Observe and capture the complete auth flow
4. Identify all auth artifacts (tokens, cookies, keys, headers)
5. THEN generate code that matches observed reality

---

## Browser-First Discovery Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER-FIRST DISCOVERY                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. LAUNCH BROWSER SESSION                                        │
│    • Open Chrome via chrome-devtools-mcp                        │
│    • Enable network capture (HAR recording)                     │
│    • Enable console logging                                     │
│    • Set up request/response interception                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. NAVIGATE TO TARGET                                            │
│    • Go to main site URL                                        │
│    • Detect if redirected (SSO, portal, login wall)             │
│    • Record redirect chain                                      │
│    • Screenshot each step                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. AUTHENTICATION OBSERVATION                                    │
│    • Prompt user: "Please log in normally"                      │
│    • Watch ALL network requests during login                    │
│    • Capture:                                                   │
│      - Form submissions                                         │
│      - OAuth redirects                                          │
│      - Token exchanges                                          │
│      - Cookie sets                                              │
│      - Header patterns                                          │
│    • Handle CAPTCHA/2FA: pause and let user complete            │
│    • Detect multi-step flows (portal → account picker → app)    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. POST-LOGIN EXPLORATION                                        │
│    • Prompt: "Navigate to where you'd normally use the API"     │
│    • Look for:                                                  │
│      - API keys displayed in UI (settings pages)                │
│      - Developer console / API sections                         │
│      - Token generation buttons                                 │
│      - Webhook configuration pages                              │
│    • Capture any additional auth artifacts                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. API ENDPOINT DISCOVERY                                        │
│    • Prompt: "Click through the features you want in the MCP"   │
│    • Capture all XHR/fetch requests                             │
│    • Record:                                                    │
│      - Endpoint URLs                                            │
│      - Request methods                                          │
│      - Request/response bodies                                  │
│      - Required headers                                         │
│      - Auth headers used                                        │
│    • Build endpoint catalog from real traffic                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. AUTH ARTIFACT ANALYSIS                                        │
│    • Consolidate all captured auth:                             │
│      - Session cookies                                          │
│      - Bearer tokens                                            │
│      - API keys (from UI or headers)                            │
│      - CSRF tokens                                              │
│      - Custom headers                                           │
│    • Determine refresh mechanism:                               │
│      - Token expiry (from JWT or observed behavior)             │
│      - Refresh token availability                               │
│      - Session timeout patterns                                 │
│    • Document complete auth requirements                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. USER CONFIRMATION                                             │
│    • Present findings:                                          │
│      "I observed the following auth flow:"                      │
│      - Step 1: SSO redirect to Okta                             │
│      - Step 2: SAML assertion                                   │
│      - Step 3: Session cookie set                               │
│      - Step 4: API key retrieved from /settings/api             │
│                                                                 │
│      "Captured endpoints:"                                      │
│      - GET /api/v1/users (requires: session + X-Api-Key)        │
│      - POST /api/v1/orders (requires: session + CSRF)           │
│                                                                 │
│    • Ask: "Is this correct? Anything missing?"                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 8. GENERATE MCP WITH OBSERVED PATTERNS                           │
│    • Generate auth handler that matches EXACTLY what was seen   │
│    • Generate tools for captured endpoints                      │
│    • Include credential refresh logic                           │
│    • Add re-auth trigger when session expires                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Auth Pattern Library

Based on real-world observation, support these patterns:

### Tier 1: Common Patterns

| Pattern            | Detection                        | Handling                            |
| ------------------ | -------------------------------- | ----------------------------------- |
| **Bearer Token**   | `Authorization: Bearer xxx`      | Store token, detect expiry, refresh |
| **API Key Header** | `X-API-Key`, `api-key`, `apikey` | Store key, no refresh needed        |
| **API Key Query**  | `?api_key=xxx`, `?key=xxx`       | Store key, inject in requests       |
| **Session Cookie** | `Set-Cookie: session=xxx`        | Store cookie, detect timeout        |
| **Basic Auth**     | `Authorization: Basic xxx`       | Store credentials                   |

### Tier 2: OAuth Variants

| Pattern                | Detection                               | Handling               |
| ---------------------- | --------------------------------------- | ---------------------- |
| **OAuth 2.0 + PKCE**   | `/authorize`, `/token`, `code_verifier` | Full PKCE flow         |
| **OAuth 2.0 Implicit** | `#access_token=` in redirect            | Token from fragment    |
| **OAuth 1.0a**         | `oauth_signature`, `oauth_token`        | Signature generation   |
| **Custom OAuth**       | Non-standard token endpoint             | Adapt to observed flow |

### Tier 3: Enterprise/SSO

| Pattern                 | Detection                         | Handling               |
| ----------------------- | --------------------------------- | ---------------------- |
| **SAML**                | SAMLRequest, SAMLResponse         | Capture assertion      |
| **OIDC**                | `id_token`, `/.well-known/openid` | Full OIDC flow         |
| **Okta**                | `*.okta.com` redirect             | Okta-specific handling |
| **Entra ID (Azure AD)** | `login.microsoftonline.com`       | MSAL-compatible        |
| **Auth0**               | `*.auth0.com` redirect            | Auth0 SDK patterns     |

### Tier 4: Multi-Step Combinations

| Pattern                                | Example          | Handling                 |
| -------------------------------------- | ---------------- | ------------------------ |
| **Portal → SSO → App**                 | Salesforce       | Chain of redirects       |
| **Login → Account Picker → Authorize** | Google Workspace | Multi-consent flow       |
| **Session + API Key**                  | Jira, Confluence | Both required            |
| **Session + CSRF**                     | Many SPAs        | Token in cookie + header |
| **Certificate + Password**             | Enterprise       | mTLS + basic auth        |

### Tier 5: Edge Cases

| Pattern                 | Detection                   | Handling                 |
| ----------------------- | --------------------------- | ------------------------ |
| **CAPTCHA Gate**        | reCAPTCHA, hCaptcha visible | Pause, let user solve    |
| **2FA/MFA**             | TOTP input, SMS code        | Pause, let user complete |
| **IP Allowlist**        | 403 from certain IPs        | Warn user                |
| **Rate Limit Pre-Auth** | 429 before login            | Backoff                  |
| **Geo-Restriction**     | Region-based redirect       | Detect and warn          |

---

## Implementation Components

### 1. BrowserSession Manager

```typescript
interface BrowserSession {
  // Lifecycle
  launch(): Promise<void>;
  close(): Promise<void>;

  // Navigation
  navigate(url: string): Promise<NavigationResult>;
  waitForNavigation(): Promise<void>;

  // Capture
  startCapture(): Promise<void>;
  stopCapture(): Promise<CapturedTraffic>;

  // Screenshots
  screenshot(): Promise<Buffer>;
  screenshotElement(selector: string): Promise<Buffer>;

  // Page inspection
  runInPage<T>(script: () => T): Promise<T>;
  querySelector(selector: string): Promise<ElementHandle | null>;

  // User prompts
  promptUser(message: string): Promise<void>;
  waitForUserAction(description: string): Promise<void>;
}
```

### 2. AuthFlowObserver

```typescript
interface AuthFlowObserver {
  // Observation
  observeLogin(): Promise<ObservedAuthFlow>;
  observeApiKeyRetrieval(): Promise<string | null>;

  // Analysis
  analyzeAuthArtifacts(traffic: CapturedTraffic): AuthArtifacts;
  detectAuthPattern(artifacts: AuthArtifacts): AuthPattern;

  // Multi-step
  detectRedirectChain(traffic: CapturedTraffic): RedirectChain;
  detectPortalFlow(chain: RedirectChain): PortalFlow | null;
}
```

### 3. EndpointDiscoverer

```typescript
interface EndpointDiscoverer {
  // Discovery
  discoverFromTraffic(traffic: CapturedTraffic): DiscoveredEndpoint[];

  // Enrichment
  inferRequestSchema(endpoint: DiscoveredEndpoint): RequestSchema;
  inferResponseSchema(endpoint: DiscoveredEndpoint): ResponseSchema;

  // Auth requirements
  detectRequiredAuth(endpoint: DiscoveredEndpoint): AuthRequirement[];
}
```

### 4. UserInteractionHandler

```typescript
interface UserInteractionHandler {
  // Prompts
  askUserToLogin(): Promise<void>;
  askUserToNavigate(description: string): Promise<void>;
  askUserToClickThrough(features: string[]): Promise<void>;

  // Confirmation
  confirmAuthFlow(observed: ObservedAuthFlow): Promise<boolean>;
  confirmEndpoints(endpoints: DiscoveredEndpoint[]): Promise<boolean>;

  // Edge cases
  notifyCaptcha(): Promise<void>; // "Please solve the CAPTCHA"
  notifyMfa(): Promise<void>; // "Please complete 2FA"
  notifyManualStep(description: string): Promise<void>;
}
```

---

## User Experience Flow

```
$ thesun servicenow

🔍 Launching browser for discovery...

📺 Browser opened. Please log in to ServiceNow normally.
   (I'm watching to learn how authentication works)

⏳ Waiting for login...

✅ Login detected! Observed:
   • Redirect to: SSO portal (Okta)
   • SAML authentication
   • Session cookie established

📍 Please navigate to the API settings or developer section.
   (I need to find any API keys or tokens)

⏳ Waiting for navigation...

🔑 Found API key at /nav_to.do?uri=sys_properties.list
   Key: ****-****-****-****

📋 Now click through the features you want in the MCP.
   Example: Open a ticket, list users, check an incident...

⏳ Capturing API traffic...

✅ Captured 12 unique endpoints:
   • GET  /api/now/table/incident
   • POST /api/now/table/incident
   • GET  /api/now/table/sys_user
   • ...

📊 Auth Requirements Detected:
   ┌─────────────────────────────────────────┐
   │ Session Cookie: JSESSIONID (required)   │
   │ API Key Header: X-sn-apikey (required)  │
   │ CSRF Token: X-UserToken (for writes)    │
   └─────────────────────────────────────────┘

❓ Does this look correct? [Y/n]

⚙️ Generating MCP with observed patterns...

✅ servicenow-mcp created!
   • 12 tools generated
   • Auth: Session + API Key + CSRF
   • Credentials saved to ~/.thesun/credentials/servicenow/
```

---

## Edge Case Handling

### CAPTCHA Detection

```typescript
async function handleCaptcha(session: BrowserSession): Promise<void> {
  const hasCaptcha = await session.runInPage(() => {
    return (
      document.querySelector(".g-recaptcha, .h-captcha, [data-captcha]") !==
      null
    );
  });

  if (hasCaptcha) {
    await session.promptUser(
      "🔐 CAPTCHA detected. Please solve it manually, then I'll continue.",
    );
    await session.waitForNavigation();
  }
}
```

### 2FA Detection

```typescript
async function handleMfa(session: BrowserSession): Promise<void> {
  const hasMfa = await session.runInPage(() => {
    const text = document.body.innerText.toLowerCase();
    return (
      text.includes("verification code") ||
      text.includes("authenticator") ||
      text.includes("two-factor") ||
      document.querySelector('input[name*="otp"], input[name*="code"]') !== null
    );
  });

  if (hasMfa) {
    await session.promptUser(
      "🔐 2FA/MFA detected. Please complete verification, then I'll continue.",
    );
    await session.waitForNavigation();
  }
}
```

### Portal Flow Detection

```typescript
async function detectPortalFlow(
  traffic: CapturedTraffic,
): Promise<PortalFlow | null> {
  const redirectChain = traffic.requests
    .filter((r) => r.status >= 300 && r.status < 400)
    .map((r) => ({
      from: r.url,
      to: r.headers["location"],
      type: detectRedirectType(r),
    }));

  // Detect SSO patterns
  const ssoProviders = [
    "okta.com",
    "auth0.com",
    "login.microsoftonline.com",
    "accounts.google.com",
    "idp.",
    "sso.",
  ];

  const ssoStep = redirectChain.find((r) =>
    ssoProviders.some((p) => r.to?.includes(p)),
  );

  if (ssoStep) {
    return {
      type: "sso",
      provider: detectSsoProvider(ssoStep.to),
      steps: redirectChain,
    };
  }

  return null;
}
```

---

## Files to Create/Modify

### New Files

- `src/browser/session-manager.ts` - Browser lifecycle and control
- `src/browser/auth-observer.ts` - Auth flow observation
- `src/browser/endpoint-discoverer.ts` - API discovery from traffic
- `src/browser/user-interaction.ts` - User prompts and confirmations
- `src/browser/edge-cases.ts` - CAPTCHA, MFA, portal handling
- `src/browser/traffic-analyzer.ts` - HAR analysis utilities

### Modified Files

- `src/mcp-server/index.ts` - Integrate browser-first flow
- `src/auth/credential-wizard.ts` - Use observed auth patterns

---

## Success Criteria

1. **ServiceNow** - Portal → SSO → Session + API Key works
2. **Salesforce** - OAuth + session combination works
3. **Jira Cloud** - Atlassian SSO + API token works
4. **Stripe Dashboard** - Login → retrieve API key from UI works
5. **AWS Console** - MFA + session + STS tokens works
6. **Generic SPA** - Session + CSRF token combo works

---

## Dependencies

- `chrome-devtools-mcp` - Browser automation
- `playwright` (optional) - More robust browser control
- Network interception APIs
- HAR parsing utilities

---

## Questions to Resolve

1. Should we support headless mode, or always show the browser?
2. How long should we wait for user actions before timing out?
3. Should we record video of the auth flow for debugging?
4. How do we handle sites that detect automation (bot protection)?
