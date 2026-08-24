import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { SafetyClass, SafetyClassification } from "./manifest.js";

/**
 * Tier-B out-of-band approval store (SC-4).
 *
 * Design constraint (critical): nothing that authorizes a Tier-B call may
 * travel through the model. Tier-A (WRITE/SIDE_EFFECT) keeps the existing
 * `confirmed: true` self-confirm — the agent re-invokes its own call with the
 * flag set, and the gateway honors it (see manifest.ts decideGate + the Tier-A
 * path in gateway.ts dispatchToolCall). That is UNCHANGED by this module.
 *
 * Tier-B classes (PRODUCTION, VAULT_VALUE, HUMAN_OUTBOUND, and anything with a
 * non-empty write_guard) instead park on a `confirmed: true` from the model:
 * the gateway records a PendingApproval and returns `approvalPending` without
 * ever calling the backend. A human authorizes the action through a transport
 * the model cannot operate — the gateway's loopback-only /approve and /grants
 * HTTP endpoints (see gateway.ts setupApprovalRoutes) or the `thesun approve` /
 * `thesun grants` CLI. Approving creates a StandingGrant (one-time by default,
 * persistent when the human opts into `standing: true`); a matching grant is
 * what lets a subsequent dispatch of the same identity+backend+tool proceed.
 *
 * This file owns ONLY the file-backed store + pure classification/redaction
 * helpers. All request/response/dispatch wiring lives in gateway.ts.
 */

// ─── THESUN_HOME resolution ───────────────────────────────────────────────────

/**
 * Mirrors fleet/fleetd/internal/paths/paths.go Home(): $THESUN_HOME wins,
 * else the OS user-config dir + "thesun" (macOS: ~/Library/Application
 * Support/thesun; Linux: $XDG_CONFIG_HOME or ~/.config/thesun; Windows:
 * %AppData%\thesun). Kept in sync so the gateway (Node) and fleetd (Go) agree
 * on where approvals.json / grants.json live without either side needing to
 * pass the path explicitly.
 */
export function resolveThesunHome(): string {
  const override = process.env.THESUN_HOME;
  if (override) return override;

  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "thesun");
  }
  if (plat === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "thesun");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "thesun");
}

// ─── Schemas ───────────────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  ts: string;
  identity: string;
  backend: string;
  tool: string;
  /** Type-tagged, value-free summary of the call arguments (see summarizeArgs). */
  argsSummary: string;
  safetyClass: SafetyClass;
  expiresAt: string;
}

export interface StandingGrant {
  id: string;
  identity: string;
  backend: string;
  tool: string;
  createdAt: string;
  /** Absent = never expires (until revoked). */
  expiresAt?: string;
  /**
   * true when this grant was created by a plain `approve` (no `standing`
   * flag) — consumed after authorizing exactly one dispatch. false/absent for
   * a `standing: true` approval, which persists across dispatches until it
   * expires (ttl) or is revoked via `thesun grants rm`.
   */
  oneTime?: boolean;
  /**
   * Present ONLY on a class-scoped grant (UX-1, created by createClassGrant).
   * Such a grant authorizes any tool of this safetyClass on the backend for a
   * short TTL. It is stored with tool = "*" but is distinct from a plain trust
   * wildcard: a trust wildcard has NO safetyClass and covers every class,
   * whereas a class grant matches only calls of this exact class. Always
   * standing within its TTL (never oneTime).
   */
  safetyClass?: SafetyClass;
}

const PENDING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h — an unactioned request expires, it is not forgotten silently forever

/**
 * Default lifetime applied to a one-time grant that is approved WITHOUT an
 * explicit ttl (SEC-6). Without this, a one-time grant that is never consumed
 * would have no expiresAt and loadGrants would never prune it, so it would
 * live in grants.json forever as stale standing authority. 24h bounds that
 * window while still covering any realistic gap between a human approving and
 * the agent re-invoking the guarded call. Standing grants are deliberately
 * excluded: they may legitimately be long-lived or explicitly TTL-capped.
 */
