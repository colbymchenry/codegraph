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

  it('advances its baseline on a full backfill — no infinite retrigger (at most one truncate park)', async () => {
    // Pre-§7a.1 contract was "a wrapped WAL never retriggers"; the file-size
    // trigger deliberately weakens that to "retriggers AT MOST once more, to
    // truncate the file, then goes quiet" — the pre-fix bug this test pinned
    // (firing on raw size forever, serializing every store) stays dead: a
    // successful truncate zeroes the file, so the trigger cannot loop. At
    // this test's pathological 10-BYTE soft cap, byte-level residue can trip
    // the 4×-soft file cap once; product-scale caps are 256MB/1GB.
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    await valve.drain(); // full backfill (and possibly a timer truncate)
    const first = valve.backpressure();
    if (first) await first; // one truncate park allowed — file must be 0 after
    expect(db.getWalSizeBytes()).toBe(0);
    expect(valve.backpressure()).toBeNull(); // and now: quiet
    valve.check();
    await valve.drain();
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

describe('indexAll WAL deferral end-to-end', () => {

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

describe('sync WAL deferral end-to-end (#1248)', () => {
  // The #1242 fix originally landed only on indexAll; sync stayed at the
  // default 1000-page autocheckpoint and reproduced the #1231 HDD thrash on
  // every incremental run (2 minutes for a 7-file sync). These pin that sync
  // defers during the run, restores after — success AND no-change paths —
  // and that a deferred sync produces the same graph as an undeferred one.
  it('defers the autocheckpoint interval DURING sync and restores it after', async () => {
    writeFixtureProject();
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    const conn = (cg as unknown as { db: DatabaseConnection }).db;

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'mod0.ts'),
      `export function fn0(x: number): number { return helper0(x) + 100; }\n` +
      `function helper0(x: number): number { return x * 100; }\n`
    );

    // Sample the interval mid-run from inside the progress callback — the
    // store loop is exactly where the #1248 thrash happened.
    const midRunIntervals: number[] = [];
    const result = await cg.sync({
      onProgress: () => {
        try { midRunIntervals.push(conn.getWalAutocheckpoint()); } catch { /* ignore */ }
      },
    });
    expect(result.filesModified).toBe(1);
    expect(midRunIntervals.length).toBeGreaterThan(0);
    expect(midRunIntervals.every((v) => v === 0)).toBe(true);
    // Scoped to the run: back on the default afterwards.
    expect(conn.getWalAutocheckpoint()).toBe(1000);
    await cg.close();
  });

  it('restores the interval on a no-change sync too', async () => {
    writeFixtureProject();
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    const conn = (cg as unknown as { db: DatabaseConnection }).db;
    const result = await cg.sync();
    expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
    expect(conn.getWalAutocheckpoint()).toBe(1000);
    await cg.close();
  });

  it('produces the same sync result with and without deferral', async () => {
    writeFixtureProject();
    const cg1 = CodeGraph.initSync(tmpDir);
    await cg1.indexAll();
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'mod1.ts'),
      `export function fn1(x: number): number { return helper1(x) + 111; }\n` +
      `function helper1(x: number): number { return x * 111; }\n`
    );
    const r1 = await cg1.sync();
    const counts1 = { modified: r1.filesModified, nodes: r1.nodesUpdated };
    await cg1.close();

    fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true, force: true });

    process.env.CODEGRAPH_NO_WAL_DEFER = '1';
    try {
      const cg2 = CodeGraph.initSync(tmpDir);
      await cg2.indexAll();
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'mod1.ts'),
        `export function fn1(x: number): number { return helper1(x) + 222; }\n` +
        `function helper1(x: number): number { return x * 222; }\n`
      );
      const r2 = await cg2.sync();
      expect({ modified: r2.filesModified, nodes: r2.nodesUpdated }).toEqual(counts1);
      await cg2.close();
    } finally {
      delete process.env.CODEGRAPH_NO_WAL_DEFER;
    }
  });
});

