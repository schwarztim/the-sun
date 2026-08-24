/**
 * Phase 3 (SECURITY-ROADMAP §2.2): capability-gated Tier-B elicitation, wire-
 * level against a REAL gateway + REAL in-process backend.
 *
 * The park record remains the source of truth in every test: the gateway
 * creates the PendingApproval FIRST, then (opt-in, capability-gated) sends an
 * `elicitation/create` dialog to the client. Only an explicit human-side
 * accept with approve=true lets the SAME in-flight call proceed — every other
 * outcome returns the parked response verbatim.
 *
 * Covers:
 *  (a) accept path — Tier-B call returns backend SUCCESS inline (no retry),
 *      backend called exactly once, grant recorded, decision log shows the
 *      elicitation approval; dialog message is value-free.
 *  (b) decline path — parked response, backend not called.
 *  (c) timeout path — parked response (short elicitation_timeout_ms override).
 *  (d) capability-absent AND config-off — parking behavior identical to the
 *      pre-Phase-3 contract (regression), elicitation handler never invoked.
 *  (e) blocklisted clientInfo.name — parked, handler never invoked.
 *
 * These sessions run the gateway's STATEFUL streamable-http path
 * (streamable_http_stateless: false) — elicitation requires the server→client
 * request to reach the same live session; the stateless per-request server
 * never sees an initialize and structurally degrades to the park.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  bootGateway,
  fakeBackend,
  mcpClient,
  callTool,
  type BootedGateway,
  type BootGatewayOpts,
  type FakeBackend,
} from "./harness.js";

const ELICIT_CLIENT_NAME = "gw-e2e-elicit-client";

async function writeProductionManifest(dir: string, ns: string): Promise<string> {
  const manifestDir = await mkdtemp(join(dir, "manifests-"));
  await writeFile(
    join(manifestDir, `${ns}.json`),
    JSON.stringify({
      manifest: "isaac-router-manifest/v1",
      backend: ns,
      capabilities: [{ tool: "fake_delete_item", safety_class: "PRODUCTION", tags: ["test"] }],
    }),
    "utf-8"
  );
  return manifestDir;
}

/** Mirrors tier-b-approvals.test.ts's reverse-order cleanup helper. */
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

interface ElicitCapture {
  /** Every elicitation/create request the client received. */
  requests: any[];
}

/**
 * SDK client that DECLARES the `elicitation` capability and answers dialogs
 * with the supplied handler — the fake stand-in for VS Code Copilot / Codex.
 */
async function elicitCapableClient(
  url: string,
  handler: (req: any) => Promise<ElicitResult> | ElicitResult
): Promise<{ client: Client; capture: ElicitCapture }> {
  const capture: ElicitCapture = { requests: [] };
  const client = new Client(
    { name: ELICIT_CLIENT_NAME, version: "0.0.1" },
    { capabilities: { elicitation: {} } }
  );
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    capture.requests.push(req);
    return handler(req);
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return { client, capture };
}

async function bootElicitGateway(overrides: {
  approvalsExtra?: object;
  gatewayExtra?: object;
} = {}): Promise<{ fake: FakeBackend; gw: BootedGateway; stack: ReturnType<typeof cleanupStack> }> {
  const stack = cleanupStack();
  const dir = await mkdtemp(join(tmpdir(), "gw-e2e-elicit-"));
  stack.track({ close: () => rm(dir, { recursive: true, force: true }) });
  const fake = stack.track(await fakeBackend("fakebe"));
  const manifestDir = await writeProductionManifest(dir, "fakebe");
  const bootOpts: BootGatewayOpts = {
    backends: { fakebe: { url: fake.url } },
    toolExposure: "both",
    enforce: "blocking",
    safetyExtra: { manifest_dir: manifestDir },
    // Stateful session + streamed (non-JSON) responses: the transport shape
    // real elicitation-capable editors use, and the only one where a
    // server→client request can reach the session mid-call.
    gatewayExtra: {
      streamable_http_stateless: false,
      streamable_http_json_response: false,
      ...(overrides.gatewayExtra ?? {}),
    },
    approvalsExtra: { elicitation: "on", elicitation_timeout_ms: 2_000, ...(overrides.approvalsExtra ?? {}) },
  };
  const gw = stack.track(await bootGateway(bootOpts));
  return { fake, gw, stack };
}