const DEFAULT_ONE_TIME_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Class-scoped grant lifetimes (UX-1). A class grant trades a broader scope
 * (every tool of one safetyClass on a backend, current and future) for a short
 * TTL, so a human can silence a burst of repeat Tier-B prompts of the same
 * class without opening an open-ended hole. DEFAULT applies when the approver
 * gives no ttl; MAX caps any explicit ttl so a class grant can never become
 * long-lived standing authority.
 */
const DEFAULT_CLASS_GRANT_TTL_MS = 15 * 60 * 1000; // 15m
const MAX_CLASS_GRANT_TTL_MS = 60 * 60 * 1000; // 1h ceiling

// ─── Tier-B classification ─────────────────────────────────────────────────────

/**
 * Tier-B predicate — deliberately separate from manifest.ts's decideGate/
 * isGatedClass (which remain untouched so Tier-A behavior and its e2e proof
 * are unaffected). PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND are always
 * Tier-B; a capability with an explicit write_guard is Tier-B regardless of
 * its safety_class (the manifest author's explicit guard intent wins, same
 * precedent as decideGate's `gated` computation).
 */
export function isTierBClass(safety: SafetyClassification | undefined): boolean {
  if (!safety) return false;
  if (
    safety.safetyClass === "PRODUCTION" ||
    safety.safetyClass === "VAULT_VALUE" ||
    safety.safetyClass === "HUMAN_OUTBOUND"
  ) {
    return true;
  }
  return Boolean(safety.writeGuard);
}

// ─── Standing-authority policy (per class) ────────────────────────────────────

/**
 * Safety classes that NO standing authority may ever cover: every single call
 * of such a class needs its own fresh, one-time human approval.
 *
 * Why PRODUCTION is here. Tier-B already refuses a model-supplied
 * confirmed:true, but that only forces the FIRST call past a human; a standing
 * grant then authorizes every later call of that tool forever. The most
 * dangerous tools in the fleet are universal executors (akamai_raw_request
 * dispatches any of 1145 catalogued operations, including property and
 * security-config activation and cache purge against live CDN), so one standing
 * grant silently blankets the entire blast radius. That is measured, not
 * hypothetical: an --always approval taken on 2026-08-07 left
 * akamai_go_akamai_raw_request dispatching to the backend with no confirmation
 * demand at all, and the audit log recorded it as decision "proceed",
 * tierB true, every time. config.fleet.yaml already told operators never to
 * grant that tool a standing approval; a comment enforces nothing, so the rule
 * now lives in the code that resolves grants.
 *
 * Deliberately NOT all of Tier-B. HUMAN_OUTBOUND standing grants are in active
 * legitimate use (a chat bot cannot ask for human approval per message, and its
 * blast radius is one message to one channel). VAULT_VALUE keeps standing
 * grants for now: no such grant exists today, so narrowing it is an operator
 * policy call rather than a fix to a measured hole, and it is one array element
 * away should the operator want it.
 */
export const NO_STANDING_GRANT_CLASSES: readonly SafetyClass[] = ["PRODUCTION"];

/**
 * True when a call of this class may be authorized by standing authority: a
 * standing per-tool grant, a class-scoped grant, or a backend-wide trust
 * wildcard. An absent class returns true, because this predicate only narrows
 * authority for the classes it names; isTierBClass remains the gate deciding
 * whether a call consults grants at all.
 */
export function allowsStandingGrant(safetyClass: SafetyClass | undefined): boolean {
  if (!safetyClass) return true;
  return !NO_STANDING_GRANT_CLASSES.includes(safetyClass);
}

// ─── Grant-identity composition (approvals.identity_scope) ───────────────────

