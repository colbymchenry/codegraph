/**
 * MCP Stdio Transport
 *
 * Handles JSON-RPC 2.0 communication over stdin/stdout for MCP protocol.
 */

import * as readline from 'readline';

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
 * Stdio Transport for MCP
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 */
export class StdioTransport {
  private rl: readline.Interface | null = null;
  private messageHandler: MessageHandler | null = null;
  // Outstanding server-initiated requests (e.g. roots/list), keyed by the id
  // we sent. Responses from the client are matched back here.
  private pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextRequestId = 1;

  /**
   * Start listening for messages on stdin
   */
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
      process.exit(0);
    });
  }

  /**
   * Stop listening
   */
  stop(): void {
    // Fail any in-flight server-initiated requests so their awaiters don't hang.
    for (const { reject } of this.pending.values()) {
      reject(new Error('Transport stopped'));
    }
    this.pending.clear();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Send a server-initiated request to the client and await its response.
   *
   * MCP is bidirectional: the server can ask the client questions too. We use
   * this for `roots/list` — the spec-blessed way to learn the workspace root
   * when the client didn't pass one in `initialize` (see issue #196). Rejects
   * on timeout so callers can fall back rather than hang forever.
   */
  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = `cg-srv-${this.nextRequestId++}`;
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
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /**
   * Send a response
   */
  send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }

  /**
   * Send a notification (no id)
   */
  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }

  /**
   * Send a success response
   */
  sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Send an error response
   */
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    });
  }

  /**
   * Handle an incoming line of JSON
   */
  private async handleLine(line: string): Promise<void> {
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
