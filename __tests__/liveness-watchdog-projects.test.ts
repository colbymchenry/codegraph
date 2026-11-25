/**
 * The liveness watchdog counts disk progress on every index the process
 * writes, not only the one it was armed with (#2404).
 *
 * The shared daemon arms its watchdog with its own project's index files, yet
 * it also syncs every other project a session names by `projectPath`, on the
 * same main thread. A long sync of one of those read as a wedge (heartbeat
 * silence, no change on the watched files), so the healthy daemon was
 * SIGKILLed mid-sync, and again after every reattach. A proxy serving
 * in-process, armed with no files at all, had the same blind spot.
 *
 * Each case spawns a real process with the real watchdog child and a short
 * timeout (the technique of liveness-watchdog.test.ts), then blocks that
 * process's main thread while a file or an index advances.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { getCodeGraphDir } from '../src/directory';
import { getWriterPidPath } from '../src/mcp/writer-lock';

const WATCHDOG = path.resolve(__dirname, '../dist/mcp/liveness-watchdog.js');
const LIFECYCLE = path.resolve(__dirname, '../dist/mcp/project-lifecycle.js');

beforeAll(() => {
  for (const file of [WATCHDOG, LIFECYCLE]) {
    if (!fs.existsSync(file)) throw new Error(`Build the project first: ${file} is missing (run npm run build).`);
  }
});

const dirs: string[] = [];
afterEach(async () => {
  // A killed process may hold its SQLite files for a moment on Windows.
  for (const dir of dirs.splice(0)) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wdp-'));
  dirs.push(dir);
  return dir;
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | 'TIMEOUT' | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `body` in a fresh Node process whose watchdog times out after
 * `timeoutMs`. Resolves once the process and its watchdog child are gone (the
 * child shares the process's stderr, where it writes its kill notice).
 */
