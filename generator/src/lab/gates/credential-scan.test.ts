import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCredentialScanGate } from "./credential-scan.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thesun-lab-credscan-"));
  tmpDir = dir;
  return dir;
}

describe("runCredentialScanGate", () => {
  it("passes a clean generated server (env-var-only config)", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "server.py"),
      "import os\napi_key = os.environ['EXAMPLE_API_KEY']\nbase_url = os.environ.get('EXAMPLE_BASE_URL', 'https://api.example.com')\n",
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(true);
  });

  it("fails when a JWT is hardcoded in the generated source", async () => {
    const dir = await makeTmpDir();
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    await fs.writeFile(path.join(dir, "server.py"), `token = "${jwt}"\n`);
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(false);
    expect((result.detail as string[]).some((issue) => issue.includes("Hardcoded JWT"))).toBe(true);
  });

  it("fails when an AWS access key ID is hardcoded", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "config.py"), 'AWS_KEY = "AKIAIOSFODNN7EXAMPLE"\n');
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(false);
    expect((result.detail as string[]).some((issue) => issue.includes("AWS access key"))).toBe(true);
  });

  it("skips non-source files and directories like __pycache__ and .venv", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, "__pycache__"));
    await fs.writeFile(path.join(dir, "__pycache__", "server.cpython-311.pyc"), "binary-garbage-AKIAIOSFODNN7EXAMPLE");
    await fs.writeFile(path.join(dir, "notes.txt"), "AKIAIOSFODNN7EXAMPLE");
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(true);
  });

  it("flags a planted fake secret (AKIAAAAAAAAAAAAAAAAA) in generated output and does not print its value in the message", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "config.py"), 'AWS_KEY = "AKIAAAAAAAAAAAAAAAAA"\n');
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(false);
    expect((result.detail as string[]).some((issue) => issue.includes("Hardcoded AWS access key"))).toBe(true);
    // The summary message is a count, never the secret value itself.
    expect(result.message).not.toContain("AKIAAAAAAAAAAAAAAAAA");
  });

  it("passes clean, credential-free generated output (Go server shape)", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "main.go"),
      'package main\n\nimport "os"\n\nfunc main() {\n\tkey := os.Getenv("SHODAN_API_KEY")\n\t_ = key\n}\n',
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(true);
  });

  // --- Go coverage regression ------------------------------------------
  // Go is the generator's DEFAULT output language. Before `.go` joined
  // SCAN_EXTENSIONS these three cases all passed vacuously: the gate collected
  // no files from a Go server directory and reported "no hardcoded credentials
  // found" without having read main.go, the Dockerfile, or .env.example.
  //
  // Every synthetic credential below is assembled at runtime by concatenation
  // so no contiguous secret-shaped literal is committed to this file.

  it("fails when a credential is hardcoded in main.go (Go is the default language)", async () => {
    const dir = await makeTmpDir();
    const awsKey = "AKIA" + "TESTONLY0000FAKE"; // synthetic, 16 chars after the prefix
    await fs.writeFile(
      path.join(dir, "main.go"),
      `package main\n\nconst awsKey = "${awsKey}"\n`,
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(false);
    expect((result.detail as string[]).some((issue) => issue.includes("main.go"))).toBe(true);
    expect(result.message).not.toContain(awsKey);
  });

  it("fails on a Go `:=` short variable declaration binding a credential", async () => {
    const dir = await makeTmpDir();
    // `token := "..."` is the idiomatic Go way to bind a captured credential.
    // A single-character assignment-operator class matched `=` and `:` but not
    // `:=`, so this exact shape used to slip the scan entirely.
    const captured = "s3ss10n" + "0123456789abcdef" + "ABCDEFGH";
    await fs.writeFile(
      path.join(dir, "main.go"),
      `package main\n\nfunc auth() string {\n\ttoken := "${captured}"\n\treturn token\n}\n`,
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(false);
    expect(
      (result.detail as string[]).some((issue) => issue.includes("Hardcoded high-entropy credential")),
    ).toBe(true);
    expect(result.message).not.toContain(captured);
  });

  it("scans extensionless Dockerfile and .env.example, whose names no extension rule matched", async () => {
    const dockerDir = await makeTmpDir();
    const dockerSecret = "AKIA" + "DOCKERFILE00FAKE";
    await fs.writeFile(
      path.join(dockerDir, "Dockerfile"),
      `FROM golang:1.23\nENV API_KEY="${dockerSecret}"\n`,
    );
    const dockerResult = await runCredentialScanGate(dockerDir);
    expect(dockerResult.passed).toBe(false);
    expect((dockerResult.detail as string[]).some((issue) => issue.includes("Dockerfile"))).toBe(true);

    // `.env.example`'s extname is ".example", not ".env", so the extension set
    // alone never reached it. This is the file a HAR-derived session cookie is
    // most likely to be written into by hand.
    await fs.rm(dockerDir, { recursive: true, force: true });
    const envDir = await makeTmpDir();
    const envSecret = "AKIA" + "ENVEXAMPLE0FAKE0";
    await fs.writeFile(path.join(envDir, ".env.example"), `AWS_ACCESS_KEY_ID=${envSecret}\n`);
    const envResult = await runCredentialScanGate(envDir);
    expect(envResult.passed).toBe(false);
    expect((envResult.detail as string[]).some((issue) => issue.includes(".env.example"))).toBe(true);
  });

  it("passes a complete, clean Go server directory (main.go + Dockerfile + .env.example)", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "main.go"),
      'package main\n\nimport "os"\n\nfunc key() string {\n\treturn os.Getenv("EXAMPLE_API_KEY")\n}\n',
    );
    await fs.writeFile(path.join(dir, "go.mod"), "module example-mcp\n\ngo 1.23\n");
    await fs.writeFile(
      path.join(dir, "Dockerfile"),
      "FROM golang:1.23\nWORKDIR /src\nCOPY . .\nRUN go build -o /bin/server .\n",
    );
    await fs.writeFile(
      path.join(dir, ".env.example"),
      "# Secret: yes\nEXAMPLE_API_KEY=${EXAMPLE_API_KEY}\n",
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(true);
    // Prove the pass is earned rather than vacuous: main.go, Dockerfile and
    // .env.example were actually read. go.mod is the fourth file on disk and is
    // intentionally NOT scanned: it holds module paths and version pins only.
    expect(result.message).toMatch(/scanned 3 file\(s\)/);
  });

  it("passes output containing only documented placeholders (hermescred:// and ${VAR})", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "settings.env"),
      'SHODAN_API_KEY=${SHODAN_API_KEY}\n# resolved from hermescred://shodan/default by fleetd at spawn time\n',
    );
    const result = await runCredentialScanGate(dir);
    expect(result.passed).toBe(true);
  });
});
