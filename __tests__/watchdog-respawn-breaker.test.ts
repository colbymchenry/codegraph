/**
 * #3137 — a watchdog kill must be visible to the NEXT process.
 *
 * The #850 watchdog SIGKILLs a wedged process so a fresh daemon starts on the
 * next connection. Nothing recorded the kill, so a request that reliably drove
 * the process into a wedge (reported on Windows as runaway commit growth) was
 * re-run by every fresh process: kill → respawn → kill, until system commit was
 * exhausted. These tests prove the persisted kill record, its window accounting,
 * and that the automatic restart path refuses instead of looping. The kill
 * conditions themselves are unchanged (#850 still kills a real wedge; see
 * liveness-watchdog.test.ts).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  WATCHDOG_KILL_TRIP_LIMIT,
  WATCHDOG_KILL_TRIP_WINDOW_MS,
  recentWatchdogKills,
  watchdogKillRecordPath,
  watchdogKillRefusal,
} from '../src/mcp/liveness-watchdog';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PROXY = path.resolve(__dirname, '../dist/mcp/proxy.js');

beforeAll(() => {
  for (const file of [BIN, PROXY]) {
    if (!fs.existsSync(file)) throw new Error(`Build the project first: ${file} is missing (run npm run build).`);
  }
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wdb-'));
  dirs.push(dir);
  return dir;
}

/** Write kill timestamps in the record file the watchdog child appends to. */
function writeKills(root: string, times: number[]): string {
  const record = watchdogKillRecordPath(root);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, times.map((t) => `${t}\n`).join(''));
  return record;
}

const now = (): number => Date.now();
const minute = 60_000;

describe('watchdog kill record accounting (#3137)', () => {
  it('counts only kills inside the sliding window and ignores malformed lines', () => {
    const root = tempDir();
    const record = writeKills(root, []);
    fs.writeFileSync(
      record,
      [
        `${now() - WATCHDOG_KILL_TRIP_WINDOW_MS - minute}`, // outside the window
        'not-a-timestamp',
        '',
        `${now() - minute}`,
        `${now() - 2 * minute}`,
      ].join('\n'),
    );

    expect(recentWatchdogKills(record)).toBe(2);
  });

  it('returns no refusal below the trip limit, a clear refusal at it, and lifts as kills age out', () => {
    const root = tempDir();
    const at = now();
    writeKills(root, [at - 3 * minute, at - 2 * minute]);
    expect(recentWatchdogKills(watchdogKillRecordPath(root), at)).toBe(WATCHDOG_KILL_TRIP_LIMIT - 1);
    expect(watchdogKillRefusal(root, at)).toBeNull();

    writeKills(root, [at - 3 * minute, at - 2 * minute, at - minute]);
    const refusal = watchdogKillRefusal(root, at);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('CodeGraph is paused');
    expect(refusal).toContain(String(WATCHDOG_KILL_TRIP_LIMIT));
    expect(refusal).toContain(watchdogKillRecordPath(root));

    // Once the oldest kill leaves the window the count is below the limit again.
    expect(watchdogKillRefusal(root, at + WATCHDOG_KILL_TRIP_WINDOW_MS)).toBeNull();
  });

  it('is not tripped by a single old kill', () => {
    const root = tempDir();
    writeKills(root, [now() - 2 * WATCHDOG_KILL_TRIP_WINDOW_MS]);
    expect(watchdogKillRefusal(root)).toBeNull();
  });
});

describe('proxy fallback refuses the exploding work (#3137)', () => {
  it('answers tool calls with the refusal instead of building an in-process engine', async () => {
    const root = tempDir();
    writeKills(root, [now() - minute, now() - 2 * minute, now() - 3 * minute]);
    const engineMarker = path.join(root, 'engine-built');

    const child = spawn(process.execPath, ['-e', `
      const { runLocalHandshakeProxy } = require(${JSON.stringify(PROXY)});
      runLocalHandshakeProxy({
        root: ${JSON.stringify(root)},
        getDaemonSocket: async () => null,
        makeEngine: () => {
          require('fs').writeFileSync(${JSON.stringify(engineMarker)}, 'built');
          return {
            ensureInitialized: async () => {},
            getToolHandler: () => ({ execute: async () => ({ content: [{ type: 'text', text: 'served-in-process' }] }) }),
            stop: () => undefined,
          };
        },
      });
    `], {
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
        CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0',
        CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } }) + '\n');
      const deadline = Date.now() + 8_000;
      while (!stdout.includes('CodeGraph is paused') && !exited()) {
        if (Date.now() > deadline) throw new Error(`timed out; stdout=${stdout} stderr=${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(stdout, stderr).toContain('CodeGraph is paused');
      expect(stdout).not.toContain('served-in-process');
      expect(fs.existsSync(engineMarker)).toBe(false);
    } finally {
      if (!exited()) child.stdin.end();
      await new Promise<void>((resolve) => {
        if (exited()) return resolve();
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 8_000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }, 20000);
});

describe('automatic restart refuses while the breaker is tripped (#3137)', () => {
  it('a tripped launcher does not spawn a daemon and returns the refusal to the client', async () => {
    const root = tempDir();
    const cg = await CodeGraph.init(root);
    cg.close();
    writeKills(root, [now() - minute, now() - 2 * minute, now() - 3 * minute]);

    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
        CODEGRAPH_PPID_POLL_MS: '0', CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
        // Pre-fix a daemon may be spawned; keep any such daemon short-lived.
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '500',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: root } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } }) + '\n');
      const deadline = Date.now() + 15_000;
      while (!stdout.includes('CodeGraph is paused') && !exited()) {
        if (Date.now() > deadline) throw new Error(`timed out; stdout=${stdout} stderr=${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(stdout, stderr).toContain('CodeGraph is paused');
      // Give the background spawn path a moment to prove it stayed put.
      await new Promise((r) => setTimeout(r, 750));
      expect(fs.existsSync(path.join(root, '.codegraph', 'daemon.pid'))).toBe(false);
    } finally {
      if (!exited()) child.stdin.end();
      await new Promise<void>((resolve) => {
        if (exited()) return resolve();
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 8_000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
      // A pre-fix run may have spawned a daemon; never leave it behind.
      try {
        const info = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8'));
        if (typeof info.pid === 'number') { try { process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ } }
      } catch { /* no daemon */ }
    }
  }, 30000);

  it('a fresh daemon refuses to start while the breaker is tripped, without taking the lock', async () => {
    const root = tempDir();
    const cg = await CodeGraph.init(root);
    cg.close();
    writeKills(root, [now() - minute, now() - 2 * minute, now() - 3 * minute]);

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--path', root],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CODEGRAPH_DAEMON_INTERNAL: '1',
            CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
            // Pre-fix this daemon would start and linger; make it reap itself.
            CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '500',
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: null, stderr }); }, 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve({ code, stderr });
      });
    });

    expect(result.stderr).toContain('CodeGraph is paused');
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(root, '.codegraph', 'daemon.pid'))).toBe(false);
  }, 30000);
});
