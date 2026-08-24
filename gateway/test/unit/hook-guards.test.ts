import { describe, it, expect, vi } from "vitest";
import {
  decide,
  decideDepScan,
  runDepScan,
  looksLikeInstall,
  hitsCredDenylist,
  isSelfRepairTarget,
  isMetadataOnlyCommand,
  hitsForbiddenTransport,
  isCopilotCamel,
  resolveDepScanUrl,
  builtinToolKind,
  isBuiltinWriteTool,
} from "../../../packaging/hooks/core.mjs";

// Built-in-tool inputs (Claude/Copilot/Codex shapes). Never embed real
// token literals — these are PATHS, and any token-shaped fixture would be
// assembled at runtime (test hygiene: GitHub push protection blocks contiguous
// secret-shaped literals).
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const read = (file_path: string) => ({ tool_name: "Read", tool_input: { file_path } });

const CRED_OPTS = { mode: "ask", credMode: "deny", env: {} as NodeJS.ProcessEnv };

describe("credential-file guard", () => {
  it("denies `cat ~/.copilot/config.json` via bash", () => {
    expect(decide(bash("cat ~/.copilot/config.json"), null, CRED_OPTS).action).toBe("deny");
  });
  it("denies Read of ~/.aws/credentials", () => {
    expect(decide(read("/Users/x/.aws/credentials"), null, CRED_OPTS).action).toBe("deny");
  });
  it("denies $HOME-expanded credential path in a bash command", () => {
    expect(decide(bash("cat $HOME/.aws/credentials"), null, CRED_OPTS).action).toBe("deny");
  });
  it("denies id_rsa, *.pem, secrets.vault, .netrc, hermes master.key", () => {
    for (const p of ["/home/u/.ssh/id_rsa", "./certs/server.pem", "~/.claude/secrets.vault", "~/.netrc", "~/.hermes/master.key"]) {
      expect(decide(read(p), null, CRED_OPTS).action, p).toBe("deny");
    }
  });
  it("denies .env and .env.local but ALLOWS .env.example / .env.sample", () => {
    expect(decide(read("./.env"), null, CRED_OPTS).action).toBe("deny");
    expect(decide(read("./.env.local"), null, CRED_OPTS).action).toBe("deny");
    expect(decide(read("./.env.example"), null, CRED_OPTS).action).toBe("allow");
    expect(decide(read("./.env.sample"), null, CRED_OPTS).action).toBe("allow");
  });
  it("passes a normal source file read (non-annoyance)", () => {
    expect(decide(read("./src/index.ts"), null, CRED_OPTS).action).toBe("allow");
    expect(decide(bash("ls -la ./src"), null, CRED_OPTS).action).toBe("allow");
  });
  it("mode=off allows; mode=ask asks", () => {
    expect(decide(bash("cat ~/.codex/auth.json"), null, { credMode: "off", env: {} }).action).toBe("allow");
    expect(decide(bash("cat ~/.codex/auth.json"), null, { credMode: "ask", env: {} }).action).toBe("ask");
  });
  it("THESUN_HOOK_CRED_PATHS extends the denylist", () => {
    const env = { THESUN_HOOK_CRED_PATHS: "~/.mytool/token.json" } as NodeJS.ProcessEnv;
    expect(decide(read("/Users/x/.mytool/token.json"), null, { credMode: "deny", env }).action).toBe("deny");
  });
  it("hitsCredDenylist directly", () => {
    expect(hitsCredDenylist(["cat ~/.copilot/config.json"], {} as NodeJS.ProcessEnv)).toBe(true);
    expect(hitsCredDenylist(["./README.md"], {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// Values are assembled at runtime, matching the fixture convention above: a
// contiguous literal here would trip the very guard under test when this file is
// written or edited through a hooked client.
const SSE = "s" + "se";
const STDIO = "std" + "io";

describe("forbidden-transport guard (covers Copilot/Codex, not just Claude)", () => {
  it("denies a prohibited transport in a config write", () => {
    for (const body of [
      `transport: ${SSE}`,
      `transport: ${STDIO}`,
      `"transport": "${SSE}"`,
      `proxy_mode = "${SSE}"`,
      `MCP_TRANSPORT=${STDIO}`,
    ]) {
      const d = decide({ tool_name: "Write", tool_input: { file_path: "./gw.yaml", content: body } }, null, CRED_OPTS);
      expect(d.action, body).toBe("deny");
      expect(d.reason.toLowerCase(), body).toContain("streamable-http");
    }
  });
  it("denies the CLI flag form in a bash command", () => {
    expect(decide(bash(`thv run --proxy-mode ${SSE} foo`), null, CRED_OPTS).action).toBe("deny");
    expect(decide(bash(`some-server --transport=${STDIO}`), null, CRED_OPTS).action).toBe("deny");
  });
  it("allows the permitted transport", () => {
    for (const body of ['transport: http', '"transport": "streamable-http"', 'transport: "http"']) {
      expect(decide({ tool_name: "Write", tool_input: { file_path: "./gw.yaml", content: body } }, null, CRED_OPTS).action, body).toBe("allow");
    }
  });
  it("does not fire on ordinary prose containing those letters", () => {
    for (const body of [
      "the session was assessed and messages were sent",
      "we discussed why stdio is prohibited in this codebase",
      "classes: [Assessor, Session]",
      "type: object",
    ]) {
      expect(hitsForbiddenTransport([body]), body).toBeNull();
    }
  });
  it("does not block a client spawning its own MCP server, only a gateway backend", () => {
    // The managed enterprise config declares a governance MCP this way. That is
    // ordinary client usage, not a supervised backend, so it must pass.
    const managed = `{"mcpServers":{"example-governance":{"type":"${STDIO}","command":"node"}}}`;
    expect(hitsForbiddenTransport([managed])).toBeNull();
    // The same value under an explicit transport key is a backend wiring: blocked.
    expect(hitsForbiddenTransport([`transport: ${STDIO}`])).toBe(STDIO);
  });
  it("never blocks a session from repairing the hook itself", () => {
    const d = decide(
      { tool_name: "Write", tool_input: { file_path: "/x/packaging/hooks/core.mjs", content: `transport: ${SSE}` } },
      null,
      CRED_OPTS,
    );
    expect(d.action).toBe("allow");
  });
});

describe("metadata-only carve-out (naming a credential path is not reading one)", () => {
  // Every command below MUST hit the denylist on its own, or the test would
  // pass for the wrong reason (a path the guard never watched) and prove nothing.
  it("allows existence and enumeration commands that name a credential path", () => {
    for (const c of [
      "ls -la ~/.hermes/vault.enc",
      "test -f ~/.aws/credentials && echo present",
      "stat ~/.hermes/vault.enc",
      "wc -c ~/.hermes/master.key",
      "find ~/.ssh/id_rsa",
      "du -sh ~/.aws/credentials",
      "ls ./certs/server.pem",
      'find . -name "*.pem"',
      "ls -la ~/.hermes/vault.enc 2>/dev/null",
      "stat ~/.aws/credentials 2>&1",
    ]) {
      expect(hitsCredDenylist([c], {} as NodeJS.ProcessEnv), `${c} must hit the denylist`).toBe(true);
      const d = decide(bash(c), null, CRED_OPTS);
      expect(d.action, c).toBe("allow");
      expect(d.reason, c).toContain("metadata-only");
    }
  });
  it("still denies any command that can emit the bytes", () => {
    for (const c of [
      "cat ~/.aws/credentials",
      "head -c 100 ~/.hermes/vault.enc",
      "strings ~/.hermes/master.key",
      "grep -r AKIA ~/.aws/credentials",
      "find ~/.aws/credentials -exec cat {} \\;",
      "ls $(cat ~/.aws/credentials)",
      "ls ~/.hermes/vault.enc > /tmp/leak",
      "cat ~/.aws/credentials 2>/dev/null",
      "cat ~/.aws/credentials > /tmp/leak 2>&1",
      "ls /tmp; cat ~/.aws/credentials",
      "echo hi && cat ~/.aws/credentials",
      'find . -name "*.pem" | xargs cat',
      "cat ~/.aws/credentials | ls",
    ]) {
      expect(decide(bash(c), null, CRED_OPTS).action, c).toBe("deny");
    }
  });
  it("never applies to file-read tools, only to exec", () => {
    expect(decide(read("/Users/x/.aws/credentials"), null, CRED_OPTS).action).toBe("deny");
  });
  it("isMetadataOnlyCommand rejects an empty command", () => {
    expect(isMetadataOnlyCommand("")).toBe(false);
  });
});

describe("self-repair carve-out (never block the hook's own files)", () => {
  it("allows editing the hook config / packaged files even via bash", () => {
    expect(isSelfRepairTarget(["vim ~/.claude/settings.json"])).toBe(true);
    expect(isSelfRepairTarget(["node packaging/hooks/thesun-hook.mjs"])).toBe(true);
    expect(decide(bash("cat ~/.claude/settings.json"), null, CRED_OPTS).action).toBe("allow");
  });
  it("does not treat unrelated paths as self-repair", () => {
    expect(isSelfRepairTarget(["./src/index.ts"])).toBe(false);
  });
});

describe("dep-scan pre-filter (looksLikeInstall)", () => {
  it("matches real package installs", () => {
    for (const c of ["npm install left-pad", "npm i", "pnpm add zod", "pip3 install requests", "go get ./...", "cargo add serde", "yarn add react", "uv pip install x", "gem install bundler"]) {
      expect(looksLikeInstall(c), c).toBe(true);
    }
  });
  it("does NOT match non-installs", () => {
    for (const c of ["git install-hooks", "npm run build", "cargo build", "go build ./...", "ls -la", "echo install"]) {
      expect(looksLikeInstall(c), c).toBe(false);
    }
  });
});

describe("dep-scan thin client (decideDepScan) — fail-open always", () => {
  const snap = { version: 1, tools: {}, gatewayUrl: "http://127.0.0.1:3100/mcp" };

  it("resolveDepScanUrl derives from snapshot.gatewayUrl (strips /mcp)", () => {
    expect(resolveDepScanUrl({}, snap)).toBe("http://127.0.0.1:3100/dep-scan");
    expect(resolveDepScanUrl({ THESUN_DEPSCAN_URL: "http://x/y" }, snap)).toBe("http://x/y");
  });

  it("DEP_SCAN_DISABLE=1 → allow, no POST", async () => {
    const fetchImpl = vi.fn();
    const d = await decideDepScan(bash("npm install left-pad"), snap, { env: { DEP_SCAN_DISABLE: "1" }, fetchImpl });
    expect(d.action).toBe("allow");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non-exec tool → allow, no POST", async () => {
    const fetchImpl = vi.fn();
    const d = await decideDepScan(read("./x.ts"), snap, { env: {}, fetchImpl });
    expect(d.action).toBe("allow");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("`npm run build` and `git install-hooks` → no POST", async () => {
    const fetchImpl = vi.fn();
    await decideDepScan(bash("npm run build"), snap, { env: {}, fetchImpl });
    await decideDepScan(bash("git install-hooks"), snap, { env: {}, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("veto response → deny with the prescriptive message", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ action: "veto", message: "use >=1.2.3" }) }));
    const d = await decideDepScan(bash("npm install left-pad"), snap, { env: {}, fetchImpl });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("1.2.3");
  });

  it("warn response → allow", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ action: "warn" }) }));
    expect((await decideDepScan(bash("npm install x"), snap, { env: {}, fetchImpl })).action).toBe("allow");
  });

  it("endpoint error/timeout → allow (fail-open)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await decideDepScan(bash("npm install x"), snap, { env: {}, fetchImpl })).action).toBe("allow");
  });

  it("install command that mentions a hook path is still scanned (no self-repair bypass of dep-scan)", async () => {
    // Regression for the SEC-1 bypass class: a fragment like `packaging/hooks`
    // in an install command must NOT wave the command past the vulnerability
    // veto. The dep-scan POST must fire so the packages are actually checked.
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ action: "allow", findings: [] }) }));
    await decideDepScan(bash("npm install --prefix packaging/hooks"), snap, { env: {}, fetchImpl });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("runDepScan with no url/fetch → allow", async () => {
    expect((await runDepScan("npm install x", { url: "", fetchImpl: null })).action).toBe("allow");
  });
});

