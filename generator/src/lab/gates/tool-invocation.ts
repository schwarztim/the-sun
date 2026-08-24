/**
 * Gates 6 (callability) and 7 (precision).
 *
 * Both live-invoke every generated tool against a single shared mock
 * backend (mock-backend.ts), so they share one spawn + one invocation
 * loop rather than duplicating harness plumbing.
 *
 *  - Callability: every tool must return a well-formed JSON-RPC result OR
 *    a well-formed auth-error (never throw/hang/crash the server).
 *  - Precision: cross-references the mock backend's request log for 404s
 *    — a tool that hit a path outside the authoritative op set (from
 *    coverage.json) is mis-mapped or fabricated. Degrades to
 *    skipped-not-failed when no coverage.json exists, since without an
 *    authoritative op set the gate cannot distinguish a fabricated tool
 *    from a legitimate one (see report's residual-unverified-surface).
 *
 * An opt-in live smoke (`THESUN_VERIFY_LIVE=1`, real credentials present)
 * is intentionally NOT implemented here — see runLab's `live` option and
 * the report's `live_acceptance_last_verified` field, which is left null
 * until that path exists. This keeps the credential-free path (what this
 * file verifies) decoupled from live-target acceptance testing.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { launchAndConnect, resolveBaseUrlEnvVar } from "../harness.js";
import { type KnownOp, startMockBackend } from "../mock-backend.js";
import { synthesizeArgs } from "../schema-args.js";
import type { CoverageManifest, GateFinding, LaunchSpec } from "../types.js";

export interface ToolInvocationOutcome {
  tool: string;
  wellFormed: boolean;
  isError: boolean;
  note: string;
}

interface CallToolResultShape {
  content?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export async function runToolInvocationGates(
  serverDir: string,
  spec: LaunchSpec,
  tools: Tool[],
  coverage: CoverageManifest | null,
): Promise<{ callability: GateFinding; precision: GateFinding }> {
  const invokable = tools.filter((t) => !t.name.endsWith("_help"));
  const knownOps: KnownOp[] = coverage
    ? coverage.ops.filter((op) => op.tool).map((op) => ({ method: op.method, path: op.path }))
    : [];
  // No manifest: match everything so callability can still run; precision
  // degrades to skipped (see below) since it can't tell a hallucinated
  // tool from a real one without the authoritative op set.
  const wildcardMode = coverage === null;

  const baseUrlEnvVar = resolveBaseUrlEnvVar(spec, serverDir);
  const backend = await startMockBackend(wildcardMode ? [{ method: "*", path: "*" }] : knownOps);

  const outcomes: ToolInvocationOutcome[] = [];
  let spawned: Awaited<ReturnType<typeof launchAndConnect>> | null = null;
  try {
    spawned = await launchAndConnect(serverDir, spec, {
      [baseUrlEnvVar]: `http://127.0.0.1:${backend.port}`,
    });
    for (const tool of invokable) {
      const args = synthesizeArgs(tool.inputSchema);
      try {
        const result = (await spawned.client.callTool({
          name: tool.name,
          arguments: args,
        })) as CallToolResultShape;
        const hasContent = Array.isArray(result.content);
        const hasToolResult = typeof result.toolResult !== "undefined";
        const isError = Boolean(result.isError);
        outcomes.push({
          tool: tool.name,
          wellFormed: hasContent || hasToolResult,
          isError,
          note: isError
            ? "returned isError:true (acceptable — credential-free/auth-error path)"
            : "returned a well-formed result",
        });
      } catch (error) {
        outcomes.push({
          tool: tool.name,
          wellFormed: false,
          isError: true,
          note: `callTool threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    if (spawned) await spawned.close();
    await backend.close();
  }

  const malformed = outcomes.filter((o) => !o.wellFormed);
  const callability: GateFinding = {
    gate: "callability",
    passed: malformed.length === 0,
    message:
      malformed.length === 0
        ? `all ${outcomes.length} invokable tool(s) returned a well-formed JSON-RPC result or auth-error`
        : `${malformed.length} tool(s) did not return a well-formed response: ${malformed
            .map((m) => m.tool)
            .join(", ")}`,
    detail: outcomes,
  };

  if (wildcardMode) {
    return {
      callability,
      precision: {
        gate: "precision",
        passed: true,
        skipped: true,
        message:
          "no coverage.json manifest — precision gate cannot distinguish fabricated tools from real ones without an authoritative op set",
      },
    };
  }

  const notFound = backend.requestLog.filter((r) => r.status === 404);
  return {
    callability,
    precision: {
      gate: "precision",
      passed: notFound.length === 0,
      message:
        notFound.length === 0
          ? "all invoked tools resolved to a known op — no 404s"
          : `${notFound.length} tool invocation(s) hit an unmapped path (404), suggesting a mis-mapped or fabricated tool: ${notFound
              .slice(0, 5)
              .map((r) => `${r.method} ${r.path}`)
              .join(", ")}${notFound.length > 5 ? ", ..." : ""}`,
      detail: backend.requestLog,
    },
  };
}