/**
 * Compose the identity string used for grant/approval matching (Phase 4,
 * addresses G4). Pure function — the store itself stays scope-agnostic and
 * simply matches identity strings exactly, so scoping is entirely decided by
 * what the gateway composes here.
 *
 *  scope "install"        → the base identity unchanged (Entra oid or the
 *                           stable per-install id). Default; preserves every
 *                           existing grant.
 *  scope "install+client" → `<base>+client:<clientInfo.name>` when the
 *                           connecting MCP client's name is known (captured
 *                           from the initialize handshake on stateful
 *                           transports). A grant issued under client A then
 *                           never matches a dispatch from client B. When the
 *                           client name is unavailable (stateless streamable
 *                           HTTP has no per-call client identity), falls back
 *                           to the base identity — degraded to install scope
 *                           rather than inventing an unstable identity that
 *                           would strand grants.
 */
export function composeGrantIdentity(
  base: string,
  scope: "install" | "install+client",
  clientName?: string
): string {
  if (scope !== "install+client") return base;
  const name = clientName?.trim();
  if (!name) return base;
  return `${base}+client:${name}`;
}

// ─── Argument redaction (stricter than content-guard: values never persist) ───

/**
 * Type-tag redaction for the approval record: every argument VALUE is
 * replaced by its type tag, so no secret or PII value is ever written to
 * approvals.json (a persisted, disk-resident file — a higher bar than a
 * transient tool-call response). Structurally identical to the redaction
 * gateway.ts already applies to a Tier-A block response's `redactedArguments`
 * field; duplicated here (rather than imported) to keep this module
 * self-contained and to avoid touching gateway.ts's existing Tier-A block
 * path at all.
 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null) redacted[k] = "<null>";
    else if (Array.isArray(v)) redacted[k] = "<array>";
    else redacted[k] = `<${typeof v}>`;
  }
  return JSON.stringify(redacted);
}

/** Human-readable one-line description of a pending approval (CLI + HTML + tool response). */
export function describeApproval(approval: PendingApproval): string {
  return `${approval.backend}.${approval.tool} (${approval.safetyClass}) requested by ${approval.identity} — arguments: ${approval.argsSummary}`;
}

// ─── Store ─────────────────────────────────────────────────────────────────────

