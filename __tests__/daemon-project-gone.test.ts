/**
 * A daemon exits once the project it serves is gone (#3245).
 *
 * A git worktree removed, or a project folder deleted, under a running daemon
 * left it serving, watching (a recursive watch on a folder that no longer
 * exists) and registered until its last client disconnected and the idle
 * timeout passed. Short-lived agent worktrees made that common. The daemon now
 * checks every few seconds and exits once the project has stayed gone for a
 * grace period, so a network share that drops out for a moment doesn't stop a
 * healthy one.
 *
 * Gone looks different per platform. On macOS and Linux the whole folder goes.
 * On Windows the daemon's open database keeps `.codegraph/` from being
 * deleted with the rest (`rd /s /q`, `git worktree remove`), but `daemon.pid`,
 * which nothing holds open, goes with the folder, so a lock file that is gone
 * or names another process counts too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { Daemon, projectGoneReason } from '../src/mcp/daemon';
import { encodeLockInfo, getDaemonPidPath } from '../src/mcp/daemon-paths';
import { deregisterDaemon, listDaemons, registerDaemon } from '../src/mcp/daemon-registry';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function writeLock(root: string, pid: number): string {
  const pidPath = getDaemonPidPath(root);
  fs.writeFileSync(pidPath, encodeLockInfo({ pid, version: '0.0.0-test', socketPath: 'x', startedAt: Date.now() }));
  return pidPath;
}

describe('projectGoneReason (#3245)', () => {
  let root: string;
  let pidPath: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-gone-')));
    fs.mkdirSync(path.join(root, '.codegraph'));
    pidPath = writeLock(root, 4242);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is null while the folder, .codegraph/ and a lock naming this daemon are there', () => {
    expect(projectGoneReason(root, pidPath, 4242)).toBeNull();
  });

  it('reports the project folder removed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(projectGoneReason(root, pidPath, 4242)).toMatch(/was removed/);
  });

  it('reports .codegraph/ removed', () => {
    fs.rmSync(path.join(root, '.codegraph'), { recursive: true, force: true });
    expect(projectGoneReason(root, pidPath, 4242)).toMatch(/\.codegraph was removed/);
  });

  it('reports the lock file removed, as deleting the folder does on Windows', () => {
    fs.rmSync(pidPath);
    expect(projectGoneReason(root, pidPath, 4242)).toMatch(/lock file .* was removed/);
  });

  it('reports a lock file that names another process', () => {
    writeLock(root, 4343);
    expect(projectGoneReason(root, pidPath, 4242)).toMatch(/now names pid 4343/);
  });

  it('looks again at a lock file caught mid-write', () => {
    fs.writeFileSync(pidPath, '{"pid": 42');
    expect(projectGoneReason(root, pidPath, 4242)).toBeNull();
  });
});

describe('Daemon.checkProject (#3245)', () => {
  // A Daemon is safe to construct (nothing binds until start()); stop() is
  // replaced so a positive check can't tear down the test process.
  const makeDaemon = (rootGoneGraceMs: number) => {
    const d = new Daemon(path.join(os.tmpdir(), 'codegraph-project-gone-unit-test'), { idleTimeoutMs: 0, rootGoneGraceMs }) as any;
    d.stop = vi.fn(async () => {});
    return d;
  };
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errors = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write); });
  afterEach(() => { errors.mockRestore(); });

  it('exits only once the project has stayed gone for the grace period', () => {
    const d = makeDaemon(30_000);
    const gone = () => 'its lock file was removed';
    expect(d.checkProject(gone, 1_000)).toBe(false);
    expect(d.checkProject(gone, 30_999)).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
    expect(d.checkProject(gone, 31_000)).toBe(true);
    expect(d.stop).toHaveBeenCalledWith('project removed');
  });

  it('starts the grace period over when the project comes back, as a network share does', () => {
    const d = makeDaemon(30_000);
    const gone = () => 'D:\\share\\project was removed';
    expect(d.checkProject(gone, 0)).toBe(false);
    expect(d.checkProject(() => null, 20_000)).toBe(false);
    expect(d.checkProject(gone, 25_000)).toBe(false);
    expect(d.checkProject(gone, 50_000)).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
    expect(d.checkProject(gone, 55_000)).toBe(true);
  });

  it('keeps running while the project is there, and does nothing once stopping', () => {
    const d = makeDaemon(0);
    expect(d.checkProject(() => null, 0)).toBe(false);
    d.stopping = true;
    expect(d.checkProject(() => 'gone', 1)).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
  });
});

describe('deregisterDaemon with a pid (#3245)', () => {
  it('removes this daemon\'s record and leaves one that names another daemon', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-gone-registry-')));
    // The record files themselves: listDaemons leaves out a record whose pid is dead.
    const registry = path.join(os.homedir(), '.codegraph', 'daemons');
    const naming = (pid: number) => {
      let files: string[] = [];
      try { files = fs.readdirSync(registry); } catch { return 0; }
      return files.filter((f) => {
        try { const r = JSON.parse(fs.readFileSync(path.join(registry, f), 'utf8')); return r.root === root && r.pid === pid; } catch { return false; }
      }).length;
    };
    try {
      registerDaemon({ root, pid: 4343, version: '0.0.0-test', socketPath: 'x', startedAt: Date.now() });
      expect(naming(4343)).toBe(1);
      deregisterDaemon(root, 4242);
      expect(naming(4343)).toBe(1);
      deregisterDaemon(root, 4343);
      expect(naming(4343)).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Delete what can be deleted, as `rd /s /q` does: skip what is held open. */
function deleteWhatYouCan(dir: string): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) deleteWhatYouCan(p);
    else try { fs.unlinkSync(p); } catch { /* held open */ }
  }
  try { fs.rmdirSync(dir); } catch { /* not empty */ }
}

describe('a running daemon exits once its project is deleted (#3245)', () => {
  let root: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-gone-e2e-')));
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function a(): number { return 1; }\n');
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
  }, 60_000);

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    child = null;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('stops serving, closes the index and drops its registry record', async () => {
    child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--path', root], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_DAEMON_INTERNAL: '1',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '120000',
        CODEGRAPH_DAEMON_ROOT_CHECK_MS: '100',
        CODEGRAPH_DAEMON_ROOT_GRACE_MS: '500',
      },
    }) as ChildProcessWithoutNullStreams;
    child.stdout.resume();
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child!.once('exit', (code) => resolve(code)));

    const deadline = Date.now() + 30_000;
    while (!/Listening on/.test(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(log).toMatch(/Listening on/);
    expect(listDaemons({ prune: false }).some((r) => r.root === root && r.pid === child!.pid)).toBe(true);

    // The folder goes, as far as the OS lets it while the daemon runs: all of
    // it on macOS and Linux; on Windows all but the open database files.
    deleteWhatYouCan(root);

    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]);
    expect(code).toBe(0);
    expect(log).toMatch(/The project is gone/);
    expect(listDaemons({ prune: false }).some((r) => r.root === root)).toBe(false);
    // Nothing holds the rest any more: the delete completes.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(fs.existsSync(root)).toBe(false);
  }, 90_000);
});
