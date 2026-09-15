/**
 * Read-only consumption of a prebuilt index: `DatabaseConnection.open()` on a
 * path the current user cannot write must fall back to an immutable read-only
 * connection (SQLite WAL readers need a -shm file that cannot be created on a
 * non-writable path — see the immutable fallback in sqlite-adapter.ts) and
 * keep serving plain queries.
 *
 * Skipped on Windows: chmod read-only semantics differ (file attributes, not
 * permission bits) and the 0444/0555 trick does not produce a non-writable
 * path there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db/index';

const isWindows = process.platform === 'win32';
// As root, access(W_OK) bypasses permission bits and the chmod setup would
// silently exercise the writable path instead.
const isRoot = (process.getuid?.() ?? -1) === 0;

describe.skipIf(isWindows || isRoot)('read-only index fallback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ro-'));
  const dbPath = path.join(tmp, 'codegraph.db');

  beforeAll(() => {
    // Build the prebuilt-artifact shape: a cleanly closed WAL database
    // (initialize writes the schema_versions row, then close checkpoints
    // the WAL away).
    const conn = DatabaseConnection.initialize(dbPath);
    expect(conn.getSchemaVersion()).not.toBeNull();
    conn.close();
  });

  afterAll(() => {
    // Restore permissions first: a 0555 directory would block cleanup.
    try {
      fs.chmodSync(dbPath, 0o644);
      fs.chmodSync(tmp, 0o755);
    } catch {
      /* best effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves queries when neither the db file nor its directory is writable', () => {
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(tmp, 0o555);
    try {
      // Before the immutable fallback this threw
      // "attempt to write a readonly database" on the first statement.
      const conn = DatabaseConnection.open(dbPath);
      expect(conn.getSchemaVersion()).not.toBeNull();
      expect(
        conn.getDb().prepare('SELECT COUNT(*) AS n FROM schema_versions').get()
      ).toMatchObject({ n: expect.any(Number) });
      conn.close();
    } finally {
      fs.chmodSync(tmp, 0o755);
      fs.chmodSync(dbPath, 0o644);
    }
  });

  it('keeps writable indexes on the regular read-write WAL path', () => {
    const conn = DatabaseConnection.open(dbPath);
    expect(conn.getJournalMode()).toBe('wal');
    expect(conn.getSchemaVersion()).not.toBeNull();
    conn.close();
  });
});
