import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnHttpServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--http', '--port', '0', '--no-watch'],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    },
  ) as ChildProcessWithoutNullStreams;
}

function waitForHttpUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for HTTP server URL. stderr=${stderr}`));
    }, 5000);
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const match = stderr.match(/listening on (http:\/\/[^\s]+)/);
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`server exited before listening, code=${code}, stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function initializeBody(projectPath: string) {
  return {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${projectPath}`,
    },
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1000);
    const cleanup = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', cleanup);
    child.kill('SIGTERM');
  });
}

describe('MCP Streamable HTTP transport', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-'));
  });

  afterEach(async () => {
    if (child) {
      await stopChild(child);
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves initialize over POST /mcp as application/json', async () => {
    child = spawnHttpServer(tempDir);
    const baseUrl = await waitForHttpUrl(child);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(initializeBody(tempDir)),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const json = await res.json() as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string }; capabilities: { tools: unknown } };
    };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(0);
    expect(json.result.serverInfo.name).toBe('codegraph');
    expect(json.result.capabilities.tools).toBeDefined();
  }, 10000);

  it('accepts notifications with 202 and no response body', async () => {
    child = spawnHttpServer(tempDir);
    const baseUrl = await waitForHttpUrl(child);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }),
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  }, 10000);

  it('accepts JSON-RPC responses with 202 and no response body', async () => {
    child = spawnHttpServer(tempDir);
    const baseUrl = await waitForHttpUrl(child);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'client-1', result: {} }),
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  }, 10000);

  it('does not offer a standalone GET SSE stream yet', async () => {
    child = spawnHttpServer(tempDir);
    const baseUrl = await waitForHttpUrl(child);

    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });

    expect(res.status).toBe(405);
  }, 10000);

  it('rejects invalid Origin headers to prevent local DNS rebinding', async () => {
    child = spawnHttpServer(tempDir);
    const baseUrl = await waitForHttpUrl(child);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify(initializeBody(tempDir)),
    });

    expect(res.status).toBe(403);
  }, 10000);
});
