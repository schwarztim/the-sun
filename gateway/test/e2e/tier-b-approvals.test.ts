/**
 * SC-4 Tier-B wire-level suite: proves the out-of-band approval channel end
 * to end against a REAL gateway + REAL in-process backend.
 *
 * "fakebe_fake_delete_item" (harness.ts's write-verb fake tool) is manifested
 * here as PRODUCTION — one of the three always-Tier-B safety classes — so
 * this suite has a Tier-B-classified tool to dispatch against without
 * touching the WRITE-classed acceptance proof in invariants.test.ts.
 *
 * Covers:
 *  (a) confirmed:true on a Tier-B tool does NOT execute it — approvalPending,
 *      zero backend invocations.
 *  (b) POST /approve (one-time, no `standing`) lets exactly the next
 *      re-dispatch proceed.
 *  (c) a pre-existing standing grant lets a Tier-B call proceed without
 *      parking at all, and does not get consumed by use.
 *  (d) a Tier-A WRITE call with confirmed:true still proceeds — unchanged
 *      (full acceptance proof lives in invariants.test.ts; this is a light
 *      redundant check that Tier-B interception did not leak onto Tier-A).
 *  (e) /approve and /grants are reachable as plain loopback HTTP endpoints
 *      but are NOT exposed anywhere in the MCP tool surface — the model has
 *      no tool that can reach them.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootGateway, fakeBackend, mcpClient, callTool, type FakeBackend, type BootedGateway } from "./harness.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function writeProductionManifest(dir: string, ns: string): Promise<string> {
  const manifestDir = await mkdtemp(join(dir, "manifests-"));
  await writeFile(
    join(manifestDir, `${ns}.json`),
    JSON.stringify({
      manifest: "isaac-router-manifest/v1",
      backend: ns,
      capabilities: [
        { tool: "fake_delete_item", safety_class: "PRODUCTION", tags: ["test"] },
        // Standing-capable Tier-B tool. PRODUCTION forbids standing authority
        // (approvals.ts NO_STANDING_GRANT_CLASSES), so the standing-grant case
        // below needs a Tier-B class that still permits it.
        { tool: "echo_message", safety_class: "HUMAN_OUTBOUND", tags: ["test"] },
      ],
    }),
    "utf-8"
  );
  return manifestDir;
}

/** Track resources and close them all (reverse order) in finally — mirrors invariants.test.ts's helper. */
function cleanupStack() {
  const fns: Array<() => Promise<void>> = [];
  return {
    track<T extends { close?: () => Promise<void>; stop?: () => Promise<void> }>(r: T): T {
      fns.push(async () => {
        if (typeof r.stop === "function") await r.stop();
        else if (typeof r.close === "function") await r.close();
      });
      return r;
    },
    async closeAll() {
      for (const fn of fns.reverse()) {
        try {
          await fn();
        } catch {
          /* best-effort teardown */
        }
      }
    },
  };
}

async function bootTierB(): Promise<{
  fake: FakeBackend;
  gw: BootedGateway;
  client: Client;
  stack: ReturnType<typeof cleanupStack>;
}> {
  const stack = cleanupStack();
  const dir = await mkdtemp(join(tmpdir(), "gw-e2e-tierb-"));
  stack.track({ close: () => rm(dir, { recursive: true, force: true }) });
  const fake = stack.track(await fakeBackend("fakebe"));
  const manifestDir = await writeProductionManifest(dir, "fakebe");
  const gw = stack.track(
    await bootGateway({
      backends: { fakebe: { url: fake.url } },
      toolExposure: "both",
      enforce: "blocking",
      safetyExtra: { manifest_dir: manifestDir },
    })
  );
  const client = stack.track(await mcpClient(gw.url));
  return { fake, gw, client, stack };
}

