import { describe, it, expect } from "vitest";
import {
  DiscoveredEndpointSchema,
  ToolInstrumentationResultSchema,
  BuildStateSchema,
} from "./index.js";

describe("DiscoveredEndpointSchema instrumentation fields", () => {
  it("accepts endpoint with instrumentation metadata", () => {
    const endpoint = {
      path: "/api/users/{id}",
      method: "GET",
      tags: ["users"],
      parameters: [],
      toolName: "get_user",
      prerequisites: [
        { paramName: "id", sourceToolName: "list_users", sourceField: "id" },
      ],
      nextTools: ["update_user", "delete_user"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inferredFrom: "openapi" as const,
    };
    const result = DiscoveredEndpointSchema.safeParse(endpoint);
    expect(result.success).toBe(true);
  });

  it("accepts endpoint without instrumentation metadata (backward compat)", () => {
    const endpoint = {
      path: "/api/users",
      method: "GET",
      tags: [],
      parameters: [],
    };
    const result = DiscoveredEndpointSchema.safeParse(endpoint);
    expect(result.success).toBe(true);
  });

  it("validates inferredFrom enum values", () => {
    const endpoint = {
      path: "/api/users",
      method: "GET",
      tags: [],
      parameters: [],
      inferredFrom: "invalid",
    };
    const result = DiscoveredEndpointSchema.safeParse(endpoint);
    expect(result.success).toBe(false);
  });
});

describe("ToolInstrumentationResultSchema", () => {
  it("validates a complete instrumentation result", () => {
    const result = {
      target: "stripe",
      toolCount: 15,
      workflowPatterns: [
        {
          topic: "payments",
          steps: [
            { toolName: "list_customers", purpose: "Find customer" },
            { toolName: "create_charge", purpose: "Charge customer" },
          ],
        },
      ],
      helpToolGenerated: true,
      enrichmentStats: {
        prerequisitesAdded: 8,
        nextDirectivesAdded: 12,
        annotationsAdded: 15,
        descriptionsRewritten: 5,
      },
    };
    expect(ToolInstrumentationResultSchema.safeParse(result).success).toBe(
      true,
    );
  });
});

describe("BuildState instrumenting phase", () => {
  it("accepts instrumenting as a valid phase", () => {
    const state = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      toolName: "stripe",
      phase: "instrumenting",
    };
    const result = BuildStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it("accepts toolInstrumentation field on BuildState", () => {
    const state = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      toolName: "stripe",
      phase: "completed",
      toolInstrumentation: {
        target: "stripe",
        toolCount: 10,
        workflowPatterns: [],
        helpToolGenerated: true,
        enrichmentStats: {
          prerequisitesAdded: 5,
          nextDirectivesAdded: 8,
          annotationsAdded: 10,
          descriptionsRewritten: 3,
        },
      },
    };
    const result = BuildStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });
});
