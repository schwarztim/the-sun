/**
 * E2E content-guard suite: boots the REAL gateway against a REAL in-process
 * MCP backend and proves the content-inspection stage fires on the actual
 * wire path — both directions:
 *
 *  - Egress: a secret-shaped string in a tool RESULT is redacted before it
 *    reaches the client, for an ordinary READ-classified tool (not just
 *    HUMAN_OUTBOUND — the redaction stage applies to every dispatch).
 *  - Outbound args: a Luhn-valid card number in a HUMAN_OUTBOUND tool's
 *    arguments is BLOCKED before the backend is ever invoked — even once a
 *    Tier-B standing grant authorizes the dispatch (a grant authorizes the
 *    write, not exfiltration of payment-card data through the outbound
 *    channel; content-guard is independent of and downstream from
 *    authorization, Tier-A confirmed:true or Tier-B grant alike).
 *  - Benign traffic passes through completely unaffected in both directions.
 *
 * The manifest classifies "echo_message" (one of harness.ts's two fake-backend
 * tools) as HUMAN_OUTBOUND purely so this suite has a HUMAN_OUTBOUND-classified
 * tool to exercise the arg-blocking path against — it does not model a real
 * outbound-message capability.
 *
 * HUMAN_OUTBOUND is a Tier-B safety class (SC-4): a bare confirmed:true no
 * longer reaches the backend for it (see test/e2e/tier-b-approvals.test.ts for
 * that gate's own proof). These two tests exercise content-guard SPECIFICALLY,
 * so each first parks the call, self-approves it as a standing grant via the
 * gateway's loopback /approve endpoint (the same channel `thesun approve`
 * uses), and only then re-dispatches to reach the content-guard stage.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootGateway, fakeBackend, mcpClient, callTool, type BootedGateway } from "./harness.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Well-known, non-real test values:
//  - AKIAIOSFODNN7EXAMPLE is AWS's own documentation placeholder access key.
//  - 4111111111111111 is the universally-used Visa test card number.
const AWS_EXAMPLE_KEY = ("AKIA" + "IOSFODNN7EXAMPLE");
const TEST_VISA = "4111111111111111";

async function writeHumanOutboundManifest(dir: string, ns: string): Promise<string> {
  const manifestDir = await mkdtemp(join(dir, "manifests-"));
  await writeFile(
    join(manifestDir, `${ns}.json`),
    JSON.stringify({
      manifest: "isaac-router-manifest/v1",
      backend: ns,
      capabilities: [
        {
          tool: "echo_message",
          safety_class: "HUMAN_OUTBOUND",
          tags: ["test", "outbound"],
          write_guard: "router_confirmation_maps_to_downstream",
          confirmation_maps_to_downstream: false,
        },
      ],
    }),
    "utf-8"
  );
  return manifestDir;
}

/**
 * Park a Tier-B call once (to obtain a pending-approval id), then approve it
 * as a standing grant via the gateway's loopback /approve endpoint — the same
 * out-of-band channel a human (or `thesun approve --always`) uses. Returns
 * once the grant exists so the caller's next dispatch of the same
 * identity+backend+tool proceeds past the Tier-B gate.
 */
async function parkThenGrantStanding(
  gw: BootedGateway,
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<void> {
  const parked = await callTool(client, toolName, args);
  expect(parked.json?.approvalPending).toBe(true);
  const id: string = parked.json.id;

  const res = await fetch(`${gw.adminUrl}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ id, standing: true }),
  });
  expect(res.ok).toBe(true);
  const body: any = await res.json();
  expect(body.status).toBe("approved");
}

describe("content-guard (wire-level, real gateway, real backend)", () => {
  it("egress: redacts a secret-shaped string in a tool RESULT before it reaches the client", async () => {
    const fake = await fakeBackend("fakebe");
    const gw = await bootGateway({ backends: { fakebe: { url: fake.url } }, toolExposure: "both" });
    try {
      const client = await mcpClient(gw.url);
      try {
        const result = await callTool(client, "fakebe_echo_message", {
          text: `here is the key: ${AWS_EXAMPLE_KEY}`,
        });
        expect(result.isError).toBe(false);
        expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
        expect(result.text).toContain("[REDACTED:aws-key]");
      } finally {
        await client.close();
      }
    } finally {
      await gw.stop();
      await fake.close();
    }
  });

  it("outbound args: blocks a Luhn-valid card number in a HUMAN_OUTBOUND tool's args, even with confirmed:true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-e2e-cg-"));
    try {
      const fake = await fakeBackend("fakebe");
      const manifestDir = await writeHumanOutboundManifest(dir, "fakebe");
      const gw = await bootGateway({
        backends: { fakebe: { url: fake.url } },
        toolExposure: "both",
        enforce: "blocking",
        safetyExtra: { manifest_dir: manifestDir },
      });
      try {
        const client = await mcpClient(gw.url);
        try {
          const callArgs = { text: `charge card ${TEST_VISA} please` };
          // First dispatch parks (HUMAN_OUTBOUND is Tier-B) and is approved as
          // a standing grant out-of-band, so the retry below reaches the
          // content-guard stage rather than the Tier-B gate.
          await parkThenGrantStanding(gw, client, "fakebe_echo_message", callArgs);
          const denied = await callTool(client, "fakebe_echo_message", callArgs);
          expect(denied.isError).toBe(true);
          expect(denied.json).toBeDefined();
          expect(denied.json.error).toBe("content_guard_blocked");
          expect(denied.json.kind).toBe("card-number");
          // The backend must NEVER have been invoked — the block happens at the gateway.
          expect(fake.calls.echo_message).toBe(0);
        } finally {
          await client.close();
        }
      } finally {
        await gw.stop();
        await fake.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("benign traffic passes through unaffected in both directions (non-annoying)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-e2e-cg-benign-"));
    try {
      const fake = await fakeBackend("fakebe");
      const manifestDir = await writeHumanOutboundManifest(dir, "fakebe");
      const gw = await bootGateway({
        backends: { fakebe: { url: fake.url } },
        toolExposure: "both",
        enforce: "blocking",
        safetyExtra: { manifest_dir: manifestDir },
      });
      try {
        const client = await mcpClient(gw.url);
        try {
          const callArgs = { text: "Your order has shipped, thanks for your business!" };
          // Same Tier-B park-then-grant sequence as the card-number test above.
          await parkThenGrantStanding(gw, client, "fakebe_echo_message", callArgs);
          const result = await callTool(client, "fakebe_echo_message", callArgs);
          expect(result.isError).toBe(false);
          expect(result.text).toContain("Your order has shipped, thanks for your business!");
          expect(fake.calls.echo_message).toBe(1);
        } finally {
          await client.close();
        }
      } finally {
        await gw.stop();
        await fake.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
