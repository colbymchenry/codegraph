/**
 * Issue #2980 — several processes opening an index with a pending schema
 * migration failed with SQLITE_BUSY instead of waiting.
 *
 * `runMigrations` used to read the version outside any transaction and then
 * run each migration in a `db.transaction(...)`, which is a deferred `BEGIN`.
 * Two processes both read the old version and both began a deferred
 * transaction; when they upgraded from read to write, SQLite returned
 * SQLITE_BUSY immediately — it does not consult `busy_timeout` for that
 * upgrade, because waiting could deadlock.
 *
 * The fix runs the version check and the migrations in ONE `BEGIN IMMEDIATE`
 * transaction, so a racing opener waits on `busy_timeout` and then re-reads
 * the version inside the transaction, skipping what the winner applied.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../src/db/migrations';

const DIST_INDEX = path.resolve(__dirname, '../dist/index.js');
const V16_INDEX = 'idx_unresolved_failed_module_member';

/**
 * Opens the project the way a second agent session would, once released.
 * `openSync` runs the same `DatabaseConnection.open` + migration path as
 * `CodeGraph.open`, without the grammar warm-up that would skew the start.
 */
const OPEN_CHILD = `
const fs = require('fs');
const CodeGraph = require(process.argv[1]).default;
process.stdout.write('READY\\n');
try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) { /* parent gone: still go */ }
try {
  const cg = CodeGraph.openSync(process.argv[2]);
  cg.close();
  process.stdout.write('OPENED\\n');
} catch (err) {
  process.stderr.write(String((err && err.stack) || err) + '\\n');
  process.exitCode = 1;
}
`;

/**
 * Stands in for a process that is migrating the database: it holds the write
 * lock (`BEGIN IMMEDIATE`), releases it when the parent goes, and records
 * version 16 as applied just before committing — the version record is the one
 * part of a migration this test needs to observe, so the DDL itself is left to
 * the opener (which must skip it).
 */
const LOCK_CHILD = `
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO project_metadata(key, value, updated_at) VALUES ('cg2980-lock', '1', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
process.stdout.write('READY\\n');
try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) { /* parent gone: still go */ }
setTimeout(() => {
  db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (16, ?, 'applied by another process')").run(Date.now());
  db.exec('COMMIT');
  db.close();
}, 1000);
`;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let tmp: string | null = null;
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** An initialized project whose database is one migration behind (only v16 pending). */
function makeProjectAtV15(): { dir: string; dbPath: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg2980-'));
  CodeGraph.initSync(tmp).close();
  const dbPath = path.join(tmp, '.codegraph', 'codegraph.db');
  const { db } = createDatabase(dbPath);
  try {
    db.exec(`DROP INDEX IF EXISTS ${V16_INDEX};
      DELETE FROM schema_versions WHERE version >= 16;`);
    // A fresh database records only v1 and CURRENT; record v15 so v16 is the
    // one migration a pre-v16 index is missing.
    db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (15, 0, 'legacy fixture')").run();
  } finally {
    db.close();
  }
  return { dir: tmp, dbPath };
}

function readState(dbPath: string): { version: number; index: boolean } {
  const { db } = createDatabase(dbPath, { readOnly: true });
  try {
    return {
      version: getCurrentVersion(db),
      index: db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(V16_INDEX) !== undefined,
    };
  } finally {
    db.close();
  }
}

function countVersionRows(dbPath: string, version: number): number {
  const { db } = createDatabase(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = ?').get(version) as { n: number }).n;
  } finally {
    db.close();
  }
}

function spawnGated(script: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Keep the child's cwd off the temp dir (Windows EPERM-on-cleanup quirk).
    cwd: os.tmpdir(),
  });
  children.push(child);
  return child;
}

/**
 * Collect each child's output and exit, and resolve when each has announced
 * READY (its gate read is about to block). Callers write a byte to every
 * child's stdin to release them at once.
 */
