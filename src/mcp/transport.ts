/**
 * MCP JSON-RPC Transports
 *
 * Two flavors share the same wire format (newline-delimited JSON-RPC 2.0):
 *
 * - `StdioTransport` — original transport; reads/writes the process's
 *   stdin/stdout. Used by direct-mode MCP servers.
 * - `SocketTransport` — wraps a single `net.Socket`. Used by the shared-daemon
 *   architecture (see {@link ./daemon}) to multiplex multiple MCP clients onto
 *   one CodeGraph instance via per-connection sessions.
 *
 * Both implement {@link JsonRpcTransport} so the session-level protocol logic
 * (initialize / tools/list / tools/call, plus server-initiated `roots/list`)
 * is identical regardless of where the bytes come from.
 */

import * as readline from 'readline';
import type { Socket } from 'net';

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 Response
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// Standard JSON-RPC error codes
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type MessageHandler = (message: JsonRpcRequest | JsonRpcNotification) => Promise<void>;

/**
 * Generic JSON-RPC transport interface — common surface for stdio and socket
 * carriers. Anything below the session layer (initialize, tool dispatch, etc.)
 * talks to this, not to a concrete transport class.
 */
export interface JsonRpcTransport {
  start(handler: MessageHandler): void;
  stop(): void;
  send(response: JsonRpcResponse): void;
  notify(method: string, params?: unknown): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  sendResult(id: string | number, result: unknown): void;
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void;
}

/**
 * Shared implementation of newline-delimited JSON-RPC 2.0 over any
 * `Readable`/`Writable` stream pair. Stdio and socket transports both wrap
 * this — the only difference between them is which streams get plugged in
 * and how a "close" propagates back to the owning code.
 */
abstract class LineBasedJsonRpcTransport implements JsonRpcTransport {
  protected messageHandler: MessageHandler | null = null;
  // Outstanding server-initiated requests (e.g. roots/list), keyed by the id
  // we sent. Responses from the client are matched back here.
  protected pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  protected nextRequestId = 1;
  protected stopped = false;

  abstract start(handler: MessageHandler): void;
  protected abstract write(line: string): void;
  protected abstract idPrefix(): string;
  abstract stop(): void;

