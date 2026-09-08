/**
 * Regression tests for #1431: a SIGKILL'd session (the #850 liveness watchdog,
 * OOM, a crash) leaves the SQLite WAL on disk; the next session appends to the
 * same file; and before the fix NOTHING ever truncated it — PASSIVE
 * checkpoints fold frames but keep the file at its high-water mark, and the
 * only shrinking path (a clean last-connection close) is exactly what a
 * killed-daemon world never takes. Observed in the wild at 25.6 GB on a
 * 5.46 GB database, growing until the disk filled.
 *
 * The fix: `journal_size_limit` on every connection (resetting checkpoints now
 * clip the file), plus `healOversizedWal()` fired from every
 * `DatabaseConnection.open` (off-thread PASSIVE fold + TRUNCATE when the WAL
 * exceeds the threshold).
 *
 * The killed writer here reproduces the real shape: same open pragmas as
 * `configureConnection`, `wal_autocheckpoint = 0` (deferred-checkpoint sync
 * mode, #1248), bulk writes, then SIGKILL mid-session with the connection open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  DatabaseConnection,
  WAL_HEAL_THRESHOLD_BYTES,
  resolveWalHealBytes,
} from '../src/db/index';
import { watchdogProgressPaths, stampLogChunk } from '../src/mcp/index';

const MB = 1024 * 1024;

// Writer child: real codegraph pragmas + deferred checkpointing, grows the WAL
// past the target, prints READY, then idles with the connection open until the
// parent SIGKILLs it (what the liveness watchdog does to a daemon).
const WRITER_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const dbPath = process.argv[1];
const targetBytes = Number(process.argv[2]);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA wal_autocheckpoint = 0');
db.exec('CREATE TABLE IF NOT EXISTS junk (id INTEGER PRIMARY KEY, blob BLOB)');
const ins = db.prepare('INSERT INTO junk (blob) VALUES (?)');
const chunk = Buffer.alloc(256 * 1024, 0xab);
const walSize = () => { try { return fs.statSync(dbPath + '-wal').size; } catch (e) { return 0; } };
while (walSize() < targetBytes) {
  db.exec('BEGIN');
  for (let i = 0; i < 20; i++) ins.run(chunk);
  db.exec('COMMIT');
}
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

async function growWalThenSigkill(dbPath: string, targetBytes: number): Promise<void> {
  const child = spawn(process.execPath, ['-e', WRITER_SOURCE, dbPath, String(targetBytes)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    // Keep the child's cwd off the temp dir (Windows EPERM-on-cleanup quirk).
    cwd: os.tmpdir(),
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => {
      out += String(d);
      if (out.includes('READY')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`writer exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out growing the WAL')), 90_000);
  });
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
}

describe('WAL heal after killed sessions (#1431)', () => {
  let dir: string;
  let dbPath: string;
  const walSize = (): number => {
    try { return fs.statSync(`${dbPath}-wal`).size; } catch { return 0; }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-heal-'));
    dbPath = path.join(dir, 'codegraph.db');
    DatabaseConnection.initialize(dbPath).close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the heal threshold from the env override, defaulting to 64 MB', () => {
    expect(resolveWalHealBytes(undefined)).toBe(64 * MB);
    expect(resolveWalHealBytes('')).toBe(64 * MB);
    expect(resolveWalHealBytes('nope')).toBe(64 * MB);
    expect(resolveWalHealBytes('-3')).toBe(64 * MB);
    expect(resolveWalHealBytes('128')).toBe(128 * MB);
  });

  it('sets journal_size_limit on every connection so resetting checkpoints clip the file', () => {
    const conn = DatabaseConnection.open(dbPath);
    try {
      // Private-field peek: journal_size_limit is per-connection, so only this
      // connection can report it.
      const raw = (conn as unknown as { db: { pragma(q: string, o: { simple: true }): unknown } }).db
        .pragma('journal_size_limit', { simple: true });
      expect(Number(raw)).toBe(WAL_HEAL_THRESHOLD_BYTES);
    } finally {
      conn.close();
    }
  });

  it('leaves healthy small WALs alone', async () => {
    const conn = DatabaseConnection.open(dbPath);
    try {
      const res = await conn.healOversizedWal();
      expect(res.healed).toBe(false);
      expect(res.beforeBytes).toBeLessThanOrEqual(WAL_HEAL_THRESHOLD_BYTES);
    } finally {
      conn.close();
    }
  });

  it('reproduces the ratchet and heals it: killed sessions stack the WAL, open() truncates it', async () => {
    // Session 1 killed mid-write: WAL survives the SIGKILL.
    await growWalThenSigkill(dbPath, WAL_HEAL_THRESHOLD_BYTES / 2);
    const afterFirstKill = walSize();
    expect(afterFirstKill).toBeGreaterThanOrEqual(WAL_HEAL_THRESHOLD_BYTES / 2);

    // Session 2 appends to the SAME file — the unbounded ratchet.
    await growWalThenSigkill(dbPath, WAL_HEAL_THRESHOLD_BYTES + 8 * MB);
    const afterSecondKill = walSize();
    expect(afterSecondKill).toBeGreaterThan(afterFirstKill);
    expect(afterSecondKill).toBeGreaterThan(WAL_HEAL_THRESHOLD_BYTES);

    // The next session opens the DB: the heal folds + truncates. (open() also
    // fires the heal itself, so await an explicit pass rather than asserting
    // on the racing return values — the on-disk size is the invariant.)
    const conn = DatabaseConnection.open(dbPath);
    try {
      await conn.healOversizedWal();
      expect(walSize()).toBeLessThan(WAL_HEAL_THRESHOLD_BYTES);
      // The folded data is all there.
      const rows = (conn as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db
        .prepare('SELECT COUNT(*) AS n FROM junk').get();
      expect(rows.n).toBeGreaterThan(0);
    } finally {
      conn.close();
    }
  }, 180_000);

  it('open() itself kicks off the heal without being asked', async () => {
    await growWalThenSigkill(dbPath, WAL_HEAL_THRESHOLD_BYTES + 8 * MB);
    expect(walSize()).toBeGreaterThan(WAL_HEAL_THRESHOLD_BYTES);

    const conn = DatabaseConnection.open(dbPath); // fire-and-forget heal
    try {
      const deadline = Date.now() + 30_000;
      while (walSize() > WAL_HEAL_THRESHOLD_BYTES && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(walSize()).toBeLessThanOrEqual(WAL_HEAL_THRESHOLD_BYTES);
    } finally {
      conn.close();
    }
  }, 180_000);
});

describe('daemon observability for watchdog kills (#1431)', () => {
  it('derives watchdog progressPaths from the project root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wd-paths-'));
    try {
      const { progressPaths } = watchdogProgressPaths(dir);
      expect(progressPaths).toHaveLength(2);
      expect(progressPaths![0].endsWith(path.join('.codegraph', 'codegraph.db'))).toBe(true);
      expect(progressPaths![1]).toBe(`${progressPaths![0]}-wal`);
      expect(watchdogProgressPaths(null)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps log chunks with an ISO-8601 timestamp', () => {
    const iso = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /;
    expect(String(stampLogChunk('[CodeGraph daemon] Listening.\n'))).toMatch(iso);
    const stamped = stampLogChunk(Buffer.from('bytes\n'));
    expect(Buffer.isBuffer(stamped)).toBe(true);
    expect(String(stamped)).toMatch(iso);
    expect(String(stamped).endsWith('bytes\n')).toBe(true);
  });
});
