import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection, walAvailable, configureConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';

/**
 * Regression coverage for #990: WAL mode must be probed before it is enabled,
 * and the connection must fall back to DELETE mode (still writable) when the
 * filesystem can't sustain WAL. The EOPNOTSUPP path itself (ntfs3 / WSL2 /mnt /
 * some CIFS/NFS) cannot be reproduced on APFS, so these tests exercise the
 * branching logic and the fallback's write path directly.
 */
describe('WAL fallback (#990)', () => {
  it('walAvailable returns true on a normal writable dir and cleans up its probe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-ok-'));
    try {
      expect(walAvailable(dir)).toBe(true);
      const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.cg-wal-probe-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walAvailable returns false when the dir cannot host a database', () => {
    const missing = path.join(os.tmpdir(), `cg-wal-missing-${Date.now()}`, 'nested');
    expect(walAvailable(missing)).toBe(false);
  });

  it('configureConnection(useWal=true) enables WAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-on-'));
    try {
      const { db } = createDatabase(path.join(dir, 't.db'));
      configureConnection(db, true);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL, safe under WAL
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('configureConnection(useWal=false) falls back to DELETE and stays writable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-off-'));
    try {
      const { db } = createDatabase(path.join(dir, 't.db'));
      configureConnection(db, false);
      expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL, durable under DELETE
      // The point of the fallback: writes must still succeed in DELETE mode.
      db.exec('CREATE TABLE t (x); INSERT INTO t (x) VALUES (1);');
      const row = db.prepare('SELECT x FROM t').get() as { x: number };
      expect(row.x).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DatabaseConnection.initialize produces a working DB (WAL on a normal fs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-init-'));
    try {
      const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
      expect(conn.getDb().pragma('journal_mode', { simple: true })).toBe('wal');
      conn.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
