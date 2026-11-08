/**
 * Deferred liveness watchdog for unindexed stdio sessions (#3250).
 *
 * A `codegraph serve --mcp` session launched in a directory with no indexed
 * project used to start a dedicated liveness watchdog child process during
 * startup — before the client issued any tool call. A client that only
 * discovers the tool catalog paid for a process it never used (on Windows/npm
 * 1.6.2: 3 Node processes and ~117 MiB per client instead of 2 and ~98 MiB).
 *
 * The watchdog must only be armed once work that needs it begins: the first
 * `tools/call`, a project named at launch (`--path`) or at `initialize`
 * (rootUri/workspaceFolders) that actually resolves to an indexed root, or a
 * `tools/list` that ends up opening a default project. Discovery-only
 * sessions (`initialize` + `tools/list`, no project anywhere) must have no
 * watchdog child. EOF cleanup must still reap the server and its watchdog.
 *
 * Process-count assertions are Linux-only (they read /proc); the suite is
 * skipped elsewhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const IS_LINUX = process.platform === 'linux';

function spawnServer(
  cwd: string,
  args: string[] = ['serve', '--mcp'],
  extraEnv: Record<string, string> = {}
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Direct (in-process) mode — the unindexed path never has a daemon
    // anyway (the daemon socket lives in .codegraph/).
    // CODEGRAPH_WASM_RELAUNCHED skips the --liftoff-only re-exec: without
    // it the server runs as a GRANDCHILD that survives child.kill() on
    // Windows and holds the temp cwd/SQLite handles, failing teardown with
    // EPERM no matter how long rmSync retries (the class documented for
    // the mcp-initialize/mcp-roots suites).
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', ...extraEnv },
  }) as ChildProcessWithoutNullStreams;
}

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout waiting for response id=${msg.id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === msg.id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // non-JSON noise on stdout — ignore
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

function notify(child: ChildProcessWithoutNullStreams, method: string): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}

/** Direct child pids of `pid` (Linux only). */
function childPids(pid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim();
    return out ? out.split('\n').map(Number) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a pid is a CodeGraph liveness watchdog child: it runs `node -e`
 * with the #850 kill notice baked into its source.
 */
function isWatchdogChild(pid: number): boolean {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('Main thread unresponsive');
  } catch {
    return false;
  }
}

function watchdogChildPids(serverPid: number): number[] {
  return childPids(serverPid).filter(isWatchdogChild);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function handshake(child: ChildProcessWithoutNullStreams): Promise<void> {
  await request(child, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test', version: '1' },
      capabilities: {},
    },
  });
  notify(child, 'notifications/initialized');
}

describe.skipIf(!IS_LINUX)('deferred liveness watchdog (#3250)', () => {
  let tempDir: string;
  let projectDir: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deferred-watchdog-'));
  });

  afterEach(async () => {
    if (child) {
      const c = child;
      child = null;
      try {
        c.stdin.end();
      } catch {
        /* already gone */
      }
      await Promise.race([new Promise((r) => c.on('exit', r)), sleep(8000)]);
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (projectDir) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      projectDir = null;
    }
  });

  it('starts no watchdog child for a discovery-only session with no project', async () => {
    child = spawnServer(tempDir);
    await handshake(child);
    const list = await request(child, { id: 2, method: 'tools/list', params: {} });
    expect(Array.isArray((list.result as { tools?: unknown[] })?.tools)).toBe(true);
    await sleep(500);
    expect(watchdogChildPids(child.pid)).toEqual([]);
  }, 30000);

  it('arms the watchdog on the first tools/call', async () => {
    child = spawnServer(tempDir);
    await handshake(child);
    await request(child, { id: 2, method: 'tools/list', params: {} });
    const call = await request(child, {
      id: 3,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    expect((call as { error?: unknown }).error).toBeUndefined();
    await sleep(500);
    expect(watchdogChildPids(child.pid).length).toBe(1);
  }, 30000);

  it('arms the watchdog at startup when launched with --path to an indexed project', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deferred-watchdog-proj-'));
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const a = 1;\n');
    const cg = await CodeGraph.init(projectDir);
    cg.close();
    child = spawnServer(tempDir, ['serve', '--mcp', '--path', projectDir]);
    await handshake(child);
    await request(child, { id: 2, method: 'tools/list', params: {} });
    await sleep(500);
    expect(watchdogChildPids(child.pid).length).toBe(1);
  }, 60000);

  it('EOF still reaps the server and its watchdog child', async () => {
    child = spawnServer(tempDir);
    await handshake(child);
    await request(child, { id: 2, method: 'tools/list', params: {} });
    await request(child, {
      id: 3,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    await sleep(500);
    const wd = watchdogChildPids(child.pid);
    expect(wd.length).toBe(1);
    const serverPid = child.pid;
    child.stdin.end();
    await Promise.race([new Promise((r) => child!.on('exit', r)), sleep(8000)]);
    expect(child.exitCode).toBe(0);
    await sleep(500);
    expect(isAlive(serverPid)).toBe(false);
    expect(wd.every((p) => !isAlive(p))).toBe(true);
  }, 30000);
});
