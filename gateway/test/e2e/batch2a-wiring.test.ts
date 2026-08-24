/**
 * Batch-2A gateway wiring e2e (real gateway, real in-process backend):
 *
 *  CTX-3  operator tool_overrides are ACTIVE — a configured override renames
 *         (and re-describes) the client-facing tool through the real
 *         ToolRegistry construction path; backend dispatch is unaffected.
 *  UX-1   a CLASS-scoped grant created via the loopback /trust endpoint (with
 *         a safetyClass) authorizes matching-class Tier-B dispatches without a
 *         re-park, while a Tier-B call of a DIFFERENT class still parks.
 *  GW-1   GET /metrics returns 200 Prometheus text-format exposition with the
 *         expected counter/gauge names, live counts after real traffic, and no
 *         secret/token material.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootGateway, fakeBackend, mcpClient, callTool, type BootedGateway, type FakeBackend } from "./harness.js";

/** Manifest classifying two harness tools into two DIFFERENT Tier-B classes. */
async function writeTwoClassManifest(dir: string, ns: string): Promise<string> {
  const manifestDir = await mkdtemp(join(dir, "manifests-"));
  await writeFile(
    join(manifestDir, `${ns}.json`),
    JSON.stringify({
      manifest: "isaac-router-manifest/v1",
      backend: ns,
      capabilities: [
        { tool: "fake_delete_item", safety_class: "VAULT_VALUE", tags: ["test"] },
        { tool: "echo_message", safety_class: "HUMAN_OUTBOUND", tags: ["test"] },
      ],
    }),
    "utf-8"
  );
  return manifestDir;
}