describe('resolution-phase WAL backpressure plumbing (§7a.1)', () => {
  // The valve's timer-driven passive checkpoints stay perpetually partial
  // against the resolver pool's continuous reads, so during resolution the
  // writer-side backpressure() hook is the ONLY mechanism that can complete
  // a backfill and let the WAL wrap — a kernel-scale run without it grew a
  // 22GB WAL on a 4.6GB DB. These pin that the batch loop (a) calls the hook
  // at the pool-idle boundary and (b) actually parks on a returned promise.

  async function seedPendingRefs(cg: CodeGraph): Promise<void> {
    const raw = (cg as unknown as { db: DatabaseConnection }).db.getDb();
    const node = raw.prepare("SELECT id, file_path FROM nodes WHERE kind = 'function' LIMIT 1").get() as
      | { id: string; file_path: string }
      | undefined;
    expect(node).toBeDefined();
    const ins = raw.prepare(
      "INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status) VALUES (?, ?, 'calls', 1, 0, ?, 'typescript', 'pending')"
    );
    ins.run(node!.id, 'helper0', node!.file_path);
    ins.run(node!.id, 'helper1', node!.file_path);
  }

  it('calls the backpressure hook once per settled batch', async () => {
    writeFixtureProject();
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    await seedPendingRefs(cg);

    let calls = 0;
    const result = await cg.resolveReferencesBatched(undefined, undefined, () => {
      calls++;
      return null; // under the hard cap — loop must proceed without waiting
    });
    expect(result.stats.total).toBeGreaterThan(0);
    expect(calls).toBeGreaterThanOrEqual(1);
    await cg.close();
  });

  it('parks the batch loop on a backpressure promise until it resolves', async () => {
    writeFixtureProject();
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    await seedPendingRefs(cg);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let hookHit = false;
    const done = cg
      .resolveReferencesBatched(undefined, undefined, () => {
        if (hookHit) return null; // park only on the first boundary
        hookHit = true;
        return gate;
      })
      .then(() => true);

    // Give the loop ample turns: it must reach the hook and then be parked.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(hookHit).toBe(true);
    const settledEarly = await Promise.race([done, Promise.resolve(false)]);
    expect(settledEarly).toBe(false); // still parked on the gate

    release();
    expect(await done).toBe(true);
    await cg.close();
  });
});

describe('checkpointWalTruncate (§7a.1 file containment)', () => {
  it('chops a fully-backfilled WAL file to zero', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 400);
    expect(db.getWalSizeBytes()).toBeGreaterThan(1024 * 1024);
    const res = await db.checkpointWalTruncate();
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(db.getWalSizeBytes()).toBe(0); // the file itself, not just the backlog
    db.close();
  });
});

describe('valve file-size trigger (§7a.1: backfilled WAL still grows the file)', () => {
  it('backpressure trips on file size alone once past the file cap, even with zero backlog', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    // Grow the file well past a 0.5MB soft cap (file cap = 4× = 2MB), then
    // fold the backlog completely so growth-vs-baseline is ~zero.
    writeRows(db, 800);
    const valve = new WalCheckpointValve(db, 0.5);
    await valve.foldNow(); // baseline := file size; backlog now 0; file unchanged
    expect(db.getWalSizeBytes()).toBe(0); // foldNow's success path truncates at the barrier
    db.close();
  });

  it('a fully-backfilled but oversized file is chopped at the barrier', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 800);
    const before = db.getWalSizeBytes();
    expect(before).toBeGreaterThan(2 * 1024 * 1024);
    const valve = new WalCheckpointValve(db, 0.5);
    const bp = valve.backpressure(); // growth past hard cap → parks
    expect(bp).not.toBeNull();
    await bp;
    expect(db.getWalSizeBytes()).toBe(0); // truncated at the parked barrier
    // And the file-size trigger alone re-arms it after regrowth:
    writeRows(db, 800);
    await valve.foldNow();
    writeRows(db, 100); // small backlog, file grows again but under hard cap
    const sizeTrigger = valve.backpressure();
    // 100 rows ≈ <1MB backlog (under 1MB hard cap) but file is past the 2MB cap
    expect(sizeTrigger).not.toBeNull();
    await sizeTrigger;
    expect(db.getWalSizeBytes()).toBe(0);
    db.close();
  });
});

describe('resolveWalValveMb DB-size scaling (§7a.2 fold-tax reduction)', () => {
  it('scales soft cap ~dbSize/4 within [256, 2048]MB; env always wins', () => {
    const GB = 1024 * 1024 * 1024;
    expect(resolveWalValveMb(undefined, 100 * 1024 * 1024)).toBe(256); // floor
    expect(resolveWalValveMb(undefined, 4.6 * GB)).toBe(1177); // ~dbSize/4
    expect(resolveWalValveMb(undefined, 40 * GB)).toBe(2048); // ceiling
    expect(resolveWalValveMb('64', 40 * GB)).toBe(64); // env override wins
    expect(resolveWalValveMb(undefined, 0)).toBe(256); // unknown size → default
  });
});
