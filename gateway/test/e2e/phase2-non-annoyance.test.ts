/**
 * Phase 2 "non-annoyance kit" e2e suite (SECURITY-ROADMAP §2.3 / Phase 2)
 * against a REAL gateway + REAL in-process backend:
 *
 *  (1) In-memory redacted arg preview (fixes G5): the /approve JSON listing
 *      carries content-guard-redacted ACTUAL values for a parked call, while
 *      approvals.json / grants.json on disk contain ZERO argument values
 *      (the files are read and grepped).
 *  (2) The parked JSON the model sees never mentions `thesun trust` — the
 *      model's suggested remedy stays per-tool.
 *  (3) POST /trust: unknown backend → 404; known backend → backend-wide
 *      standing grant, subsequent Tier-B dispatch proceeds without parking.
 *  (4) Park notification: fires exactly once per NEW park (store dedup =
 *      notification dedup), not on re-dispatch of an already-parked call;
 *      gated off by safety.notifications=false. Spawn is stubbed — no real
 *      OS toast fires in CI (the gateway boots in-process, so the module
 *      seam is shared).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootGateway, fakeBackend, mcpClient, callTool, type FakeBackend, type BootedGateway } from "./harness.js";
import { __setSpawnImplForTests } from "../../src/notify.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Manifest BOTH fake tools as HUMAN_OUTBOUND so the suite has two Tier-B tools.
 * HUMAN_OUTBOUND rather than PRODUCTION because this suite exercises the
 * backend-wide /trust wildcard, and PRODUCTION forbids standing authority
 * outright (approvals.ts NO_STANDING_GRANT_CLASSES); the class is incidental
 * to what is under test here, Tier-B-ness is not.
 */
async function writeProductionManifest(dir: string, ns: string): Promise<string> {
  const manifestDir = await mkdtemp(join(dir, "manifests-"));
  await writeFile(
    join(manifestDir, `${ns}.json`),
    JSON.stringify({
      manifest: "isaac-router-manifest/v1",
      backend: ns,
      capabilities: [
        { tool: "fake_delete_item", safety_class: "HUMAN_OUTBOUND", tags: ["test"] },
        { tool: "echo_message", safety_class: "HUMAN_OUTBOUND", tags: ["test"] },
      ],
    }),
    "utf-8"
  );
  return manifestDir;
}

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

async function bootPhase2(safetyExtra: object = {}): Promise<{
  fake: FakeBackend;
  gw: BootedGateway;
  client: Client;
  stack: ReturnType<typeof cleanupStack>;
}> {
  const stack = cleanupStack();
  const dir = await mkdtemp(join(tmpdir(), "gw-e2e-phase2-"));
  stack.track({ close: () => rm(dir, { recursive: true, force: true }) });
  const fake = stack.track(await fakeBackend("fakebe"));
  const manifestDir = await writeProductionManifest(dir, "fakebe");
  const gw = stack.track(
    await bootGateway({
      backends: { fakebe: { url: fake.url } },
      toolExposure: "both",
      enforce: "blocking",
      safetyExtra: { manifest_dir: manifestDir, ...safetyExtra },
    })
  );
  const client = stack.track(await mcpClient(gw.url));
  return { fake, gw, client, stack };
}

afterEach(() => __setSpawnImplForTests(undefined));

