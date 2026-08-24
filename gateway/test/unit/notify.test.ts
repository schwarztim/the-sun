/**
 * Phase 2 park-notification unit suite (notify.ts).
 *
 * All tests inject a spawn stub via __setSpawnImplForTests — NO real OS
 * notification is ever fired from CI. Covers: the per-platform command shape
 * (macOS osascript / Windows PowerShell toast / Linux notify-send), the
 * unsupported-platform no-op, quote sanitization, and the never-throws /
 * fire-and-forget contract (spawn throwing, spawn emitting "error").
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNotifyCommand,
  notifyPark,
  __setSpawnImplForTests,
  type ParkNotification,
  type SpawnLike,
} from "../../src/notify.js";

const SAMPLE: ParkNotification = {
  backend: "github",
  tool: "github_delete_repo",
  safetyClass: "PRODUCTION",
  approveUrl: "http://127.0.0.1:3100/approve",
};

function stubSpawn() {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => undefined, on: () => undefined };
  };
  return { calls, spawn };
}

afterEach(() => __setSpawnImplForTests(undefined));

describe("buildNotifyCommand — per-platform command shape", () => {
  it("darwin → osascript display notification carrying backend.tool + approve URL", () => {
    const cmd = buildNotifyCommand(SAMPLE, "darwin");
    expect(cmd).toBeDefined();
    expect(cmd!.command).toBe("osascript");
    expect(cmd!.args[0]).toBe("-e");
    expect(cmd!.args[1]).toContain("display notification");
    expect(cmd!.args[1]).toContain("github.github_delete_repo");
    expect(cmd!.args[1]).toContain("http://127.0.0.1:3100/approve");
    expect(cmd!.args[1]).toContain("PRODUCTION");
  });

  it("win32 → powershell WinRT toast, non-interactive, carrying the same fields", () => {
    const cmd = buildNotifyCommand(SAMPLE, "win32");
    expect(cmd).toBeDefined();
    expect(cmd!.command).toBe("powershell");
    expect(cmd!.args).toContain("-NoProfile");
    expect(cmd!.args).toContain("-NonInteractive");
    const script = cmd!.args[cmd!.args.length - 1];
    expect(script).toContain("ToastNotificationManager");
    expect(script).toContain("github.github_delete_repo");
    expect(script).toContain("http://127.0.0.1:3100/approve");
  });

  it("linux → notify-send with title + body", () => {
    const cmd = buildNotifyCommand(SAMPLE, "linux");
    expect(cmd).toBeDefined();
    expect(cmd!.command).toBe("notify-send");
    expect(cmd!.args.join(" ")).toContain("github.github_delete_repo");
    expect(cmd!.args.join(" ")).toContain("http://127.0.0.1:3100/approve");
  });

  it("unknown platform → undefined (no notifier)", () => {
    expect(buildNotifyCommand(SAMPLE, "sunos")).toBeUndefined();
    expect(buildNotifyCommand(SAMPLE, "aix")).toBeUndefined();
  });

  it("sanitizes quotes/backslashes/newlines out of every interpolated field", () => {
    const hostile: ParkNotification = {
      backend: `gh"; do shell script "rm -rf ~`,
      tool: "tool'`\\\nname",
      safetyClass: "PRODUCTION",
      approveUrl: 'http://127.0.0.1:1/"approve',
    };
    for (const plat of ["darwin", "win32", "linux"]) {
      const cmd = buildNotifyCommand(hostile, plat)!;
      const flat = cmd.args.join(" ");
      // The only quotes left are the ones the template itself emits — none
      // from the interpolated values.
      expect(flat).not.toContain('do shell script "rm');
      expect(flat).not.toContain("\\");
      expect(flat).not.toContain("\n");
      expect(flat).not.toContain("`");
    }
  });
});

describe("notifyPark — fire-and-forget contract", () => {
  it("spawns detached with ignored stdio and unrefs the child", () => {
    const { calls, spawn } = stubSpawn();
    let unreffed = false;
    __setSpawnImplForTests((c, a, o) => {
      const r = spawn(c, a, o);
      return { unref: () => (unreffed = true), on: r.on };
    });
    notifyPark(SAMPLE, "darwin");
    expect(calls.length).toBe(1);
    expect(calls[0].options).toEqual({ detached: true, stdio: "ignore" });
    expect(unreffed).toBe(true);
  });

  it("attaches an error listener so a missing binary never crashes the process", () => {
    const events: string[] = [];
    __setSpawnImplForTests(() => ({
      unref: () => undefined,
      on: (event: string, cb: (...a: unknown[]) => void) => {
        events.push(event);
        // Simulate the async ENOENT error path — the callback must not throw.
        cb(new Error("spawn osascript ENOENT"));
        return undefined;
      },
    }));
    expect(() => notifyPark(SAMPLE, "darwin")).not.toThrow();
    expect(events).toContain("error");
  });

  it("swallows a synchronously-throwing spawn (never throws, never blocks)", () => {
    __setSpawnImplForTests(() => {
      throw new Error("EPERM");
    });
    expect(() => notifyPark(SAMPLE, "linux")).not.toThrow();
  });

  it("is a silent no-op on an unsupported platform", () => {
    const { calls, spawn } = stubSpawn();
    __setSpawnImplForTests(spawn);
    notifyPark(SAMPLE, "freebsd");
    expect(calls.length).toBe(0);
  });
});