  /**
   * Send a server-initiated request to the client and await its response.
   *
   * MCP is bidirectional: the server can ask the client questions too. We use
   * this for `roots/list` — the spec-blessed way to learn the workspace root
   * when the client didn't pass one in `initialize` (see issue #196). Rejects
   * on timeout so callers can fall back rather than hang forever.
   */
  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = `${this.idPrefix()}-${this.nextRequestId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${method}" response`));
      }, timeoutMs);
      // Don't let a pending request keep the process alive on shutdown.
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  send(response: JsonRpcResponse): void {
    this.write(JSON.stringify(response));
  }

  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(JSON.stringify(notification));
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  /**
   * Fail any in-flight server-initiated requests so their awaiters don't hang.
   * Called from `stop()` in subclasses.
   */
  protected rejectPending(reason: string): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Handle an incoming line of JSON. Both transports feed lines here.
   */
  protected async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.sendError(null, ErrorCodes.ParseError, 'Parse error: invalid JSON');
      return;
    }

    // Response to a server-initiated request (has id + result/error, no method).
    // Route it to the awaiting requester instead of the message handler — these
    // used to be dropped as "Invalid Request" because they carry no method.
    const obj = parsed as Record<string, unknown>;
    if (
      obj?.jsonrpc === '2.0' &&
      typeof obj.method !== 'string' &&
      'id' in obj &&
      ('result' in obj || 'error' in obj)
    ) {
      this.handleResponse(obj);
      return;
    }

    // Validate basic JSON-RPC structure
    if (!this.isValidMessage(parsed)) {
      this.sendError(null, ErrorCodes.InvalidRequest, 'Invalid Request: not a valid JSON-RPC 2.0 message');
      return;
    }

    if (this.messageHandler) {
      try {
        await this.messageHandler(parsed as JsonRpcRequest | JsonRpcNotification);
      } catch (err) {
        const message = parsed as JsonRpcRequest;
        if ('id' in message) {
          this.sendError(
            message.id,
            ErrorCodes.InternalError,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  /**
   * Resolve (or reject) the pending server-initiated request matching this
   * response's id. Unknown ids are ignored — the client may echo something we
   * never sent, or a request may have already timed out.
   */
  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as string | number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ('error' in msg && msg.error) {
      const err = msg.error as { message?: string };
      pending.reject(new Error(err.message || 'Request failed'));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Check if message is a valid JSON-RPC 2.0 message
   */
  private isValidMessage(msg: unknown): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj.jsonrpc !== '2.0') return false;
    if (typeof obj.method !== 'string') return false;
    return true;
  }
}

export interface StdioTransportOptions {
  /**
   * If true, the transport calls `process.exit(0)` when stdin closes. Set to
   * `false` in shared-daemon mode where the stdio "session" is just *one* of
   * many clients — losing it shouldn't drag the daemon down. The default
   * (true) matches the original single-process behavior callers rely on.
   */
  exitOnClose?: boolean;
  /**
   * Optional callback fired when the stdin stream closes. The daemon uses
   * this to decrement its connected-clients refcount.
   */
  onClose?: () => void;
}

/**
 * Stdio Transport for MCP
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout. Used by
 * the direct (single-process) MCP server path, where the MCP host launches
 * one server per session and talks to it over the child's stdio. Also used by
 * shared-daemon mode for the launcher's session (with `exitOnClose: false`)
 * so the daemon outlives its launcher.
 */
export class StdioTransport extends LineBasedJsonRpcTransport {
  private rl: readline.Interface | null = null;
  private opts: Required<StdioTransportOptions>;

  constructor(opts: StdioTransportOptions = {}) {
    super();
    this.opts = {
      exitOnClose: opts.exitOnClose ?? true,
      onClose: opts.onClose ?? (() => { /* no-op */ }),
    };
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      await this.handleLine(line);
    });

    this.rl.on('close', () => {
      this.opts.onClose();
      if (this.opts.exitOnClose) {
        process.exit(0);
      }
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Transport stopped');
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  protected write(line: string): void {
    process.stdout.write(line + '\n');
  }

  protected idPrefix(): string {
    return 'cg-srv';
  }
}

/**
 * Socket Transport for MCP daemon sessions.
 *
 * Wraps a single `net.Socket` (Unix domain socket on POSIX, named pipe on
 * Windows). One instance per connected MCP client. Unlike {@link StdioTransport},
 * `stop()` and stream-close *don't* call `process.exit` — a daemon-side session
 * ending must not bring down the whole daemon.
 */
export class SocketTransport extends LineBasedJsonRpcTransport {
  private buffer = '';
  private closeHandlers: Array<() => void> = [];

  constructor(private socket: Socket, private prefix: string = 'cg-sock') {
    super();
  }

  /**
   * Register a callback fired exactly once when the socket closes (from either
   * side). Used by the daemon to decrement its connected-clients refcount.
   */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx;
      // Drain every complete line; tail-fragment stays in the buffer for the
      // next chunk. The handler is async but we don't await it here — JSON-RPC
      // permits out-of-order responses, and serializing here would deadlock if
      // a handler issued a server-initiated request that needed a *later* line
      // to arrive (e.g. roots/list mid-tools-call).
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        void this.handleLine(line);
      }
    });

    this.socket.on('close', () => this.handleSocketClose());
    this.socket.on('error', (err) => {
      // Don't crash the daemon over a broken pipe; just shut this connection.
      process.stderr.write(`[CodeGraph daemon] socket error: ${err.message}\n`);
      this.handleSocketClose();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Transport stopped');
    if (!this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
  }

  /**
   * Write a one-shot line directly to the socket (no JSON-RPC framing applied
   * by this class — caller produces the line). The daemon uses this for the
   * hello/handshake line that precedes the JSON-RPC stream.
   */
  writeRaw(line: string): void {
    if (!this.socket.destroyed) {
      this.socket.write(line.endsWith('\n') ? line : line + '\n');
    }
  }

  protected write(line: string): void {
    if (!this.socket.destroyed) {
      this.socket.write(line + '\n');
    }
  }

  protected idPrefix(): string {
    return this.prefix;
  }

  private handleSocketClose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Socket closed');
    for (const h of this.closeHandlers) {
      try { h(); } catch { /* never let a close-handler take the daemon down */ }
    }
    this.closeHandlers = [];
  }
}
