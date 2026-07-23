/**
 * Streamable HTTP MCP transport.
 *
 * The default MCP entry remains stdio, but `serve --mcp --transport http`
 * exposes the same MCPSession over a POST-only Streamable HTTP endpoint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpMCPServer } from '../src/mcp/http-server';

interface HttpJsonResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function requestJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpJsonResponse> {
  const u = new URL(url);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method ?? 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('HTTP MCP transport', () => {
  let tempDir: string;
  let server: HttpMCPServer;
  let url: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-'));
    server = new HttpMCPServer({
      projectPath: tempDir,
      host: '127.0.0.1',
      port: 0,
      engineOptions: { watch: false },
    });
    url = (await server.start()).url;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves initialize and tools/list over POST with an MCP session id', async () => {
    const init = await requestJson(url, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0.0.0' },
          rootUri: `file://${tempDir}`,
        },
      },
    });

    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('codegraph');
    const sessionId = init.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const tools = await requestJson(url, {
      headers: { 'Mcp-Session-Id': sessionId as string, 'MCP-Protocol-Version': '2024-11-05' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(tools.status).toBe(200);
    expect(Array.isArray(tools.body.result.tools)).toBe(true);
    expect(tools.body.result.tools.map((t: { name: string }) => t.name)).toContain('codegraph_explore');

    const deleted = await requestJson(url, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId as string },
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await requestJson(url, {
      headers: { 'Mcp-Session-Id': sessionId as string },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    });
    expect(afterDelete.status).toBe(404);
  });

  it('rejects non-local Origin headers', async () => {
    const resp = await requestJson(url, {
      headers: { Origin: 'https://example.com' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(resp.status).toBe(403);
  });

  it('ignores client projectPath arguments when the HTTP server has a fixed project path', async () => {
    const init = await requestJson(url, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          rootUri: 'file:///client/local/workspace',
        },
      },
    });
    const sessionId = init.headers['mcp-session-id'] as string;
    const clientOnlyPath = path.join(os.tmpdir(), 'client-only-codegraph-path');

    const resp = await requestJson(url, {
      headers: { 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'codegraph_explore',
          arguments: {
            query: 'spring aop',
            projectPath: clientOnlyPath,
          },
        },
      },
    });

    expect(resp.status).toBe(200);
    const text = resp.body.result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).not.toContain(clientOnlyPath);
    expect(text).toContain(tempDir);
  });
});
