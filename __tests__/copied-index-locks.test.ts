/** Copied indexes must recover without disturbing a live holder of the source index. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { canonicalProjectRoot } from '../src/directory';
import * as writer from '../src/mcp/writer-lock';
import { decodeLockInfo, getDaemonPidPath } from '../src/mcp/daemon-paths';
import { clearStaleDaemonLock, tryAcquireDaemonLock } from '../src/mcp/daemon';
import { FileLock } from '../src/utils';

// Inode identity is intentionally unavailable on Windows; recovery there stays
// PID-based. These tests exercise physical copies on a POSIX filesystem.
describe.runIf(process.platform !== 'win32')('copied index lock ownership', () => {
  let temp: string;
  let source: string;
  let target: string;
  let holder: ChildProcess;
  let pid: number;

  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-copy-lock-'));
    source = path.join(temp, 'source');
    target = path.join(temp, 'target');
    fs.mkdirSync(path.join(source, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(source, '.codegraph/codegraph.db'), 'fixture');
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(holder, 'spawn');
    if (!holder.pid) throw new Error('Holder did not start');
    pid = holder.pid;
  });

  afterEach(async () => {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  function stamp(root: string) {
    const id = (p: string) => {
      const s = fs.statSync(p, { bigint: true });
      return `${s.dev}:${s.ino}`;
    };
    return {
      root: canonicalProjectRoot(root),
      dirId: id(path.join(root, '.codegraph')),
      dbId: id(path.join(root, '.codegraph/codegraph.db')),
    };
  }

  function copy() {
    fs.cpSync(source, target, { recursive: true });
  }

  it.each(['writer.pid', 'rebuild.pid'] as const)('publishes and preserves identity in %s', (name) => {
    const result = writer.tryAcquireWriterLock(source, 'direct', name);
    expect(result.kind).toBe('acquired');
    expect(writer.readWriterLock(source, name)).toMatchObject(stamp(source));
    if (name === 'writer.pid') {
      writer.markWriterReady(source);
      expect(writer.readWriterLock(source)).toMatchObject({ ...stamp(source), ready: true });
      expect(writer.swapWriterLock(source, process.pid, {
        ...writer.readWriterLock(source)!, mode: 'handover',
      })).toBe(true);
      expect(writer.readWriterLock(source)).toMatchObject(stamp(source));
    }
  });

  it.each(['writer.pid', 'rebuild.pid'] as const)('reclaims a copied %s without stealing the source lock', (name) => {
    const record = { pid, mode: 'daemon', startedAt: Date.now(), ...stamp(source) };
    fs.writeFileSync(writer.getWriterPidPath(source, name), JSON.stringify(record));
    copy();
    expect(writer.readWriterLock(target, name)).toBeNull();
    if (name === 'rebuild.pid') expect(writer.isRebuildInProgress(target)).toBe(false);
    expect(writer.tryAcquireWriterLock(target, 'direct', name).kind).toBe('acquired');
    expect(writer.readWriterLock(target, name)).toMatchObject({ pid: process.pid, ...stamp(target) });
    expect(writer.tryAcquireWriterLock(source, 'direct', name).kind).toBe('taken');
    expect(writer.readWriterLock(source, name)).toMatchObject(record);
  });

  it('stamps daemon claims and clears only a copied daemon record, even while its source PID lives', () => {
    const acquired = tryAcquireDaemonLock(source);
    expect(acquired.kind).toBe('acquired');
    expect(decodeLockInfo(fs.readFileSync(getDaemonPidPath(source), 'utf8'))).toMatchObject(stamp(source));
    const record = { pid, version: '1.0.0', socketPath: path.join(source, 'unused.sock'), startedAt: 1, ...stamp(source) };
    const raw = JSON.stringify(record);
    fs.writeFileSync(getDaemonPidPath(source), raw);
    copy();
    const taken = tryAcquireDaemonLock(target);
    expect(taken.kind).toBe('taken');
    if (taken.kind === 'taken') expect(taken.existing).toBeNull();
    expect(decodeLockInfo(raw, target)).toBeNull();
    expect(clearStaleDaemonLock(getDaemonPidPath(target), pid, {
      expectedLockContents: raw, projectRoot: target,
    })).toBe(true);
    expect(tryAcquireDaemonLock(target).kind).toBe('acquired');
    expect(clearStaleDaemonLock(getDaemonPidPath(source), pid, { projectRoot: source })).toBe(false);
    expect(fs.readFileSync(getDaemonPidPath(source), 'utf8')).toBe(raw);
  });

  it('requires independent physical identities, preserving aliases, moves, restores, hard links and legacy records', () => {
    const original = stamp(source);
    copy();
    expect(writer.isForeignLockRecord(original, target)).toBe(true);
    expect(writer.isForeignLockRecord(original, source)).toBe(false);
    for (const record of [null, {}, { root: original.root }, { ...original, dbId: '' }, { ...original, root: 1 }]) {
      expect(writer.isForeignLockRecord(record, target)).toBe(false);
    }
    expect(writer.isForeignLockRecord({ ...original, root: stamp(target).root }, target)).toBe(false);
    expect(writer.isForeignLockRecord({ ...original, dbId: stamp(target).dbId }, target)).toBe(false);
    expect(writer.isForeignLockRecord({ ...original, dirId: stamp(target).dirId }, target)).toBe(false);
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(source, alias);
    expect(writer.lockStamp(alias)).toEqual(original);
    const moved = path.join(temp, 'moved');
    fs.renameSync(source, moved);
    expect(writer.isForeignLockRecord(original, moved)).toBe(false);
    fs.cpSync(moved, source, { recursive: true });
    expect(writer.isForeignLockRecord(original, source)).toBe(false);
    fs.unlinkSync(path.join(target, '.codegraph/codegraph.db'));
    fs.linkSync(path.join(moved, '.codegraph/codegraph.db'), path.join(target, '.codegraph/codegraph.db'));
    expect(writer.isForeignLockRecord(original, target)).toBe(false);
    fs.unlinkSync(path.join(target, '.codegraph/codegraph.db'));
    expect(writer.isForeignLockRecord(original, target)).toBe(false);
  });

  it('the database facade publishes a PID-compatible stamped codegraph.lock', () => {
    fs.rmSync(path.join(source, '.codegraph'), { recursive: true });
    const graph = CodeGraph.initSync(source);
    // The database facade's lock is exercised directly to avoid indexing a
    // language fixture just to observe the lock configuration it installs.
    const lock = (graph as unknown as { fileLock: FileLock }).fileLock;
    try {
      lock.acquire();
      const body = fs.readFileSync(path.join(source, '.codegraph/codegraph.lock'), 'utf8');
      expect(parseInt(body, 10)).toBe(process.pid);
      expect(JSON.parse(body.split('\n')[1])).toEqual(stamp(source));
    } finally {
      lock.release();
      graph.close();
    }
  });

  it('recovers a copied database lock only through the stale-takeover breaker', () => {
    const original = `${pid}\n${JSON.stringify(stamp(source))}\n`;
    fs.writeFileSync(path.join(source, '.codegraph/codegraph.lock'), original);
    copy();
    const lockPath = path.join(target, '.codegraph/codegraph.lock');
    const lock = new FileLock(lockPath, {
      stamp: () => writer.lockStamp(target),
      isForeign: (record) => writer.isForeignLockRecord(record, target),
    });
    // A genuinely live, different process holds the breaker; the copied
    // record must not bypass #3056's serialized stale takeover.
    fs.writeFileSync(`${lockPath}.break`, String(pid));
    expect(() => lock.acquire()).toThrow(/locked/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(original);
    fs.unlinkSync(`${lockPath}.break`);
    try {
      expect(() => lock.acquire()).not.toThrow();
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8').split('\n')[1])).toEqual(stamp(target));
      expect(fs.readFileSync(path.join(source, '.codegraph/codegraph.lock'), 'utf8')).toBe(original);
    } finally { lock.release(); }
    // PID-only and malformed identity records retain live-PID protection.
    for (const body of [String(pid), `${pid}\n{invalid`, `${pid}\n${JSON.stringify({ root: source })}`]) {
      fs.writeFileSync(lockPath, body);
      expect(() => lock.acquire()).toThrow(/locked/);
    }
  });
});