export class ApprovalStore {
  private readonly dir: string;
  private readonly approvalsPath: string;
  private readonly grantsPath: string;
  private readonly identityPath: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveThesunHome();
    this.approvalsPath = join(this.dir, "approvals.json");
    this.grantsPath = join(this.dir, "grants.json");
    this.identityPath = join(this.dir, "install-identity.json");
  }

  // ── generic JSON array persistence (fail-soft: unreadable/corrupt → empty) ──

  private load<T>(path: string): T[] {
    try {
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, "utf-8");
      if (!raw.trim()) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      // Fail-soft by design here: a corrupt approvals/grants file must never
      // crash dispatch. Losing a stale pending record is not a security
      // problem (the call simply re-parks on next attempt); losing a grant
      // fails closed (no bypass), which is the safe direction.
      return [];
    }
  }

  private save<T>(path: string, items: T[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  // ── pending approvals ──

  private loadPending(): PendingApproval[] {
    const now = Date.now();
    const items = this.load<PendingApproval>(this.approvalsPath);
    const live = items.filter((a) => new Date(a.expiresAt).getTime() > now);
    if (live.length !== items.length) this.save(this.approvalsPath, live);
    return live;
  }

  listPending(): PendingApproval[] {
    return this.loadPending();
  }

  getPending(id: string): PendingApproval | undefined {
    return this.loadPending().find((a) => a.id === id);
  }

  /**
   * Create (or reuse) a pending approval for one identity+backend+tool call.
   * Repeated dispatches of the same guarded tool while a request is already
   * parked reuse the existing record rather than piling up duplicates — the
   * human only needs to see one entry per outstanding request.
   */
  createPending(input: {
    identity: string;
    backend: string;
    tool: string;
    argsSummary: string;
    safetyClass: SafetyClass;
  }): PendingApproval {
    const pending = this.loadPending();
    const existing = pending.find(
      (a) => a.identity === input.identity && a.backend === input.backend && a.tool === input.tool
    );
    if (existing) return existing;

    const record: PendingApproval = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      identity: input.identity,
      backend: input.backend,
      tool: input.tool,
      argsSummary: input.argsSummary,
      safetyClass: input.safetyClass,
      expiresAt: new Date(Date.now() + PENDING_APPROVAL_TTL_MS).toISOString(),
    };
    pending.push(record);
    this.save(this.approvalsPath, pending);
    return record;
  }

  /**
   * Approve a pending request by id. Always creates/refreshes a grant for the
   * approval's identity+backend+tool: `standing: true` makes it persistent
   * (optionally capped by ttlMs); otherwise it is one-time — consumed by the
   * next dispatch that matches (see consumeIfOneTime).
   *
   * Returns undefined if the id is unknown or already expired/removed.
   */
  approve(
    id: string,
    opts: { standing?: boolean; ttlMs?: number } = {}
  ): { approval: PendingApproval; grant: StandingGrant } | undefined {
    const pending = this.loadPending();
    const idx = pending.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    const [approval] = pending.splice(idx, 1);
    this.save(this.approvalsPath, pending);

    const grants = this.loadGrants().filter(
      (g) => !(g.identity === approval.identity && g.backend === approval.backend && g.tool === approval.tool)
    );
    // Creation-side half of the no-standing rule: a PRODUCTION approval is
    // one-time even when the human passes --always. Refusing at write time as
    // well as at resolve time keeps `thesun grants` honest, so no grant is ever
    // recorded that reads as standing authority the resolver would then ignore.
    const oneTime = !opts.standing || !allowsStandingGrant(approval.safetyClass);
    // A one-time grant with no explicit ttl gets DEFAULT_ONE_TIME_TTL_MS so it
    // cannot outlive its intended single use as stale authority (SEC-6);
    // loadGrants then prunes it once past expiresAt. Standing grants keep the
    // prior semantics: no default expiry (only an explicit ttlMs caps them).
    const ttlMs = opts.ttlMs ?? (oneTime ? DEFAULT_ONE_TIME_TTL_MS : undefined);
    const grant: StandingGrant = {
      id: randomUUID(),
      identity: approval.identity,
      backend: approval.backend,
      tool: approval.tool,
      createdAt: new Date().toISOString(),
      ...(ttlMs ? { expiresAt: new Date(Date.now() + ttlMs).toISOString() } : {}),
      oneTime,
    };
    grants.push(grant);
    this.save(this.grantsPath, grants);
    return { approval, grant };
  }

  // ── standing grants ──

  private loadGrants(): StandingGrant[] {
    const now = Date.now();
    const items = this.load<StandingGrant>(this.grantsPath);
    const live = items.filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now);
    if (live.length !== items.length) this.save(this.grantsPath, live);
    return live;
  }

  listGrants(): StandingGrant[] {
    return this.loadGrants();
  }

  /**
   * Find a grant authorizing identity × backend × tool. Three match shapes
   * (deliberately NO general globbing), in strict precedence order:
   *   - exact:    grant.tool === tool and no safetyClass (a plain approve)
   *   - class:    grant.safetyClass === safetyClass (UX-1 class grant, stored
   *               tool "*") — only tried when the caller passes the call's
   *               safetyClass; covers all current AND FUTURE tools of that
   *               class on the backend for the grant's TTL
   *   - wildcard: grant.tool === "*" and no safetyClass (backend-wide trust,
   *               created by `thesun trust <backend>` — every tool, every class)
   * Exact beats class beats wildcard, so a one-time exact approval is the one
   * consumed (consumeIfOneTime) rather than silently riding a broader standing
   * grant, and a narrow class grant is preferred over a backend-wide trust.
   * safetyClass is optional so pre-UX-1 callers keep exact/wildcard behavior.
   */
  findGrant(
    identity: string,
    backend: string,
    tool: string,
    safetyClass?: SafetyClass
  ): StandingGrant | undefined {
    const candidates = this.loadGrants().filter((g) => g.identity === identity && g.backend === backend);
    // A no-standing class (NO_STANDING_GRANT_CLASSES) is authorized ONLY by a
    // fresh one-time approval of this exact tool: a standing per-tool grant, a
    // class grant, and a backend-wide trust wildcard are all refused. Enforcing
    // it here, at the resolve site, is the load-bearing half of the rule: any
    // such grant ALREADY on disk becomes inert, so the guarantee never depends
    // on the store having been cleaned up.
    const noStanding = !allowsStandingGrant(safetyClass);
    const exact = candidates.find(
      (g) => g.tool === tool && !g.safetyClass && (!noStanding || g.oneTime === true)
    );
    if (exact) return exact;
    if (noStanding) return undefined;
    if (safetyClass) {
      const cls = candidates.find((g) => g.safetyClass === safetyClass);
      if (cls) return cls;
    }
    return candidates.find((g) => g.tool === "*" && !g.safetyClass);
  }

  /**
   * Atomic resolve-and-consume for the Tier-B dispatch path (SEC-2 TOCTOU fix).
   *
   * Previously the gateway called findGrant, then made the backend tool call,
   * then called consumeIfOneTime — three steps with `await` boundaries in
   * between. Two concurrent Tier-B dispatches could both resolve the SAME
   * one-time grant before either consumed it, so a single human approval
   * authorized TWO backend actions. This method collapses resolve + consume
   * into ONE synchronous critical section: a matching one-time grant is
   * spliced out and persisted to disk BEFORE it is returned, so a second
   * concurrent caller sees it already gone and gets undefined.
   *
   * Why this is sufficient without a lock or a promise queue: every grant
   * write funnels through this one gateway process, and all grant-store I/O
   * here is synchronous (readFileSync / writeFileSync / renameSync). Node runs
   * a synchronous method to completion without interleaving any other JS, so
   * no two read-modify-write sequences (findAndConsume, createTrustGrant,
   * revokeGrant, approve) can ever interleave and lose an update. The TOCTOU
   * existed only because the read and the write were split across the backend
   * call's `await`; keeping both inside one synchronous method removes that
   * gap entirely. A cross-process file lock is deliberately NOT added (KISS,
   * single-writer process).
   *
   * Match precedence is identical to findGrant: exact-tool beats class-scoped
   * (UX-1) beats backend-wide "*" wildcard, so a one-time exact approval is the
   * one consumed rather than silently riding a broader standing grant. Only
   * one-time exact grants are consumed; class and wildcard grants (both always
   * standing) are returned WITHOUT consumption.
   */
  findAndConsume(
    identity: string,
    backend: string,
    tool: string,
    safetyClass?: SafetyClass
  ): StandingGrant | undefined {
    const grants = this.loadGrants();
    const candidates = grants.filter((g) => g.identity === identity && g.backend === backend);
    // Same no-standing rule as findGrant, applied at the authorization site the
    // Tier-B dispatch path actually calls (gateway.ts dispatchTierB).
    const noStanding = !allowsStandingGrant(safetyClass);
    const exact = candidates.find(
      (g) => g.tool === tool && !g.safetyClass && (!noStanding || g.oneTime === true)
    );
    const cls =
      safetyClass && !noStanding
        ? candidates.find((g) => g.safetyClass === safetyClass)
        : undefined;
    const wildcard = noStanding
      ? undefined
      : candidates.find((g) => g.tool === "*" && !g.safetyClass);
    const grant = exact ?? cls ?? wildcard;
    if (!grant) return undefined;
    if (grant.oneTime) {
      const idx = grants.findIndex((g) => g.id === grant.id);
      if (idx !== -1) {
        grants.splice(idx, 1);
        this.save(this.grantsPath, grants);
      }
    }
    return grant;
  }

  /**
   * Backend-wide standing grant (`thesun trust <backend>`): tool = "*" for
   * one identity × backend. Always standing (never one-time — a one-time
   * wildcard makes no sense), optionally TTL-capped. Replaces any existing
   * wildcard grant for the same identity × backend so re-trusting refreshes
   * the TTL instead of stacking duplicates. Exact-tool grants are untouched.
   */
  createTrustGrant(input: { identity: string; backend: string; ttlMs?: number }): StandingGrant {
    const grants = this.loadGrants().filter(
      (g) => !(g.identity === input.identity && g.backend === input.backend && g.tool === "*")
    );
    const grant: StandingGrant = {
      id: randomUUID(),
      identity: input.identity,
      backend: input.backend,
      tool: "*",
      createdAt: new Date().toISOString(),
      ...(input.ttlMs ? { expiresAt: new Date(Date.now() + input.ttlMs).toISOString() } : {}),
    };
    grants.push(grant);
    this.save(this.grantsPath, grants);
    return grant;
  }

  /**
   * Class-scoped standing grant (UX-1): authorizes every tool of one
   * safetyClass on one identity × backend for a short TTL. Stored with
   * tool = "*" plus a safetyClass tag, so findGrant/findAndConsume match it
   * only for calls of that exact class (a plain trust wildcard has no
   * safetyClass and matches every class). Always standing within its TTL
   * (never one-time). The ttl defaults to DEFAULT_CLASS_GRANT_TTL_MS and is
   * capped at MAX_CLASS_GRANT_TTL_MS so a class grant can never become
   * long-lived authority. Replaces any existing class grant for the same
   * identity × backend × safetyClass so re-approving refreshes the TTL instead
   * of stacking duplicates; exact-tool and plain wildcard grants are untouched.
   *
   * `identity` is the already-composed grant identity (see composeGrantIdentity,
   * applied by the gateway), matching the convention of createTrustGrant.
   */
  createClassGrant(input: {
    identity: string;
    backend: string;
    safetyClass: SafetyClass;
    ttlMs?: number;
  }): StandingGrant {
    // A class grant is standing authority over every current AND future tool of
    // one class on a backend, which is precisely what a no-standing class must
    // never have. Throwing is the fail-closed backstop behind the /trust
    // route's own 400 (gateway.ts setupApprovalRoutes).
    if (!allowsStandingGrant(input.safetyClass)) {
      throw new Error(
        `class grants are not allowed for safety class ${input.safetyClass}: every call of this class requires a fresh one-time human approval`
      );
    }
    const ttlMs = Math.min(input.ttlMs ?? DEFAULT_CLASS_GRANT_TTL_MS, MAX_CLASS_GRANT_TTL_MS);
    const grants = this.loadGrants().filter(
      (g) =>
        !(g.identity === input.identity && g.backend === input.backend && g.safetyClass === input.safetyClass)
    );
    const grant: StandingGrant = {
      id: randomUUID(),
      identity: input.identity,
      backend: input.backend,
      tool: "*",
      safetyClass: input.safetyClass,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    grants.push(grant);
    this.save(this.grantsPath, grants);
    return grant;
  }

  /** Consume a one-time grant after it authorizes a dispatch. No-op for standing grants or unknown ids. */
  consumeIfOneTime(grantId: string): void {
    const grants = this.loadGrants();
    const idx = grants.findIndex((g) => g.id === grantId);
    if (idx === -1 || !grants[idx].oneTime) return;
    grants.splice(idx, 1);
    this.save(this.grantsPath, grants);
  }

  revokeGrant(id: string): boolean {
    const grants = this.loadGrants();
    const idx = grants.findIndex((g) => g.id === id);
    if (idx === -1) return false;
    grants.splice(idx, 1);
    this.save(this.grantsPath, grants);
    return true;
  }

  // ── per-install identity (auth.mode = none / no Entra oid) ──

  /**
   * Stable per-install identity used for grant matching when there is no
   * Entra identity (auth.mode != "entra"). Generated once and persisted
   * alongside the approval store so grants survive gateway restarts.
   */
  getInstallIdentity(): string {
    try {
      if (existsSync(this.identityPath)) {
        const raw = JSON.parse(readFileSync(this.identityPath, "utf-8")) as { id?: string };
        if (raw?.id) return raw.id;
      }
    } catch {
      // fall through to regenerate — a corrupt identity file must not crash dispatch
    }
    const id = `install-${randomUUID()}`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.identityPath, JSON.stringify({ id }, null, 2), { mode: 0o600 });
    } catch {
      // best-effort persistence: if the write fails, this call still returns
      // a usable id, just not a stable one across restarts.
    }
    return id;
  }
}
