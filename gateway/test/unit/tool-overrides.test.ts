/**
 * CTX-3: client-facing tool rename + description overrides in ToolRegistry.
 *
 * These tests drive the real registerBackend/resolve path with a directly
 * constructed ToolRegistry (overrides injected via the constructor), so they
 * are hermetic and exercise the exact code the gateway runs. The invariant
 * under test: overrides change ONLY the client-facing surface (exposed name and
 * description); backend routing (originalName + backendName) is preserved so a
 * renamed tool still dispatches to the real backend tool.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolOverride } from "../../src/tool-registry.js";
import type { Logger } from "../../src/logger.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Minimal spyable logger (registry only uses info/debug/warn). */
function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function tool(name: string, description: string): Tool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

/** Build a registry with no global prefix and no classifier, given overrides. */
function newRegistry(
  overrides: Record<string, ToolOverride> = {},
  logger: Logger = fakeLogger()
): ToolRegistry {
  return new ToolRegistry(logger, "", undefined, overrides);
}

describe("tool_overrides — no override leaves the tool unchanged", () => {
  it("exposes the namespaced name and original description untouched", () => {
    const reg = newRegistry();
    reg.registerBackend("az-teams", "az_teams", [tool("send_message", "Send a Teams message.")]);
    const entry = reg.resolve("az_teams_send_message");
    expect(entry).toBeDefined();
    expect(entry!.tool.name).toBe("az_teams_send_message");
    expect(entry!.tool.description).toBe("Send a Teams message.");
    expect(entry!.originalName).toBe("send_message");
    expect(entry!.backendName).toBe("az-teams");
  });
});

describe("tool_overrides — description override", () => {
  it("changes the exposed description but NOT dispatch routing", () => {
    const reg = newRegistry({
      az_teams_send_message: { description: "Post to Teams." },
    });
    reg.registerBackend("az-teams", "az_teams", [
      tool("send_message", "Send a Teams message to a channel or user, with attachments."),
    ]);
    const entry = reg.resolve("az_teams_send_message");
    expect(entry).toBeDefined();
    // Exposed description is the override.
    expect(entry!.tool.description).toBe("Post to Teams.");
    // Exposed name unchanged (description-only override).
    expect(entry!.tool.name).toBe("az_teams_send_message");
    // Routing preserved: real backend tool + backend name intact.
    expect(entry!.originalName).toBe("send_message");
    expect(entry!.backendName).toBe("az-teams");
  });
});

describe("tool_overrides — name override (rename)", () => {
  it("changes the exposed name while routing still resolves to the real tool", () => {
    const reg = newRegistry({
      az_teams_send_message: { name: "teams_send" },
    });
    reg.registerBackend("az-teams", "az_teams", [tool("send_message", "Send a Teams message.")]);

    // The old namespaced name is no longer exposed.
    expect(reg.resolve("az_teams_send_message")).toBeUndefined();

    // The new exposed name resolves, and dispatch metadata points at the real tool.
    const entry = reg.resolve("teams_send");
    expect(entry).toBeDefined();
    expect(entry!.tool.name).toBe("teams_send");
    expect(entry!.namespacedName).toBe("teams_send");
    expect(entry!.originalName).toBe("send_message"); // routing preserved
    expect(entry!.backendName).toBe("az-teams");

    // tools/list surface shows the renamed tool.
    const names = reg.getAllTools().map((t) => t.name);
    expect(names).toContain("teams_send");
    expect(names).not.toContain("az_teams_send_message");
  });

  it("applies both name and description in a single override", () => {
    const reg = newRegistry({
      az_teams_send_message: { name: "teams_send", description: "Post to Teams." },
    });
    reg.registerBackend("az-teams", "az_teams", [tool("send_message", "Send a Teams message.")]);
    const entry = reg.resolve("teams_send");
    expect(entry).toBeDefined();
    expect(entry!.tool.description).toBe("Post to Teams.");
    expect(entry!.originalName).toBe("send_message");
  });
});

describe("tool_overrides — colliding rename is rejected, original kept", () => {
  it("keeps the original name and logs a warning when a rename target already exists", () => {
    const logger = fakeLogger();
    // Rename get_chats -> az_teams_send_message, which is another tool's exposed
    // name registered earlier in the same backend batch.
    const reg = new ToolRegistry(logger, "", undefined, {
      az_teams_get_chats: { name: "az_teams_send_message" },
    });
    reg.registerBackend("az-teams", "az_teams", [
      tool("send_message", "Send a Teams message."),
      tool("get_chats", "List Teams chats."),
    ]);

    // The renamed tool falls back to its original exposed name (never dropped).
    const collided = reg.resolve("az_teams_get_chats");
    expect(collided).toBeDefined();
    expect(collided!.originalName).toBe("get_chats");

    // The pre-existing tool at the collided name is intact (not overwritten).
    const existing = reg.resolve("az_teams_send_message");
    expect(existing).toBeDefined();
    expect(existing!.originalName).toBe("send_message");

    // Both tools survive.
    expect(reg.getAllTools()).toHaveLength(2);

    // A warning was logged for the collision.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/collides/i);
  });
});
