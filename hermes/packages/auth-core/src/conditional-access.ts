export type ConditionalAccessChallengeState =
  | 'mfa_or_totp_required'
  | 'device_certificate_required'
  | 'vpn_or_network_required'
  | 'consent_required'
  | 'password_expired'
  | 'browser_profile_locked'
  | 'prompt_loop'
  | 'policy_blocks_headless'
  | 'unknown_login_route';

export type ConditionalAccessChallengeCategory =
  | 'auth-required'
  | 'environment-required'
  | 'configuration-required'
  | 'transient'
  | 'unsupported'
  | 'unknown';

export type ConditionalAccessRetryHint =
  | 'do-not-retry'
  | 'retry-after'
  | 'safe-to-retry'
  | 'human-action-required';

export interface ConditionalAccessChallenge {
  state: ConditionalAccessChallengeState;
  category: ConditionalAccessChallengeCategory;
  message: string;
  retryable: boolean;
  retryHint: ConditionalAccessRetryHint;
  retryAfterMs?: number;
  remediation: string;
  remediationCommands: string[];
  evidence: {
    url?: string;
    status?: number;
    matchedPattern?: string;
    selector?: string;
  };
}

export interface ConditionalAccessClassificationInput {
  message?: string;
  text?: string;
  url?: string;
  status?: number;
  selectors?: readonly string[];
  service?: string;
  acquireCommand?: string;
  totpConfigured?: boolean;
  unknownLoginRoute?: boolean;
  retryAfterMs?: number;
}

interface ChallengeRule {
  state: ConditionalAccessChallengeState;
  category: ConditionalAccessChallengeCategory;
  retryable: boolean;
  retryHint: ConditionalAccessRetryHint;
  retryAfterMs?: number;
  text: RegExp[];
  selectors?: readonly string[];
  status?: readonly number[];
  skip?: (input: ConditionalAccessClassificationInput) => boolean;
  remediation: (input: ConditionalAccessClassificationInput) => string;
}

export const CONDITIONAL_ACCESS_CHALLENGE_SELECTORS = [
  'input[name="otc"]',
  '#idTxtBx_SAOTCC_OTC',
  'text=/approve sign in request/i',
  'text=/enter code/i',
  'text=/verify your identity/i',
  'text=/select a certificate/i',
  'text=/certificate/i',
  'text=/need admin approval/i',
  'text=/permissions requested/i',
  'text=/password has expired/i',
  'text=/you cannot access this right now/i',
  'text=/blocked by conditional access/i',
] as const;

function acquireCommands(input: ConditionalAccessClassificationInput): string[] {
  if (input.acquireCommand) return [input.acquireCommand];
  if (input.service) return [`hermes acquire ${input.service}`];
  return [];
}

function commandText(input: ConditionalAccessClassificationInput): string {
  const commands = acquireCommands(input);
  return commands.length > 0 ? ` Then run: ${commands.join(' && ')}` : '';
}