function expectParked(result: { json: any }, backendCalls: number, fake: FakeBackend): void {
  expect(result.json).toBeDefined();
  expect(result.json.approvalPending).toBe(true);
  expect(result.json.safetyClass).toBe("PRODUCTION");
  expect(typeof result.json.id).toBe("string");
  expect(typeof result.json.approveWith).toBe("string");
  expect(fake.calls.fake_delete_item).toBe(backendCalls);
}

describe("Phase 3: capability-gated Tier-B elicitation (wire-level)", () => {
  it("(a) accept path: the SAME in-flight call proceeds inline, grant recorded, approval audited, dialog value-free", async () => {
    const { fake, gw, stack } = await bootElicitGateway();
    try {
      const { client, capture } = await elicitCapableClient(gw.url, () => ({
        action: "accept",
        content: { approve: true, standing: true },
      }));
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "elicit-42" },
      });

      // The ONE call returned the backend result inline — no park, no retry.
      expect(result.isError).toBe(false);
      expect(result.text).toContain("deleted elicit-42");
      expect(fake.calls.fake_delete_item).toBe(1);

      // Exactly one dialog was shown, and it never carried raw argument values.
      expect(capture.requests.length).toBe(1);
      const message: string = capture.requests[0].params.message;
      expect(message).not.toContain("elicit-42");
      expect(message).toContain("PRODUCTION");
      const schema = capture.requests[0].params.requestedSchema;
      expect(Object.keys(schema.properties).sort()).toEqual(["approve", "standing"]);

      // The human accepted with standing:true, but fake_delete_item is
      // PRODUCTION, which forbids standing authority (approvals.ts
      // NO_STANDING_GRANT_CLASSES): the approval is recorded one-time and
      // consumed by this very dispatch, so no grant is left behind to
      // authorize a second call. The in-flight call still proceeded inline,
      // which is what this case is about.
      const grantsBody: any = await (await fetch(`${gw.adminUrl}/grants`)).json();
      expect(
        grantsBody.grants.some((g: any) => g.backend === "fakebe" && g.tool === "fakebe_fake_delete_item")
      ).toBe(false);

      // Decision log shows BOTH the park and the elicitation approval.
      const logLines = (await readFile(gw.decisionLogPath, "utf-8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((l) => l.tool === "fakebe_fake_delete_item");
      expect(logLines.some((l) => l.decision === "parked" && l.tierB === true)).toBe(true);
      expect(
        logLines.some((l) => l.decision === "proceed" && l.tierB === true && l.elicitation === true && l.standing === true)
      ).toBe(true);
    } finally {
      await stack.closeAll();
    }
  });

  it("(a2) accept with standing:false consumes the grant after this one dispatch — next call re-parks", async () => {
    const { fake, gw, stack } = await bootElicitGateway();
    try {
      let respond = true;
      const { client } = await elicitCapableClient(gw.url, () => {
        if (respond) {
          respond = false;
          return { action: "accept" as const, content: { approve: true, standing: false } };
        }
        return { action: "decline" as const };
      });
      stack.track(client);

      const first = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "once" },
      });
      expect(first.isError).toBe(false);
      expect(first.text).toContain("deleted once");
      expect(fake.calls.fake_delete_item).toBe(1);

      // One-time grant consumed by the inline continue — second call parks again.
      const second = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "once" },
      });
      expectParked(second, 1, fake);

      const grantsBody: any = await (await fetch(`${gw.adminUrl}/grants`)).json();
      expect(grantsBody.grants.length).toBe(0);
    } finally {
      await stack.closeAll();
    }
  });

  it("(b) decline path: parked response, backend not called", async () => {
    const { fake, gw, stack } = await bootElicitGateway();
    try {
      const { client, capture } = await elicitCapableClient(gw.url, () => ({ action: "decline" }));
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "no" },
      });
      expectParked(result, 0, fake);
      expect(capture.requests.length).toBe(1); // dialog WAS shown, human said no
    } finally {
      await stack.closeAll();
    }
  });

  it("(b2) accept with approve:false: parked response, backend not called", async () => {
    const { fake, gw, stack } = await bootElicitGateway();
    try {
      const { client } = await elicitCapableClient(gw.url, () => ({
        action: "accept",
        content: { approve: false },
      }));
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "no2" },
      });
      expectParked(result, 0, fake);
    } finally {
      await stack.closeAll();
    }
  });

  it("(c) timeout path: no human answer within elicitation_timeout_ms → parked response", async () => {
    const { fake, gw, stack } = await bootElicitGateway({
      approvalsExtra: { elicitation: "on", elicitation_timeout_ms: 500 },
    });
    try {
      const { client } = await elicitCapableClient(gw.url, async () => {
        // Human never answers within the window.
        await new Promise((r) => setTimeout(r, 2_000));
        return { action: "accept" as const, content: { approve: true } };
      });
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "slow" },
      });
      expectParked(result, 0, fake);

      // The park is the source of truth — the record survives the timed-out dialog.
      const approveList: any = await (
        await fetch(`${gw.adminUrl}/approve`, { headers: { accept: "application/json" } })
      ).json();
      expect(JSON.stringify(approveList)).toContain(result.json.id);
    } finally {
      await stack.closeAll();
    }
  }, 15_000);

  it("(d) capability-absent client parks with the pre-Phase-3 contract (regression)", async () => {
    const { fake, gw, stack } = await bootElicitGateway(); // elicitation: "on"
    try {
      // Plain harness client — declares NO elicitation capability.
      const client = stack.track(await mcpClient(gw.url));
      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "plain" },
        confirmed: true, // still ignored on Tier-B
      });
      expectParked(result, 0, fake);
      // Full pre-Phase-3 parked envelope, key for key.
      expect(Object.keys(result.json).sort()).toEqual(
        [
          "approvalPending",
          "approveUrl",
          "approveWith",
          "backend",
          "expiresAt",
          "id",
          "note",
          "reason",
          "safetyClass",
          "summary",
          "tool",
        ].sort()
      );
      expect(result.json.summary).not.toContain('"plain"');
    } finally {
      await stack.closeAll();
    }
  });

  it("(d2) config off (default): elicitation-capable client still parks, dialog never sent", async () => {
    const { fake, gw, stack } = await bootElicitGateway({
      approvalsExtra: { elicitation: "off" },
    });
    try {
      const { client, capture } = await elicitCapableClient(gw.url, () => ({
        action: "accept",
        content: { approve: true },
      }));
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "off" },
      });
      expectParked(result, 0, fake);
      expect(capture.requests.length).toBe(0); // never elicited
    } finally {
      await stack.closeAll();
    }
  });

  it("(e) blocklisted clientInfo.name parks, dialog never sent", async () => {
    const { fake, gw, stack } = await bootElicitGateway({
      approvalsExtra: {
        elicitation: "on",
        elicitation_blocklist: [ELICIT_CLIENT_NAME],
      },
    });
    try {
      const { client, capture } = await elicitCapableClient(gw.url, () => ({
        action: "accept",
        content: { approve: true },
      }));
      stack.track(client);

      const result = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "blocked" },
      });
      expectParked(result, 0, fake);
      expect(capture.requests.length).toBe(0);
    } finally {
      await stack.closeAll();
    }
  });
});
