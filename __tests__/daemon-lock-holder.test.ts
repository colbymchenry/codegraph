/**
 * Issue #2770: `codegraph index` could not stop a project's daemon whose lock
 * named a live process it couldn't verify, and told the user to run
 * `codegraph daemon stop`, a command the CLI rejects. `codegraph daemon` lists
 * nothing in that state and `codegraph unlock` kept the lock, so nothing the
 * CLI offered got past it.
 *
 * A lock whose live holder the OS shows is not a CodeGraph server (a pid the
 * OS gave to another program, or a lock written by hand) is now treated as
 * stale, the way a dead holder's is: `index` clears it and rebuilds, and
 * `unlock` clears it, without signalling the process. A holder that does run a
 * CodeGraph server keeps its lock, and the message names that process and a
 * command that stops it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { encodeLockInfo, getDaemonPidPath } from '../src/mcp/daemon-paths';
import { isProcessAlive } from '../src/mcp/daemon-registry';
import {
  classifyLockHolder,
  describeProcess,
  isCodeGraphServerCommandLine,
} from '../src/mcp/process-identity';
import { tryAcquireWriterLock, releaseWriterLock } from '../src/mcp/writer-lock';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const windows = process.platform === 'win32';
const holders: number[] = [];
let root: string;

/**
 * Each OS lookup gets a minute here, in this process and in the CLIs it runs,
 * not the 5 s CodeGraph gives one: on a loaded machine PowerShell can take
 * longer than that to start, and a Windows lookup that runs out falls back to
 * tasklist, which has no command line to show. The tests that look a process
 * up allow for it.
 */
const LOOKUP_ENV = 'CODEGRAPH_PROCESS_LOOKUP_TIMEOUT_MS';
const savedLookupTimeout = process.env[LOOKUP_ENV];
beforeAll(() => {
  process.env[LOOKUP_ENV] = '60000';
});
afterAll(() => {
  if (savedLookupTimeout === undefined) delete process.env[LOOKUP_ENV];
  else process.env[LOOKUP_ENV] = savedLookupTimeout;
});

/**
 * Start a long-lived process to be named by the lock: `native` is no
 * JavaScript runtime, `node` is Node running something else, and
 * `codegraph-server` is Node with a CodeGraph MCP server's command line.
 */
function startHolder(kind: 'native' | 'node' | 'codegraph-server'): number {
  const idle = ['-e', 'setInterval(() => {}, 1000)'];
  const [command, args] = kind === 'native'
    ? windows
      ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), ['-n', '600', '127.0.0.1']]
      : ['sleep', ['600']]
    : kind === 'node'
      ? [process.execPath, idle]
      : [process.execPath, [...idle, path.join(root, 'install', 'dist', 'bin', 'codegraph.js'), 'serve', '--mcp', '--path', root]];
  const child = spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  if (!child.pid) throw new Error(`could not start a ${kind} holder`);
  holders.push(child.pid);
  return child.pid;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1' },
  });
}

function writeLegacyLock(pid: number): string {
  const lockPath = getDaemonPidPath(root);
  fs.writeFileSync(lockPath, `${pid}\n`);
  return lockPath;
}

/** A current-format lock whose socket no daemon listens on. */
function writeLock(pid: number): string {
  const lockPath = getDaemonPidPath(root);
  fs.writeFileSync(lockPath, encodeLockInfo({
    pid,
    version: '1.6.2',
    socketPath: windows ? '\\\\.\\pipe\\codegraph-2770-nobody-listens' : path.join(root, '.codegraph', 'nobody-listens.sock'),
    startedAt: Date.now() - 60_000,
  }));
  return lockPath;
}

function stopCommand(pid: number): string {
  return windows ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-holder-')));
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
});