const RULES: ChallengeRule[] = [
  {
    state: 'browser_profile_locked',
    category: 'transient',
    retryable: true,
    retryHint: 'retry-after',
    retryAfterMs: 10_000,
    text: [/browser profile.*lock/i, /profile.*in use/i, /singletonlock/i, /parent\.lock/i, /\bELOCKED\b/i],
    remediation: (input) => `Close stale headless browser processes or remove stale profile lock files after confirming no browser is using the profile.${commandText(input)}`,
  },
  {
    state: 'vpn_or_network_required',
    category: 'environment-required',
    retryable: true,
    retryHint: 'retry-after',
    retryAfterMs: 60_000,
    status: [407, 511],
    text: [/vpn/i, /private access/i, /network.*required/i, /proxy/i, /tunnel/i, /netskope/i, /zscaler/i, /ENOTFOUND/i, /ECONNREFUSED/i, /ERR_(TUNNEL|PROXY|CONNECTION|NAME)/i],
    remediation: (input) => `Connect to the required corporate VPN/network path and confirm proxy trust before retrying headless auth.${commandText(input)}`,
  },
  {
    state: 'device_certificate_required',
    category: 'environment-required',
    retryable: false,
    retryHint: 'human-action-required',
    selectors: ['text=/select a certificate/i', 'text=/certificate/i'],
    text: [/select a certificate/i, /client certificate/i, /device certificate/i, /certificate is required/i, /AADSTS53000/i, /device.*(compliant|managed|joined)/i],
    remediation: (input) => `Run Hermes on a managed device with the required client/device certificate available to the headless browser profile.${commandText(input)}`,
  },
  {
    state: 'password_expired',
    category: 'auth-required',
    retryable: false,
    retryHint: 'human-action-required',
    text: [/password has expired/i, /change your password/i, /AADSTS50055/i],
    remediation: (input) => `Reset the password in the identity provider; Hermes will not open a foreground password-change browser.${commandText(input)}`,
  },
  {
    state: 'consent_required',
    category: 'auth-required',
    retryable: false,
    retryHint: 'human-action-required',
    selectors: ['text=/need admin approval/i', 'text=/permissions requested/i'],
    text: [/need admin approval/i, /admin approval/i, /permissions requested/i, /consent.*required/i, /AADSTS65001/i, /AADSTS65004/i],
    remediation: (input) => `Grant the required user/admin consent for the application and scopes; Hermes cannot approve new consent out of band.${commandText(input)}`,
  },
  {
    state: 'policy_blocks_headless',
    category: 'unsupported',
    retryable: false,
    retryHint: 'human-action-required',
    selectors: ['text=/you cannot access this right now/i', 'text=/blocked by conditional access/i'],
    text: [/you cannot access this right now/i, /blocked by conditional access/i, /AADSTS53003/i, /conditional access policy/i, /browser or app may not be secure/i, /doesn'?t meet.*security/i],
    remediation: (input) => `Conditional Access blocks this headless route. Adjust policy, run from an allowed managed context, or add a supported headless-safe provider route before retrying.${commandText(input)}`,
  },
  {
    state: 'mfa_or_totp_required',
    category: 'auth-required',
    retryable: false,
    retryHint: 'human-action-required',
    selectors: ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC', 'text=/approve sign in request/i', 'text=/enter code/i', 'text=/verify your identity/i'],
    text: [/AADSTS50076/i, /AADSTS50079/i, /multi-factor authentication/i, /\bMFA\b/i, /authenticator app/i, /approve sign in request/i, /enter.*(code|verification code)/i, /verify your identity/i],
    skip: (input) => input.totpConfigured === true,
    remediation: (input) => `Configure a headless-safe TOTP secret in the keychain or satisfy MFA through an approved non-UI route; Hermes will not open a foreground browser.${commandText(input)}`,
  },
  {
    state: 'prompt_loop',
    category: 'auth-required',
    retryable: false,
    retryHint: 'human-action-required',
    text: [/too many redirects/i, /ERR_TOO_MANY_REDIRECTS/i, /sign-?in.*loop/i, /taking you to your organization'?s sign-?in page/i, /checking your credentials/i],
    remediation: (input) => `The IdP is looping between prompts. Check stale cookies/profile state, CA prompt frequency, and provider route selectors before retrying.${commandText(input)}`,
  },
];

function normalizeText(input: ConditionalAccessClassificationInput): string {
  return [
    input.message,
    input.text,
    input.url,
    ...(input.selectors ?? []),
  ].filter(Boolean).join('\n');
}

function buildChallenge(
  rule: ChallengeRule,
  input: ConditionalAccessClassificationInput,
  matchedPattern?: string,
  selector?: string,
): ConditionalAccessChallenge {
  const retryAfterMs = input.retryAfterMs ?? rule.retryAfterMs;
  return {
    state: rule.state,
    category: rule.category,
    message: `${rule.state}: ${matchedPattern ?? selector ?? input.message ?? input.text ?? input.url ?? 'classified headless SSO challenge'}`,
    retryable: rule.retryable,
    retryHint: retryAfterMs !== undefined && rule.retryable ? 'retry-after' : rule.retryHint,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    remediation: rule.remediation(input),
    remediationCommands: acquireCommands(input),
    evidence: {
      ...(input.url ? { url: input.url } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(matchedPattern ? { matchedPattern } : {}),
      ...(selector ? { selector } : {}),
    },
  };
}

export function classifyConditionalAccessChallenge(input: ConditionalAccessClassificationInput): ConditionalAccessChallenge | undefined {
  const text = normalizeText(input);
  for (const rule of RULES) {
    if (rule.skip?.(input)) continue;
    const selector = rule.selectors?.find((sel) => input.selectors?.includes(sel));
    if (selector) return buildChallenge(rule, input, undefined, selector);
    const matched = rule.text.find((pattern) => pattern.test(text));
    if (matched) return buildChallenge(rule, input, String(matched));
    if (input.status !== undefined && rule.status?.includes(input.status)) {
      return buildChallenge(rule, input, `HTTP ${input.status}`);
    }
  }

  if (input.unknownLoginRoute) {
    return {
      state: 'unknown_login_route',
      category: 'configuration-required',
      message: `unknown_login_route: ${input.url ?? input.message ?? 'unclassified login route'}`,
      retryable: false,
      retryHint: 'do-not-retry',
      remediation: `Capture the headless login route and add provider selectors/classification before retrying.${commandText(input)}`,
      remediationCommands: acquireCommands(input),
      evidence: {
        ...(input.url ? { url: input.url } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    };
  }

  return undefined;
}

export class ConditionalAccessChallengeError extends Error {
  public readonly challenge: ConditionalAccessChallenge;

  constructor(challenge: ConditionalAccessChallenge) {
    super(challenge.message);
    this.name = 'ConditionalAccessChallengeError';
    this.challenge = challenge;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      ...this.challenge,
    };
  }
}

interface LocatorLike {
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  innerText?(options?: { timeout?: number }): Promise<string>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
}

interface ConditionalAccessPageLike {
  url(): string;
  locator(selector: string): LocatorLike;
}

export async function classifyConditionalAccessPage(
  page: ConditionalAccessPageLike,
  input: Omit<ConditionalAccessClassificationInput, 'url' | 'text' | 'selectors'> = {},
): Promise<ConditionalAccessChallenge | undefined> {
  const selectors: string[] = [];
  for (const selector of CONDITIONAL_ACCESS_CHALLENGE_SELECTORS) {
    const visible = await page.locator(selector).isVisible({ timeout: 250 }).catch(() => false);
    if (visible) selectors.push(selector);
  }
  const body = page.locator('body');
  const text = await (body.innerText
    ? body.innerText({ timeout: 500 })
    : body.textContent({ timeout: 500 })
  ).catch(() => '');
  return classifyConditionalAccessChallenge({
    ...input,
    url: page.url(),
    text: text ?? '',
    selectors,
  });
}
