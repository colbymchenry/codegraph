/**
 * Streamable HTTP MCP transport.
 *
 * This is intentionally small and dependency-free: CodeGraph already owns its
 * JSON-RPC/session layer, so HTTP only adapts one POST body to one JSON-RPC
 * response. We return application/json responses and 405 GET, which is the
 * spec's "no standalone SSE stream" path.
 */

import * as http from 'http';
import { randomUUID } from 'crypto';
import { MCPEngine, type MCPEngineOptions } from './engine';
import { MCPSession } from './session';
import {
  ErrorCodes,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
  type MessageHandler,
} from './transport';
import { getTelemetry } from '../telemetry';
import { checkForUpdateInBackground } from '../upgrade/update-check';
import { installMainThreadWatchdog, type WatchdogHandle } from './liveness-watchdog';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ENDPOINT = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export interface HttpMCPServerOptions {
  projectPath?: string | null;
  host?: string;
  port?: number;
  endpoint?: string;
  token?: string;
  allowOrigins?: string[];
  maxBodyBytes?: number;
  engineOptions?: MCPEngineOptions;
}

export interface HttpMCPServerAddress {
  host: string;
  port: number;
  endpoint: string;
  url: string;
}

interface HttpSession {
  id: string;
  transport: HttpJsonRpcTransport;
  session: MCPSession;
}

export class HttpMCPServer {
  private server: http.Server | null = null;
  private engine: MCPEngine;
  private sessions = new Map<string, HttpSession>();
  private livenessWatchdog: WatchdogHandle | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly endpoint: string;
  private readonly token: string | undefined;
  private readonly allowOrigins: string[];
  private readonly maxBodyBytes: number;

  constructor(private opts: HttpMCPServerOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? 3333;
    this.endpoint = normalizeEndpoint(opts.endpoint ?? DEFAULT_ENDPOINT);
    this.token = opts.token;
    this.allowOrigins = opts.allowOrigins ?? [];
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.engine = new MCPEngine(opts.engineOptions);
    if (opts.projectPath) {
      this.engine.setProjectPathHint(opts.projectPath);
    }
  }

  async start(): Promise<HttpMCPServerAddress> {
    if (this.server) return this.address();

    if (!isLoopbackHost(this.host) && !this.token) {
      throw new Error('HTTP MCP on a non-loopback host requires --token or CODEGRAPH_MCP_HTTP_TOKEN');
    }

    getTelemetry().startInterval();
    checkForUpdateInBackground();

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

    if (this.opts.projectPath) {
      void this.engine.ensureInitialized(this.opts.projectPath);
    }
    this.livenessWatchdog = installMainThreadWatchdog();
    process.stderr.write(`[CodeGraph MCP] HTTP listening on ${this.address().url}\n`);
    return this.address();
  }

  async stop(): Promise<void> {
    if (this.livenessWatchdog) {
      this.livenessWatchdog.stop();
      this.livenessWatchdog = null;
    }
    for (const s of this.sessions.values()) {
      s.session.stop();
    }
    this.sessions.clear();
    this.engine.stop();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  address(): HttpMCPServerAddress {
    if (!this.server) {
      return {
        host: this.host,
        port: this.port,
        endpoint: this.endpoint,
        url: `http://${formatHostForUrl(this.host)}:${this.port}${this.endpoint}`,
      };
    }
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.port;
    return {
      host: this.host,
      port,
      endpoint: this.endpoint,
      url: `http://${formatHostForUrl(this.host)}:${port}${this.endpoint}`,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== this.endpoint) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    if (!this.originAllowed(req)) {
      writeJson(res, 403, { error: 'Forbidden origin' });
      return;
    }
    if (!this.authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'OPTIONS') {
      writeCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST, DELETE, OPTIONS');
      writeJson(res, 405, { error: 'SSE stream is not supported; use POST for Streamable HTTP' });
      return;
    }
    if (req.method === 'DELETE') {
      this.deleteSession(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE, OPTIONS');
      writeJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!acceptsJson(req)) {
      writeJson(res, 406, { error: 'Accept must include application/json' });
      return;
    }

    let body: string;
    try {
      body = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 413, jsonRpcError(null, ErrorCodes.InvalidRequest, msg));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      writeJson(res, 400, jsonRpcError(null, ErrorCodes.ParseError, 'Parse error: invalid JSON'));
      return;
    }

    if (isJsonRpcResponse(parsed) || isJsonRpcNotification(parsed)) {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (!isJsonRpcRequest(parsed)) {
      writeJson(res, 400, jsonRpcError(null, ErrorCodes.InvalidRequest, 'Invalid Request: not a JSON-RPC request'));
      return;
    }

    const session = this.sessionFor(req, parsed);
    if (!session) {
      writeJson(res, 404, { error: 'Unknown MCP session; initialize a new session' });
      return;
    }

    res.setHeader('Mcp-Session-Id', session.id);
    res.setHeader('MCP-Protocol-Version', req.headers[PROTOCOL_HEADER] ?? '2024-11-05');
    await session.transport.handle(parsed, res);
  }

  private sessionFor(req: http.IncomingMessage, msg: JsonRpcRequest): HttpSession | null {
    const sid = headerValue(req.headers[SESSION_HEADER]);
    if (sid) return this.sessions.get(sid) ?? null;
    if (msg.method !== 'initialize') return null;

    const id = randomUUID();
    const transport = new HttpJsonRpcTransport();
    const session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.opts.projectPath ?? null,
    });
    const httpSession = { id, transport, session };
    this.sessions.set(id, httpSession);
    session.start();
    return httpSession;
  }

