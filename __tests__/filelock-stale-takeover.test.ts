/**
 * Taking over a stale `codegraph.lock` must leave exactly one holder (#2979).
 *
 * `FileLock.acquire()` used to read the lock, see a dead PID, unlink the file
 * and create its own. Two processes that both read the same dead PID could
 * then both succeed: the first replaced the stale lock, and the second, acting
 * on what it had read a moment earlier, unlinked the first one's live lock and
 * created its own. Both then wrote to the index as its only writer.
 *
 * The two-process cases pin that interleaving with a barrier rather than
 * timing: the slow contender stops right after reading the stale lock and
 * resumes only once the fast one holds it (see fixtures/filelock-contender.cjs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLock } from '../src/utils';

const UTILS = path.resolve(__dirname, '../dist/utils.js');
const CONTENDER = path.resolve(__dirname, 'fixtures/filelock-contender.cjs');
/** Above every platform's PID range (and odd, which no Windows PID is): never a live process. */
const DEAD_PID = '99999999';

interface Contender {
  child: ChildProcess;
  name: string;
  stderr: () => string;
  exited: Promise<number | null>;
}

describe('FileLock stale takeover (#2979)', () => {
  let dir: string;
  let lockPath: string;
  let markers: string;
  let contenders: Contender[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-filelock-'));
    lockPath = path.join(dir, 'codegraph.lock');
    markers = path.join(dir, 'markers');
    fs.mkdirSync(markers);
  });

  afterEach(async () => {
    for (const { child, exited } of contenders) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    contenders = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function track(name: string, args: string[]): Contender {
    const child = spawn(process.execPath, args, {
      // Off the fixture, so a child still exiting cannot hold it (Windows EBUSY).
      cwd: os.tmpdir(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const contender = { child, name, stderr: () => stderr, exited };
    contenders.push(contender);
    return contender;
  }

  const start = (name: string, mode: 'pause' | 'run') =>
    track(name, [CONTENDER, UTILS, lockPath, markers, name, mode]);
  /** A live process that never touches the lock: its PID names a holder that is alive. */
  const idle = () => track('idle', ['-e', 'setInterval(() => {}, 1000)']);

  /** The first of `names` (marker files) to appear, and its content. */
  async function firstMarker(names: string[], from: Contender[]): Promise<{ name: string; text: string }> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      for (const name of names) {
        const file = path.join(markers, name);
        if (fs.existsSync(file)) return { name, text: fs.readFileSync(file, 'utf8') };
      }
      if (Date.now() > deadline) {
        const detail = from.map((c) => `${c.name} (exit ${c.child.exitCode}): ${c.stderr()}`).join('\n');
        throw new Error(`none of ${names.join(', ')} appeared\n${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const release = (who: Contender) => fs.writeFileSync(path.join(markers, `${who.name}.release`), '');
  const go = () => fs.writeFileSync(path.join(markers, 'go'), '');

  it('lets only one of two processes take over a stale lock', async () => {
    fs.writeFileSync(lockPath, DEAD_PID);

    // The slow process reads the dead PID, then stalls before acting on it.
    const slow = start('slow', 'pause');
    const read = await firstMarker(['slow.read'], [slow]);
    expect(read.text.trim()).toBe(DEAD_PID);

    // Meanwhile another process takes the stale lock over, and holds it.
    const fast = start('fast', 'run');
    expect((await firstMarker(['fast.acquired', 'fast.refused'], [fast])).name).toBe('fast.acquired');

    // The slow one resumes with the dead PID it read: it must not replace a live lock.
    go();
    const slowOutcome = await firstMarker(['slow.acquired', 'slow.refused'], [slow]);
    expect(slowOutcome.name, 'both processes held the lock at once').toBe('slow.refused');
    expect(slowOutcome.text).toMatch(/locked by another process/);
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(fast.child.pid));

    release(fast);
    expect(await fast.exited).toBe(0);
    expect(await slow.exited).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 60_000);

  it('still lets the slow process in once the other one has released the lock', async () => {
    fs.writeFileSync(lockPath, DEAD_PID);

    const slow = start('slow', 'pause');
    await firstMarker(['slow.read'], [slow]);
    const fast = start('fast', 'run');
    expect((await firstMarker(['fast.acquired', 'fast.refused'], [fast])).name).toBe('fast.acquired');
    release(fast);
    await firstMarker(['fast.released'], [fast]);
    expect(await fast.exited).toBe(0);

    // The lock is free now: what the slow one read is out of date in the other direction.
    go();
    expect((await firstMarker(['slow.acquired', 'slow.refused'], [slow])).name).toBe('slow.acquired');
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(slow.child.pid));
    release(slow);
    expect(await slow.exited).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 60_000);

  it('leaves a stale lock to the process already taking it over', async () => {
    // A live process holds the takeover sentinel: it is replacing the stale lock right now.
    const breaker = idle();
    fs.writeFileSync(lockPath, DEAD_PID);
    fs.writeFileSync(`${lockPath}.break`, String(breaker.child.pid));

    const lock = new FileLock(lockPath);
    expect(() => lock.acquire()).toThrow(new RegExp(`locked by another process \\(PID ${breaker.child.pid}\\)`));
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(DEAD_PID);
    expect(fs.readFileSync(`${lockPath}.break`, 'utf8')).toBe(String(breaker.child.pid));
  });

  it('takes over a stale lock whose takeover sentinel a dead process left behind', () => {
    fs.writeFileSync(lockPath, DEAD_PID);
    fs.writeFileSync(`${lockPath}.break`, DEAD_PID);

    const lock = new FileLock(lockPath);
    lock.acquire();
    try {
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
      expect(fs.readdirSync(dir).sort()).toEqual(['codegraph.lock', 'markers']);
    } finally {
      lock.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('treats an empty lock file its creator may still be writing as held, and an old one as stale', () => {
    // A filesystem without hard links creates the lock first and writes the PID after.
    fs.writeFileSync(lockPath, '');
    const lock = new FileLock(lockPath);
    expect(() => lock.acquire()).toThrow(/locked by another process/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('');

    // Left empty by a crash long ago: stale.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    lock.acquire();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('treats a PID it may not signal (EPERM) as a live holder', () => {
    // Another user's process, or an elevated one on Windows: alive, just not ours to signal.
    const foreign = 4242;
    fs.writeFileSync(lockPath, String(foreign));
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === foreign && signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return true;
    }) as typeof process.kill);
    try {
      expect(() => new FileLock(lockPath).acquire()).toThrow(/locked by another process \(PID 4242\)/);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(foreign));
    } finally {
      kill.mockRestore();
    }
  });

  it.runIf(process.platform === 'win32')('keeps a lock whose holder Windows will not let us open, like an elevated process', () => {
    // PID 4 is always the System process: opening it to signal is refused (EPERM), as for an elevated one.
    fs.writeFileSync(lockPath, '4');
    expect(() => new FileLock(lockPath).acquire()).toThrow(/locked by another process \(PID 4\)/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('4');
  });

  it('leaves nothing but the lock file while held, and nothing after release', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    expect(fs.readdirSync(dir).sort()).toEqual(['codegraph.lock', 'markers']);
    lock.release();
    expect(fs.readdirSync(dir)).toEqual(['markers']);
  });
});
