# Managed-hooks hardening (enterprise installs)

> Phase 4 guidance (SECURITY-ROADMAP.md §Phase 4, item 4), layered on the Phase 1b
> client-hook artifacts (`thesun hooks install`).

## The problem this solves

The thesun client hook (Phase 1b) is the first line of defense: it fires inside each
client before a Tier-A `confirmed:true` call ever leaves the machine, restoring a
human `ask` at exactly the step full-auto mode removed. But the hook configuration
lives in **user-writable files** (Claude `settings.json` hook entries,
`~/.copilot/hooks/thesun.json`, `~/.codex/hooks.json`, the VS Code hooks file, the
OpenCode plugins directory). A fully autonomous agent with filesystem access — the
very thing the hook gates — can simply edit or delete those files and then proceed
un-hooked.

On personal installs that is an accepted, documented caveat: the gateway floor
(Tier-A challenge + Tier-B out-of-band approval) remains the guarantee regardless
of hook presence. On **enterprise installs**, two clients offer a managed mode that
closes the removal hole. Enable it wherever you deploy thesun hooks fleet-wide.

## Client-by-client

### Claude Code — `allowManagedHooksOnly`

Claude Code supports **managed settings** deployed by an administrator to a path the
end user (and therefore any agent running as the end user) is not expected to
control — e.g. `/Library/Application Support/ClaudeCode/managed-settings.json` on
macOS, `/etc/claude-code/managed-settings.json` on Linux. Managed settings take
precedence over user, project, and local settings.

Two-step hardening:

1. **Move the thesun hook entry into the managed settings file** (the same
   `hooks.PreToolUse` entry `thesun hooks install --client claude` writes into user
   settings, relocated to the managed file by your MDM/config-management tooling).
2. **Set `allowManagedHooksOnly: true` in the managed settings file.** With this
   flag on, Claude Code **ignores hooks from user, project, and local settings
   entirely** — only managed-file hooks run.

How this prevents agent removal: the agent can still write to `~/.claude/settings.json`
or `.claude/settings.local.json`, but nothing it writes there (including deleting the
thesun entry it finds) changes which hooks execute — the hook set is pinned by a
root/MDM-owned file. Removing the managed file itself requires privileges the agent
process does not have. Deploy the managed file with OS permissions that the
interactive user cannot write (root-owned, `0644`).

### Codex CLI — `allow_managed_hooks_only` (requirements.toml)

Codex CLI (≥ v0.141 — earlier versions have the MCP hook-enforcement bug, #4152)
supports admin-deployed **requirements** via `requirements.toml`, placed in a
system-managed location outside the user profile. Mirror of the Claude mechanism:

1. **Ship the thesun hook definition in the managed hooks location** your fleet
   tooling controls (rather than the user-writable `~/.codex/hooks.json`).
2. **Set `allow_managed_hooks_only = true` in `requirements.toml`.** Codex then
   refuses to load hooks from user-writable configuration — `~/.codex/hooks.json`
   and `[hooks]` blocks in the user's `config.toml` are ignored.

How this prevents agent removal: identical structure to Claude — the agent can edit
every file it can reach, but the hook roster is resolved exclusively from the
admin-controlled requirements, so deleting the user-level hook entry is a no-op and
adding a permissive replacement is equally a no-op.

### Copilot CLI / VS Code Copilot — no managed equivalent

Copilot's hooks configuration (`~/.copilot/hooks/`, repo-level `.github/hooks/`, and
the VS Code Preview hooks file) is **user-writable with no verified
managed-only enforcement mode** at the time of writing. An autonomous agent running
with the user's filesystem access can remove or neuter the thesun hook.

Mitigations available today (none equivalent to a managed mode):

- File-permission hardening (root-owned hook files) is fragile — the *directory*
  generally remains user-writable, and client behavior when the hook file is
  unreadable is not contractually fail-closed across versions.
- `thesun hooks status` reports installation and version drift per client; run it
  from CI or endpoint management to **detect** removal after the fact.
- Rely on the gateway floor: Tier-B calls still park for out-of-band human approval
  and Tier-A calls still log a truthful challenge/confirm audit pair
  (`safety.confirm_token`) regardless of hook presence.

### OpenCode — no managed equivalent

OpenCode's plugin directory is user-writable and there is no managed/locked plugin
mode. Same posture as Copilot: detection via `thesun hooks status`, and the gateway
floor as the guarantee. (Also note the pre-existing caveat that OpenCode `task`-tool
subagent calls bypass plugins entirely — issue #5894 — which managed enforcement
would not fix even if it existed.)

## Summary table

| Client | Managed setting | User-writable hook config ignored? | Agent can remove hook? |
|---|---|---|---|
| Claude Code | `allowManagedHooksOnly: true` (managed-settings.json) | Yes — only managed hooks run | No (requires admin/root) |
| Codex CLI ≥ v0.141 | `allow_managed_hooks_only = true` (requirements.toml) | Yes — user hooks.json ignored | No (requires admin/root) |
| Copilot CLI / VS Code | — none verified | n/a | **Yes** — detect via `thesun hooks status` |
| OpenCode | — none | n/a | **Yes** — detect via `thesun hooks status` |

## Honest scope statement

Managed hooks harden the **first line of defense** against removal by the agent it
gates. They do not change the trust model's foundation: the client hook layer —
managed or not — is defense-in-depth in front of the gateway PEP. The guarantees
(Tier-B out-of-band approval, fail-closed audit, value-free persistence, and the
Tier-A challenge/confirm audit integrity provided by `safety.confirm_token`) are
enforced at the gateway and hold on machines where no hook was ever installed. Do
not describe a managed hook — or the Tier-A confirm token — as a control that stops
a fully autonomous agent from executing Tier-A writes; Tier-B classification is the
mechanism for calls that must never be model-authorized.