  private deleteSession(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sid = headerValue(req.headers[SESSION_HEADER]);
    if (!sid) {
      writeJson(res, 400, { error: 'Missing Mcp-Session-Id' });
      return;
    }
    const session = this.sessions.get(sid);
    if (!session) {
      writeJson(res, 404, { error: 'Unknown MCP session' });
      return;
    }
    session.session.stop();
    this.sessions.delete(sid);
    res.statusCode = 204;
    res.end();
  }

  private authorized(req: http.IncomingMessage): boolean {
    if (!this.token) return true;
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  private originAllowed(req: http.IncomingMessage): boolean {
    const origin = headerValue(req.headers.origin);
    if (!origin) return true;
    if (this.allowOrigins.includes(origin)) return true;
    try {
      const u = new URL(origin);
      return isLoopbackHost(u.hostname);
    } catch {
      return false;
    }
  }
}

class HttpJsonRpcTransport implements JsonRpcTransport {
  private handler: MessageHandler | null = null;
  private pending = new Map<string | number, http.ServerResponse>();
  private stopped = false;

  start(handler: MessageHandler): void {
    this.handler = handler;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const res of this.pending.values()) {
      if (!res.writableEnded) writeJson(res, 503, jsonRpcError(null, ErrorCodes.InternalError, 'Transport stopped'));
    }
    this.pending.clear();
  }

  async handle(message: JsonRpcRequest, res: http.ServerResponse): Promise<void> {
    if (this.stopped) {
      writeJson(res, 503, jsonRpcError(message.id, ErrorCodes.InternalError, 'Transport stopped'));
      return;
    }
    if (!this.handler) {
      writeJson(res, 503, jsonRpcError(message.id, ErrorCodes.InternalError, 'Transport not started'));
      return;
    }
    this.pending.set(message.id, res);
    try {
      await this.handler(message);
      if (!res.writableEnded) {
        writeJson(res, 500, jsonRpcError(message.id, ErrorCodes.InternalError, `No response for ${message.method}`));
      }
    } catch (err) {
      if (!res.writableEnded) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 500, jsonRpcError(message.id, ErrorCodes.InternalError, msg));
      }
    } finally {
      this.pending.delete(message.id);
    }
  }

  send(response: JsonRpcResponse): void {
    const id = response.id;
    const res = id === null ? undefined : this.pending.get(id);
    if (!res || res.writableEnded) return;
    writeJson(res, 200, response);
  }

  notify(_method: string, _params?: unknown): void {
    // Standalone server-to-client HTTP streams are not implemented.
  }

  request(method: string, _params?: unknown, _timeoutMs?: number): Promise<unknown> {
    return Promise.reject(new Error(`Server-initiated request "${method}" is not supported over HTTP without SSE`));
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  writeCorsHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function writeCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) return DEFAULT_ENDPOINT;
  return endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function acceptsJson(req: http.IncomingMessage): boolean {
  const accept = headerValue(req.headers.accept);
  if (!accept) return true;
  return accept.includes('application/json') || accept.includes('*/*');
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === '2.0' && typeof o.method === 'string' && (typeof o.id === 'string' || typeof o.id === 'number');
}

function isJsonRpcNotification(v: unknown): v is JsonRpcNotification {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === '2.0' && typeof o.method === 'string' && !('id' in o);
}

function isJsonRpcResponse(v: unknown): v is JsonRpcResponse {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === '2.0' && 'id' in o && typeof o.method !== 'string' && ('result' in o || 'error' in o);
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
