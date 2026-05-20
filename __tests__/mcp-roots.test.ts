/**
 * MCP project-resolution regression tests (issue #196).
 *
 * When an MCP client launches the server outside the project directory AND
 * doesn't pass a `rootUri`/`workspaceFolders` in `initialize`, the server used
 * to fall straight back to `process.cwd()` — which for many IDE clients is the
 * wrong directory. Every tool call without an explicit `projectPath` then
 * failed with a misleading "CodeGraph not initialized. Run 'codegraph init'."
 *
 * The fix: when no explicit path is provided, the server asks the client for
 * its workspace root via the spec-blessed `roots/list` request (if the client
 * advertised the `roots` capability), and only falls back to cwd otherwise.
 * When it still can't resolve, the error now says exactly how to fix it.
 *
 * These tests drive the real stdio transport via a spawned subprocess — no
 * mocking — so they also exercise the new bidirectional request/response path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  // --no-watch keeps the test deterministic and avoids watcher startup noise.
  return spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

/** Parse every JSON-RPC message the server writes to stdout into an array. */
function collectMessages(child: ChildProcessWithoutNullStreams): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });
  return messages;
}

function waitForMessage(
  messages: ReadonlyArray<Record<string, any>>,
  predicate: (m: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out. Messages so far: ${JSON.stringify(messages)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function send(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const CLIENT_INFO = { name: 'test', version: '0.0.0' };

describe('MCP project resolution via roots/list (issue #196)', () => {
  let cwdDir: string;     // where the server is launched — has NO .codegraph
  let projectDir: string; // the real indexed project the client reports
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-cwd-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-proj-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('resolves the project from the client roots/list when no rootUri is sent', async () => {
    const cg = await CodeGraph.init(projectDir);
    cg.close();

    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    // Advertise the roots capability but pass NO rootUri/workspaceFolders.
    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: CLIENT_INFO },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // First tool call (no projectPath) drives the server to ask us for roots.
    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });

    const rootsReq = await waitForMessage(messages, (m) => m.method === 'roots/list', 5000);
    expect(typeof rootsReq.id).toBe('string'); // server-initiated id
    send(child, {
      jsonrpc: '2.0', id: rootsReq.id,
      result: { roots: [{ uri: `file://${projectDir}`, name: 'proj' }] },
    });

    // The status call now succeeds against the resolved project.
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;
    expect(text).toContain('CodeGraph Status');
    expect(text).not.toContain('No CodeGraph project is loaded');
  }, 20000);

  it('returns an actionable error when there is no rootUri and no roots capability', async () => {
    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;

    expect(text).toContain('No CodeGraph project is loaded');
    expect(text).toContain('projectPath');
    expect(text).toContain('--path');
    // Names the directory it actually searched (the wrong cwd) so the user can
    // see why detection missed. basename survives any symlink realpath-ing.
    expect(text).toContain(path.basename(cwdDir));
    // It must not have hung waiting on roots/list — the client never offered it.
    expect(messages.some((m) => m.method === 'roots/list')).toBe(false);
  }, 20000);

  it('honors an explicit rootUri without asking the client for roots', async () => {
    const cg = await CodeGraph.init(projectDir);
    cg.close();

    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { roots: {} },
        clientInfo: CLIENT_INFO,
        rootUri: `file://${projectDir}`,
      },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;

    expect(text).toContain('CodeGraph Status');
    // rootUri is a stronger signal than roots — we never needed to ask.
    expect(messages.some((m) => m.method === 'roots/list')).toBe(false);
  }, 20000);
});
