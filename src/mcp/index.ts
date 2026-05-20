/**
 * CodeGraph MCP Server
 *
 * Model Context Protocol server that exposes CodeGraph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'codegraph';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 */

import * as path from 'path';
import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import { watchDisabledReason } from '../sync';
import { StdioTransport, JsonRpcRequest, JsonRpcNotification, ErrorCodes } from './transport';
import { tools, ToolHandler } from './tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';

/**
 * Convert a file:// URI to a filesystem path.
 * Handles URL encoding and Windows drive letter paths.
 */
function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    // On Windows, file:///C:/path produces pathname /C:/path — strip leading /
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return path.resolve(filePath);
  } catch {
    // Fallback for non-standard URIs
    return uri.replace(/^file:\/\/\/?/, '');
  }
}

/**
 * MCP Server Info
 */
const SERVER_INFO = {
  name: 'codegraph',
  version: '0.1.0',
};

/**
 * MCP Protocol Version
 */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * How long to wait for the client's `roots/list` response before giving up
 * and falling back to the process cwd.
 */
const ROOTS_LIST_TIMEOUT_MS = 5000;

/**
 * Extract the first usable filesystem path from a `roots/list` result.
 * Shape per MCP spec: `{ roots: [{ uri: "file:///path", name?: string }] }`.
 * Returns null if the result is empty or malformed.
 */
function firstRootPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const roots = (result as { roots?: unknown }).roots;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const first = roots[0] as { uri?: unknown };
  if (typeof first?.uri !== 'string') return null;
  return fileUriToPath(first.uri);
}

/**
 * MCP Server for CodeGraph
 *
 * Implements the Model Context Protocol to expose CodeGraph
 * functionality as tools that can be called by AI assistants.
 */
