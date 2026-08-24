import { describe, it, expect } from "vitest";
// SEC-1 regression: the self-repair carve-out used to substring-match
// SELF_REPAIR_FRAGMENTS against EVERY candidate string, including the whole shell
// command. So appending a benign fragment to a credential read (e.g.
// `# packaging/hooks` or `&& echo .claude/settings.json`) made the command look
// like self-repair and skipped the credential deny. The carve-out is now
// write-target-only and never applies to exec/shell tools. Import the SAME core
// the installed hooks run (packaging/hooks/core.mjs), matching hook-*.test.ts.
import { decide, selfRepairTargets } from "../../../packaging/hooks/core.mjs";

// Built-in-tool inputs (Claude/Copilot/Codex shapes). Credential PATHS only; no
// token-shaped literals (GitHub push protection blocks contiguous secret shapes).
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => ({ tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } });

const CRED_OPTS = { mode: "ask", credMode: "deny", env: {} as NodeJS.ProcessEnv };

describe("SEC-1: fragment-append no longer bypasses the credential guard", () => {
  it("DENIES `cat ~/.aws/credentials # packaging/hooks` (trailing comment fragment)", () => {
    expect(decide(bash("cat ~/.aws/credentials # packaging/hooks"), null, CRED_OPTS).action).toBe("deny");
  });

  it("DENIES `cat ~/.aws/credentials && echo .claude/settings.json` (chained fragment)", () => {
    expect(decide(bash("cat ~/.aws/credentials && echo .claude/settings.json"), null, CRED_OPTS).action).toBe("deny");
  });

  it("DENIES the baseline `cat ~/.aws/credentials` (guard still works)", () => {
    expect(decide(bash("cat ~/.aws/credentials"), null, CRED_OPTS).action).toBe("deny");
  });

  it("does not let an exec tool smuggle a hook file_path arg to carve out", () => {
    // Even if a Bash envelope also carries a file_path pointing at a hook file,
    // exec tools never take the carve-out; the cred deny still fires.
    const smuggle = { tool_name: "Bash", tool_input: { command: "cat ~/.aws/credentials", file_path: "packaging/hooks/thesun-hook.mjs" } };
    expect(decide(smuggle, null, CRED_OPTS).action).toBe("deny");
  });
});

describe("SEC-1: genuine self-repair (write/edit of the hook's own files) still allowed", () => {
  it("ALLOWS an Edit whose file_path is a hook file", () => {
    expect(decide(edit("/Users/x/Projects/thesun/packaging/hooks/thesun-hook.mjs"), null, CRED_OPTS).action).toBe("allow");
  });

  it("selfRepairTargets resolves the write target and ignores exec commands", () => {
    expect(selfRepairTargets(edit("/tmp/packaging/hooks/thesun-hook.mjs"))).toEqual([
      "/tmp/packaging/hooks/thesun-hook.mjs",
    ]);
    expect(selfRepairTargets(bash("cat ~/.aws/credentials # packaging/hooks"))).toEqual([]);
  });
});

describe("SEC-1: no false positives on benign work", () => {
  it("ALLOWS a benign unrelated command (`ls`)", () => {
    expect(decide(bash("ls"), null, CRED_OPTS).action).toBe("allow");
  });

  it("ALLOWS a normal source-file edit (not a hook file)", () => {
    expect(decide(edit("/Users/x/Projects/thesun/src/index.ts"), null, CRED_OPTS).action).toBe("allow");
  });
});
