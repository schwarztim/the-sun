import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Best-effort OS notification for Tier-B parks (Phase 2, SECURITY-ROADMAP
 * §2.3 item 1). When a Tier-B call parks awaiting out-of-band approval, the
 * human learns about it TODAY only if the agent relays the parked response —
 * the real-world annoyance is discovery latency, not the approval itself.
 * This module fires a native OS notification deep-linking the loopback
 * /approve page.
 *
 * Hard requirements (all enforced here, not at the call site):
 *  - NEVER throws, NEVER blocks, NEVER fails dispatch: every error path is
 *    swallowed. A missing osascript/notify-send/powershell binary, a spawn
 *    failure, or an unsupported platform is silently a no-op.
 *  - Detached fire-and-forget spawn: stdio ignored, child unref()ed — the
 *    gateway's event loop never waits on the notifier process.
 *  - Value-free: the notification carries backend.tool + safety class + the
 *    approve URL. Argument values (even redacted ones) never enter an OS
 *    notification pipeline (notification centers persist history to disk).
 *
 * Config gate (`safety.notifications`, default ON) lives in gateway.ts — the
 * caller checks it; this module only knows how to emit.
 */

export interface ParkNotification {
  backend: string;
  tool: string;
  safetyClass: string;
  /** Loopback /approve page URL to surface to the human. */
  approveUrl: string;
}

/** Minimal spawn signature — injectable so tests never fire a real toast. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" }
) => { unref: () => void; on: (event: string, cb: (...a: unknown[]) => void) => unknown };

let spawnImpl: SpawnLike = spawn as unknown as SpawnLike;

/** Test seam: replace (or restore, by passing undefined) the spawn used to fire notifications. */
export function __setSpawnImplForTests(impl?: SpawnLike): void {
  spawnImpl = impl ?? (spawn as unknown as SpawnLike);
}

/** Strip characters that could break out of the quoting context of any of the three platform commands. */
function sanitize(s: string): string {
  return s.replace(/["'`\\\r\n]/g, " ").slice(0, 200);
}

/**
 * Build the platform-native notification command. Exported for unit tests;
 * returns undefined on platforms with no known notifier.
 */
export function buildNotifyCommand(
  n: ParkNotification,
  plat: string
): { command: string; args: string[] } | undefined {
  const title = "thesun gateway";
  const subtitle = `Tier-B approval needed: ${sanitize(n.backend)}.${sanitize(n.tool)}`;
  const body = `${sanitize(n.safetyClass)} call parked — approve at ${sanitize(n.approveUrl)}`;

  if (plat === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `display notification "${body}" with title "${title}" subtitle "${subtitle}"`],
    };
  }
  if (plat === "win32") {
    // Windows toast via the WinRT ToastNotificationManager (no modules to
    // install). Falls back to nothing if the runtime types are unavailable —
    // the powershell process just exits non-zero, which we ignore.
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
      "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
      `$t = $x.GetElementsByTagName('text'); $null = $t.Item(0).AppendChild($x.CreateTextNode('${subtitle}'));`,
      `$null = $t.Item(1).AppendChild($x.CreateTextNode('${body}'));`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${title}').Show([Windows.UI.Notifications.ToastNotification]::new($x));`,
    ].join(" ");
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  if (plat === "linux") {
    return { command: "notify-send", args: [`${title} — ${subtitle}`, body] };
  }
  return undefined;
}

/**
 * Fire the notification. Best-effort: swallows every error, returns
 * immediately, never blocks or fails the caller's dispatch.
 */
export function notifyPark(n: ParkNotification, plat: string = platform()): void {
  try {
    const cmd = buildNotifyCommand(n, plat);
    if (!cmd) return;
    const child = spawnImpl(cmd.command, cmd.args, { detached: true, stdio: "ignore" });
    // Missing binary (ENOENT) etc. surfaces as an async "error" event — a
    // listener must exist or Node raises an uncaught exception.
    child.on("error", () => {
      /* best-effort by design: a failed notification must never surface */
    });
    child.unref();
  } catch {
    /* best-effort by design: notification failure must never affect dispatch */
  }
}
