/**
 * MCP (Model Context Protocol) Client
 *
 * A lightweight JSON-RPC 2.0 client that communicates with CodeGraph's MCP server
 * over stdio. This avoids importing the heavy CodeGraph core library directly into
 * the VS Code Extension Host, which would fail due to Node.js version constraints
 * (Extension Host runs ~Node 20.x, but CodeGraph requires node:sqlite from Node 22.5+).
 *
 * Instead, we spawn codegraph as a child process and speak the standard MCP protocol.
 *
 * Bug fixes applied:
 * - #2: Send 'initialized' notification after handshake (MCP spec requirement)
 * - #3: Save process reference before nulling in stop() to allow SIGKILL
 * - #4: Reset ready=false on process crash and notify via onCrash callback
 * - D: Handle signal termination (e.g., OOM killer SIGKILL) in close event
 * - E: Prevent concurrent start() calls from spawning duplicate processes
 */

import { ChildProcess, spawn } from 'child_process';

/** JSON-RPC 2.0 Request structure */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 Response structure */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 Notification structure (client-to-server or server-to-client) */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Lightweight MCP client for communicating with CodeGraph's stdio-based MCP server.
 *
 * Lifecycle:
 * 1. Construct with the command path and arguments
 * 2. Call start() to spawn the process and perform MCP handshake
 * 3. Use callTool() to invoke CodeGraph tools
 * 4. Call stop() to gracefully terminate the child process
 *
 * MCP protocol flow:
 * 1. Client sends 'initialize' request → Server responds with capabilities
 * 2. Client sends 'initialized' notification → Server is ready for tool calls
 * 3. Client sends 'tools/call' requests → Server responds with ToolResult
 */
export class McpClient {
  /** The spawned child process handle */
  private process: ChildProcess | null = null;

  /** Monotonically increasing request ID for JSON-RPC correlation */
  private requestId = 0;

  /** Pending request promises, keyed by JSON-RPC id */
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  /** True after successful initialize handshake AND initialized notification sent */
  private ready = false;

  /** Buffer for incomplete JSON-RPC lines (stdio may split messages across chunks) */
  private dataBuffer = '';

  /** Handle for the force-kill timeout in stop(), to prevent leaking timers */
  private killTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bug E fix: Guard against concurrent start() calls.
   * If start() is already in progress, subsequent calls return the same promise
   * instead of spawning a duplicate process.
   */
  private startPromise: Promise<void> | null = null;

  /**
   * Callback invoked when the MCP server process crashes unexpectedly.
   * Used by CodeGraphManager to transition to 'error' state and attempt recovery.
   * Bug #4 fix: previously the manager had no way to detect process crashes.
   */
  public onCrash: ((code: number | null) => void) | null = null;

  /**
   * @param command - Absolute path to the codegraph executable
   * @param args - CLI arguments (e.g., ['serve', '--mcp'])
   * @param cwd - Working directory for the child process (project root)
   */
  constructor(
    private command: string,
    private args: string[] = [],
    private cwd?: string
  ) {}

  /**
   * Start the MCP client by spawning the CodeGraph child process and performing
   * the MCP initialize handshake. This is async because the handshake requires
   * a round-trip with the server.
   *
   * Why spawn instead of import? Because the VS Code Extension Host's Node.js
   * version is too old for CodeGraph's node:sqlite requirement.
   *
   * MCP handshake steps:
   * 1. Send 'initialize' request with client capabilities
   * 2. Wait for server response with capabilities
   * 3. Send 'initialized' notification (Bug #2 fix: this was missing)
   * 4. Mark client as ready for tool calls
   *
   * Bug E fix: Uses startPromise to prevent concurrent calls from
   * spawning duplicate processes. If already ready, returns immediately.
   * If a start is in progress, returns the same promise.
   */
  async start(): Promise<void> {
    // Already fully connected — nothing to do
    if (this.ready) return;

    // Bug E fix: If a start is already in progress, return the same promise.
    // This prevents rapid-fire retry clicks from spawning multiple processes.
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._doStart();

    try {
      await this.startPromise;
    } finally {
      // Clear the guard so a future start() after failure can retry
      this.startPromise = null;
    }
  }

  /**
   * Internal start implementation — separated from the public start()
   * so the concurrency guard can wrap it.
   */
  private async _doStart(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Spawn with stdio pipes so we can read/write JSON-RPC messages
      this.process = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!this.process.stdout || !this.process.stdin) {
        reject(new Error('Failed to spawn process with stdio pipes'));
        return;
      }

