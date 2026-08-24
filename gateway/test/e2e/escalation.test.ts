/**
 * Phase 1 acceptance: the default-conservative escalation overlay routes
 * genuinely-dangerous generated tools into the Tier-B out-of-band-approval
 * machinery — proven end to end against a REAL gateway + REAL backend, and
 * against the worst reachable client state (a model that sets confirmed:true,
 * i.e. Copilot CLI --allow-all-tools with no client hooks).
 *
 * Closes gap G1: the generator emits only READ|WRITE, so without this overlay a
 * generated *_delete_* tool sits in Tier-A where confirmed:true self-executes.
 * With the overlay it parks, un-bypassably, until a human runs `thesun approve`.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootGateway, fakeBackend, mcpClient, callTool } from "./harness.js";

const ESCALATION_ON = {
  enabled: true,
  delete_method_to_tier_b: true,
  destructive_verbs: [
    "delete", "remove", "purge", "destroy", "drop", "terminate", "kill",
    "revoke", "wipe", "erase", "shutdown", "deprovision", "force",
  ],
  outbound_verbs: ["send", "reply", "email", "notify", "broadcast", "publish", "comment", "message"],
  production_backends: [],
  exempt: [] as string[],
};

/** Write a one-backend manifest into a fresh temp dir; return the dir. */
async function writeManifest(
  backend: string,
  capabilities: Array<Record<string, unknown>>
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "esc-manifests-"));
  await writeFile(
    join(dir, `${backend}.json`),
    JSON.stringify({ manifest: "isaac-router-manifest/v1", backend, capabilities }),
    "utf-8"
  );
  return dir;
}

async function readDecisionLog(path: string): Promise<any[]> {
  const raw = await readFile(path, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** A known decision-log path so the test can read the audit trail back. */
async function logPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "esc-log-"));
  return join(dir, "decisions.jsonl");
}

