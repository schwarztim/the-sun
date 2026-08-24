import { describe, it, expect } from "vitest";
import { evaluateBindGuard, isLoopbackHost } from "../../src/gateway.js";

/**
 * SEC-5 fail-closed bind guard (evaluateBindGuard). These assert the decision
 * logic only — the pure function never opens a socket, so no server is started
 * here. start() consumes the decision: allowed=false => throw (refuse to
 * start); insecureOverride=true => bind but log a loud warning.
 */
describe("isLoopbackHost", () => {
  it("recognizes the three loopback forms", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("treats any other host as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("gateway.internal")).toBe(false);
  });
});

describe("evaluateBindGuard", () => {
  it("allows loopback bind with auth none (the default posture)", () => {
    const d = evaluateBindGuard({ host: "127.0.0.1", authMode: "none" });
    expect(d.allowed).toBe(true);
    expect(d.insecureOverride).toBe(false);
  });

  it("refuses non-loopback bind with auth none (fail closed)", () => {
    const d = evaluateBindGuard({ host: "0.0.0.0", authMode: "none" });
    expect(d.allowed).toBe(false);
    expect(d.insecureOverride).toBe(false);
    expect(d.reason).toMatch(/Refusing to start/);
  });

  it("allows non-loopback bind when auth.mode is entra", () => {
    const d = evaluateBindGuard({ host: "0.0.0.0", authMode: "entra" });
    expect(d.allowed).toBe(true);
    expect(d.insecureOverride).toBe(false);
  });

  it("allows non-loopback bind when a shared_secret is set (auth none)", () => {
    const d = evaluateBindGuard({
      host: "0.0.0.0",
      authMode: "none",
      sharedSecret: "some-shared-secret",
    });
    expect(d.allowed).toBe(true);
    expect(d.insecureOverride).toBe(false);
  });

  it("ignores an empty-string shared_secret (treated as no auth => refuse)", () => {
    const d = evaluateBindGuard({
      host: "0.0.0.0",
      authMode: "none",
      sharedSecret: "",
    });
    expect(d.allowed).toBe(false);
  });

  it("allows non-loopback + auth none via the allow_insecure escape hatch, flagging override", () => {
    const d = evaluateBindGuard({
      host: "0.0.0.0",
      authMode: "none",
      allowInsecureNonLoopback: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.insecureOverride).toBe(true);
    expect(d.reason).toMatch(/allow_insecure_non_loopback/);
  });

  it("does not set insecureOverride when the escape hatch is unnecessary (loopback)", () => {
    const d = evaluateBindGuard({
      host: "127.0.0.1",
      authMode: "none",
      allowInsecureNonLoopback: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.insecureOverride).toBe(false);
  });
});