function collect(gated: ChildProcess[]): { done: Promise<ChildResult[]>; ready: Promise<void[]> } {
  const stdout = gated.map(() => '');
  const stderr = gated.map(() => '');
  const done = gated.map((child, i) => new Promise<ChildResult>((resolve) => {
    child.stdout!.on('data', (data) => { stdout[i] += String(data); });
    child.stderr!.on('data', (data) => { stderr[i] += String(data); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout[i], stderr: stderr[i] });
    });
  }));
  const ready = gated.map((child, i) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child ${i} never reported READY: ${stderr[i]}`)),
      45_000,
    );
    const onData = (): void => {
      if (!stdout[i].includes('READY')) return;
      clearTimeout(timer);
      child.stdout!.off('data', onData);
      resolve();
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => {
      if (stdout[i].includes('READY')) return;
      clearTimeout(timer);
      reject(new Error(`child ${i} exited (${code}) before READY: ${stderr[i]}`));
    });
  }));
  return { done, ready: Promise.all(ready) };
}

describe('issue #2980 — concurrent opens with a pending migration', () => {
  it('three processes opening the same pending-v16 index all succeed', { timeout: 180_000 }, async () => {
    const { dir, dbPath } = makeProjectAtV15();

    // Several rounds, as in the report: the race is between one process
    // recording v16 and the others reaching their write.
    for (let round = 0; round < 3; round++) {
      const gated = [0, 1, 2].map(() => spawnGated(OPEN_CHILD, [DIST_INDEX, dir]));
      const { done, ready } = collect(gated);
      await ready;
      for (const child of gated) child.stdin!.write('go\n');
      const results = await Promise.all(done);

      results.forEach((result, i) => {
        expect(result.stderr, `round ${round}, process ${i}`).not.toMatch(/SQLITE_BUSY|database is locked/i);
        expect(result.code, `round ${round}, process ${i}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('OPENED');
      });

      expect(readState(dbPath)).toEqual({ version: CURRENT_SCHEMA_VERSION, index: true });
      // The winner's record is the only one: the losers skipped, not re-ran.
      expect(countVersionRows(dbPath, CURRENT_SCHEMA_VERSION)).toBe(1);
    }
  });

  it('waits on busy_timeout for a competing writer, then skips what it applied', { timeout: 60_000 }, async () => {
    const { dbPath } = makeProjectAtV15();

    const holder = spawnGated(LOCK_CHILD, [dbPath]);
    const { done, ready } = collect([holder]);
    await ready;
    holder.stdin!.write('go\n');

    // The holder keeps the write lock for 1s. The opener's version read still
    // says 15; it must not fail the upgrade — it waits, then finds 16 inside
    // its own transaction and applies nothing.
    const started = Date.now();
    const conn = DatabaseConnection.open(dbPath);
    const waited = Date.now() - started;
    conn.close();

    const [holderResult] = await Promise.all(done);
    expect(holderResult.code).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(500);

    const state = readState(dbPath);
    expect(state.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(state.index).toBe(false); // skipped: the v16 index was never created
    expect(countVersionRows(dbPath, CURRENT_SCHEMA_VERSION)).toBe(1);
  });

  it('a single process still applies the pending migration', () => {
    const { dbPath } = makeProjectAtV15();

    const conn = DatabaseConnection.open(dbPath);
    try {
      expect(getCurrentVersion(conn.getDb())).toBe(CURRENT_SCHEMA_VERSION);
      // Migrations run on a connection whose busy_timeout is the bounded 5s.
      expect(Number(conn.getDb().pragma('busy_timeout', { simple: true }))).toBe(5000);
    } finally {
      conn.close();
    }

    expect(readState(dbPath)).toEqual({ version: CURRENT_SCHEMA_VERSION, index: true });
    expect(countVersionRows(dbPath, CURRENT_SCHEMA_VERSION)).toBe(1);
  });
});
