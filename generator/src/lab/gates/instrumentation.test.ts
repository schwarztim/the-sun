import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { runInstrumentationGate } from "./instrumentation.js";

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function tool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: "Does a thing.",
    inputSchema: { type: "object", properties: {} },
    annotations: ANNOTATIONS,
    ...overrides,
  } as Tool;
}

describe("runInstrumentationGate", () => {
  it("passes a well-instrumented tool set", () => {
    const tools = [
      tool({ name: "list_widgets", description: "Lists widgets." }),
      tool({
        name: "example_help",
        description: "Help topics.",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
      }),
    ];
    const result = runInstrumentationGate("example", tools);
    expect(result.passed).toBe(true);
  });

  it("fails when a tool with an ID parameter lacks prerequisite guidance", () => {
    const tools = [
      tool({
        name: "get_widget",
        description: "Get a widget.", // no "requires"/"call X first"
        inputSchema: { type: "object", properties: { widgetId: { type: "string" } } },
      }),
      tool({
        name: "example_help",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
      }),
    ];
    const result = runInstrumentationGate("example", tools);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/prerequisite/);
  });

  it("fails when a tool has no annotations at all", () => {
    const tools = [
      tool({ name: "list_widgets", annotations: undefined }),
      tool({
        name: "example_help",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
      }),
    ];
    const result = runInstrumentationGate("example", tools);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/no annotations/);
  });

  it("fails when the target's help tool is missing", () => {
    const tools = [tool({ name: "list_widgets" })];
    const result = runInstrumentationGate("example", tools);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/Missing example_help tool/);
  });

  it("fails when the help tool exists but lacks a topic parameter", () => {
    const tools = [
      tool({ name: "list_widgets" }),
      tool({ name: "example_help", inputSchema: { type: "object", properties: {} } }),
    ];
    const result = runInstrumentationGate("example", tools);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/missing "topic" parameter/);
  });
});
