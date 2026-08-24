import { describe, it, expect } from "vitest";
import { ValidationGate } from "./validation-gate.js";

describe("instrumentation validation", () => {
  it("fails when tool descriptions are single-sentence with ID prerequisites", () => {
    const toolDef = {
      name: "get_user",
      description: "Get a user.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolDescription(toolDef, [
      "list_users",
      "get_user",
      "delete_user",
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("prerequisite");
  });

  it("passes when tool description has 3-part structure", () => {
    const toolDef = {
      name: "get_user",
      description:
        "Get user details by ID. Requires userId — call list_users first. Next: update_user to modify, delete_user to remove.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolDescription(toolDef, [
      "list_users",
      "get_user",
      "update_user",
      "delete_user",
    ]);
    expect(result.passed).toBe(true);
  });

  it("passes for terminal DELETE tools with prerequisite but no Next", () => {
    const toolDef = {
      name: "delete_user",
      description:
        "Delete a user permanently. Requires userId — call list_users first. This action is destructive and irreversible.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolDescription(toolDef, [
      "list_users",
      "get_user",
      "delete_user",
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when prerequisite references a non-existent tool", () => {
    const toolDef = {
      name: "get_user",
      description:
        "Get user details. Requires userId — call find_users first. Next: update_user.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolDescription(toolDef, [
      "list_users",
      "get_user",
      "update_user",
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("find_users");
  });

  it("fails when annotations are missing", () => {
    const toolDef = {
      name: "list_users",
      description: "List all users. Next: get_user for details.",
    };
    const gate = new ValidationGate();
    const result = gate.validateToolAnnotations(toolDef);
    expect(result.passed).toBe(false);
  });

  it("passes when all annotations are set", () => {
    const toolDef = {
      name: "list_users",
      description: "List all users. Next: get_user for details.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolAnnotations(toolDef);
    expect(result.passed).toBe(true);
  });

  it("passes a write tool's wire shape (destructive+openWorld only; readOnly/idempotent omitted as false)", () => {
    // A Go write (POST) tool: go-sdk drops readOnlyHint:false / idempotentHint:false
    // (bool,omitempty), so only the *bool hints reach the wire. This must PASS.
    const toolDef = {
      name: "set_charge_cost",
      description: "Set a charge cost. Requires a charge id from search_charges.",
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
      },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolAnnotations(toolDef);
    expect(result.passed).toBe(true);
  });

  it("fails when a required always-serializable hint (destructiveHint) is absent", () => {
    const toolDef = {
      name: "list_users",
      description: "List all users.",
      annotations: { openWorldHint: true },
    };
    const gate = new ValidationGate();
    const result = gate.validateToolAnnotations(toolDef);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("destructiveHint");
  });

  it("fails when help tool is missing", () => {
    const tools = [
      { name: "list_users", description: "List users." },
      { name: "get_user", description: "Get user." },
    ];
    const gate = new ValidationGate();
    const result = gate.validateHelpToolExists("myapi", tools);
    expect(result.passed).toBe(false);
  });

  it("passes when help tool exists with topic param", () => {
    const tools = [
      { name: "list_users", description: "List users." },
      {
        name: "myapi_help",
        description: "Get workflow guidance.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
        },
      },
    ];
    const gate = new ValidationGate();
    const result = gate.validateHelpToolExists("myapi", tools);
    expect(result.passed).toBe(true);
  });
});
