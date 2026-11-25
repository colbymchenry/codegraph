/**
 * MCP `initialize` handshake regression tests.
 *
 * Issue #172: on slow filesystems (Docker Desktop VirtioFS on macOS, WSL2),
 * the MCP server was blocking the initialize response on CodeGraph.open() and
 * Parser.init() (web-tree-sitter WASM bootstrap), which could take longer than
 * Claude Code's ~30s handshake timeout. The child process stayed alive and
 * had received the request, but never sent a response, so tools never
 * appeared in the client. The fix sends the initialize response before
 * kicking off the heavy init in the background. These tests guard the
 * contract that initialize is fast regardless of how much work init does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { once } from 'events';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { SERVER_INFO } from '../src/mcp/session';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/** The fields of `serverInfo` a host can draw. */
function expectServerBranding(info: { title?: string; icons?: Array<Record<string, unknown>> }): void {
  expect(info.title).toBe('CodeGraph');
  expect(info.icons).toHaveLength(1);
  const icon = info.icons![0]!;
  expect(icon.mimeType).toBe('image/svg+xml');
  expect(String(icon.src)).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(String(icon.src).split(',')[1]!, 'base64').toString('utf8');
  expect(svg).toMatch(/^<svg\b/);
  // `sizes` is left off on purpose: see SERVER_INFO.
  expect(Object.keys(icon).sort()).toEqual(['mimeType', 'src']);
}

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Pin to direct (in-process) mode. #172 is a contract about the in-process
    // server's init ordering — the "File watcher active" log this test observes
    // is emitted in-process. In daemon mode the watcher runs in the detached
    // daemon (logging to .codegraph/daemon.log, not the child's stderr); the
    // same response-before-init guarantee lives in the shared session code and
    // is covered by mcp-daemon.test.ts. Direct mode also avoids leaking a
    // detached daemon from this suite.
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
  }) as ChildProcessWithoutNullStreams;
}

function sendInitialize(child: ChildProcessWithoutNullStreams, projectPath: string) {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${projectPath}`,
    },
  });
  child.stdin.write(msg + '\n');
}

/**
 * Collect stdout lines and stderr text from the child, tagging each piece
 * with a monotonic sequence number. Lets us assert ordering between the
 * JSON-RPC response (stdout) and side-effect logs (stderr).
 */
function tagStreams(child: ChildProcessWithoutNullStreams) {
  const events: Array<{ seq: number; stream: 'stdout' | 'stderr'; text: string }> = [];
  let seq = 0;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stdout', text: line });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stderr', text: line });
    }
  });
  return events;
}

function waitFor<T>(
  events: ReadonlyArray<{ seq: number; stream: string; text: string }>,
  predicate: (e: { seq: number; stream: string; text: string }) => boolean,
  timeoutMs: number,
): Promise<{ seq: number; stream: string; text: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for predicate. Events: ${JSON.stringify(events)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * Remove `dir` once nothing holds it. Even after the killed server's 'close',
 * Windows can keep the dir itself busy a moment longer under load, and
 * `fs.rmSync`'s `maxRetries` never retries EBUSY on a directory: it throws at
 * once. A dir still held at the deadline fails the test.
 */
async function removeWhenReleased(dir: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe('MCP server title and icon', () => {
  it('names the server and carries an icon no host has to fetch', () => {
    expectServerBranding(SERVER_INFO);
  });

  it('keeps the machine name hosts key on, and nothing but shapes in the icon', () => {
    expect(SERVER_INFO.name).toBe('codegraph');
    const svg = Buffer.from(SERVER_INFO.icons[0]!.src.split(',')[1]!, 'base64').toString('utf8');
    expect(svg.match(/<\w+/g)?.sort()).toEqual(
      ['<circle', '<circle', '<circle', '<line', '<line', '<line', '<rect', '<svg'],
    );
    expect(svg).not.toMatch(/href|url\(|on\w+=|style/i);
  });
});

describe('MCP initialize handshake (issue #172)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-init-'));
  });

  afterEach(async () => {
    // Spawn with the runtime flags so this is the server, not a relauncher
    // whose grandchild would retain the Windows cwd/database handles.
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    child = null;
    await removeWhenReleased(tempDir);
  });

  it('responds to initialize quickly when no .codegraph exists in cwd', async () => {
    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);
    const response = await waitFor(events, (e) => e.stream === 'stdout', 5000);
    const json = JSON.parse(response.text);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(0);
    expect(json.result.protocolVersion).toBeDefined();
    expect(json.result.capabilities.tools).toBeDefined();
  }, 10000);

  it('sends initialize response BEFORE tryInitializeDefault finishes', async () => {
    // Seed a real .codegraph so the server's tryInitializeDefault path runs
    // its full body: CodeGraph.open() (which awaits initGrammars()) and then
    // startWatching() (which logs "File watcher active" to stderr). On any
    // platform, that stderr log is observable evidence that tryInitializeDefault
    // has completed. The contract we're protecting: the JSON-RPC response on
    // stdout must arrive BEFORE that stderr log. If a future change re-awaits
    // tryInitializeDefault before sendResult, this ordering inverts and the
    // test fails — regardless of how fast the local filesystem is.
    const cg = await CodeGraph.init(tempDir);
    cg.close();

    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);

    const response = await waitFor(events, (e) => e.stream === 'stdout', 10000);
    const watcherLog = await waitFor(
      events,
      (e) => e.stream === 'stderr' && e.text.includes('File watcher active'),
      10000,
    );
    expect(response.seq).toBeLessThan(watcherLog.seq);
    const json = JSON.parse(response.text);
    expect(json.id).toBe(0);
    expect(json.result.serverInfo.name).toBe('codegraph');
    expectServerBranding(json.result.serverInfo);
  }, 20000);

  it('answers resources/list and prompts/list with empty lists, not -32601 (issue #621)', async () => {
    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);
    await waitFor(events, (e) => e.stream === 'stdout', 5000); // initialize reply

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }) + '\n');

    const replyFor = async (id: number) => {
      const ev = await waitFor(events, (e) => {
        if (e.stream !== 'stdout') return false;
        try { return JSON.parse(e.text).id === id; } catch { return false; }
      }, 5000);
      return JSON.parse(ev.text);
    };

    const resources = await replyFor(1);
    expect(resources.error).toBeUndefined();
    expect(resources.result.resources).toEqual([]);

    const prompts = await replyFor(2);
    expect(prompts.error).toBeUndefined();
    expect(prompts.result.prompts).toEqual([]);
  }, 15000);
});

describe('MCP initialize teardown', () => {
  // On Windows a dir another process holds (here as its cwd) refuses removal
  // with EBUSY; the teardown waits until it is let go.
  it.runIf(process.platform === 'win32')('removes a dir once the process holding it has exited', async () => {
    const held = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-init-held-'));
    const holder = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 500)"], {
      cwd: held,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await once(holder.stdout, 'data'); // running, so its cwd is open
    expect(() => fs.rmdirSync(held)).toThrow(/EBUSY/);
    await removeWhenReleased(held);
    expect(fs.existsSync(held)).toBe(false);
  });
});
