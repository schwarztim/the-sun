/**
 * SEC-2 regression suite: Tier-B one-time-grant TOCTOU (findAndConsume).
 *
 * The bug: the dispatch path resolved a grant (findGrant) and consumed it
 * (consumeIfOneTime) as two separate steps with the backend tool call between
 * them. Two concurrent Tier-B dispatches could both resolve the SAME one-time
 * grant before either consumed it, so ONE human approval authorized TWO
 * backend actions. findAndConsume collapses resolve + consume into a single
 * synchronous critical section: a matching one-time grant is spliced out and
 * persisted BEFORE it is returned, so exactly one caller can ever win.
 *
 * Covers:
 *  - two concurrent findAndConsume against one one-time grant: exactly ONE
 *    wins, the other gets undefined, and zero copies remain in the store
 *  - a standing (non one-time) grant is returned WITHOUT being consumed
 *  - a "*" wildcard trust grant (always standing) is returned WITHOUT being
 *    consumed
 *  - match precedence (exact wins over "*") is preserved, matching findGrant
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore, summarizeArgs, type StandingGrant } from "../../src/approvals.js";

let dir: string;
let store: ApprovalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approvals-toctou-"));
  store = new ApprovalStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Park + approve to mint a grant through the same path production uses. */
function mintGrant(tool: string, opts: { standing?: boolean } = {}): StandingGrant {
  const pending = store.createPending({
    identity: "id-1",
    backend: "github",
    tool,
    argsSummary: summarizeArgs({ x: 1 }),
    // HUMAN_OUTBOUND, not PRODUCTION: this suite exercises standing-grant
    // mechanics, and PRODUCTION now forbids standing authority outright
    // (approvals.ts NO_STANDING_GRANT_CLASSES). The class here is incidental to
    // what is under test; HUMAN_OUTBOUND is Tier-B and standing-capable.
    safetyClass: "HUMAN_OUTBOUND",
  });
  const result = store.approve(pending.id, opts);
  if (!result) throw new Error("approve failed in fixture");
  return result.grant;
}

describe("findAndConsume — one-time grant TOCTOU (SEC-2)", () => {
  it("two concurrent calls against ONE one-time grant: exactly one wins, zero copies remain", async () => {
    const grant = mintGrant("github_delete_repo"); // one-time (no standing)
    expect(grant.oneTime).toBe(true);

    // Schedule two dispatches concurrently. findAndConsume runs its
    // read-modify-write synchronously to completion, so whichever microtask
    // runs first consumes the grant and the second finds it already gone.
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => store.findAndConsume("id-1", "github", "github_delete_repo")),
      Promise.resolve().then(() => store.findAndConsume("id-1", "github", "github_delete_repo")),
    ]);

    const winners = [a, b].filter((g): g is StandingGrant => Boolean(g));
    expect(winners).toHaveLength(1); // exactly one authorization, never two
    expect(winners[0].id).toBe(grant.id);

    // Store has zero remaining copies of the consumed grant.
    expect(store.listGrants().filter((g) => g.id === grant.id)).toHaveLength(0);
    expect(store.findGrant("id-1", "github", "github_delete_repo")).toBeUndefined();
  });

  it("a second sequential call re-parks (returns undefined) after the one-time grant is consumed", () => {
    const grant = mintGrant("github_delete_repo");
    const first = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(first?.id).toBe(grant.id);
    const second = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(second).toBeUndefined();
  });
});

describe("findAndConsume — standing / wildcard grants are NOT consumed", () => {
  it("a standing (non one-time) exact grant is returned every time and stays in the store", () => {
    const grant = mintGrant("github_delete_repo", { standing: true });
    expect(grant.oneTime).toBe(false);

    const first = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(first?.id).toBe(grant.id);
    // Still present — a standing grant authorizes repeatedly.
    expect(store.listGrants().filter((g) => g.id === grant.id)).toHaveLength(1);
    const second = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(second?.id).toBe(grant.id);
    expect(store.listGrants().filter((g) => g.id === grant.id)).toHaveLength(1);
  });

  it('a "*" wildcard trust grant (always standing) is returned WITHOUT being consumed', () => {
    const wildcard = store.createTrustGrant({ identity: "id-1", backend: "github" });
    expect(wildcard.oneTime).toBeUndefined();

    const first = store.findAndConsume("id-1", "github", "github_any_tool");
    expect(first?.id).toBe(wildcard.id);
    const second = store.findAndConsume("id-1", "github", "github_other_tool");
    expect(second?.id).toBe(wildcard.id);
    // Wildcard still present after two dispatches.
    expect(store.listGrants().filter((g) => g.tool === "*")).toHaveLength(1);
  });

  it("exact one-time grant wins over a standing wildcard, and the wildcard survives to answer afterwards", () => {
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    const oneTime = mintGrant("github_delete_repo"); // one-time exact

    const first = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(first?.id).toBe(oneTime.id); // exact preferred over "*"
    expect(first?.oneTime).toBe(true);

    // Exact one-time consumed; the standing wildcard now answers (and is NOT consumed).
    const after = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(after?.tool).toBe("*");
    expect(store.listGrants().filter((g) => g.tool === "*")).toHaveLength(1);
  });
});

/**
 * STAB-3 (port-conflict silent hang) note.
 *
 * The fix lives in Gateway.start()'s listener bind: an `'error'` handler is
 * attached to this.httpServer that logs fatal, rejects the startup Promise,
 * and calls process.exit(1) so a supervisor restarts the process instead of
 * it hanging alive-but-not-listening on EADDRINUSE. It is intentionally NOT
 * unit-tested here: exercising it requires binding a real port (and a second
 * conflicting listener), which must not run in CI per the brief, and calls
 * process.exit(1), which would abort the vitest worker. It is verified by code
 * review of the bind block in gateway.ts.
 */
describe.skip("STAB-3 listener error handler (verified by code review, not port-binding in CI)", () => {
  it("attaches an 'error' handler that exits non-zero on EADDRINUSE", () => {
    /* intentionally skipped — see block comment above */
  });
});
