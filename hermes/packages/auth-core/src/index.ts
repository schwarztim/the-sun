export {
  type BrowserAuth, type BrowserAuthParams, type BrowserAuthResult,
  PlaywrightBrowserAuth, clearProfileLock, trySelector,
} from './browser-auth.js';

export {
  BrowserAuthTimeoutError,
  withManagedBrowser,
  forceCloseBrowser,
  raceDeadline,
  browserRegistry,
  snapshotPlaywrightChildPids,
  diffNewPlaywrightChildPid,
  resetManagedBrowserStateForTests,
  type BrowserEngine,
  type BrowserRegistryEntry,
  type BrowserRunFileEntry,
  type ManagedBrowserLike,
  type ManagedBrowserLogger,
  type ReapPriorIncarnationsSeams,
  type WithManagedBrowserOptions,
} from './managed-browser.js';

export {
  generateTotp, base32ToBytes, readKeychainPassword, readTotpFromKeychain, extractTotpSecret,
  readTotpSeedFromKeychain, makeTotpSupplier, supplyFreshTotp, resolveTotp,
  resetTotpReplayRegistryForTests, TotpRejectedError,
  type TotpSupplier, type TotpInput,
} from './totp.js';

export {
  silentRefresh, defaultFetcher, OAuthRefreshError, RefreshTokenExpiredError,
  RefreshTokenUnusableError, SPA_REFRESH_TOKEN_MAX_AGE_MS,
  refreshTokenAcquiredAt, assertRefreshTokenUsable,
  type RefreshFailureCategory, type TokenBundle, type OauthFetcher, type OauthTokenResponse, type SilentRefreshOptions,
} from './refresh.js';

export {
  ConditionalAccessChallengeError,
  classifyConditionalAccessChallenge,
  classifyConditionalAccessPage,
  type ConditionalAccessChallenge,
  type ConditionalAccessChallengeCategory,
  type ConditionalAccessChallengeState,
  type ConditionalAccessClassificationInput,
  type ConditionalAccessRetryHint,
} from './conditional-access.js';

export {
  type CredentialStore,
  MacKeychainStore, KeytarStore, FileStore, MemoryStore,
  createCredentialStore,
} from './credential-store.js';

export {
  loadSessionState, saveSessionState, invalidateSessionState,
  type SessionState, type SessionStateLogger,
} from './session-state.js';

export { getToken, type DualModeAuthOptions } from './dual-mode.js';

export {
  captureDebugState,
  redactPasswordValues,
  type CaptureablePage,
  type CaptureDebugStateOptions,
  type CaptureDebugStateResult,
} from './capture-debug-state.js';

export { sanitizeUrl } from './url-sanitizer.js';

export {
  runSsoLoop,
  type SsoPage,
  type SsoLocator,
  type SsoLoopLogger,
  type SsoLoopSelectors,
  type SsoLoopOptions,
  type SsoLoopAction,
  type SsoLoopResult,
} from './sso-loop.js';
