/**
 * MCP per-connection session — speaks the JSON-RPC protocol (initialize,
 * tools/list, tools/call) over a single {@link JsonRpcTransport}. It owns
 * per-client state only (which protocol version the client asked for, whether
 * it advertised `roots`, the one-shot roots/list latch); the heavyweight
 * resources (CodeGraph, watcher, ToolHandler) live in the shared
 * {@link MCPEngine} so daemon mode can collapse N inotify sets / DB handles
 * to one.
 *
 * The state-machine itself mirrors what `MCPServer` used to do inline before
 * issue #411 split it out — the same regression tests in
 * `__tests__/mcp-initialize.test.ts` still drive this code path.
 */

import * as path from 'path';
import { JsonRpcRequest, JsonRpcNotification, JsonRpcTransport, ErrorCodes } from './transport';
import { MCPEngine } from './engine';
import { tools } from './tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { CodeGraphPackageVersion } from './version';

/**
 * MCP Server Info — kept on the session because some clients log it. The
 * version tracks the real package version (was a hard-coded '0.1.0').
 */
// Exported so the proxy can answer `initialize` locally with the IDENTICAL
// payload the daemon would send — no drift between the two handshake paths.
export const SERVER_INFO = {
  name: 'codegraph',
  version: CodeGraphPackageVersion,
};

/** MCP Protocol Version (latest the server claims). */
export const PROTOCOL_VERSION = '2024-11-05';

/**
 * How long to wait for the client's `roots/list` response before giving up
 * and falling back to the process cwd.
 */
const ROOTS_LIST_TIMEOUT_MS = 5000;

/**
 * Convert a file:// URI to a filesystem path. Handles URL encoding and
 * Windows drive letter paths.
 */
function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return path.resolve(filePath);
  } catch {
    return uri.replace(/^file:\/\/\/?/, '');
  }
}

/** First usable filesystem path from a `roots/list` result, or null. */
function firstRootPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const roots = (result as { roots?: unknown }).roots;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const first = roots[0] as { uri?: unknown };
  if (typeof first?.uri !== 'string') return null;
  return fileUriToPath(first.uri);
}

export interface MCPSessionOptions {
  /**
   * Explicit project path from the `--path` CLI flag. When set, the session
   * will not bother asking the client for `roots/list` — we already know
   * where the project lives.
   */
  explicitProjectPath?: string | null;
}

/**
 * One MCP client's view of the server. Created fresh per stdio launch
 * (direct mode) or per socket connection (daemon mode).
 */
export class MCPSession {
  private clientSupportsRoots = false;
  private rootsAttempted = false;
  private resolvePromise: Promise<void> | null = null;
  private explicitProjectPath: string | null;

  constructor(
    private transport: JsonRpcTransport,
    private engine: MCPEngine,
    opts: MCPSessionOptions = {},
  ) {
    this.explicitProjectPath = opts.explicitProjectPath ?? null;
  }

  /**
   * Start handling messages from the transport. Returns immediately — the
   * session lives for as long as the transport is open.
   */
  start(): void {
    this.transport.start(this.handleMessage.bind(this));
  }

  /**
   * Tear down the session. Does NOT touch the engine (the engine may serve
   * other sessions) or call `process.exit` (the daemon decides when to exit).
   */
  stop(): void {
    this.transport.stop();
  }

