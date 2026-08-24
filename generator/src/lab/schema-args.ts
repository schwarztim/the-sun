/**
 * Synthesizes minimal-but-valid tool call arguments from a JSON Schema
 * (the shape `Tool.inputSchema` carries over the wire). Used by gates that
 * live-invoke tools (wire-fingerprint, callability, precision) — they need
 * SOME arguments to trigger a call, not semantically meaningful ones.
 */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: unknown[];
  [key: string]: unknown;
}

export function synthesizeArgs(schema: JsonSchemaLike | undefined): Record<string, unknown> {
  if (!schema || schema.type !== "object" || !schema.properties) return {};
  const required = new Set(schema.required ?? []);
  const args: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!required.has(key)) continue;
    args[key] = synthesizeValue(propSchema as JsonSchemaLike);
  }
  return args;
}

function synthesizeValue(propSchema: JsonSchemaLike): unknown {
  if (Array.isArray(propSchema?.enum) && propSchema.enum.length > 0) {
    return propSchema.enum[0];
  }
  switch (propSchema?.type) {
    case "string":
      return "test";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "test";
  }
}
