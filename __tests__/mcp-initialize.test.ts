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

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
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

describe('MCP initialize handshake (issue #172)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-init-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
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

/**
 * The AOSP-tools addendum (see docs/design/android-platform-analysis.md's Exposure
 * section): SERVER_INSTRUCTIONS is a static template, so before this existed,
 * enabling an AOSP tool via CODEGRAPH_MCP_TOOLS still left the agent's
 * system prompt talking only about codegraph_explore, so the agent had no
 * reason to ever call the newly-enabled tool. Tested directly against the
 * pure functions (no subprocess) since the logic itself needs no CodeGraph
 * instance; the handshake-wiring itself is exercised end-to-end by the
 * `describe` block above (both call the same `enabledAospAddendum`).
 */
describe('AOSP tools addendum in the initialize instructions', () => {
  const ORIGINAL_ENV = process.env.CODEGRAPH_MCP_TOOLS;
  let tempDir: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
    else process.env.CODEGRAPH_MCP_TOOLS = ORIGINAL_ENV;
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('adds nothing when no AOSP tool is enabled (the common, non-Android case)', async () => {
    delete process.env.CODEGRAPH_MCP_TOOLS;
    const { enabledAospAddendum } = await import('../src/mcp/session');
    expect(enabledAospAddendum()).toBe('');

    process.env.CODEGRAPH_MCP_TOOLS = 'explore,node,search';
    expect(enabledAospAddendum()).toBe('');

    process.env.CODEGRAPH_MCP_TOOLS = '';
    expect(enabledAospAddendum()).toBe('');
  });

  it('names exactly the enabled AOSP tools, and only those', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = 'explore,aidl_impl,trace_permission';
    const { enabledAospAddendum } = await import('../src/mcp/session');
    const addendum = enabledAospAddendum();

    expect(addendum).toContain('codegraph_aidl_impl');
    expect(addendum).toContain('codegraph_trace_permission');
    expect(addendum).not.toContain('codegraph_jni_bridge');
    expect(addendum).not.toContain('codegraph_hal_interface');
    expect(addendum).not.toContain('codegraph_system_service');
    expect(addendum).not.toContain('codegraph_trace_broadcast');
    expect(addendum).not.toContain('codegraph_messenger_ipc');
    expect(addendum).not.toContain('codegraph_content_provider');
    expect(addendum).not.toContain('codegraph_local_socket_ipc');
  });

  it('names the three IPC-pattern AOSP tools (messenger_ipc/content_provider/local_socket_ipc) when enabled, and only those', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = 'explore,messenger_ipc,content_provider,local_socket_ipc';
    const { enabledAospAddendum } = await import('../src/mcp/session');
    const addendum = enabledAospAddendum();

    expect(addendum).toContain('codegraph_messenger_ipc');
    expect(addendum).toContain('codegraph_content_provider');
    expect(addendum).toContain('codegraph_local_socket_ipc');
    expect(addendum).not.toContain('codegraph_aidl_impl');
    expect(addendum).not.toContain('codegraph_jni_bridge');
    expect(addendum).not.toContain('codegraph_hal_interface');
    expect(addendum).not.toContain('codegraph_system_service');
    expect(addendum).not.toContain('codegraph_trace_permission');
    expect(addendum).not.toContain('codegraph_trace_broadcast');
  });

  it('is appended to the initialize instructions payload end-to-end', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = 'explore,jni_bridge';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-aosp-init-'));
    await CodeGraph.init(tempDir, { index: true });

    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);
    const ev = await waitFor(events, (e) => e.stream === 'stdout', 20000);
    const json = JSON.parse(ev.text);

    expect(json.result.instructions).toContain('codegraph_jni_bridge');
    expect(json.result.instructions).not.toContain('codegraph_aidl_impl');
  }, 25000);
});
