/**
 * Gate 2 — Instrumentation.
 *
 * Feeds the REAL protocol `Tool` objects (from a live `listTools()` call —
 * they carry `inputSchema` + `annotations` straight off the wire) into the
 * existing, reused `ValidationGate.validateToolDescription` /
 * `validateToolAnnotations` / `validateHelpToolExists` checks
 * (src/validation/validation-gate.ts:727/783/809). This is the Lab's
 * replacement for the deleted `extractToolDefinitions` regex-scrape of
 * `src/index.ts` — the Lab has a live protocol connection, so it doesn't
 * need to guess tool shape from TypeScript source text (which also never
 * worked for Python output).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ValidationGate } from "../../validation/validation-gate.js";
import type { GateFinding } from "../types.js";

export interface InstrumentationSubResult {
  tool: string;
  check: "description" | "annotations";
  passed: boolean;
  error?: string;
}

export function runInstrumentationGate(target: string, tools: Tool[]): GateFinding {
  const gate = new ValidationGate();
  const allToolNames = tools.map((t) => t.name);
  const subResults: InstrumentationSubResult[] = [];

  for (const tool of tools) {
    const descResult = gate.validateToolDescription(
      { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema },
      allToolNames,
    );
    subResults.push({
      tool: tool.name,
      check: "description",
      passed: descResult.passed,
      error: descResult.error,
    });

    const annResult = gate.validateToolAnnotations({
      name: tool.name,
      annotations: tool.annotations as unknown as Record<string, boolean> | undefined,
    });
    subResults.push({
      tool: tool.name,
      check: "annotations",
      passed: annResult.passed,
      error: annResult.error,
    });
  }

  const helpResult = gate.validateHelpToolExists(
    target,
    tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );

  const failures = subResults.filter((r) => !r.passed);
  const passed = failures.length === 0 && helpResult.passed;

  const messages = [
    ...failures.map((f) => `${f.tool} [${f.check}]: ${f.error}`),
    ...(helpResult.passed ? [] : [`help tool: ${helpResult.error}`]),
  ];

  return {
    gate: "instrumentation",
    passed,
    message: passed
      ? `all ${tools.length} tool(s) carry valid descriptions and annotations, and a help tool exists`
      : messages.join("; "),
    detail: { subResults, helpToolPassed: helpResult.passed, helpToolError: helpResult.error },
  };
}
