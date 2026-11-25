/**
 * SQLite backend reporting.
 *
 * node:sqlite (Node's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / CodeGraph report it and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { CodeGraph } from '../src';

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the node-sqlite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('read-only opens never migrate, repair bulk-load state, or permit writes (#1963)', () => {
    const dbPath = path.join(dir, 'test.db');
    const owner = DatabaseConnection.initialize(dbPath);
    const db = owner.getDb();
    db.exec('DELETE FROM schema_versions WHERE version = (SELECT MAX(version) FROM schema_versions)');
    db.exec('DROP TRIGGER nodes_ai');
    const before = db.pragma('data_version', { simple: true });
    const reader = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      expect(reader.getDb().prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
      expect(() => reader.getDb().exec("CREATE TABLE reader_write (value TEXT)"))
        .toThrow(/readonly|read-only/i);
      expect(db.pragma('data_version', { simple: true })).toBe(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes_ai'").get()).toBeUndefined();
    } finally { reader.close(); owner.close(); }
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('node-sqlite');
    } finally {
      cg.destroy();
    }
  });
});
