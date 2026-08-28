/**
 * Tests for the vendored encrypted credential store.
 *
 * Ported from the module's original suite when it was vendored into thesun. It
 * had come across as source only, which left an AES-256-GCM store handling
 * every generated server's credentials with no tests at all in this repo.
 *
 * The original ran on node:test; this is the same coverage on vitest, which is
 * what the generator uses. One test did not come over: a cross-language check
 * that shelled out to a Python CLI in the original repository. thesun does not
 * ship that CLI, so the test could only ever have failed here for reasons
 * unrelated to this code.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VaultStore } from "./vault-store.js";

const IS_WINDOWS = process.platform === "win32";

type Workspace = { root: string; vaultPath: string; masterKeyPath: string };

const created: string[] = [];

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "thesun-vault-"));
  created.push(root);
  const keyDir = join(root, "store");
  const masterKeyPath = join(keyDir, "master.key");
  const vaultPath = join(keyDir, "secrets.vault");
  await mkdir(keyDir, { recursive: true });
  await writeFile(masterKeyPath, randomBytes(32), { mode: 0o600 });
  return { root, vaultPath, masterKeyPath };
}

function newStore(w: Workspace): VaultStore {
  return new VaultStore({ vaultPath: w.vaultPath, masterKeyPath: w.masterKeyPath });
}

afterEach(async () => {
  while (created.length > 0) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

describe("VaultStore round trip", () => {
  it("writes Vault V2 and reads the value back", async () => {
    const w = await createWorkspace();
    const store = newStore(w);

    await store.set("hermes", "ms365:graph", "top-secret");

    expect(await store.get("hermes", "ms365:graph")).toBe("top-secret");
    expect(await store.getPassword("hermes", "ms365:graph")).toBe("top-secret");

    const raw = JSON.parse(await readFile(w.vaultPath, "utf8"));
    expect(raw.meta).toEqual({ version: "2", algo: "AES-256-GCM", key_source: "file" });
    expect(raw.entries["hermes::ms365:graph"]).toBeTruthy();
  });

  it("never stores the plaintext value on disk", async () => {
    const w = await createWorkspace();
    await newStore(w).set("hermes", "ms365:graph", "top-secret");

    const bytes = await readFile(w.vaultPath);
    expect(bytes.includes(Buffer.from("top-secret", "utf8"))).toBe(false);
    expect(bytes.toString("latin1")).not.toContain("top-secret");
  });

  it.skipIf(IS_WINDOWS)("writes the vault 0600", async () => {
    const w = await createWorkspace();
    await newStore(w).set("hermes", "ms365:graph", "top-secret");
    expect((await stat(w.vaultPath)).mode & 0o777).toBe(0o600);
  });
});

describe("VaultStore lookup and removal", () => {
  it("findCredentials returns matching service entries only, sorted", async () => {
    const w = await createWorkspace();
    const store = newStore(w);

    await store.setPassword("hermes", "ms365:graph", "alpha");
    await store.setPassword("hermes", "jira", "beta");
    await store.setPassword("other", "jira", "gamma");

    expect(await store.findCredentials("hermes")).toEqual([
      { account: "jira", password: "beta" },
      { account: "ms365:graph", password: "alpha" },
    ]);
  });

  it("delete removes an entry and reports a missing one", async () => {
    const w = await createWorkspace();
    const store = newStore(w);

    await store.set("hermes", "ms365:graph", "to-delete");

    expect(await store.delete("hermes", "ms365:graph")).toBe(true);
    expect(await store.get("hermes", "ms365:graph")).toBeNull();
    expect(await store.deletePassword("hermes", "ms365:graph")).toBe(false);
  });

  it("treats an empty or missing vault as an empty store", async () => {
    const w = await createWorkspace();
    const store = newStore(w);

    expect(await store.get("hermes", "ms365:graph")).toBeNull();
    expect(await store.findCredentials("hermes")).toEqual([]);
    expect(await store.delete("hermes", "ms365:graph")).toBe(false);

    await writeFile(w.vaultPath, "", { encoding: "utf8", mode: 0o600 });
    expect(await store.getPassword("hermes", "ms365:graph")).toBeNull();
  });
});

describe("VaultStore cryptographic integrity", () => {
  it("refuses to decrypt under the wrong master key", async () => {
    const w = await createWorkspace();
    await newStore(w).set("hermes", "ms365:graph", "secret-value");

    await writeFile(w.masterKeyPath, randomBytes(32), { mode: 0o600 });

    await expect(newStore(w).get("hermes", "ms365:graph")).rejects.toThrow();
  });

  it("rejects a tampered ciphertext rather than returning it", async () => {
    // The GCM auth tag is the whole point of choosing AES-GCM here: a silent
    // accept of edited ciphertext would make the vault merely obfuscated.
    const w = await createWorkspace();
    await newStore(w).set("hermes", "ms365:graph", "secret-value");

    const raw = JSON.parse(await readFile(w.vaultPath, "utf8"));
    const entry = raw.entries["hermes::ms365:graph"];
    const ct = Buffer.from(entry.ciphertext, "base64");
    ct[0] ^= 0xff; // flip a bit in the ciphertext
    entry.ciphertext = ct.toString("base64");
    await writeFile(w.vaultPath, JSON.stringify(raw), { encoding: "utf8", mode: 0o600 });

    await expect(newStore(w).get("hermes", "ms365:graph")).rejects.toThrow();
  });

  it("refuses a master key that is not 32 bytes", async () => {
    const w = await createWorkspace();
    await newStore(w).set("hermes", "ms365:graph", "secret-value");

    await writeFile(w.masterKeyPath, randomBytes(16), { mode: 0o600 });

    await expect(newStore(w).get("hermes", "ms365:graph")).rejects.toThrow(/32 bytes/);
  });
});

describe("VaultStore default location", () => {
  // The defaults are resolved from the real home directory, so these assert the
  // decision rather than writing to it: the store must not reach into an
  // unrelated tool's directory for a fresh install, and must not abandon an
  // existing vault that already lives in the legacy one.
  it("defaults both files into the same directory", () => {
    const store = new VaultStore() as unknown as { vaultPath: string; masterKeyPath: string };
    expect(dirname(store.vaultPath)).toBe(dirname(store.masterKeyPath));
  });

  it("keeps an explicit path untouched", async () => {
    const w = await createWorkspace();
    const store = newStore(w) as unknown as { vaultPath: string; masterKeyPath: string };
    expect(store.vaultPath).toBe(w.vaultPath);
    expect(store.masterKeyPath).toBe(w.masterKeyPath);
  });
});

describe("VaultStore concurrent writes", () => {
  // Regression for two failure modes:
  //   (1) Byte-level interleave: a fixed `${vaultPath}.tmp` let two writers
  //       write into the same intermediate file at offset 0, leaving the longer
  //       payload's tail past the shorter one's closing brace.
  //   (2) Lost writes: two setPassword calls each read, mutate, then write, so
  //       without serialization the second rename silently drops the first.
  it("never corrupts the vault and preserves every write", async () => {
    const w = await createWorkspace();
    const store = newStore(w);

    await store.set("hermes", "seed", "seed-value");

    const writerCount = 25;
    await Promise.all(
      Array.from({ length: writerCount }, (_, i) => store.set("hermes", `concurrent-${i}`, `value-${i}`)),
    );

    // 1: still valid JSON, with no extra data past the closing brace.
    const parsed = JSON.parse(await readFile(w.vaultPath, "utf8"));
    expect(parsed.meta.version).toBe("2");

    // 2: every concurrent write survived.
    for (let i = 0; i < writerCount; i++) {
      expect(await store.getPassword("hermes", `concurrent-${i}`)).toBe(`value-${i}`);
    }

    // 3: the pre-existing entry was not clobbered by the race.
    expect(await store.getPassword("hermes", "seed")).toBe("seed-value");

    // 4: no temp files left behind.
    const siblings = await readdir(dirname(w.vaultPath));
    expect(siblings.filter((n) => n.includes("secrets.vault.tmp"))).toEqual([]);
  });
});