  /** Underlying transport — exposed for daemon-side close hooks. */
  getTransport(): JsonRpcTransport {
    return this.transport;
  }

  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const isRequest = 'id' in message;
    switch (message.method) {
      case 'initialize':
        if (isRequest) await this.handleInitialize(message as JsonRpcRequest);
        break;
      case 'initialized':
        // Notification that client has finished initialization — no action needed.
        break;
      case 'tools/list':
        if (isRequest) await this.handleToolsList(message as JsonRpcRequest);
        break;
      case 'tools/call':
        if (isRequest) await this.handleToolsCall(message as JsonRpcRequest);
        break;
      case 'ping':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, {});
        break;
      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`,
          );
        }
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      rootUri?: string;
      workspaceFolders?: Array<{ uri: string; name: string }>;
      capabilities?: { roots?: unknown };
    } | undefined;

    this.clientSupportsRoots = !!params?.capabilities?.roots;

    // Explicit project signal, strongest first: client-provided rootUri /
    // workspaceFolders (LSP-style), else the --path the server was launched
    // with. cwd is NOT used here — we defer it so a roots/list answer can
    // win over it. See issue #196.
    let explicitPath: string | null = null;
    if (params?.rootUri) {
      explicitPath = fileUriToPath(params.rootUri);
    } else if (params?.workspaceFolders?.[0]?.uri) {
      explicitPath = fileUriToPath(params.workspaceFolders[0].uri);
    } else if (this.explicitProjectPath) {
      explicitPath = this.explicitProjectPath;
    }

    // Respond to the handshake BEFORE doing any heavy init — see issue #172.
    this.transport.sendResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    });

    if (explicitPath) {
      // Kick off engine init in the background. If another session in the
      // same daemon already opened the project, `ensureInitialized` is a
      // ~free no-op — N concurrent clients pay exactly one open.
      this.resolvePromise = this.engine.ensureInitialized(explicitPath);
    }
  }

  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    await this.retryInitIfNeeded();
    this.transport.sendResult(request.id, {
      tools: this.engine.getToolHandler().getTools(),
    });
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    if (!params || !params.name) {
      this.transport.sendError(request.id, ErrorCodes.InvalidParams, 'Missing tool name');
      return;
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        `Unknown tool: ${toolName}`,
      );
      return;
    }

    await this.retryInitIfNeeded();

    const result = await this.engine.getToolHandler().execute(toolName, toolArgs);
    this.transport.sendResult(request.id, result);
  }

  /**
   * Lazy default-project resolution. Three layers:
   *   1. await the in-flight init kicked off from `handleInitialize` (if any);
   *   2. if still uninitialized and we never asked the client for its roots,
   *      do so now (one-shot); fall back to cwd if the client lacks roots;
   *   3. last-resort: re-walk from the best candidate — picks up projects
   *      that were `codegraph init`'d *after* the server started.
   */
  private async retryInitIfNeeded(): Promise<void> {
    if (this.resolvePromise) {
      try { await this.resolvePromise; } catch { /* fall through to retry */ }
      this.resolvePromise = null;
    }

    if (this.engine.hasDefaultCodeGraph()) return;

    const hint = this.explicitProjectPath ?? this.engine.getProjectPath();
    if (!hint && !this.rootsAttempted) {
      this.rootsAttempted = true;
      this.resolvePromise = this.clientSupportsRoots
        ? this.initFromRoots()
        : this.engine.ensureInitialized(process.cwd());
      try { await this.resolvePromise; } catch { /* fall through */ }
      this.resolvePromise = null;
      if (this.engine.hasDefaultCodeGraph()) return;
    }

    // Last resort: walk from the best candidate (sync open). Picks up
    // projects that appeared after the server started.
    const candidate = hint ?? process.cwd();
    this.engine.retryInitializeSync(candidate);
  }

  /**
   * Ask the client for its workspace root via `roots/list` and open the
   * first one. Falls back to `process.cwd()` on timeout or empty answer.
   */
  private async initFromRoots(): Promise<void> {
    let target = process.cwd();
    try {
      const result = await this.transport.request('roots/list', undefined, ROOTS_LIST_TIMEOUT_MS);
      const rootPath = firstRootPath(result);
      if (rootPath) {
        target = rootPath;
      } else {
        process.stderr.write('[CodeGraph MCP] Client returned no workspace roots; falling back to process cwd.\n');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] roots/list request failed (${msg}); falling back to process cwd.\n`);
    }
    await this.engine.ensureInitialized(target);
  }
}
