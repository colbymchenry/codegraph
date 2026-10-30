/**
 * Opening an index that still needs a schema migration, while another process
 * opens it too, must not fail (#2980).
 *
 * The open read the schema version, then ran each pending migration in its own
 * deferred transaction. A process that read the version just before another
 * one migrated went on to apply the same migration again: it either failed
 * recording a version that was already recorded ("UNIQUE constraint failed:
 * schema_versions.version"), or, for a migration that reads before it writes,
 * hit SQLITE_BUSY at once, since SQLite does not wait on a lock for a
 * transaction that has already read. Either way the open failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../src/db/migrations';

const DIST_INDEX = path.resolve(__dirname, '../dist/index.js');
/** The index migration 16 adds: the one migration the fixture leaves pending. */
const V16_INDEX = 'idx_unresolved_failed_module_member';

/** Opens the project once the test writes a byte to its stdin, and says how it went. */
const OPENER = `
const fs = require('fs');
const CodeGraph = require(process.argv[1]).default;
process.stdout.write('READY\\n');
try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) {}
try {
  CodeGraph.openSync(process.argv[2]).close();
  process.stdout.write('OPENED\\n');
} catch (err) {
  process.stdout.write('FAILED ' + String((err && err.message) || err).replace(/\\s+/g, ' ') + '\\n');
}
`;

/**
 * Another process in the middle of migrating: it holds the write lock with
 * version 16 recorded but not committed, and commits on its own after a while.
 * Until then any other connection still reads version 15.
 */
const MIGRATING = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (16, ?, 'another process')").run(Date.now());
process.stdout.write('HOLDING\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); process.stdout.write('COMMITTED\\n'); }, Number(process.argv[2]));
`;

/** A writer holding the lock on a current index, until the test ends it. */
const WRITING = `
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO project_metadata (key, value, updated_at) VALUES ('cg2980', '1', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
process.stdout.write('HOLDING\\n');
try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) {}
db.exec('ROLLBACK');
db.close();
`;

interface Child {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

describe('opening an index with a pending migration from several processes (#2980)', () => {
  let dir: string;
  let dbPath: string;
  let children: Child[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-migrate-'));
    CodeGraph.initSync(dir).close();
    dbPath = path.join(dir, '.codegraph', 'codegraph.db');
  });

  afterEach(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    children = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Take the index back to version 15, the way an index built before migration 16 is. */
  function pendingV16(refs = 0): void {
    const { db } = createDatabase(dbPath);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`DROP INDEX IF EXISTS ${V16_INDEX};
        DELETE FROM schema_versions WHERE version >= 16;
        INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (15, 0, 'fixture');`);
      if (refs > 0) {
        // Enough rows that building the index takes a while, so openers overlap.
        db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${refs})
          INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
          SELECT 'n' || (i % 500), 'store.get' || i, 'calls', i % 900, 1, 'src/f' || (i % 300) || '.ts', 'typescript',
            CASE WHEN i % 3 = 0 THEN 'failed' ELSE 'pending' END,
            CASE WHEN i % 3 = 0 THEN 'module:./m' || (i % 50) ELSE 'get' || i END
          FROM n`);
      }
    } finally {
      db.close();
    }
  }

  function state(): { version: number; v16Records: number; index: boolean } {
    const { db } = createDatabase(dbPath, { readOnly: true });
    try {
      return {
        version: getCurrentVersion(db),
        v16Records: (db.prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = 16').get() as { n: number }).n,
        index: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(V16_INDEX) !== undefined,
      };
    } finally {
      db.close();
    }
  }

  function run(args: string[]): Child {
    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      // Off the fixture, so a child still exiting cannot hold it (Windows EBUSY).
      cwd: os.tmpdir(),
      windowsHide: true,
    });
    let out = '';
    child.stdout!.on('data', (chunk) => { out += String(chunk); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const handle = { child, output: () => out, exited };
    children.push(handle);
    return handle;
  }

  async function says(who: Child, word: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!who.output().includes(word)) {
      if (who.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`expected "${word}", got: ${who.output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('waits for a process already migrating, then skips the migration it applied', async () => {
    pendingV16();
    const migrating = run(['-e', MIGRATING, dbPath, '1500']);
    await says(migrating, 'HOLDING');

    // Version 16 is not committed yet: this open reads 15, so it has a migration to run.
    const started = Date.now();
    const conn = DatabaseConnection.open(dbPath);
    const waited = Date.now() - started;
    try {
      expect(getCurrentVersion(conn.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
    await says(migrating, 'COMMITTED');
    expect(waited).toBeGreaterThanOrEqual(500);
    // Recorded once, by the other process, and not run again here: its index was never built.
    expect(state()).toEqual({ version: CURRENT_SCHEMA_VERSION, v16Records: 1, index: false });
  }, 60_000);

  it('opens in every one of three processes that start at the same moment', async () => {
    for (let round = 0; round < 2; round++) {
      pendingV16(round === 0 ? 150_000 : 0);
      const openers = [0, 1, 2].map(() => run(['-e', OPENER, DIST_INDEX, dir]));
      await Promise.all(openers.map((opener) => says(opener, 'READY')));
      for (const opener of openers) opener.child.stdin!.write('g');
      await Promise.all(openers.map((opener) => opener.exited));
      for (const opener of openers) expect(opener.output(), `round ${round}`).toContain('OPENED');
      expect(state()).toEqual({ version: CURRENT_SCHEMA_VERSION, v16Records: 1, index: true });
    }
  }, 120_000);

  it('still applies a pending migration in a single process', () => {
    pendingV16();
    DatabaseConnection.open(dbPath).close();
    expect(state()).toEqual({ version: CURRENT_SCHEMA_VERSION, v16Records: 1, index: true });
  });

  it('opens a current index without waiting for another process that is writing', async () => {
    const writing = run(['-e', WRITING, dbPath]);
    await says(writing, 'HOLDING');
    const started = Date.now();
    DatabaseConnection.open(dbPath).close();
    expect(Date.now() - started).toBeLessThan(2_000);
    writing.child.stdin!.write('g');
    expect(await writing.exited).toBe(0);
  }, 60_000);
});
