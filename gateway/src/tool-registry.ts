import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";
import type { SafetyClassification } from "./manifest.js";

export interface ToolEntry {
  /** The namespaced tool name exposed to clients */
  namespacedName: string;
  /** The original tool name on the backend */
  originalName: string;
  /** The backend this tool belongs to */
  backendName: string;
  /** Full tool definition with namespaced name */
  tool: Tool;
  /** Safety classification (set when a classifier is provided to the registry) */
  safety?: SafetyClassification;
}

/**
 * Client-facing override for a single tool, keyed elsewhere by the tool's
 * ORIGINAL namespaced name. Overriding `name` renames the tool as clients see
 * it (backend routing is unaffected); overriding `description` rewrites the
 * exposed description. Both are optional; an absent field leaves the original
 * value unchanged.
 */
export interface ToolOverride {
  name?: string;
  description?: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();
  /**
   * Monotonic change counter, bumped whenever the registered tool set changes
   * (a backend is registered or unregistered). Consumers that cache anything
   * derived from the tool set (e.g. the semantic embedding index in
   * tool-embeddings.ts) read this to know when to invalidate their cache.
   */
  private changeVersion = 0;
  private logger: Logger;
  private globalPrefix: string;
  private classify?: (
    backendName: string,
    originalName: string,
    namespacedName: string
  ) => SafetyClassification;
  /** Client-facing overrides keyed by ORIGINAL namespaced tool name. */
  private overrides: Record<string, ToolOverride>;

  constructor(
    logger: Logger,
    globalPrefix = "",
    classify?: (
      backendName: string,
      originalName: string,
      namespacedName: string
    ) => SafetyClassification,
    overrides: Record<string, ToolOverride> = {}
  ) {
    this.logger = logger;
    this.globalPrefix = globalPrefix;
    this.classify = classify;
    this.overrides = overrides;
  }

  /** Register all tools from a backend, namespacing them */
  registerBackend(backendName: string, namespace: string, tools: Tool[]): void {
    // Remove any existing tools for this backend first
    this.unregisterBackend(backendName);

    const prefix = this.globalPrefix ? `${this.globalPrefix}${namespace}` : namespace;
    for (const tool of tools) {
      const namespacedName = `${prefix}_${tool.name}`;
      const override = this.overrides[namespacedName];

      // Exposed (client-facing) identity. Starts as the namespaced name and is
      // replaced only when a valid, non-colliding rename override is present.
      let exposedName = namespacedName;
      let description = tool.description;

      if (override) {
        if (override.description !== undefined) {
          description = override.description;
        }
        if (override.name !== undefined && override.name !== namespacedName) {
          if (this.tools.has(override.name)) {
            // Never silently drop a tool: a colliding rename is rejected and the
            // original exposed name is kept.
            this.logger.warn(
              `tool_overrides: rename "${namespacedName}" -> "${override.name}" collides with an already-exposed tool; keeping original name`
            );
          } else {
            exposedName = override.name;
          }
        }
      }

      const entry: ToolEntry = {
        // Exposed identity (what clients see and call by). Backend routing uses
        // originalName + backendName below, so a rename never breaks dispatch.
        namespacedName: exposedName,
        originalName: tool.name,
        backendName,
        tool: { ...tool, name: exposedName, description },
      };
      if (this.classify) {
        // Classify against the ORIGINAL namespaced name so name-based safety
        // rules are unaffected by a client-facing rename.
        entry.safety = this.classify(backendName, tool.name, namespacedName);
      }
      this.tools.set(exposedName, entry);
    }
    this.changeVersion++;
    this.logger.info(
      `Registered ${tools.length} tools from backend "${backendName}" (namespace: ${prefix})`
    );
  }

  /** Remove all tools for a backend */
  unregisterBackend(backendName: string): void {
    const toRemove: string[] = [];
    for (const [name, entry] of this.tools) {
      if (entry.backendName === backendName) toRemove.push(name);
    }
    for (const name of toRemove) this.tools.delete(name);
    if (toRemove.length > 0) {
      this.changeVersion++;
      this.logger.debug(
        `Unregistered ${toRemove.length} tools from backend "${backendName}"`
      );
    }
  }

  /**
   * Monotonic version of the registered tool set. Increments on every
   * register/unregister that changes the set. Cache holders (semantic index)
   * compare against a stored value to decide when to invalidate.
   */
  getVersion(): number {
    return this.changeVersion;
  }

  /** Get all registered tools (for tools/list) */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  /** Get all registered tool entries, including backend routing metadata */
  getAllEntries(): ToolEntry[] {
    return Array.from(this.tools.values());
  }

  /** Look up a tool by its namespaced name */
  resolve(namespacedName: string): ToolEntry | undefined {
    return this.tools.get(namespacedName);
  }

  /** Get count of tools per backend */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const entry of this.tools.values()) {
      stats[entry.backendName] = (stats[entry.backendName] || 0) + 1;
    }
    return stats;
  }
}
