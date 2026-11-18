/**
 * A direct session arms its liveness watchdog when work begins (#3250).
 *
 * The watchdog (#850) is a separate `node -e` process. A direct-mode
 * `serve --mcp` used to spawn it at launch, so every session in a folder with
 * no index paid a process (about 19 MiB on Windows) before, and usually
 * without, a single tool call: many hosts start a server per chat and only
 * list its tools. It now starts with the first tool call, or as soon as the
 * session opens a project (at launch with `--path`, or when the client names
 * one), so hang protection still covers every operation that can block.
 *
 * `CODEGRAPH_MCP_DEBUG=1` makes the watchdog log `armed (child pid N)` the
 * moment its process is spawned, which is what these tests read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const ARMED = /\[CodeGraph watchdog\] armed \(child pid (\d+)\)/;

function spawnServer(cwd: string, args: string[] = []): { child: ChildProcessWithoutNullStreams; stderr: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Direct mode: the folder has no index, or the test asks for it.
    CODEGRAPH_NO_DAEMON: '1',
    // No --liftoff-only re-exec, so the server is this child, not a grandchild
    // that outlives it on Windows (see mcp-unindexed.test.ts).
    CODEGRAPH_WASM_RELAUNCHED: '1',
    CODEGRAPH_MCP_DEBUG: '1',
  };
  delete env.CODEGRAPH_NO_WATCHDOG;
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env }) as ChildProcessWithoutNullStreams;
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  return { child, stderr: () => err };
}

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(child: ChildProcessWithoutNullStreams, msg: { id: number; method: string; params?: unknown }, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { child.stdout.off('data', onData); reject(new Error(`timeout waiting for response id=${msg.id}`)); }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === msg.id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(parsed); return; }
        } catch { /* not JSON */ }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

const notify = (child: ChildProcessWithoutNullStreams, method: string) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

const initialize = (child: ChildProcessWithoutNullStreams, rootUri?: string) =>
  request(child, { id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, ...(rootUri ? { rootUri } : {}),
  } });

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('a direct session arms its liveness watchdog when work begins (#3250)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-watchdog-'));
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => { if (child!.exitCode !== null) resolve(); else child!.once('exit', () => resolve()); });
      try { child.stdin.end(); } catch { /* gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      }
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('starts no watchdog for a session that only lists the tools, then arms it on the first tool call', async () => {
    const server = spawnServer(tempDir);
    child = server.child;
    await initialize(child);
    notify(child, 'notifications/initialized');
    const list = await request(child, { id: 2, method: 'tools/list', params: {} });
    expect(Array.isArray((list.result as { tools?: unknown[] }).tools)).toBe(true);
    // Room for a startup-time arm to show up, which is what main did.
    await new Promise((r) => setTimeout(r, 1000));
    expect(server.stderr()).not.toMatch(ARMED);

    const call = await request(child, { id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    expect(call.result).toBeDefined();
    expect(server.stderr()).toMatch(ARMED);
  }, 60_000);

  it('arms it at launch when started with --path on an indexed project', async () => {
    const cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();
    const server = spawnServer(tempDir, ['--path', tempDir]);
    child = server.child;
    // Before any request: the engine opens the project during startup.
    expect(await waitFor(() => ARMED.test(server.stderr()), 20_000)).toBe(true);
    await initialize(child);
  }, 60_000);

  it('arms it when the client names an indexed project in initialize, before any tool call', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a(): number { return 1; }\n');
    const cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();
    const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-watchdog-launch-'));
    try {
      const server = spawnServer(launchDir);
      child = server.child;
      await initialize(child, `file://${tempDir.replace(/\\/g, '/')}`);
      expect(await waitFor(() => ARMED.test(server.stderr()), 20_000)).toBe(true);
    } finally {
      const exited = new Promise<void>((resolve) => { if (child!.exitCode !== null) resolve(); else child!.once('exit', () => resolve()); });
      child!.stdin.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      fs.rmSync(launchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it('closing stdin still ends the server and the watchdog it armed', async () => {
    const server = spawnServer(tempDir);
    child = server.child;
    await initialize(child);
    await request(child, { id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const watchdogPid = Number(ARMED.exec(server.stderr())?.[1]);
    expect(watchdogPid).toBeGreaterThan(0);
    const exited = new Promise<number | null>((resolve) => child!.once('exit', (code) => resolve(code)));
    child.stdin.end();
    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])).toBe(0);
    expect(await waitFor(() => !alive(watchdogPid), 10_000)).toBe(true);
  }, 60_000);
});
