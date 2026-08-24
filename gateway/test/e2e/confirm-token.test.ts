/**
 * E2E: Phase-4 Tier-A confirm token (audit nonce) through the REAL gateway.
 *
 * AUDIT INTEGRITY ONLY (roadmap §2.4) — these tests prove that with
 * safety.confirm_token on:
 *   - the challenge carries a confirmToken bound to the challenged args,
 *   - the challenge→confirm round-trip executes (token echoed, args unchanged),
 *   - blind first-call self-confirm no longer executes (re-challenged),
 *   - confirm-then-swap no longer executes (token for args A + call with
 *     args B → re-challenged),
 * and that the backend records ZERO invocations for every re-challenged call.
 *
 * The harness boots pre-nonce semantics (confirm_token: false) for the rest
 * of the suite; this file opts back into the shipped default via safetyExtra.
 */
import { describe, it, expect } from "vitest";
import {
  bootGateway,
  fakeBackend,
  mcpClient,
  callTool,
  type FakeBackend,
  type BootedGateway,
} from "./harness.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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

async function bootWithToken(): Promise<{
  fake: FakeBackend;
  gw: BootedGateway;
  client: Client;
  stack: ReturnType<typeof cleanupStack>;
}> {
  const stack = cleanupStack();
  const fake = stack.track(await fakeBackend("fakebe"));
  const gw = stack.track(
    await bootGateway({
      backends: { fakebe: { url: fake.url } },
      toolExposure: "both",
      enforce: "blocking",
      safetyExtra: { confirm_token: true },
    })
  );
  const client = stack.track(await mcpClient(gw.url));
  return { fake, gw, client, stack };
}

describe("tier-a confirm token (audit nonce) — real gateway round-trips", () => {
  it("challenge→confirm round-trip: block response carries confirmToken; echoing it with unchanged args executes", async () => {
    const { fake, client, stack } = await bootWithToken();
    try {
      // 1. Unconfirmed WRITE → challenge with a confirmToken.
      const challenged = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "42" },
      });
      expect(challenged.json?.confirmationRequired).toBe(true);
      expect(typeof challenged.json?.confirmToken).toBe("string");
      expect(challenged.json.confirmToken).toMatch(/^v1\.\d+\./);
      expect(fake.calls.fake_delete_item).toBe(0);

      // 2. Confirmed re-call with the token and UNCHANGED args → executes.
      const allowed = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "42" },
        confirmed: true,
        confirmToken: challenged.json.confirmToken,
      });
      expect(allowed.isError).toBe(false);
      expect(allowed.text).toContain("deleted 42");
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  it("blind first-call self-confirm is re-challenged: confirmed:true with no token does NOT execute", async () => {
    const { fake, client, stack } = await bootWithToken();
    try {
      const blind = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "7" },
        confirmed: true,
      });
      // Treated as unconfirmed → fresh challenge (with a token), zero backend hits.
      expect(blind.json?.confirmationRequired).toBe(true);
      expect(typeof blind.json?.confirmToken).toBe("string");
      expect(fake.calls.fake_delete_item).toBe(0);
    } finally {
      await stack.closeAll();
    }
  });

  it("confirm-then-swap is re-challenged: token issued for args A + confirmed call with args B does NOT execute", async () => {
    const { fake, client, stack } = await bootWithToken();
    try {
      const challenged = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "benign" },
      });
      const tokenForA = challenged.json.confirmToken;
      expect(typeof tokenForA).toBe("string");

      const swapped = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "malicious" },
        confirmed: true,
        confirmToken: tokenForA,
      });
      expect(swapped.json?.confirmationRequired).toBe(true);
      expect(fake.calls.fake_delete_item).toBe(0);

      // The re-challenge token covers the NEW args — completing the honest
      // round-trip for args B now executes args B.
      const honest = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "malicious" },
        confirmed: true,
        confirmToken: swapped.json.confirmToken,
      });
      expect(honest.isError).toBe(false);
      expect(honest.text).toContain("deleted malicious");
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  it("direct namespaced path: same challenge→confirm semantics, token stripped before the backend sees args", async () => {
    const { fake, client, stack } = await bootWithToken();
    try {
      const challenged = await callTool(client, "fakebe_fake_delete_item", { id: "d1" });
      expect(challenged.json?.confirmationRequired).toBe(true);
      const token = challenged.json.confirmToken;
      expect(typeof token).toBe("string");
      expect(fake.calls.fake_delete_item).toBe(0);

      const allowed = await callTool(client, "fakebe_fake_delete_item", {
        id: "d1",
        confirmed: true,
        confirmToken: token,
      });
      expect(allowed.isError).toBe(false);
      // Backend echoed only the semantic args — control keys were stripped.
      expect(allowed.text).toContain("deleted d1");
      expect(fake.calls.fake_delete_item).toBe(1);
    } finally {
      await stack.closeAll();
    }
  });

  it("tampered token is re-challenged, not executed", async () => {
    const { fake, client, stack } = await bootWithToken();
    try {
      const challenged = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "t1" },
      });
      const token: string = challenged.json.confirmToken;
      const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");

      const denied = await callTool(client, "gateway_call_tool", {
        tool: "fakebe_fake_delete_item",
        arguments: { id: "t1" },
        confirmed: true,
        confirmToken: tampered,
      });
      expect(denied.json?.confirmationRequired).toBe(true);
      expect(fake.calls.fake_delete_item).toBe(0);
    } finally {
      await stack.closeAll();
    }
  });
});
