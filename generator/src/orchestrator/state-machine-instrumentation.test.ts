import { describe, it, expect } from "vitest";
import { isValidTransition, getNextPhase } from "./state-machine.js";
import { BuildPhase, BuildState } from "../types/index.js";

describe("state machine instrumentation transitions", () => {
  it("allows GENERATING -> INSTRUMENTING", () => {
    expect(
      isValidTransition(BuildPhase.GENERATING, BuildPhase.INSTRUMENTING),
    ).toBe(true);
  });

  it("disallows GENERATING -> TESTING (must go through INSTRUMENTING)", () => {
    expect(isValidTransition(BuildPhase.GENERATING, BuildPhase.TESTING)).toBe(
      false,
    );
  });

  it("allows INSTRUMENTING -> TESTING", () => {
    expect(
      isValidTransition(BuildPhase.INSTRUMENTING, BuildPhase.TESTING),
    ).toBe(true);
  });

  it("allows INSTRUMENTING -> FAILED", () => {
    expect(isValidTransition(BuildPhase.INSTRUMENTING, BuildPhase.FAILED)).toBe(
      true,
    );
  });

  it("getNextPhase returns INSTRUMENTING after GENERATING", () => {
    const state = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      toolName: "stripe",
      phase: BuildPhase.GENERATING,
    } as BuildState;
    expect(getNextPhase(state)).toBe(BuildPhase.INSTRUMENTING);
  });

  it("loop-back from TESTING still goes through INSTRUMENTING", () => {
    const state = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      toolName: "stripe",
      phase: BuildPhase.GENERATING,
      testing: {
        totalTests: 5,
        passed: 3,
        failed: 2,
        coverage: 50,
        iterations: 1,
      },
    } as BuildState;
    expect(getNextPhase(state)).toBe(BuildPhase.INSTRUMENTING);
  });
});
