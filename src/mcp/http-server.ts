import * as http from 'http';
import type { AddressInfo } from 'net';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import {
  ErrorCodes,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcTransport,
  MessageHandler,
} from './transport';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ENDPOINT = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

interface PendingResult {
  status: number;
  body: JsonRpcResponse | null;
}

class SingleRequestHttpTransport implements JsonRpcTransport {
  private response: JsonRpcResponse | null = null;
  private done: Promise<PendingResult>;
  private resolveDone!: (result: PendingResult) => void;
  private settled = false;

  constructor(private message: JsonRpcRequest | JsonRpcNotification) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(handler: MessageHandler): void {
    void this.run(handler);
  }

  stop(): void {
    this.finish();
  }

  send(response: JsonRpcResponse): void {
    this.response = response;
  }

  notify(_method: string, _params?: unknown): void {
    // The minimal Streamable HTTP mode does not keep a server-to-client stream.
  }

  request(method: string, _params?: unknown, _timeoutMs?: number): Promise<unknown> {
    return Promise.reject(new Error(`Server-initiated request "${method}" is not available over JSON HTTP responses`));
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  result(): Promise<PendingResult> {
    return this.done;
  }

  private async run(handler: MessageHandler): Promise<void> {
    try {
      await handler(this.message);
    } catch (err) {
      if ('id' in this.message) {
        this.sendError(
          this.message.id,
          ErrorCodes.InternalError,
          `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone({
      status: this.response ? 200 : 202,
      body: this.response,
    });
  }
}

export interface MCPHttpServerOptions {
  projectPath?: string;
  host?: string;
  port?: number;
  endpoint?: string;
}

export class MCPHttpServer {
  private server: http.Server | null = null;
  private engine = new MCPEngine();
  private endpoint: string;
  private host: string;
  private port: number;
  private projectPath: string;

  constructor(options: MCPHttpServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? 0;
    this.endpoint = normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.projectPath = options.projectPath ?? process.cwd();
  }

  async start(): Promise<string> {
    this.engine.setProjectPathHint(this.projectPath);
    void this.engine.ensureInitialized(this.projectPath);

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    const address = this.server.address() as AddressInfo;
    return `http://${formatHost(this.host)}:${address.port}${this.endpoint}`;
  }

  stop(): void {
    this.engine.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isEndpoint(req.url)) {
      writeText(res, 404, 'Not Found');
      return;
    }

    if (!originAllowed(req.headers.origin)) {
      writeJson(res, 403, jsonRpcError(null, ErrorCodes.InvalidRequest, 'Forbidden: invalid Origin header'));
      return;
    }

    if (req.method === 'GET') {
      writeText(res, 405, 'Method Not Allowed', { Allow: 'POST' });
      return;
    }

    if (req.method !== 'POST') {
      writeText(res, 405, 'Method Not Allowed', { Allow: 'POST' });
      return;
    }

    if (!acceptsStreamableHttp(req.headers.accept)) {
      writeJson(res, 406, jsonRpcError(null, ErrorCodes.InvalidRequest, 'Not Acceptable: expected application/json and text/event-stream'));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(res, 413, jsonRpcError(null, ErrorCodes.InvalidRequest, message));
      return;
    }

    const message = parseJsonRpcMessage(body);
    if (!message.ok) {
      writeJson(res, 400, jsonRpcError(null, message.code, message.message));
      return;
    }

    if (!('method' in message.value)) {
      writeEmpty(res, 202);
      return;
    }

    if (!('id' in message.value)) {
      const transport = new SingleRequestHttpTransport(message.value);
      const session = new MCPSession(transport, this.engine, { explicitProjectPath: this.projectPath });
      session.start();
      await transport.result();
      writeEmpty(res, 202);
      return;
    }

    const transport = new SingleRequestHttpTransport(message.value);
    const session = new MCPSession(transport, this.engine, { explicitProjectPath: this.projectPath });
    session.start();
    const result = await transport.result();
    if (!result.body) {
      writeJson(res, 500, jsonRpcError(message.value.id, ErrorCodes.InternalError, 'Request produced no response'));
      return;
    }
    writeJson(res, result.status, result.body);
  }

  private isEndpoint(rawUrl: string | undefined): boolean {
    if (!rawUrl) return false;
    const path = rawUrl.split('?', 1)[0] || '/';
    return path === this.endpoint;
  }
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint.startsWith('/')) return `/${endpoint}`;
  return endpoint;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function acceptsStreamableHttp(accept: string | undefined): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return lower.includes('application/json') && lower.includes('text/event-stream');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

type ParseResult =
  | { ok: true; value: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse }
  | { ok: false; code: number; message: string };

function parseJsonRpcMessage(body: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, code: ErrorCodes.ParseError, message: 'Parse error: invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: ErrorCodes.InvalidRequest, message: 'Invalid Request: not a JSON-RPC object' };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    return { ok: false, code: ErrorCodes.InvalidRequest, message: 'Invalid Request: not a valid JSON-RPC 2.0 message' };
  }

  if (typeof obj.method === 'string') {
    return { ok: true, value: obj as unknown as JsonRpcRequest | JsonRpcNotification };
  }

  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    return { ok: true, value: obj as unknown as JsonRpcResponse };
  }

  return { ok: false, code: ErrorCodes.InvalidRequest, message: 'Invalid Request: not a valid JSON-RPC 2.0 message' };
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function writeJson(res: http.ServerResponse, status: number, body: JsonRpcResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeEmpty(res: http.ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function writeText(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
