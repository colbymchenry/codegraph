/**
 * The prompt hook asks the project's running daemon for its explore (#3284).
 *
 * The hook is a new process on every prompt, so an explore it runs itself
 * starts cold: it reads the name lists, the name index and the dominant file
 * again each time, seconds on a large index. The daemon an MCP session keeps
 * running for the project has all of that in memory. These tests cover the
 * three sides of the hand-off: the request the daemon answers, the client that
 * asks it, and the hook falling back to its own explore when there is no
 * daemon to ask.
 *
 * The fake daemon is a real socket server on the path the client looks for, so
 * the hello line, the client hello and the request all cross a real socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests, type ToolResult } from '../src/mcp/tools';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { MCPSession, PROMPT_EXPLORE_METHOD } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcTransport } from '../src/mcp/transport';
import { getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { getTelemetry } from '../src/telemetry';
import { exploreViaDaemon } from '../src/mcp/hook-client';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  __setLoadCodeGraphForTests(null);
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

/** An indexed project whose functions call each other, so explore has something to say. */
async function indexedProject(): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hookd-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'orders.ts'),
    'export function placeOrder() { return chargeCard(); }\nexport function chargeCard() { return 1; }\n',
  );
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();
  return root;
}

function resultText(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function fakeTransport(): JsonRpcTransport & {
  deliver(message: JsonRpcRequest): Promise<void>;
  results: unknown[];
  errors: unknown[];
} {
  let handler: ((message: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
  const results: unknown[] = [];
  const errors: unknown[] = [];
  return {
    start(next) { handler = next; },
    stop() { /* nothing to tear down */ },
    send() { /* unused */ },
    notify() { /* unused */ },
    async request() { return {}; },
    sendResult(_id, result) { results.push(result); },
    sendError(_id, code) { errors.push(code); },
    results,
    errors,
    async deliver(message) { await handler?.(message); },
  };
}

type Reply = (request: { id: number; method: string; params?: { query?: string } }) => unknown | undefined;

/**
 * A daemon stand-in on the socket the client looks for: says hello as
 * `version`, then answers each request with what `reply` returns, or stays
 * silent when it returns undefined. Records the requests it was sent.
 */
async function fakeDaemon(root: string, version: string, reply: Reply): Promise<Array<{ method: string; params?: { query?: string } }>> {
  const sockPath = getDaemonSocketCandidates(root)[0]!;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  const seen: Array<{ method: string; params?: { query?: string } }> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => { /* a client that hung up */ });
    socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath: sockPath, protocol: 1 }) + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.codegraph_client) continue; // the client hello, not a request
        seen.push({ method: message.method, params: message.params });
        const body = reply(message);
        if (body !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(body as object) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(sockPath, { force: true });
  });
  return seen;
}

const answer = (text: string): Reply => () => ({ result: { content: [{ type: 'text', text }] } });

describe('the daemon answers a prompt hook explore (#3284)', () => {
  it('answers like explore, without the once-per-client stale-index warning or a tool-usage count', async () => {
    const root = await indexedProject();
    const cg = await CodeGraph.open(root);
    cleanups.push(() => cg.close());
    const writer = cg as unknown as { queries: { setMetadata(key: string, value: string): void } };
    writer.queries.setMetadata('indexed_with_version', '0.1.0');
    writer.queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
    const handler = new ToolHandler(cg);
    cleanups.push(() => { handler.closeAll(); });
    __setLoadCodeGraphForTests(CodeGraph);
    const engine = {
      ensureInitialized: async () => { /* already initialized */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => root,
      retryInitializeSync: () => { /* already initialized */ },
      getToolHandler: () => handler,
    } as unknown as MCPEngine;
    const usage = vi.spyOn(getTelemetry(), 'recordUsage');
    const transport = fakeTransport();
    new MCPSession(transport, engine).start();

    await transport.deliver({ jsonrpc: '2.0', id: 1, method: PROMPT_EXPLORE_METHOD, params: { query: 'placeOrder chargeCard' } });
    await transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'placeOrder chargeCard' } },
    });

    expect(transport.errors).toEqual([]);
    const viaHook = resultText(transport.results[0] as ToolResult);
    const viaTool = resultText(transport.results[1] as ToolResult);
    expect(viaHook).toContain('placeOrder');
    expect(viaHook).not.toMatch(/index predates the running extraction engine/i);
    // The hook's request left the client's one warning unclaimed, and left its
    // explore history alone: the tool call still warns and still shows the source.
    expect(viaTool).toMatch(/index predates the running extraction engine/i);
    expect(viaTool).toContain(viaHook.trim());
    expect(usage.mock.calls.filter(([kind]) => kind === 'mcp_tool')).toHaveLength(1);
  });
});

