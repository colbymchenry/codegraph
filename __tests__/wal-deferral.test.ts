/**
 * WAL checkpoint deferral during bulk indexing (#1231).
 *
 * The default 1000-page wal_autocheckpoint re-writes hot pages into the main
 * DB over and over during a bulk index (~95% of all disk I/O on slow
 * storage). indexAll defers auto-checkpointing for the whole run, a
 * WalCheckpointValve bounds WAL growth via off-thread PASSIVE checkpoints,
 * and the interval is restored afterwards. These tests pin the DB helpers,
 * the valve's trigger/dedupe/backpressure logic, and the end-to-end indexAll
 * behavior (identical graph with and without deferral; interval restored).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, resolveWalValveMb } from '../src/db/wal-valve';
import CodeGraph from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-deferral-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): DatabaseConnection {
  return DatabaseConnection.initialize(path.join(tmpDir, 'test.db'));
}

/** Grow the WAL: with autocheckpoint off, every commit appends and nothing folds back. */
function writeRows(db: DatabaseConnection, rows: number): void {
  const raw = db.getDb();
  raw.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)');
  const stmt = raw.prepare('INSERT INTO t (blob) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run('x'.repeat(4096));
}

describe('resolveWalValveMb', () => {
  it('honors a positive numeric override and falls back otherwise', () => {
    expect(resolveWalValveMb('64')).toBe(64);
    expect(resolveWalValveMb('64.9')).toBe(64);
    expect(resolveWalValveMb(undefined)).toBe(256);
    expect(resolveWalValveMb('')).toBe(256);
    expect(resolveWalValveMb('abc')).toBe(256);
    expect(resolveWalValveMb('0')).toBe(256);
    expect(resolveWalValveMb('-5')).toBe(256);
  });
});

describe('DatabaseConnection WAL helpers', () => {
  it('reads and writes the wal_autocheckpoint interval', () => {
    const db = openDb();
    expect(db.getWalAutocheckpoint()).toBe(1000); // SQLite default
    db.setWalAutocheckpoint(0);
    expect(db.getWalAutocheckpoint()).toBe(0);
    db.setWalAutocheckpoint(1000);
    expect(db.getWalAutocheckpoint()).toBe(1000);
    db.close();
  });

  it('reports WAL size that grows with deferred commits', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    const before = db.getWalSizeBytes();
    writeRows(db, 200);
    expect(db.getWalSizeBytes()).toBeGreaterThan(before);
    db.close();
  });

  it('checkpointWalPassive backfills the WAL from a worker connection and reports the result', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    const res = await db.checkpointWalPassive();
    // Backfill moves the committed pages into the main DB file…
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    // …and reports a full backfill (idle DB: every WAL frame checkpointed).
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(res!.log).toBeGreaterThan(0);
    expect(res!.checkpointed).toBe(res!.log);
    db.close();
  });
});

describe('WalCheckpointValve', () => {
  it('check() fires an off-thread checkpoint once growth passes the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500); // WAL well past a ~10-byte threshold
    const valve = new WalCheckpointValve(db, 0.00001); // ~10 bytes soft
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    db.close();
  });

  it('advances its baseline on a full backfill — a wrapped WAL does not retrigger it', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    await valve.drain(); // full backfill on an idle DB → baseline = current file size
    // The WAL file keeps its high-water size, but growth is now 0: neither
    // the timer path nor backpressure may fire again (the pre-fix bug fired
    // on raw size forever and serialized every store behind a checkpoint).
    expect(valve.backpressure()).toBeNull();
    valve.check();
    await valve.drain(); // no-op drain: nothing in flight
    // New commits recycle wrapped frames — file size is flat, still no trigger.
    writeRows(db, 5);
    expect(valve.backpressure()).toBeNull();
    db.close();
  });

  it('does not fire below the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 5);
    const valve = new WalCheckpointValve(db, 1024); // 1GB soft — never reached
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBe(mainSizeBefore);
    db.close();
  });

  it('backpressure() is null under the hard cap and a promise above it', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const relaxed = new WalCheckpointValve(db, 1024);
    expect(relaxed.backpressure()).toBeNull();
    const strict = new WalCheckpointValve(db, 0.0000001); // hard cap ~0.4 bytes
    const bp = strict.backpressure();
    expect(bp).toBeInstanceOf(Promise);
    await bp;
    await strict.drain();
    db.close();
  });

  it('foldNow() backfills everything at a phase boundary and resets growth', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 1024); // thresholds never reached on their own
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    await valve.foldNow();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore); // pages backfilled
    expect(valve.backpressure()).toBeNull(); // baseline advanced — growth is zero
    await valve.foldNow(); // second fold is a no-op (growth 0), must not spin
    db.close();
  });

  it('dedupes concurrent fires into one in-flight checkpoint', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    const first = valve.backpressure();
    const second = valve.backpressure();
    expect(second).toBe(first); // same in-flight promise, not a second worker
    db.close();
    return first ?? undefined;
  });
});

describe('indexAll WAL deferral end-to-end', () => {
  function writeFixtureProject(): void {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(tmpDir, 'src', `mod${i}.ts`),
        `export function fn${i}(x: number): number { return helper${i}(x) + ${i}; }\n` +
        `function helper${i}(x: number): number { return x * ${i}; }\n`
      );
    }
  }

  it('produces the same graph with and without deferral, and restores the interval', async () => {
    writeFixtureProject();

    const cg1 = CodeGraph.initSync(tmpDir);
    const r1 = await cg1.indexAll();
    expect(r1.success).toBe(true);
    // Deferral is scoped to the run: the connection is back on the default.
    const conn1 = (cg1 as unknown as { db: DatabaseConnection }).db;
    expect(conn1.getWalAutocheckpoint()).toBe(1000);
    const counts1 = { nodes: r1.nodesCreated, edges: r1.edgesCreated };
    await cg1.close();

    fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true, force: true });

    process.env.CODEGRAPH_NO_WAL_DEFER = '1';
    try {
      const cg2 = CodeGraph.initSync(tmpDir);
      const r2 = await cg2.indexAll();
      expect(r2.success).toBe(true);
      expect({ nodes: r2.nodesCreated, edges: r2.edgesCreated }).toEqual(counts1);
      await cg2.close();
    } finally {
      delete process.env.CODEGRAPH_NO_WAL_DEFER;
    }
  });
});