describe("Phase 2 non-annoyance kit (wire-level, real gateway, real backend)", () => {
  it("(1) /approve JSON shows a content-guard-redacted ACTUAL-value preview; disk files stay value-free", async () => {
    const { gw, client, stack } = await bootPhase2();
    try {
      const plainValue = "my-repo-name-e2e-visible";
      const awsKey = ("AKIA" + "IOSFODNN7EXAMPLE"); // content-guard aws-key pattern
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: plainValue, credential: awsKey },
      });
      expect(parked.json.approvalPending).toBe(true);
      const approvalId = parked.json.id as string;

      // The parked response the MODEL sees stays value-free (type tags only).
      expect(parked.text).not.toContain(plainValue);
      expect(parked.text).not.toContain(awsKey);

      // The HUMAN's /approve listing shows redacted actual values.
      const res = await fetch(`${gw.adminUrl}/approve`, { headers: { accept: "application/json" } });
      const body: any = await res.json();
      const entry = body.pending.find((p: any) => p.id === approvalId);
      expect(entry).toBeDefined();
      expect(entry.argsPreview, "preview carries the benign actual value").toContain(plainValue);
      expect(entry.argsPreview, "content-guard strips the secret").not.toContain(awsKey);
      expect(entry.argsPreview).toContain("[REDACTED:aws-key]");
      // The value-free type-tag summary is still there alongside.
      expect(entry.argsSummary).not.toContain(plainValue);

      // The HTML page renders the preview too.
      const htmlRes = await fetch(`${gw.adminUrl}/approve`, { headers: { accept: "text/html" } });
      const html = await htmlRes.text();
      expect(html).toContain(plainValue);
      expect(html).not.toContain(awsKey);

      // Phase 2 acceptance: the PERSISTED files contain zero argument values.
      const approvalsRaw = await readFile(join(gw.approvalsDir, "approvals.json"), "utf-8");
      expect(approvalsRaw).not.toContain(plainValue);
      expect(approvalsRaw).not.toContain(awsKey);
      expect(approvalsRaw).not.toContain("[REDACTED"); // not even the redacted form persists

      // Approve (mints a grant) and grep grants.json the same way.
      const approveRes = await fetch(`${gw.adminUrl}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ id: approvalId, standing: true }),
      });
      expect(approveRes.ok).toBe(true);
      const grantsRaw = await readFile(join(gw.approvalsDir, "grants.json"), "utf-8");
      expect(grantsRaw).not.toContain(plainValue);
      expect(grantsRaw).not.toContain(awsKey);
      expect(grantsRaw).not.toContain("[REDACTED");

      // Preview evicted on approval: the listing no longer carries the id at all.
      const after: any = await (
        await fetch(`${gw.adminUrl}/approve`, { headers: { accept: "application/json" } })
      ).json();
      expect(after.pending.find((p: any) => p.id === approvalId)).toBeUndefined();
    } finally {
      await stack.closeAll();
    }
  });

  it("(2) the parked JSON the model sees never mentions the trust command", async () => {
    const { client, stack } = await bootPhase2();
    try {
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "x" },
        confirmed: true,
      });
      expect(parked.json.approvalPending).toBe(true);
      expect(parked.text.toLowerCase(), "model-visible remedy stays per-tool").not.toContain("trust");
      expect(parked.json.approveWith).toContain("thesun approve");
    } finally {
      await stack.closeAll();
    }
  });

  it("(3) POST /trust: 404 on unknown backend; backend-wide grant lets Tier-B dispatch proceed without parking", async () => {
    const { fake, gw, client, stack } = await bootPhase2();
    try {
      const unknown = await fetch(`${gw.adminUrl}/trust`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ backend: "no-such-backend" }),
      });
      expect(unknown.status).toBe(404);
      const unknownBody: any = await unknown.json();
      expect(unknownBody.error).toBe("unknown_backend");
      expect(unknownBody.knownBackends).toContain("fakebe");

      const trusted = await fetch(`${gw.adminUrl}/trust`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ backend: "fakebe", ttlMinutes: 60 }),
      });
      expect(trusted.ok).toBe(true);
      const trustedBody: any = await trusted.json();
      expect(trustedBody.status).toBe("trusted");
      expect(trustedBody.grant.tool).toBe("*");
      expect(trustedBody.grant.expiresAt).toBeDefined();
      expect(trustedBody.warning).toMatch(/future/i);

      // BOTH Tier-B tools of the backend now dispatch without parking —
      // including one never individually approved.
      for (const [tool, args] of [
        ["fakebe_fake_delete_item", { id: "42" }],
        ["fakebe_echo_message", { text: "hello" }],
      ] as const) {
        const r = await callTool(client, "gateway_call_tool", { tool, arguments: args });
        expect(r.isError, `${tool} should proceed under the trust grant`).toBe(false);
        expect(r.json?.approvalPending).toBeUndefined();
      }
      expect(fake.calls.fake_delete_item).toBe(1);
      expect(fake.calls.echo_message).toBe(1);

      // The wildcard grant is standing: it survives both dispatches.
      const grants: any = await (await fetch(`${gw.adminUrl}/grants`)).json();
      expect(grants.grants.some((g: any) => g.backend === "fakebe" && g.tool === "*")).toBe(true);
    } finally {
      await stack.closeAll();
    }
  });

  it("(4) park notification fires once per NEW park (dedup), not per retry; respects the config gate", async () => {
    const spawns: Array<{ command: string; args: string[] }> = [];
    __setSpawnImplForTests((command, args) => {
      spawns.push({ command, args });
      return { unref: () => undefined, on: () => undefined };
    });

    // notifications ON (the production default) for this boot only.
    const { gw, client, stack } = await bootPhase2({ notifications: true });
    try {
      await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "1" },
      });
      expect(spawns.length, "first park notifies").toBe(1);
      expect(spawns[0].args.join(" ")).toContain("fakebe.fakebe_fake_delete_item");
      expect(spawns[0].args.join(" ")).toContain(`http://127.0.0.1:${gw.port}/approve`);
      // Value-free notification: argument values never enter the OS pipeline.
      expect(spawns[0].args.join(" ")).not.toContain('"1"');

      // Re-dispatch of the SAME parked call: store dedups → no second toast.
      await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "1" },
      });
      expect(spawns.length, "retry of an already-parked call stays silent").toBe(1);

      // A DIFFERENT tool parking is a new park → second toast.
      await callTool(client, "gateway_call_tool", {
        tool: "fakebe_echo_message",
        arguments: { text: "hi" },
      });
      expect(spawns.length).toBe(2);
    } finally {
      await stack.closeAll();
    }

    // Config gate: with notifications OFF (harness default), a park spawns nothing.
    spawns.length = 0;
    const off = await bootPhase2(); // harness sets notifications: false
    try {
      await callTool(off.client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "9" },
      });
      expect(spawns.length, "safety.notifications=false suppresses the toast").toBe(0);
    } finally {
      await off.stack.closeAll();
    }
  });
});