describe.runIf(process.platform !== 'win32')('exploreViaDaemon — the hook asking a running daemon (#3284)', () => {
  it('returns what the daemon answered, having asked with the prompt as the query', async () => {
    const root = await indexedProject();
    const seen = await fakeDaemon(root, CodeGraphPackageVersion, answer('FROM THE DAEMON'));

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({
      status: 'answered',
      text: 'FROM THE DAEMON',
    });
    expect(seen).toEqual([{ method: PROMPT_EXPLORE_METHOD, params: { query: 'how does placeOrder work' } }]);
  });

  it('is unavailable when no daemon is running for the project', async () => {
    const root = await indexedProject();

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the daemon is another version', async () => {
    const root = await indexedProject();
    const seen = await fakeDaemon(root, '0.0.0-not-our-version', answer('FROM AN OLD DAEMON'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(seen).toEqual([]);
  });

  // A daemon of the same version string that predates this request, like a
  // build from main before it landed, answers "method not found".
  it('is unavailable when the daemon does not know the request', async () => {
    const root = await indexedProject();
    await fakeDaemon(root, CodeGraphPackageVersion, () => ({ error: { code: -32601, message: 'Method not found' } }));

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the daemon answers with an error result or with nothing to inject', async () => {
    const failing = await indexedProject();
    await fakeDaemon(failing, CodeGraphPackageVersion, () => ({ result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }));
    const empty = await indexedProject();
    await fakeDaemon(empty, CodeGraphPackageVersion, answer('  \n'));

    await expect(exploreViaDaemon(failing, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    await expect(exploreViaDaemon(empty, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
  });

  it('times out at the deadline when the daemon never answers', async () => {
    const root = await indexedProject();
    await fakeDaemon(root, CodeGraphPackageVersion, () => undefined);

    const started = Date.now();
    await expect(exploreViaDaemon(root, 'how does placeOrder work', 300)).resolves.toEqual({ status: 'timed-out' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // One socket candidate is in the system temp directory, which other users
  // of the machine can write to on Linux. Whoever puts a socket there first
  // would read every prompt and write into the agent's context.
  it('never sends the prompt to a socket another user created', async () => {
    const root = await indexedProject();
    const seen = await fakeDaemon(root, CodeGraphPackageVersion, answer('FROM SOMEONE ELSE'));
    const mine = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(mine + 1);

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(seen).toEqual([]);
  });

  it('never follows a link left where the daemon socket goes', async () => {
    const root = await indexedProject();
    const elsewhere = await indexedProject();
    const seen = await fakeDaemon(elsewhere, CodeGraphPackageVersion, answer('FROM SOMEWHERE ELSE'));
    const expected = getDaemonSocketCandidates(root)[0]!;
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.symlinkSync(getDaemonSocketCandidates(elsewhere)[0]!, expected);
    cleanups.push(() => fs.rmSync(expected, { force: true }));

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(seen).toEqual([]);
  });

  // In a folder others can write to, they can swap this user's socket for
  // their own between the check and the connection. The sticky bit, which
  // /tmp carries, is what stops them: only a file's owner may remove it.
  it('never trusts a socket in a folder where others can replace it', async () => {
    const root = await indexedProject();
    const seen = await fakeDaemon(root, CodeGraphPackageVersion, answer('FROM THE DAEMON'));
    const folder = path.dirname(getDaemonSocketCandidates(root)[0]!);
    expect(folder.startsWith(root)).toBe(true);
    fs.chmodSync(folder, 0o777);

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(seen).toEqual([]);
  });

  it('trusts its own socket in a shared folder that has the sticky bit, like /tmp', async () => {
    const root = await indexedProject();
    await fakeDaemon(root, CodeGraphPackageVersion, answer('FROM THE DAEMON'));
    const folder = path.dirname(getDaemonSocketCandidates(root)[0]!);
    expect(folder.startsWith(root)).toBe(true);
    fs.chmodSync(folder, 0o1777);

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({
      status: 'answered',
      text: 'FROM THE DAEMON',
    });
  });
});

/** Run the built CLI's `prompt-hook` in `dir`, as Claude Code does, and return what it injects. */
function runPromptHook(dir: string, prompt: string, env: NodeJS.ProcessEnv = {}): { stdout: string; ms: number } {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'prompt-hook'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, hook_event_name: 'UserPromptSubmit', prompt }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
      CODEGRAPH_NO_RELAUNCH: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
      CODEGRAPH_NO_PROMPT_HOOK: '0', CODEGRAPH_PROMPT_HOOK: '1',
      CODEGRAPH_NO_DAEMON: '',
      ...env,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return { stdout: result.stdout, ms: Date.now() - started };
}

/**
 * `spawnSync` blocks this thread, so a fake daemon inside the test process
 * could never answer the hook. This one runs as its own process.
 */
function spawnFakeDaemon(root: string, mode: 'answer' | 'silent'): void {
  const sockPath = getDaemonSocketCandidates(root)[0]!;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  const script = `
    const net = require('net');
    const [sockPath, version, mode] = process.argv.slice(1);
    net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath: sockPath, protocol: 1 }) + '\\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.codegraph_client || mode === 'silent') continue;
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'FROM THE DAEMON' }] } }) + '\\n');
        }
      });
    }).listen(sockPath, () => process.stdout.write('listening\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script, sockPath, CodeGraphPackageVersion, mode], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanups.push(() => { child.kill('SIGKILL'); fs.rmSync(sockPath, { force: true }); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error('fake daemon did not start');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

describe.runIf(process.platform !== 'win32')('prompt-hook front-loads from a running daemon (#3284)', () => {
  const PROMPT = 'trace the call path of placeOrder';

  it('injects the daemon’s answer when one is running for the project', async () => {
    const root = await indexedProject();
    spawnFakeDaemon(root, 'answer');

    const { stdout } = runPromptHook(root, PROMPT);

    expect(stdout).toMatch(/^<codegraph_context /);
    expect(stdout).toContain('FROM THE DAEMON');
    expect(stdout).not.toContain('chargeCard');
  });

  it('runs its own explore when there is no daemon', async () => {
    const root = await indexedProject();

    const { stdout } = runPromptHook(root, PROMPT);

    expect(stdout).toMatch(/^<codegraph_context /);
    expect(stdout).toContain('chargeCard');
  });

  it('runs its own explore under CODEGRAPH_NO_DAEMON=1, daemon or not', async () => {
    const root = await indexedProject();
    spawnFakeDaemon(root, 'answer');

    const { stdout } = runPromptHook(root, PROMPT, { CODEGRAPH_NO_DAEMON: '1' });

    expect(stdout).toContain('chargeCard');
    expect(stdout).not.toContain('FROM THE DAEMON');
  });

  // The explore is running in the daemon, so a second one here would only
  // add load to a machine that is already too slow to answer in time.
  it('injects nothing, and soon, when the daemon does not answer by the deadline', async () => {
    const root = await indexedProject();
    spawnFakeDaemon(root, 'silent');

    const { stdout, ms } = runPromptHook(root, PROMPT, { CODEGRAPH_PROMPT_HOOK_DAEMON_TIMEOUT_MS: '400' });

    expect(stdout).toBe('');
    expect(ms).toBeLessThan(10_000);
  });
});
