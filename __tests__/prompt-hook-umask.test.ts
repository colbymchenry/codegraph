/**
 * The prompt hook reaches the project's daemon when `.codegraph/` was made
 * with a umask of 0002 (#3417).
 *
 * The hook connects to no socket in a folder its group or others can write to
 * without a sticky bit, and the daemon's preferred socket lives in
 * `.codegraph/`. A umask of 0002, the default for users with a private group
 * (Ubuntu and others), makes that folder group-writable, so the hook never
 * reached the daemon. The daemon now binds in this user's runtime folder
 * (`$XDG_RUNTIME_DIR`, else `/run/user/<uid>`) first when `.codegraph/` is like that, and its clients
 * look there too; nothing's mode is changed. The modes are set explicitly
 * here, so the suite's own umask doesn't decide the result. The test sandbox
 * gives every file a private runtime folder (setup-home-sandbox.ts). Runtime
 * folders are made directly under /tmp: a socket path must stay short.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import { socketGoneReason } from '../src/mcp/daemon';
import { exploreViaDaemon } from '../src/mcp/hook-client';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const posix = process.platform !== 'win32';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** A private runtime folder with a short path. */
function privateRunDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/cg-run-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** A project with a `.codegraph/` of this mode. */
function projectWith(mode: number): string {
  const root = tempDir('cg-umask-');
  fs.mkdirSync(path.join(root, '.codegraph'));
  fs.chmodSync(path.join(root, '.codegraph'), mode);
  return root;
}

/** Set XDG_RUNTIME_DIR for one test. */
function runtimeDir(value: string | undefined): void {
  const previous = process.env.XDG_RUNTIME_DIR;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  });
  if (value === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = value;
}

const modeOf = (p: string): number => fs.statSync(p).mode & 0o7777;

describe.runIf(posix)('the daemon socket for a .codegraph/ made with umask 0002 (#3417)', () => {
  it('is in the runtime folder first when .codegraph/ is group-writable', () => {
    const run = privateRunDir();
    runtimeDir(run);
    for (const mode of [0o775, 0o777, 0o2775]) {
      const root = projectWith(mode);
      const candidates = getDaemonSocketCandidates(root);
      expect(candidates).toHaveLength(3);
      expect(path.dirname(candidates[0]!)).toBe(run);
      expect(path.basename(candidates[0]!)).toMatch(/^codegraph-[0-9a-f]{16}\.sock$/);
      expect(candidates[1]).toBe(path.join(root, '.codegraph', 'daemon.sock'));
      expect(candidates[2]!.startsWith(os.tmpdir())).toBe(true);
      // Nothing's mode is changed.
      expect(modeOf(path.join(root, '.codegraph'))).toBe(mode);
    }
  });

  it('stays in .codegraph/ when no one else could replace a socket there', () => {
    const run = privateRunDir();
    runtimeDir(run);
    for (const mode of [0o755, 0o700, 0o1777]) {
      const root = projectWith(mode);
      expect(getDaemonSocketCandidates(root)[0]).toBe(path.join(root, '.codegraph', 'daemon.sock'));
      expect(getDaemonSocketCandidates(root)).toHaveLength(2);
    }
  });

  // systemd's folder, for a process started without the variable, or with one
  // naming a folder others can write to (WSLg's shared one): the daemon and its
  // clients still agree. Where that folder isn't usable either, nothing changes.
  const systemdRunDir = posix ? `/run/user/${process.getuid!()}` : '';
  const systemdRunDirUsable = (() => {
    try {
      const stat = fs.statSync(systemdRunDir);
      return stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o022) === 0;
    } catch {
      return false;
    }
  })();
  it('is in /run/user/<uid> without a runtime folder of its own to trust, else as before', () => {
    const root = projectWith(0o775);
    const loose = privateRunDir();
    const group = privateRunDir();
    const sticky = privateRunDir();
    fs.chmodSync(loose, 0o777);
    fs.chmodSync(group, 0o770);
    fs.chmodSync(sticky, 0o1777);
    for (const value of [undefined, '', 'relative/run', loose, group, sticky, path.join(loose, 'missing')]) {
      runtimeDir(value);
      const candidates = getDaemonSocketCandidates(root);
      if (systemdRunDirUsable) {
        expect(path.dirname(candidates[0]!)).toBe(systemdRunDir);
        expect(candidates.slice(1)).toEqual([path.join(root, '.codegraph', 'daemon.sock'), candidates[2]]);
      } else {
        expect(candidates).toHaveLength(2);
        expect(candidates[0]).toBe(path.join(root, '.codegraph', 'daemon.sock'));
        expect(candidates[1]!.startsWith(os.tmpdir())).toBe(true);
      }
    }
  });

  it('is reported gone once its file is removed, as logging out removes the runtime folder', () => {
    const run = privateRunDir();
    const socketPath = path.join(run, 'codegraph-test.sock');
    fs.writeFileSync(socketPath, '');
    expect(socketGoneReason(socketPath)).toBeNull();
    fs.rmSync(run, { recursive: true, force: true });
    expect(socketGoneReason(socketPath)).toMatch(/was removed/);
  });

  it('lets the prompt hook reach the running daemon', async () => {
    const root = tempDir('cg-umask-e2e-');
    fs.writeFileSync(path.join(root, 'orders.ts'), 'export function placeOrder(): number { return 1; }\n');
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
    // As a umask of 0002 leaves it.
    fs.chmodSync(path.join(root, '.codegraph'), 0o775);

    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--path', root], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_DAEMON_INTERNAL: '1',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '120000',
        CODEGRAPH_DAEMON_ROOT_CHECK_MS: '100',
        CODEGRAPH_DAEMON_ROOT_GRACE_MS: '300',
      },
    }) as ChildProcessWithoutNullStreams;
    cleanups.push(async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    });
    child.stdout.resume();
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
    const deadline = Date.now() + 30_000;
    while (!/Listening on/.test(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(log).toMatch(/Listening on/);
    // In the sandbox's runtime folder, not the group-writable .codegraph/.
    expect(log).toContain(`Listening on ${path.join(process.env.XDG_RUNTIME_DIR!, 'codegraph-')}`);

    // A daemon still catching up after its start answers busy, which the hook
    // reads as no daemon; ask until it answers.
    let answer = await exploreViaDaemon(root, 'placeOrder', 20_000);
    for (let tries = 0; answer.status === 'unavailable' && tries < 100; tries++) {
      await new Promise((r) => setTimeout(r, 100));
      answer = await exploreViaDaemon(root, 'placeOrder', 20_000);
    }
    expect(answer.status).toBe('answered');
    expect(answer.status === 'answered' && answer.text).toContain('placeOrder');
    expect(modeOf(path.join(root, '.codegraph'))).toBe(0o775);

    // Its socket removed, as logging out removes the runtime folder, the daemon
    // exits rather than hold the project's locks where no client can reach it.
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    fs.rmSync(getDaemonSocketCandidates(root)[0]!, { force: true });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]);
    expect(code).toBe(0);
    expect(log).toMatch(/its socket .* was removed/);
  }, 90_000);
});