describe("Phase 1 — escalation overlay routes dangerous tools to Tier-B (real gateway)", () => {
  it("R1 delete-method: a generated WRITE+DELETE tool parks on confirmed:true; audit shows policy:delete-method + agentConfirmedIgnored", async () => {
    const fake = await fakeBackend("svc");
    const manifestDir = await writeManifest("svc", [
      { tool: "fake_delete_item", safety_class: "WRITE", http_method: "DELETE", tags: [] },
    ]);
    const decisions = await logPath();
    const gw = await bootGateway({
      backends: { svc: { url: fake.url } },
      enforce: "blocking",
      safetyExtra: {
        manifest_dir: manifestDir,
        escalation: ESCALATION_ON,
        decision_log: { enabled: true, path: decisions },
      },
    });
    const client = await mcpClient(gw.url);
    try {
      // Worst reachable client: sets confirmed:true (Copilot --allow-all-tools).
      const res = await callTool(client, "gateway_call_tool", {
        tool: "svc_fake_delete_item",
        arguments: { id: "42" },
        confirmed: true,
      });
      expect(res.json?.approvalPending).toBe(true);
      expect(res.json?.safetyClass).toBe("WRITE"); // class unchanged; the writeGuard is the Tier-B lever
      expect(fake.calls.fake_delete_item).toBe(0); // un-bypassable: confirmed:true did NOT execute

      const log = await readDecisionLog(decisions);
      const entry = log.find((e) => e.tool === "svc_fake_delete_item");
      expect(entry).toBeDefined();
      expect(entry.writeGuard).toBe("policy:delete-method");
      expect(entry.tierB).toBe(true);
      expect(entry.decision).toBe("parked");
      expect(entry.agentConfirmedIgnored).toBe(true);
    } finally {
      // Close the MCP client BEFORE stopping the gateway. Leaving it open leaks
      // the client's long-lived GET /mcp SSE stream and its reconnection timer;
      // under the singleFork e2e pool those dangling handles accumulate across
      // tests and, under load, starve the shared event loop enough to time out
      // an in-flight callTool. Every other e2e suite (content-guard, invariants,
      // tier-b) closes its client for exactly this reason — this suite was the
      // only one that did not.
      await client.close();
      await gw.stop();
      await fake.close();
    }
  });

  it("R2 destructive-verb: an UNMANIFESTED *_delete_* tool parks; audit shows policy:destructive-verb", async () => {
    const fake = await fakeBackend("svc");
    const decisions = await logPath();
    const gw = await bootGateway({
      backends: { svc: { url: fake.url } },
      enforce: "blocking",
      safetyExtra: { escalation: ESCALATION_ON, decision_log: { enabled: true, path: decisions } },
    });
    const client = await mcpClient(gw.url);
    try {
      const res = await callTool(client, "gateway_call_tool", {
        tool: "svc_fake_delete_item",
        arguments: { id: "7" },
        confirmed: true,
      });
      expect(res.json?.approvalPending).toBe(true);
      expect(fake.calls.fake_delete_item).toBe(0);

      const log = await readDecisionLog(decisions);
      const entry = log.find((e) => e.tool === "svc_fake_delete_item");
      expect(entry?.writeGuard).toBe("policy:destructive-verb");
      expect(entry?.agentConfirmedIgnored).toBe(true);
    } finally {
      // Close the MCP client BEFORE stopping the gateway. Leaving it open leaks
      // the client's long-lived GET /mcp SSE stream and its reconnection timer;
      // under the singleFork e2e pool those dangling handles accumulate across
      // tests and, under load, starve the shared event loop enough to time out
      // an in-flight callTool. Every other e2e suite (content-guard, invariants,
      // tier-b) closes its client for exactly this reason — this suite was the
      // only one that did not.
      await client.close();
      await gw.stop();
      await fake.close();
    }
  });

  it("benign write still flows: a WRITE+POST tool with confirmed:true reaches the backend (non-annoying 80%)", async () => {
    const fake = await fakeBackend("svc");
    // store_note: a WRITE+POST tool whose name matches NO destructive or
    // outbound verb, so the overlay leaves it Tier-A and confirmed:true flows.
    const manifestDir = await writeManifest("svc", [
      { tool: "store_note", safety_class: "WRITE", http_method: "POST", tags: [] },
    ]);
    const gw = await bootGateway({
      backends: { svc: { url: fake.url } },
      enforce: "blocking",
      safetyExtra: { manifest_dir: manifestDir, escalation: ESCALATION_ON },
    });
    const client = await mcpClient(gw.url);
    try {
      const res = await callTool(client, "gateway_call_tool", {
        tool: "svc_store_note",
        arguments: { text: "hello" },
        confirmed: true,
      });
      expect(res.isError).toBe(false);
      expect(res.text).toContain("hello");
      expect(fake.calls.store_note).toBe(1); // benign write executed
    } finally {
      // Close the MCP client BEFORE stopping the gateway. Leaving it open leaks
      // the client's long-lived GET /mcp SSE stream and its reconnection timer;
      // under the singleFork e2e pool those dangling handles accumulate across
      // tests and, under load, starve the shared event loop enough to time out
      // an in-flight callTool. Every other e2e suite (content-guard, invariants,
      // tier-b) closes its client for exactly this reason — this suite was the
      // only one that did not.
      await client.close();
      await gw.stop();
      await fake.close();
    }
  });

  it("exempt knob: a listed tool stays Tier-A (confirmationRequired, not a Tier-B park)", async () => {
    const fake = await fakeBackend("svc");
    const gw = await bootGateway({
      backends: { svc: { url: fake.url } },
      enforce: "blocking",
      safetyExtra: {
        escalation: { ...ESCALATION_ON, exempt: ["svc.fake_delete_item"] },
      },
    });
    const client = await mcpClient(gw.url);
    try {
      // No confirmed → a Tier-A tool returns confirmationRequired; a Tier-B tool
      // would return approvalPending. Exemption keeps it Tier-A.
      const res = await callTool(client, "gateway_call_tool", {
        tool: "svc_fake_delete_item",
        arguments: { id: "1" },
      });
      expect(res.json?.confirmationRequired).toBe(true);
      expect(res.json?.approvalPending).toBeUndefined();
      expect(res.json?.safetyClass).toBe("WRITE");
    } finally {
      // Close the MCP client BEFORE stopping the gateway. Leaving it open leaks
      // the client's long-lived GET /mcp SSE stream and its reconnection timer;
      // under the singleFork e2e pool those dangling handles accumulate across
      // tests and, under load, starve the shared event loop enough to time out
      // an in-flight callTool. Every other e2e suite (content-guard, invariants,
      // tier-b) closes its client for exactly this reason — this suite was the
      // only one that did not.
      await client.close();
      await gw.stop();
      await fake.close();
    }
  });
});
