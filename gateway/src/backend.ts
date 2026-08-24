import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  BackendConfig,
  SseBackendConfig,
  HttpBackendConfig,
} from "./config.js";
import type { Logger } from "./logger.js";

export type BackendStatus =
  | "starting"
  | "connected"
  | "disconnected"
  | "error"
  | "disabled";

export interface BackendInfo {
  name: string;
  config: BackendConfig;
  status: BackendStatus;
  tools: Tool[];
  error?: string;
  restartCount: number;
  lastConnected?: Date;
}

export class BackendInstance {
  readonly name: string;
  readonly config: BackendConfig;
  private client: Client | null = null;
  private transport: SSEClientTransport | StreamableHTTPClientTransport | null = null;
  private _status: BackendStatus = "disconnected";
  private _tools: Tool[] = [];
  private _error?: string;
  private _restartCount = 0;
  private _consecutiveFailures = 0;
  private _lastFailureAt?: number;
  private _lastConnected?: Date;
  private logger: Logger;
  private onToolsChanged?: () => void;
  private connectionGeneration = 0;
  // Handle for the pending reconnect timer scheduled by handleDisconnect().
  // Stored so disconnect() can cancel it: an uncancelled timer fires ~reconnect_interval
  // later and calls connect() (bumping its own connectionGeneration, so the generation
  // guard misses it), which re-registers a removed backend's tools. See STAB-2 resurrection bug.
  private _reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    name: string,
    config: BackendConfig,
    logger: Logger,
    onToolsChanged?: () => void
  ) {
    if (config.transport !== "http" && config.transport !== "sse") {
      throw new Error(
        `TransportViolation: backend "${name}" declares unsupported transport "${(config as { transport?: string }).transport}" — only streamable-http and sse are representable`
      );
    }
    this.name = name;
    this.config = config;
    this.logger = logger;
    this.onToolsChanged = onToolsChanged;
  }

  get status(): BackendStatus {
    return this._status;
  }
  get tools(): Tool[] {
    return this._tools;
  }
  get error(): string | undefined {
    return this._error;
  }
  get restartCount(): number {
    return this._restartCount;
  }

  /**
   * Consecutive failed connect attempts, counted separately from _restartCount
   * (STAB-8).
   *
   * _restartCount only ever counted drops FROM a connected state, because it is
   * incremented in handleDisconnect, which fires from transport.onclose. A
   * backend that has never connected therefore keeps _restartCount at 0
   * forever, its max_restarts cap never engages, and the health monitor retries
   * it every 30 seconds indefinitely. With 19 permanently dead backends that is
   * 19 pointless connect attempts a minute, forever. This counter is what the
   * retry backoff is computed from, so it must count EVERY failed attempt,
   * whether or not the backend was ever up.
   */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /** Epoch ms of the most recent failed connect, or undefined if none. */
  get lastFailureAt(): number | undefined {
    return this._lastFailureAt;
  }
  get lastConnected(): Date | undefined {
    return this._lastConnected;
  }

  getInfo(): BackendInfo {
    return {
      name: this.name,
      config: this.config,
      status: this._status,
      tools: this._tools,
      error: this._error,
      restartCount: this._restartCount,
      lastConnected: this._lastConnected,
    };
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this._status = "disabled";
      return;
    }

    const generation = ++this.connectionGeneration;
    this._status = "starting";
    this._error = undefined;

    // STAB-6: close any prior client/transport pair BEFORE replacing it below.
    // connect() assigns fresh objects to this.client and this.transport, so a
    // caller that reaches connect() without a preceding disconnect() (the
    // handleDisconnect reconnect timer does exactly that) silently orphaned the
    // previous pair: its socket stayed open and its onerror/onclose handlers
    // stayed wired, so it could never be collected. That leak was masked while
    // the gateway was crash-looping every four minutes; with the crash fixed it
    // would accumulate instead. Best-effort: a teardown failure on an already
    // dead transport must never block the new connection attempt.
    await this.closeActiveTransport();

    try {
      this.client = new Client(
        { name: `mcp-gateway/${this.name}`, version: "1.0.0" },
        { capabilities: {} }
      );

      if (this.config.transport === "http") {
        await this.connectHttp(this.config);
      } else {
        await this.connectSse(this.config);
      }

      if (generation !== this.connectionGeneration || !this.client || this._status !== "starting") {
        throw new Error(`Connection was cancelled for backend "${this.name}"`);
      }

      // Fetch tools
      const toolsResult = await this.client.listTools();
      if (generation !== this.connectionGeneration || !this.client || this._status !== "starting") {
        throw new Error(`Connection was cancelled for backend "${this.name}"`);
      }
      this._tools = toolsResult.tools;
      this._status = "connected";
      this._lastConnected = new Date();
      // STAB-1: a successful reconnect must refund the restart budget. Otherwise a backend
      // that flaps and recovers repeatedly accumulates _restartCount across every recovery
      // and is eventually abandoned at max_restarts even though every reconnect worked.
      this._restartCount = 0;
      // STAB-8: a success also clears the backoff, so a backend that recovers is
      // retried promptly again if it drops later rather than inheriting the
      // long delay it had earned while it was down.
      this._consecutiveFailures = 0;
      this._lastFailureAt = undefined;
      this.logger.info(
        `Backend "${this.name}" connected — ${this._tools.length} tools available`
      );
    } catch (err) {
      if (generation === this.connectionGeneration) {
        this._status = "error";
        this._error = err instanceof Error ? err.message : String(err);
        // STAB-8: record the failure for the retry backoff. Counted here (in
        // connect) rather than in handleDisconnect so it covers backends that
        // have NEVER connected, which is the whole population this backoff
        // exists for.
        this._consecutiveFailures++;
        this._lastFailureAt = Date.now();
        this.logger.error(
          `Backend "${this.name}" failed to connect: ${this._error}`
        );
      }
      throw err;
    }
  }

  private async connectSse(config: SseBackendConfig): Promise<void> {
    const url = new URL(config.url);
    const headers: Record<string, string> = { ...config.headers };
    this.transport = new SSEClientTransport(url, {
      requestInit: {
        headers,
      },
    });

    this.transport.onclose = () => {
      if (this._status === "connected") {
        this.logger.warn(`Backend "${this.name}" SSE connection closed`);
        this._status = "disconnected";
        this.handleDisconnect();
      }
    };

    this.transport.onerror = (err) => {
      this.logger.error(`Backend "${this.name}" SSE error: ${err.message}`);
      this._error = err.message;
    };

    await this.client!.connect(this.transport);
  }

  private async connectHttp(config: HttpBackendConfig): Promise<void> {
    const url = new URL(config.url);
    const headers: Record<string, string> = { ...config.headers };
    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers,
      },
    });

    this.transport.onclose = () => {
      if (this._status === "connected") {
        this.logger.warn(`Backend "${this.name}" HTTP connection closed`);
        this._status = "disconnected";
        this.handleDisconnect();
      }
    };

    this.transport.onerror = (err) => {
      this.logger.error(`Backend "${this.name}" HTTP error: ${err.message}`);
      this._error = err.message;
    };

    await this.client!.connect(this.transport);
  }

  private handleDisconnect(): void {
    const policy = this.config.restart_policy;
    const maxRestarts = this.config.max_restarts;

    if (
      policy === "never" ||
      (policy === "on-failure" && this._restartCount >= maxRestarts)
    ) {
      this.logger.warn(
        `Backend "${this.name}" will not be restarted (policy: ${policy}, restarts: ${this._restartCount}/${maxRestarts})`
      );
      return;
    }

    this._restartCount++;
    const delay = this.config.reconnect_interval;
    this.logger.info(
      `Backend "${this.name}" reconnecting in ${delay}s (attempt ${this._restartCount})`
    );

    // STAB-2: clear any prior pending reconnect before scheduling a new one so overlapping
    // timers do not leak, and store the handle so disconnect() can cancel it. Without this,
    // a backend removed during config reload fires its stale timer and resurrects itself.
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = undefined;
      try {
        await this.connect();
        this.onToolsChanged?.();
      } catch {
        // Error already logged in connect()
      }
    }, delay * 1000);
  }

  /** Call a tool on this backend */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.client || this._status !== "connected") {
      throw new Error(`Backend "${this.name}" is not connected`);
    }
    return this.client.callTool({ name: toolName, arguments: args });
  }

  /** List resources from this backend */
  async listResources() {
    if (!this.client || this._status !== "connected") return [];
    try {
      const result = await this.client.listResources();
      return result.resources;
    } catch {
      return [];
    }
  }

  /** Read a resource from this backend */
  async readResource(uri: string) {
    if (!this.client || this._status !== "connected") {
      throw new Error(`Backend "${this.name}" is not connected`);
    }
    return this.client.readResource({ uri });
  }

  /** List prompts from this backend */
  async listPrompts() {
    if (!this.client || this._status !== "connected") return [];
    try {
      const result = await this.client.listPrompts();
      return result.prompts;
    } catch {
      return [];
    }
  }

  /** Get a prompt from this backend */
  async getPrompt(name: string, args?: Record<string, string>) {
    if (!this.client || this._status !== "connected") {
      throw new Error(`Backend "${this.name}" is not connected`);
    }
    return this.client.getPrompt({ name, arguments: args });
  }

  /**
   * Close and drop the current client/transport pair, if any (STAB-6).
   *
   * Shared by connect() (before it installs a replacement) and disconnect().
   * Best-effort by contract: closing an already-dead transport throws in some
   * SDK paths, and that must never prevent the caller from proceeding. Clearing
   * the fields matters as much as the close: a retained reference keeps the
   * socket and its handlers alive even after close().
   */
  private async closeActiveTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    if (!transport) return;
    try {
      await transport.close();
    } catch {
      // ignore close errors; the pair is being discarded either way
    }
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration++;
    // STAB-2: cancel any pending reconnect timer. A timer left running after disconnect()
    // fires ~reconnect_interval later and calls connect(), which bumps its own
    // connectionGeneration (so the generation guard above cannot catch it) and re-registers
    // a removed backend's tools via onToolsChanged. Cancelling here kills that resurrection.
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._status = "disconnected";
    await this.closeActiveTransport();
    this._tools = [];
  }

  async restart(): Promise<void> {
    this.logger.info(`Restarting backend "${this.name}"...`);
    await this.disconnect();
    await this.connect();
  }

  /** Reset the restart budget to zero (explicit operator action, e.g. /admin/enable). */
  resetRestartBudget(): void {
    this._restartCount = 0;
  }
}