afterEach(() => {
  for (const pid of holders.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  releaseWriterLock(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('what a lock holder is (#2770)', () => {
  it('recognizes a CodeGraph MCP server by its command line', () => {
    expect(isCodeGraphServerCommandLine(
      '"C:\\Program Files\\nodejs\\node.exe" --liftoff-only --disable-warning=ExperimentalWarning ' +
      '"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@colbymchenry\\codegraph\\lib\\dist\\bin\\codegraph.js" serve --mcp --path D:\\proj',
    )).toBe(true);
    expect(isCodeGraphServerCommandLine('/opt/codegraph/node /opt/codegraph/lib/dist/bin/codegraph.js serve --mcp --path /src/app')).toBe(true);
    expect(isCodeGraphServerCommandLine('node /usr/lib/node_modules/@colbymchenry/codegraph/dist/bin/codegraph.js index')).toBe(false);
    expect(isCodeGraphServerCommandLine('node server.js serve --mcp')).toBe(false);
    expect(isCodeGraphServerCommandLine('C:\\Windows\\Explorer.EXE')).toBe(false);
  });

  it('counts only what the OS shows as evidence', () => {
    expect(classifyLockHolder({ name: 'explorer.exe', commandLine: 'C:\\Windows\\Explorer.EXE' })).toBe('other');
    expect(classifyLockHolder({ name: 'node.exe', commandLine: 'node.exe -e "setInterval(() => {}, 1000)"' })).toBe('other');
    expect(classifyLockHolder({ name: 'node', commandLine: 'node codegraph.js serve --mcp --path /p' })).toBe('codegraph-server');
    // No command line (another user's or an elevated process): only an
    // executable that is no JavaScript runtime rules the holder out.
    expect(classifyLockHolder({ name: 'svchost.exe', commandLine: null })).toBe('other');
    expect(classifyLockHolder({ name: 'node.exe', commandLine: null })).toBe('unknown');
    expect(classifyLockHolder({ name: '/usr/local/bin/node', commandLine: null })).toBe('unknown');
    expect(classifyLockHolder({ name: null, commandLine: null })).toBe('unknown');
  });

  it('reads a running process from the OS', async () => {
    const native = startHolder('native');
    const server = startHolder('codegraph-server');
    const nativeInfo = await describeProcess(native);
    expect(nativeInfo.commandLine ?? '').toMatch(windows ? /ping/i : /sleep/);
    expect(classifyLockHolder(nativeInfo)).toBe('other');
    expect(classifyLockHolder(await describeProcess(server))).toBe('codegraph-server');
    process.kill(native, 'SIGKILL');
    const end = Date.now() + 30_000;
    while (isProcessAlive(native) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(classifyLockHolder(await describeProcess(native))).toBe('unknown');
  }, 240_000);

  // Windows starts no process within a millisecond, so both of its queries run out.
  it.runIf(windows)('a lookup that runs out of time says nothing, so the holder stays unknown', async () => {
    const native = startHolder('native');
    process.env[LOOKUP_ENV] = '1';
    try {
      const info = await describeProcess(native);
      expect(info).toEqual({ name: null, commandLine: null });
      expect(classifyLockHolder(info)).toBe('unknown');
    } finally {
      process.env[LOOKUP_ENV] = '60000';
    }
  }, 30_000);
});

describe('codegraph index and unlock with a daemon lock naming a live process (#2770)', () => {
  it.each([
    ['an old-format lock naming a program that is not a JavaScript runtime', 'native', writeLegacyLock],
    ['an old-format lock naming a Node process that is not CodeGraph', 'node', writeLegacyLock],
    ['a lock naming a Node process that is not CodeGraph', 'node', writeLock],
  ] as const)('index clears %s and rebuilds, leaving the process alone', (_, kind, write) => {
    const holder = startHolder(kind);
    const lockPath = write(holder);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function replacementSymbol() { return 2; }\n');

    const index = runCli(['index', '--quiet', root]);

    expect(index.stderr + index.stdout).not.toContain('daemon stop');
    expect(index.status, index.stderr).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(isProcessAlive(holder)).toBe(true);
    const cg = CodeGraph.openSync(root);
    try { expect(cg.searchNodes('replacementSymbol').length).toBeGreaterThan(0); }
    finally { cg.close(); }
  }, 300_000);

  it('unlock clears an old-format lock naming a process that is not CodeGraph, leaving the process alone', () => {
    const holder = startHolder('native');
    const lockPath = writeLegacyLock(holder);

    const unlock = runCli(['unlock', root]);

    expect(unlock.status, unlock.stderr).toBe(0);
    expect(unlock.stdout).toContain('Removed stale lock artifacts');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(isProcessAlive(holder)).toBe(true);
  }, 300_000);

  it.each([
    ['an old-format lock', writeLegacyLock],
    ['a lock', writeLock],
  ] as const)('keeps %s held by a CodeGraph server that does not answer, and names a command that clears it', async (_, write) => {
    const holder = startHolder('codegraph-server');
    const lockPath = write(holder);

    const index = runCli(['index', '--quiet', root]);

    expect(index.status).toBe(1);
    const message = index.stderr + index.stdout;
    expect(message).not.toContain('daemon stop');
    expect(message).toContain(`Process ${holder} runs a CodeGraph server`);
    expect(message).toContain(`\`${stopCommand(holder)}\``);
    expect(isProcessAlive(holder)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);

    // The advice: stop that process, then retry `codegraph index`.
    process.kill(holder, 'SIGKILL');
    const end = Date.now() + 30_000;
    while (isProcessAlive(holder) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const retry = runCli(['index', '--quiet', root]);
    expect(retry.status, retry.stderr).toBe(0);
  }, 600_000);

  it('names the stale writer lock when the same process that is not CodeGraph holds it too', () => {
    const holder = startHolder('native');
    writeLock(holder);
    // Both of a crashed daemon's lock files, once the OS has reused its pid.
    const writerPath = path.join(root, '.codegraph', 'writer.pid');
    fs.writeFileSync(writerPath, JSON.stringify({ pid: holder, mode: 'daemon', startedAt: Date.now() - 60_000, ready: true }) + '\n');

    const index = runCli(['index', '--quiet', root]);

    expect(index.status).toBe(1);
    const message = index.stderr + index.stdout;
    expect(message).toContain(`names process ${holder}, which is not a CodeGraph process, so it is stale: delete ${writerPath}`);
    fs.rmSync(writerPath);
    const retry = runCli(['index', '--quiet', root]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(isProcessAlive(holder)).toBe(true);
  }, 600_000);

  it('the writer-lock message names `codegraph daemon`, a command the CLI accepts', () => {
    expect(tryAcquireWriterLock(root, 'daemon').kind).toBe('acquired');
    try {
      const index = runCli(['index', '--quiet', root]);
      expect(index.status).toBe(1);
      const message = index.stderr + index.stdout;
      expect(message).toContain('writer lock held');
      expect(message).not.toContain('daemon stop');
      expect(message).toContain('pick it in `codegraph daemon`');
    } finally {
      releaseWriterLock(root);
    }
    const daemon = runCli(['daemon']);
    expect(daemon.stderr).not.toContain('too many arguments');
    expect(daemon.status, daemon.stderr).toBe(0);
  }, 60_000);
});