async function postApprove(gw: BootedGateway, id: string, opts: { standing?: boolean } = {}): Promise<any> {
  const res = await fetch(`${gw.adminUrl}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ id, ...opts }),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

describe("SC-4 Tier-B out-of-band approvals (wire-level, real gateway, real backend)", () => {
  it("(a) confirmed:true on a Tier-B tool parks instead of executing — zero backend invocations", async () => {
    const { fake, client, stack } = await bootTierB();
    try {
      const denied = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "1" },
        confirmed: true,
      });
      expect(denied.isError).toBeFalsy();
      expect(denied.json).toBeDefined();
      expect(denied.json.approvalPending).toBe(true);
      expect(denied.json.safetyClass).toBe("PRODUCTION");
      expect(typeof denied.json.id).toBe("string");
      // No argument values leak into the parked record's summary.
      expect(denied.json.summary).not.toContain('"1"');
      expect(fake.calls.fake_delete_item).toBe(0);
    } finally {
      await stack.closeAll();
    }
  });

  it("(b) POST /approve (one-time) lets exactly the next re-dispatch proceed", async () => {
    const { fake, gw, client, stack } = await bootTierB();
    try {
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "2" },
      });
      const id = parked.json.id as string;

      const approved = await postApprove(gw, id);
      expect(approved.ok).toBe(true);
      expect(approved.body.status).toBe("approved");
      expect(approved.body.standing).toBe(false);

      const retried = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "2" },
      });
      expect(retried.isError).toBe(false);
      expect(retried.text).toContain("deleted 2");
      expect(fake.calls.fake_delete_item).toBe(1);

      // One-time: a THIRD dispatch re-parks — the approval was consumed.
      const thirdCall = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "2" },
      });
      expect(thirdCall.json?.approvalPending).toBe(true);
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  // echo_message (HUMAN_OUTBOUND), not fake_delete_item (PRODUCTION): a standing
  // grant is exactly what PRODUCTION forbids, and that refusal has its own case
  // below. The mechanic under test here is standing authority itself.
  it("(c) a standing grant lets the Tier-B call proceed without parking, repeatedly", async () => {
    const { fake, gw, client, stack } = await bootTierB();
    try {
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_echo_message",
        arguments: { text: "3" },
      });
      const id = parked.json.id as string;

      const approved = await postApprove(gw, id, { standing: true });
      expect(approved.body.standing).toBe(true);

      for (const n of [1, 2, 3]) {
        const result = await callTool(client, "gateway_call_tool", {
          tool: "fakebe_echo_message",
          arguments: { text: "3" },
        });
        expect(result.isError, `dispatch ${n} should not error`).toBe(false);
        // echo_message returns a JSON payload of its own, so assert on the park
        // envelope specifically rather than on json being absent entirely.
        expect(result.json?.approvalPending).toBeUndefined();
      }
      expect(fake.calls.echo_message).toBe(3);

      const grantsRes = await fetch(`${gw.adminUrl}/grants`);
      const grantsBody: any = await grantsRes.json();
      expect(grantsBody.grants.some((g: any) => g.backend === "fakebe" && g.tool === "fakebe_echo_message")).toBe(true);
    } finally {
      await stack.closeAll();
    }
  });

  it("(c2) a PRODUCTION tool refuses standing authority: --always is recorded one-time and re-parks", async () => {
    // The measured hole this closes: one --always approval of
    // akamai_go_akamai_raw_request left a PRODUCTION universal executor
    // dispatching with no confirmation demand for eleven days.
    const { fake, gw, client, stack } = await bootTierB();
    try {
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "9" },
      });
      expect(parked.json.approvalPending).toBe(true);

      // The human asks for a standing grant; the store records one-time, and
      // the response says so rather than claiming standing authority it did
      // not create.
      const approved = await postApprove(gw, parked.json.id as string, { standing: true });
      expect(approved.body.standing).toBe(false);
      expect(approved.body.standingDowngraded).toBe(true);
      expect(approved.body.reason).toMatch(/PRODUCTION cannot hold standing authority/);
      const afterApprove: any = await (await fetch(`${gw.adminUrl}/grants`)).json();
      const grant = afterApprove.grants.find(
        (g: any) => g.backend === "fakebe" && g.tool === "fakebe_fake_delete_item"
      );
      expect(grant?.oneTime).toBe(true);

      // It authorizes exactly one dispatch.
      const first = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "9" },
      });
      expect(first.isError).toBe(false);
      expect(first.json).toBeUndefined();
      expect(fake.calls.fake_delete_item).toBe(1);

      // The second re-parks instead of riding standing authority, and the
      // backend is never reached again.
      const second = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "9" },
      });
      expect(second.json?.approvalPending).toBe(true);
      expect(second.json?.safetyClass).toBe("PRODUCTION");
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  it("(d) a Tier-A WRITE call on an UNMANIFESTED backend still self-confirms via confirmed:true (unchanged)", async () => {
    // A second, unmanifested backend: "fake_delete_item" here has no manifest
    // entry, so it classifies WRITE by name-pattern (Tier-A) — not PRODUCTION
    // (Tier-B) like the manifested "fakebe" backend used in tests (a)-(c).
    // The authoritative, exhaustive proof that Tier-A confirmed:true still
    // self-confirms lives in invariants.test.ts
    // ("write-without-confirmed-blocks-mux-path"); this is a light redundant
    // check that this suite's Tier-B interception adds no global side effect.
    const stack = cleanupStack();
    try {
      const fake = stack.track(await fakeBackend("plainbe"));
      const gw = stack.track(
        await bootGateway({
          backends: { plainbe: { url: fake.url } },
          toolExposure: "both",
          enforce: "blocking",
        })
      );
      const client = stack.track(await mcpClient(gw.url));

      const denied = await callTool(client, "gateway_call_tool", {
        tool: "plainbe_fake_delete_item",
        arguments: { id: "9" },
      });
      expect(denied.json.confirmationRequired).toBe(true);
      expect(denied.json.safetyClass).toBe("WRITE");
      expect(fake.calls.fake_delete_item).toBe(0);

      const allowed = await callTool(client, "gateway_call_tool", {
        tool: "plainbe_fake_delete_item",
        arguments: { id: "9" },
        confirmed: true,
      });
      expect(allowed.isError).toBe(false);
      expect(allowed.text).toContain("deleted 9");
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  it("(e) /approve and /grants are loopback HTTP endpoints, not part of the MCP tool surface", async () => {
    const { client, gw, stack } = await bootTierB();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name.toLowerCase());
      for (const forbidden of ["approve", "grant", "grants"]) {
        expect(names.some((n) => n.includes(forbidden))).toBe(false);
      }

      // Reachable as plain HTTP from the loopback admin surface (same gate as /admin/*).
      const approveRes = await fetch(`${gw.adminUrl}/approve`, { headers: { accept: "application/json" } });
      expect(approveRes.ok).toBe(true);
      const grantsRes = await fetch(`${gw.adminUrl}/grants`);
      expect(grantsRes.ok).toBe(true);
    } finally {
      await stack.closeAll();
    }
  });
});
