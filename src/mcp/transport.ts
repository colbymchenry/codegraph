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
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
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