      // Handle stdout data: parse JSON-RPC lines
      this.process.stdout.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      // Handle stderr: log for debugging but don't treat as fatal
      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('[CodeGraph stderr]', data.toString().trim());
      });

      // Process-level errors (e.g., executable not found)
      this.process.on('error', (err: Error) => {
        reject(new Error(`Failed to start codegraph: ${err.message}`));
      });

      // Process exit: clean up pending requests and notify manager
      // Bug #4 fix: set ready=false and invoke onCrash callback
      // Bug D fix: Also check the signal parameter — when a process is killed
      // by a signal (e.g., OOM killer sends SIGKILL), code is null but signal
      // has a value. Previously this was treated as a clean exit.
      this.process.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const wasReady = this.ready;
        this.ready = false;

        if (code !== 0 && code !== null) {
          // Non-zero exit code — abnormal termination
          this.rejectPending(new Error(`CodeGraph process exited with code ${code}`));
          if (this.onCrash) {
            this.onCrash(code);
          }
        } else if (signal) {
          // Bug D fix: Process was killed by a signal (e.g., SIGKILL from OOM killer,
          // SIGTERM from system shutdown). code is null in this case.
          // This is always abnormal — treat it as a crash.
          this.rejectPending(new Error(`CodeGraph process killed by signal ${signal}`));
          if (this.onCrash) {
            this.onCrash(code);
          }
        } else if (wasReady) {
          // Clean shutdown (code === 0 or null, no signal) while client was ready.
          // Likely intentional — extension deactivation called stop().
          this.rejectPending(new Error('CodeGraph process closed'));
        }
      });

      // Step 1: Send 'initialize' request with our capabilities
      this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codegraph-vscode', version: '0.9.9' },
      })
        .then(() => {
          // Step 2: Send 'initialized' notification (Bug #2 fix)
          // MCP spec requires this notification after receiving the initialize response.
          // CodeGraph server currently ignores it, but future versions may enforce it.
          this.sendNotification('initialized', {});

          // Step 3: Mark client as ready for tool calls
          this.ready = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Call a CodeGraph MCP tool by name.
   *
   * The MCP protocol returns results in this format:
   * {
   *   content: [{ type: 'text', text: '...' }],
   *   isError?: boolean
   * }
   *
   * Callers should:
   * 1. Check result.isError for error conditions
   * 2. Extract text content from result.content[0].text
   * 3. Parse the text if needed (it's markdown-formatted)
   *
   * @param name - Tool name (e.g., 'codegraph_search', 'codegraph_callers')
   * @param args - Tool arguments object
   * @returns The raw ToolResult from the MCP server
   */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.ready) {
      throw new Error('MCP client not ready. Did you call start()?');
    }
    return this.sendRequest('tools/call', { name, arguments: args });
  }

  /**
   * List all available tools from the CodeGraph MCP server.
   * Useful for dynamic discovery of capabilities.
   */
  async listTools(): Promise<unknown> {
    if (!this.ready) {
      throw new Error('MCP client not ready');
    }
    return this.sendRequest('tools/list', {});
  }

  /**
   * Gracefully stop the client and kill the child process.
   * Called on extension deactivation to prevent orphaned processes.
   *
   * Bug #3 fix: Save the process reference to a local variable before nulling
   * this.process, so the SIGKILL timeout callback can still reference it.
   */
  stop(): void {
    this.rejectPending(new Error('Client stopped'));
    // Cancel any pending force-kill timeout
    if (this.killTimeout) {
      clearTimeout(this.killTimeout);
      this.killTimeout = null;
    }

    // Bug #3 fix: Save process reference before nulling
    // The setTimeout callback for SIGKILL needs access to the process
    // even after this.process is set to null
    const proc = this.process;
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM didn't work (orphan prevention)
      // Uses local 'proc' variable instead of 'this.process' which
      // will be null by the time this callback fires
      this.killTimeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }

    this.process = null;
    this.ready = false;
    // Bug E fix: Clear the start guard so a future start() can retry
    this.startPromise = null;
  }

  /** Send a JSON-RPC request and return a promise for the response */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      if (!this.process?.stdin) {
        this.pending.delete(id);
        reject(new Error('Process stdin not available'));
        return;
      }

      // Write newline-delimited JSON-RPC message
      // Wrap in try-catch because write() throws if the process has crashed
      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        this.pending.delete(id);
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to write to codegraph stdin: ${msg}`));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   * Used for protocol messages like 'initialized' that don't require a reply.
   */
  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      this.process.stdin.write(JSON.stringify(notification) + '\n');
    } catch (err) {
      // Notifications are fire-and-forget per the JSON-RPC spec,
      // so we log errors but don't throw
      console.error('[CodeGraph] Failed to send notification:', err);
    }
  }

  /**
   * Handle incoming data from the child process stdout.
   * Handles line buffering because a single 'data' event may contain
   * partial lines or multiple JSON-RPC messages.
   */
  private handleData(chunk: string): void {
    this.dataBuffer += chunk;
    const lines = this.dataBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.dataBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);
        if ('id' in message && (message.result !== undefined || message.error !== undefined)) {
          this.handleResponse(message as JsonRpcResponse);
        }
        // Notifications from server can be handled here in future
      } catch {
        // Ignore malformed JSON lines (e.g., log output)
      }
    }
  }

  /** Match a JSON-RPC response to its pending request promise */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /** Reject all pending requests with a given error (used on shutdown) */
  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}