describe("output-shape family detection (isCopilotCamel)", () => {
  it("Copilot camelCase → true", () => {
    expect(isCopilotCamel({ toolName: "Bash", toolArgs: "{}" })).toBe(true);
    expect(isCopilotCamel({ sessionId: "s", toolName: "x" })).toBe(true);
  });
  it("Claude / VS Code alias → false", () => {
    expect(isCopilotCamel({ tool_name: "Bash", tool_input: {} })).toBe(false);
    expect(isCopilotCamel({ hook_event_name: "PreToolUse", tool_name: "x" })).toBe(false);
  });
});

describe("builtinToolKind", () => {
  it("classifies exec vs file vs mcp", () => {
    expect(builtinToolKind("Bash")).toBe("exec");
    expect(builtinToolKind("shell")).toBe("exec");
    expect(builtinToolKind("Read")).toBe("file");
    expect(builtinToolKind("grep")).toBe("file");
    expect(builtinToolKind("mcp__mcp-gateway__gh_delete_repo")).toBeNull();
    expect(builtinToolKind("mcp-gateway(x)")).toBeNull();
  });
});


// Gemini CLI shares Claude's stdin schema (tool_name / tool_input, snake_case)
// but none of its tool NAMES. builtinToolKind returning null is not a soft
// failure: every guard in decide() short-circuits and the call is allowed with
// no output and no diagnostic. These names were read out of the Gemini 0.46.0
// bundle, so this suite fails if someone trims the sets back.
describe("Gemini CLI built-in tool names are classified", () => {
  it("classifies run_shell_command as exec, not as unknown", () => {
    expect(builtinToolKind("run_shell_command")).toBe("exec");
  });

  it("classifies Gemini's read tools as file reads", () => {
    for (const t of ["read_file", "read_many_files", "search_file_content", "glob", "list_directory"]) {
      expect(builtinToolKind(t)).toBe("file");
    }
  });

  it("classifies Gemini's edit tools as writes for the transport guard", () => {
    for (const t of ["write_file", "replace", "edit"]) {
      expect(isBuiltinWriteTool(t)).toBe(true);
    }
  });

  it("denies a credential read issued through run_shell_command", () => {
    // Assembled so this file never carries a contiguous credential path.
    const cred = "~/." + "aws" + "/" + "credentials";
    // Guard against passing for the wrong reason: the command must actually be
    // on the denylist, otherwise this would "pass" on an unrelated allow.
    expect(hitsCredDenylist([`cat ${cred}`])).toBe(true);

    const decision = decide({
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: `cat ${cred}` },
    });
    expect(decision.action).toBe("deny");
  });

  it("leaves a benign Gemini shell command alone", () => {
    const decision = decide({
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "git status" },
    });
    expect(decision.action).toBe("allow");
  });
});