function runChild(body: string, timeoutMs: number, hardTimeoutMs = 15_000): Promise<Outcome> {
  const child = spawn(process.execPath, ['-e', body], {
    env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '0', CODEGRAPH_WATCHDOG_TIMEOUT_MS: String(timeoutMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'TIMEOUT', stdout, stderr });
    }, hardTimeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The process blocked its main thread and ran to its own exit(5). */
function expectSurvived(r: Outcome): void {
  expect(r.stdout, r.stderr).toContain('BLOCKING');
  expect(r.stderr).not.toContain('Main thread unresponsive');
  expect(r.signal).toBeNull();
  expect(r.code, r.stderr).toBe(5);
}

/** The process blocked its main thread and the watchdog killed it there. */
function expectKilled(r: Outcome): void {
  expect(r.stdout, r.stderr).toContain('BLOCKING');
  expect(r.stderr).toContain('Main thread unresponsive');
  expect(r.code).not.toBe(5);
}

/** Grow `file` every 100ms for `forMs`. */
function growFile(file: string, forMs: number): Promise<void> {
  return new Promise((resolve) => {
    const iv = setInterval(() => { fs.appendFileSync(file, 'x'.repeat(64)); }, 100);
    setTimeout(() => { clearInterval(iv); resolve(); }, forMs);
  });
}

/** Spawned-process source: block the main thread for `ms`, then exit(5). */
const block = (ms: number): string => `
  require('fs').writeSync(1, 'BLOCKING\\n');
  const end = Date.now() + ${ms};
  while (Date.now() < end) {}
  process.exit(5);
`;

describe('files added to the watchdog at runtime (#2404)', () => {
  it('counts a file added after arming as progress, like an armed one', async () => {
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const [r] = await Promise.all([
      runChild(`
        const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
        installMainThreadWatchdog();
        addWatchdogProgressPaths([${JSON.stringify(file)}]);
        setTimeout(() => { ${block(2500)} }, 200);
      `, 500),
      growFile(file, 3500),
    ]);
    expectSurvived(r);
  }, 20_000);

  it('counts every file one call adds, right before a block', async () => {
    // Two files in one call, then the main thread blocks at once and only the
    // second advances, as a sync advances the -wal it registered after the db.
    const dir = tempDir();
    const db = path.join(dir, 'other.db');
    const wal = path.join(dir, 'other.db-wal');
    fs.writeFileSync(db, 'seed');
    fs.writeFileSync(wal, 'seed');
    const [r] = await Promise.all([
      runChild(`
        const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
        installMainThreadWatchdog();
        setTimeout(() => {
          addWatchdogProgressPaths([${JSON.stringify(db)}, ${JSON.stringify(wal)}]);
          ${block(2500)}
        }, 200);
      `, 500),
      growFile(wal, 3500),
    ]);
    expectSurvived(r);
  }, 20_000);

  it('counts a file added before the watchdog was armed', async () => {
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const [r] = await Promise.all([
      runChild(`
        const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
        addWatchdogProgressPaths([${JSON.stringify(file)}]);
        installMainThreadWatchdog();
        setTimeout(() => { ${block(2500)} }, 200);
      `, 500),
      growFile(file, 3500),
    ]);
    expectSurvived(r);
  }, 20_000);

  it('keeps counting a file while another registration of it holds', async () => {
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const [r] = await Promise.all([
      runChild(`
        const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
        installMainThreadWatchdog();
        const first = addWatchdogProgressPaths([${JSON.stringify(file)}]);
        addWatchdogProgressPaths([${JSON.stringify(file)}]);
        first();
        first(); // idempotent: must not drop the second registration
        setTimeout(() => { ${block(2500)} }, 200);
      `, 500),
      growFile(file, 3500),
    ]);
    expectSurvived(r);
  }, 20_000);

  it('stops counting a file once dropped', async () => {
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const [r] = await Promise.all([
      runChild(`
        const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
        installMainThreadWatchdog();
        const drop = addWatchdogProgressPaths([${JSON.stringify(file)}]);
        setTimeout(() => { drop(); setTimeout(() => { ${block(2500)} }, 100); }, 100);
      `, 500),
      growFile(file, 3500),
    ]);
    expectKilled(r);
  }, 20_000);

  it('leaves no watchdog process behind as files come and go', async () => {
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const child = spawn(process.execPath, ['-e', `
      const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
      const handle = installMainThreadWatchdog();
      const drop = addWatchdogProgressPaths([${JSON.stringify(file)}]);
      setTimeout(() => {
        drop();
        setTimeout(() => {
          addWatchdogProgressPaths([${JSON.stringify(file)}]);
          setTimeout(() => { handle.stop(); process.exit(0); }, 300);
        }, 200);
      }, 200);
    `], {
      env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '0', CODEGRAPH_WATCHDOG_TIMEOUT_MS: '5000', CODEGRAPH_MCP_DEBUG: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    // 'exit', not 'close': a watchdog child left alive would hold the stderr pipe.
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code, stderr).toBe(0);
    const armed = (): number[] => [...stderr.matchAll(/armed \(child pid (\d+)\)/g)].map((m) => Number(m[1]));
    for (const until = Date.now() + 2000; armed().length < 4 && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pids = armed();
    // The first child, then one per change (added, dropped, added again).
    expect(pids, stderr).toHaveLength(4);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const survivors = pids.filter(alive);
    for (const pid of survivors) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    expect(survivors).toEqual([]);
  }, 20_000);

  it('starts no new watchdog for files dropped on the way out', async () => {
    // A server letting go of its projects as it exits drops their files all at
    // once; that must not spawn a watchdog per project just to exit with it.
    const files = [0, 1, 2].map((i) => path.join(tempDir(), `other${i}.db-wal`));
    const child = spawn(process.execPath, ['-e', `
      const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
      installMainThreadWatchdog();
      const drops = ${JSON.stringify(files)}.map((file) => addWatchdogProgressPaths([file]));
      setTimeout(() => { for (const drop of drops) drop(); process.exit(0); }, 200);
    `], {
      env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '0', CODEGRAPH_WATCHDOG_TIMEOUT_MS: '5000', CODEGRAPH_MCP_DEBUG: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    expect(code, stderr).toBe(0);
    // The first child, then one per file added; none for the drops.
    expect([...stderr.matchAll(/armed \(child pid (\d+)\)/g)], stderr).toHaveLength(4);
  }, 20_000);

  it('does not mistake a file joining the watch list for the disk advancing', async () => {
    // The file never changes. The first silent timeout must compare it with
    // itself, not with the list from before it joined: kill at ~1.5s, well
    // before the process's own exit at ~2.6s.
    const file = path.join(tempDir(), 'other.db-wal');
    fs.writeFileSync(file, 'seed');
    const r = await runChild(`
      const { installMainThreadWatchdog, addWatchdogProgressPaths } = require(${JSON.stringify(WATCHDOG)});
      installMainThreadWatchdog();
      addWatchdogProgressPaths([${JSON.stringify(file)}]);
      setTimeout(() => { ${block(2400)} }, 200);
    `, 1500);
    expectKilled(r);
  }, 20_000);
});

describe('another project this process writes (#2404)', () => {
  /** A project with an empty index, as `codegraph init` leaves one. */
  function makeProject(): { root: string; db: string } {
    const root = tempDir();
    CodeGraph.initSync(root).close();
    return { root, db: path.join(getCodeGraphDir(root), 'codegraph.db') };
  }

  /**
   * Arm the watchdog for project A, as the daemon keyed on A arms it, attach
   * project B through the project lifecycle the daemon opens every
   * `projectPath` with, then store into B's index synchronously on the main
   * thread for 3s, as a long sync of B does. The graph object stands in for
   * CodeGraph: the lifecycle only watches, syncs and closes it.
   */
  function attachAndStore(a: { db: string }, b: { root: string; db: string }, opts: { release?: boolean } = {}): Promise<Outcome> {
    return runChild(`
      const { installMainThreadWatchdog } = require(${JSON.stringify(WATCHDOG)});
      const { acquireProject } = require(${JSON.stringify(LIFECYCLE)});
      const { DatabaseSync } = require('node:sqlite');
      const graph = { watch: () => true, sync: async () => ({}), close() {}, isIndexing: () => false };
      installMainThreadWatchdog({ progressPaths: [${JSON.stringify(a.db)}, ${JSON.stringify(`${a.db}-wal`)}] });
      const lease = acquireProject(${JSON.stringify(b.root)}, () => graph, {});
      lease.ready().then(async () => {
        if (${opts.release ? 'true' : 'false'}) {
          await lease.release();
          await new Promise((resolve) => setTimeout(resolve, 50)); // dropped files re-arm on the next turn
        }
        require('fs').writeSync(1, 'BLOCKING\\n');
        const db = new DatabaseSync(${JSON.stringify(b.db)});
        db.exec('CREATE TABLE IF NOT EXISTS store_2404 (x BLOB)');
        const end = Date.now() + 3000;
        while (Date.now() < end) db.exec('INSERT INTO store_2404 VALUES (randomblob(2048))');
        db.close();
        process.exit(5);
      });
    `, 1000);
  }

  it('lets a long store into another project it now writes run to completion', async () => {
    const a = makeProject();
    const b = makeProject();
    const r = await attachAndStore(a, b);
    expectSurvived(r);
  }, 20_000);

  it('does not count a project whose writer is another process', async () => {
    const a = makeProject();
    const b = makeProject();
    // B's live writer is someone else (this test process, as a direct server
    // that has caught up): the spawned process only reads B, so B's files
    // advancing says nothing about its own main thread.
    fs.writeFileSync(getWriterPidPath(b.root), JSON.stringify({ pid: process.pid, mode: 'direct', startedAt: Date.now(), ready: true }) + '\n');
    const r = await attachAndStore(a, b);
    expectKilled(r);
  }, 20_000);

  it('stops counting a project once it is released', async () => {
    const a = makeProject();
    const b = makeProject();
    const r = await attachAndStore(a, b, { release: true });
    expectKilled(r);
  }, 20_000);
});
