/**
 * MCP workspace sub-project adoption + no-default diagnostics (#1606, #1607).
 *
 * When an MCP host launches the server from a workspace root whose indexed
 * projects live in CHILD directories (a repo container, a monorepo root), the
 * upward walk finds nothing. The server now runs the same bounded down-scan
 * the front-load hook uses:
 *   - exactly ONE indexed sub-project  → adopted as the session's default;
 *   - zero or several                  → no default, but the state is SAID:
 *     stderr names what was searched/found, and tool calls list the indexed
 *     sub-projects so the agent can pass one as `projectPath`;
 *   - non-workspace base (no manifest, no .git) → no scan at all.
 *
 * Same real-subprocess harness as mcp-roots.test.ts — no mocking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  // --no-watch keeps the test deterministic; CODEGRAPH_NO_DAEMON keeps the
  // session in direct mode so no detached daemon outlives the test.
  return spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
  }) as ChildProcessWithoutNullStreams;
}

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

function collectStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
  let buf = '';
  child.stderr.on('data', (chunk) => { buf += chunk.toString('utf8'); });
  return { text: () => buf };
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

/** Create ws/<name> with one source file and an initialized .codegraph/. */
async function makeIndexedChild(ws: string, name: string): Promise<string> {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ts'), `export function hello_${name}() { return 1; }\n`);
  const cg = await CodeGraph.init(dir);
  cg.close();
  return dir;
}

/** initialize (no rootUri, no roots capability) → initialized → codegraph_status. */
async function driveStatusCall(
  child: ChildProcessWithoutNullStreams,
  messages: Array<Record<string, any>>,
): Promise<{ initResult: Record<string, any>; statusText: string }> {
  send(child, {
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const initResult = await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
  send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
  const resp = await waitForMessage(messages, (m) => m.id === 1, 10000);
  return { initResult, statusText: resp.result.content[0].text as string };
}

describe('MCP workspace sub-project adoption (#1606) + no-default diagnostics (#1607)', () => {
  let ws: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-ws-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('adopts the single indexed sub-project below a workspace root as the default project', async () => {
    fs.mkdirSync(path.join(ws, '.git')); // workspace marker — no manifest needed
    await makeIndexedChild(ws, 'service-a');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { initResult, statusText } = await driveStatusCall(child, messages);

    // The default project works without any projectPath.
    expect(statusText).toContain('CodeGraph Status');
    expect(statusText).not.toContain('No CodeGraph project is loaded');
    // The adoption is announced on stderr (#1607 discoverability).
    expect(stderr.text()).toContain('adopted the single indexed sub-project');
    expect(stderr.text()).toContain('service-a');
    // Instructions match what the engine adopted: the FULL single-project
    // playbook, not the per-project variant.
    const instructions = initResult.result.instructions as string;
    expect(instructions).not.toContain('per-project; pass projectPath');
  }, 20000);

  it('lists several indexed sub-projects instead of adopting one, in stderr and in tool responses', async () => {
    fs.mkdirSync(path.join(ws, '.git'));
    await makeIndexedChild(ws, 'service-a');
    await makeIndexedChild(ws, 'service-b');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { initResult, statusText } = await driveStatusCall(child, messages);

    // No default was adopted — ambiguous — but the state is said, not silent.
    expect(statusText).toContain('No CodeGraph project is loaded');
    // Protocol-reachable listing (#1607): the tool response names what IS there.
    expect(statusText).toContain('Indexed sub-projects were found below it');
    expect(statusText).toContain('service-a');
    expect(statusText).toContain('service-b');
    expect(statusText).toContain('projectPath');
    // stderr carries the same facts for the host's log.
    expect(stderr.text()).toContain('no default project, live sync disabled');
    expect(stderr.text()).toContain('Indexed sub-projects found:');
    // Ambiguous root → per-project instructions variant.
    const instructions = initResult.result.instructions as string;
    expect(instructions).toContain('per-project; pass projectPath');
  }, 20000);

  it('does not scan below a base that is not a workspace (no manifest, no .git)', async () => {
    // NO .git and no manifest at ws — the gate must keep the scan off even
    // though an indexed child exists.
    await makeIndexedChild(ws, 'service-a');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { statusText } = await driveStatusCall(child, messages);

    expect(statusText).toContain('No CodeGraph project is loaded');
    expect(statusText).not.toContain('Indexed sub-projects were found below it');
    expect(stderr.text()).toContain('no default project, live sync disabled');
    expect(stderr.text()).not.toContain('Indexed sub-projects found:');
  }, 20000);
});
