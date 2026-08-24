import { z } from 'zod';

export const SCHEMES = ['session'] as const;
export type CookieSessionScheme = typeof SCHEMES[number];

/**
 * Generic cookie-session provider config.
 *
 * Works for any web app that:
 *   1. Authenticates via Azure AD SSO (or any SAML/OIDC IdP that uses the same UI selectors).
 *   2. Issues an HTTP session cookie that the app accepts as auth.
 *
 * Used for: Tufin, Brinqa, NetSkope, Carbon Black, ForgeRock, Imperva, Tenable, Workday, etc.
 * Existing service-specific providers (servicenow, dynatrace, ms365) override this with their
 * own quirks (g_ck tokens, CSRF capture, app-specific URLs).
 */
export const CookieSessionConfigSchema = z.object({
  /** Service identifier — emitted in TokenBundle.service. e.g. "tufin", "brinqa". */
  serviceName: z.string().min(1).optional(),

  /** Service base URL — Playwright navigates here to start the SSO flow. */
  baseUrl: z.string().url(),

  /** Email/username for SSO. */
  loginHint: z.string().min(1, 'loginHint is required'),

  /** macOS Keychain reference for the password (Hermes never stores passwords directly). */
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),

  /** macOS Keychain reference for the TOTP secret (base32). */
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),

  /**
   * Headless browser? Default true — background re-auth must never pop up a visible
   * browser window. Use `hermes acquire` for interactive flows that need a visible browser.
   */
  headless: z.literal(true).default(true),

  /** Total auth flow timeout in milliseconds. */
  authTimeoutMs: z.number().int().min(5_000).default(180_000),

  /**
   * Session lifetime in milliseconds — how long Hermes assumes the captured cookies
   * remain valid before scheduling a refresh. Default 8h matches typical enterprise SSO.
   */
  sessionLifetimeMs: z.number().int().min(60_000).default(8 * 60 * 60 * 1000),

  /** How early before expiry to schedule a proactive refresh. Default 1h. */
  refreshMarginMs: z.number().int().min(0).default(60 * 60 * 1000),

  /**
   * Optional relative path on the service used for `validate()` calls and the
   * post-login probe to ensure the API session is alive. e.g. "/securetrack/api/devices?count=1"
   * or "/api/users/me". If omitted, validation only checks reachability of baseUrl.
   */
  validatePath: z.string().optional(),

  /**
   * When true, acquire() only succeeds if the post-login validatePath probe
   * returns a non-auth-failure status. Useful for SSO portals that can land on
   * the service host with pre-auth cookies that are not yet API-authorized.
   */
  requireValidateSuccess: z.boolean().default(false),

  /**
   * Extra CSS selectors for an explicit "Sign in with SSO" button on the service's
   * own login page (clicked before Azure AD takes over). Sensible defaults are always
   * tried — these are appended.
   */
  ssoButtonSelectors: z.array(z.string()).default([]),

  /**
   * Additional cookie domain substrings to capture beyond the service's hostname.
   * Useful when the service uses a CDN or wildcard subdomain. Always implicitly
   * includes `new URL(baseUrl).hostname`.
   */
  extraCookieDomains: z.array(z.string()).default([]),

  /**
   * Whether to include Microsoft federation cookies (login.microsoftonline.com) in
   * the captured bundle's `extra.cookies` (for diagnostics). They are NEVER part of
   * the Cookie request header sent to the service.
   */
  includeMicrosoftCookies: z.boolean().default(true),

  /**
   * SessionStorage keys to capture after SSO completes. Some SPAs (e.g. Venafi Aperture)
   * store API keys or tokens in sessionStorage rather than cookies. Captured values are
   * included in `extra.sessionStorage`. If a key named "apiKey" or "transferToken" is
   * found, it is also set as the `accessToken` (overriding the cookie header).
   */
  captureSessionStorageKeys: z.array(z.string()).default([]),

  /**
   * When sessionStorage contains an API key/token, use it as the accessToken instead
   * of the cookie header. Set to the sessionStorage key name (e.g. "apiKey").
   */
  sessionStorageTokenKey: z.string().optional(),

  /**
   * When a SessionStorageToken is served, send the token under this header name (raw
   * value, no "Bearer " prefix) instead of `Authorization: Bearer`. Required for
   * services like Venafi that authenticate via a proprietary header (e.g. "X-Venafi-Api-Key").
   * Absent = current behavior (`Authorization: Bearer <token>`).
   */
  sessionStorageTokenHeader: z.string().min(1).optional(),

  /**
   * sessionStorage key holding the SPA session's REAL absolute expiry (e.g. Venafi
   * Aperture's `expires`). When present and captured, the bundle's `expiresAt` is
   * derived from this value instead of the optimistic `sessionLifetimeMs` default —
   * so Hermes never serves a session past its true death. Accepted formats: epoch
   * seconds, epoch milliseconds, or an ISO/date string. Absent = auto-detect a
   * captured key literally named `expires`; if neither is found, fall back to the
   * earliest finite service cookie expiry, then to `sessionLifetimeMs`.
   */
  sessionStorageExpiryKey: z.string().min(1).optional(),
});

export type CookieSessionConfig = z.infer<typeof CookieSessionConfigSchema>;