export class MCPServer {
  private transport: StdioTransport;
  private cg: CodeGraph | null = null;
  private toolHandler: ToolHandler;
  private projectPath: string | null;
  // In-flight background init kicked off from handleInitialize. Tracked so the
  // sync retry path doesn't race against it (double-opening the SQLite file).
  private initPromise: Promise<void> | null = null;
  // Whether the client advertised the MCP `roots` capability during initialize.
  // If so, and no explicit project path was given, we ask it for the workspace
  // root via roots/list rather than guessing from the (often wrong) cwd.
  private clientSupportsRoots = false;
  // Guards the one-shot deferred resolution (roots/list or cwd) so we don't
  // re-issue roots/list on every tool call.
  private rootsAttempted = false;

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
    this.transport = new StdioTransport();
    // Create ToolHandler eagerly — cross-project queries work even without a default project
    this.toolHandler = new ToolHandler(null);
  }

  /**
   * Start the MCP server
   *
   * Note: CodeGraph initialization is deferred until the initialize request
   * is received, which includes the rootUri from the client.
   */
  async start(): Promise<void> {
    // Start listening for messages immediately - don't check initialization yet
    // We'll get the project path from the initialize request's rootUri
    this.transport.start(this.handleMessage.bind(this));

    // Keep the process running
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());

    // When the parent process (Claude Code) exits, stdin closes.
    // Detect this and shut down gracefully to prevent orphaned processes.
    process.stdin.on('end', () => this.stop());
    process.stdin.on('close', () => this.stop());
  }

  /**
   * Try to initialize CodeGraph for the default project.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   *
   * If initialization fails, the error is recorded but the server continues
   * to work — cross-project queries and retries on subsequent tool calls
   * are still possible.
   */
  private async tryInitializeDefault(projectPath: string): Promise<void> {
    // Record where we searched so a later "not initialized" error can name it.
    this.toolHandler.setDefaultProjectHint(projectPath);

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      this.projectPath = projectPath;
      return;
    }

    this.projectPath = resolvedRoot;

    try {
      this.cg = await CodeGraph.open(resolvedRoot);
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
    } catch (err) {
      // Log the error so transient failures are diagnosable (see issue #47)
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
    }
  }

  /**
   * Retry initialization of the default project if it previously failed.
   * Called lazily on tool calls that need the default project.
   * Re-walks parent directories each time so it picks up projects
   * initialized after the MCP server started.
   *
   * Awaits any in-flight background init (kicked off by handleInitialize) so
   * we never open the SQLite file twice concurrently.
   */
  private async retryInitIfNeeded(): Promise<void> {
    // Wait for the background init started during handleInitialize, if any.
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* errored init falls through to retry */ }
    }

    // Already initialized successfully
    if (this.toolHandler.hasDefaultCodeGraph()) return;

    // No explicit path was given at initialize. Resolve it now, exactly once:
    // ask the client via roots/list (if it advertised roots), else use cwd.
    // Deferring to here lets a roots answer override the wrong cwd, and the
    // one-shot guard means we never re-issue roots/list per tool call.
    if (!this.projectPath && !this.rootsAttempted) {
      this.rootsAttempted = true;
      this.initPromise = (
        this.clientSupportsRoots
          ? this.initFromRoots()
          : this.tryInitializeDefault(process.cwd())
      ).finally(() => { this.initPromise = null; });
      try { await this.initPromise; } catch { /* fall through to last-resort below */ }
      if (this.toolHandler.hasDefaultCodeGraph()) return;
    }

    // Last resort: re-walk from the best candidate we have. Picks up projects
    // initialized after the server started, and covers clients that sent no
    // usable initialize signal at all.
    const candidate = this.projectPath ?? process.cwd();
    this.toolHandler.setDefaultProjectHint(candidate);
    const resolvedRoot = findNearestCodeGraphRoot(candidate);
    if (!resolvedRoot) return;

    try {
      // Close any previously failed instance to avoid leaking resources
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      this.cg = CodeGraph.openSync(resolvedRoot);
      this.projectPath = resolvedRoot;
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
    } catch {
      // Still failing — will retry on next tool call
    }
  }

  /**
   * Resolve the project root via the MCP `roots/list` request and initialize
   * from the first root the client reports. Falls back to the process cwd if
   * the client returns no usable root or doesn't answer in time. See issue #196.
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
    await this.tryInitializeDefault(target);
  }

  /**
   * Start file watching on the active CodeGraph instance.
   * Logs sync activity to stderr for diagnostics.
   */
  private startWatching(): void {
    if (!this.cg) return;

    // When the watcher is intentionally disabled (e.g. WSL2 /mnt drives, or
    // CODEGRAPH_NO_WATCH=1), say so explicitly and tell the user how to keep
    // the graph fresh — otherwise the silent staleness is hard to diagnose.
    const disabledReason = watchDisabledReason(this.projectPath ?? process.cwd());
    if (disabledReason) {
      process.stderr.write(
        `[CodeGraph MCP] File watcher disabled — ${disabledReason}. ` +
        `The graph will not auto-update; run \`codegraph sync\` (or install the git sync hooks via \`codegraph init\`) to refresh.\n`
      );
      return;
    }

    const started = this.cg.watch({
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[CodeGraph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[CodeGraph MCP] Auto-sync error: ${err.message}\n`);
      },
    });

    if (started) {
      process.stderr.write('[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n');
    } else {
      // start() can also return false when recursive fs.watch isn't supported.
      process.stderr.write(
        '[CodeGraph MCP] File watcher unavailable on this platform — run `codegraph sync` to refresh the graph after changes.\n'
      );
    }
  }

  /**
   * Stop the server
   */
  stop(): void {
    // Close all cached cross-project connections first
    this.toolHandler.closeAll();
    // Close the main CodeGraph instance
    if (this.cg) {
      this.cg.close();
      this.cg = null;
    }
    this.transport.stop();
    process.exit(0);
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    // Check if it's a request (has id) or notification (no id)
    const isRequest = 'id' in message;

    switch (message.method) {
      case 'initialize':
        if (isRequest) {
          await this.handleInitialize(message as JsonRpcRequest);
        }
        break;

      case 'initialized':
        // Notification that client has finished initialization
        // No action needed - the client is ready
        break;

      case 'tools/list':
        if (isRequest) {
          await this.handleToolsList(message as JsonRpcRequest);
        }
        break;

      case 'tools/call':
        if (isRequest) {
          await this.handleToolsCall(message as JsonRpcRequest);
        }
        break;

      case 'ping':
        if (isRequest) {
          this.transport.sendResult((message as JsonRpcRequest).id, {});
        }
        break;

      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`
          );
        }
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      rootUri?: string;
      workspaceFolders?: Array<{ uri: string; name: string }>;
      capabilities?: { roots?: unknown };
    } | undefined;

    // Does the client support the MCP `roots` protocol? If so, and we have no
    // explicit path, we ask it for the workspace root after the handshake
    // instead of falling back to the (frequently wrong) cwd. See issue #196.
    this.clientSupportsRoots = !!params?.capabilities?.roots;

    // Explicit project signal, strongest first: a client-provided rootUri /
    // workspaceFolders (LSP-style, non-standard but some clients send it), else
    // the --path the server was launched with. cwd is NOT used here — we defer
    // it so a roots/list answer can win over it.
    let explicitPath: string | null = null;
    if (params?.rootUri) {
      explicitPath = fileUriToPath(params.rootUri);
    } else if (params?.workspaceFolders?.[0]?.uri) {
      explicitPath = fileUriToPath(params.workspaceFolders[0].uri);
    } else if (this.projectPath) {
      explicitPath = this.projectPath;
    }

    // Respond to the handshake BEFORE doing any heavy initialization. Loading
    // the SQLite DB and the tree-sitter WASM runtime can take many seconds on
    // slow filesystems (Docker Desktop VirtioFS on macOS, WSL2). Clients like
    // Claude Code time out the handshake at ~30s, which manifested as
    // "MCP tools never appear" — the child was alive and had received the
    // initialize but was still awaiting initGrammars(). See issue #172.
    //
    // We accept the client's protocol version but respond with our supported
    // version. The `instructions` field is surfaced by MCP clients in the
    // agent's system prompt automatically — it's the right place for the
    // universal tool-selection playbook, ahead of individual tool descriptions.
    this.transport.sendResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    });

    // If we know the project dir, kick off init in the background now. Tool
    // calls that arrive before it finishes fall through to `retryInitIfNeeded`,
    // which waits for this promise rather than racing it with a second open.
    //
    // If we DON'T know it (no rootUri, no --path), defer: the first tool call
    // resolves it via roots/list (when the client supports roots) or cwd. This
    // is the fix for issue #196 — clients that launch the server outside the
    // project and don't pass a rootUri previously got a misleading "not
    // initialized" error on every call.
    if (explicitPath) {
      this.initPromise = this.tryInitializeDefault(explicitPath).finally(() => {
        this.initPromise = null;
      });
    }
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    await this.retryInitIfNeeded();
    this.transport.sendResult(request.id, {
      tools: this.toolHandler.getTools(),
    });
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    if (!params || !params.name) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        'Missing tool name'
      );
      return;
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    // Validate tool exists
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        `Unknown tool: ${toolName}`
      );
      return;
    }

    // If the default project isn't initialized yet, retry in case it was
    // initialized after the MCP server started (e.g. user ran codegraph init)
    await this.retryInitIfNeeded();

    const result = await this.toolHandler.execute(toolName, toolArgs);

    this.transport.sendResult(request.id, result);
  }
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