async function postTrust(
  gw: BootedGateway,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${gw.adminUrl}/trust`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

// ─── CTX-3: tool_overrides active ────────────────────────────────────────────

describe("CTX-3 tool_overrides wiring (real ToolRegistry path)", () => {
  let backend: FakeBackend;
  let gw: BootedGateway;

  beforeAll(async () => {
    backend = await fakeBackend("fakebe");
    gw = await bootGateway({
      backends: { fakebe: { url: backend.url } },
      toolExposure: "both", // exposes namespaced tools (plus mux); the override applies to the namespaced surface
      gatewayExtra: {
        tool_overrides: {
          fakebe_echo_message: { name: "renamed_echo_tool", description: "OVERRIDDEN_DESC" },
        },
      },
    });
  });

  afterAll(async () => {
    await gw.stop();
    await backend.close();
  });

  it("a configured override renames and re-describes the exposed tool", async () => {
    const client = await mcpClient(gw.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // The override target is exposed; the original namespaced name is gone.
      expect(names).toContain("renamed_echo_tool");
      expect(names).not.toContain("fakebe_echo_message");
      const renamed = tools.find((t) => t.name === "renamed_echo_tool");
      expect(renamed?.description).toBe("OVERRIDDEN_DESC");
    } finally {
      await client.close();
    }
  });
});

// ─── UX-1: class-grant creation endpoint + class-scoped authorization ────────

describe("UX-1 class-grant endpoint authorizes matching-class Tier-B without re-park", () => {
  let dir: string;
  let backend: FakeBackend;
  let gw: BootedGateway;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-e2e-ux1-"));
    backend = await fakeBackend("fakebe");
    const manifestDir = await writeTwoClassManifest(dir, "fakebe");
    gw = await bootGateway({
      backends: { fakebe: { url: backend.url } },
      toolExposure: "both",
      enforce: "blocking",
      safetyExtra: { manifest_dir: manifestDir },
    });
  });

  afterAll(async () => {
    await gw.stop();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("VAULT_VALUE class grant authorizes repeated VAULT_VALUE dispatch; HUMAN_OUTBOUND still parks", async () => {
    const client = await mcpClient(gw.url);
    try {
      // 1) A VAULT_VALUE Tier-B call parks first (no grant yet).
      const parked = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "1" },
      });
      expect(parked.json?.approvalPending).toBe(true);
      expect(parked.json?.safetyClass).toBe("VAULT_VALUE");
      expect(backend.calls.fake_delete_item).toBe(0);

      // 2) Create a CLASS-scoped grant for VAULT_VALUE on this backend.
      const trust = await postTrust(gw, { backend: "fakebe", safetyClass: "VAULT_VALUE" });
      expect(trust.ok).toBe(true);
      expect(trust.body.status).toBe("class_trusted");
      expect(trust.body.grant.safetyClass).toBe("VAULT_VALUE");
      expect(trust.body.grant.tool).toBe("*");
      expect(typeof trust.body.grant.expiresAt).toBe("string"); // class grants are always TTL-capped

      // 3) The VAULT_VALUE call now proceeds WITHOUT re-parking, and does so
      //    repeatedly (a class grant is standing within its TTL, not consumed).
      const first = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "2" },
      });
      expect(first.isError).toBe(false);
      expect(first.text).toContain("deleted 2");
      const second = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "3" },
      });
      expect(second.text).toContain("deleted 3");
      expect(backend.calls.fake_delete_item).toBe(2);

      // 4) A DIFFERENT-class Tier-B tool (HUMAN_OUTBOUND) is NOT covered by the
      //    VAULT_VALUE class grant, so it still parks.
      const otherClass = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_echo_message",
        arguments: { text: "hi" },
      });
      expect(otherClass.json?.approvalPending).toBe(true);
      expect(otherClass.json?.safetyClass).toBe("HUMAN_OUTBOUND");
      expect(backend.calls.echo_message).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("rejects an invalid safetyClass with 400", async () => {
    const bad = await postTrust(gw, { backend: "fakebe", safetyClass: "NOT_A_CLASS" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_safety_class");
  });

  it("rejects a class grant for PRODUCTION with 400 (no standing authority)", async () => {
    // A class grant is standing authority over every current and future tool of
    // the class. PRODUCTION forbids that outright, so the endpoint refuses
    // rather than minting a grant the resolver would then ignore.
    const refused = await postTrust(gw, { backend: "fakebe", safetyClass: "PRODUCTION" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("standing_grant_not_allowed");
    const grants: any = await (await fetch(`${gw.adminUrl}/grants`)).json();
    expect(grants.grants.some((g: any) => g.safetyClass === "PRODUCTION")).toBe(false);
  });
});

// ─── GW-1: /metrics Prometheus endpoint ──────────────────────────────────────

describe("GW-1 GET /metrics (Prometheus text, unauthenticated loopback)", () => {
  let dir: string;
  let backend: FakeBackend;
  let gw: BootedGateway;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-e2e-metrics-"));
    backend = await fakeBackend("fakebe");
    const manifestDir = await writeTwoClassManifest(dir, "fakebe");
    gw = await bootGateway({
      backends: { fakebe: { url: backend.url } },
      toolExposure: "both",
      enforce: "blocking",
      safetyExtra: { manifest_dir: manifestDir },
    });
  });

  afterAll(async () => {
    await gw.stop();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 200 Prometheus text with expected series and live counts, no secrets", async () => {
    const client = await mcpClient(gw.url);
    try {
      // Drive real traffic: one Tier-A UNCLASSIFIED call (store_note has no
      // manifest entry and no verb match) and one Tier-B VAULT_VALUE park.
      await callTool(client, "gateway_call_tool", { tool: "fakebe_store_note", arguments: { text: "n" } });
      await callTool(client, "gateway_call_tool", { tool: "fakebe_fake_delete_item", arguments: { id: "1" } });
    } finally {
      await client.close();
    }

    // Unauthenticated: no admin token, no bearer.
    const res = await fetch(`${gw.adminUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await res.text();

    // Expected counter + gauge series names are all present.
    for (const name of [
      "thesun_gateway_tool_calls_total",
      "thesun_gateway_tier_a_calls_total",
      "thesun_gateway_tier_b_calls_total",
      "thesun_gateway_denies_total",
      "thesun_gateway_approvals_parked_total",
      "thesun_gateway_backends_connected",
      "thesun_gateway_backends_total",
    ]) {
      expect(body).toContain(name);
    }
    // Prometheus TYPE lines present.
    expect(body).toContain("# TYPE thesun_gateway_tool_calls_total counter");
    expect(body).toContain("# TYPE thesun_gateway_backends_total gauge");

    // Live counts reflect the traffic driven above.
    const toolCalls = Number(/thesun_gateway_tool_calls_total (\d+)/.exec(body)?.[1] ?? "0");
    const tierA = Number(/thesun_gateway_tier_a_calls_total (\d+)/.exec(body)?.[1] ?? "0");
    const tierB = Number(/thesun_gateway_tier_b_calls_total (\d+)/.exec(body)?.[1] ?? "0");
    const parked = Number(/thesun_gateway_approvals_parked_total (\d+)/.exec(body)?.[1] ?? "0");
    expect(toolCalls).toBeGreaterThanOrEqual(2);
    expect(tierA).toBeGreaterThanOrEqual(1);
    expect(tierB).toBeGreaterThanOrEqual(1);
    expect(parked).toBeGreaterThanOrEqual(1);
    const connected = Number(/thesun_gateway_backends_connected (\d+)/.exec(body)?.[1] ?? "-1");
    expect(connected).toBe(1);

    // No secret/token material may appear in an unauthenticated endpoint.
    for (const forbidden of ["token", "authorization", "bearer", "secret", "password", "apikey", "api_key"]) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });
});
