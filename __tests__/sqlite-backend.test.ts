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

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('node-sqlite');
    } finally {
      cg.destroy();
    }
  });

  describe('transaction depth and rollback safety (CG-SQLITE-TX-01)', () => {
    it('resets transaction depth to 0 on standard error rollback and allows subsequent transactions', () => {
      const conn = DatabaseConnection.initialize(path.join(dir, 'tx-test.db'));
      const db = (conn as any).db;
      db.exec('CREATE TABLE items (id INT, val TEXT)');

      const failingTx = db.transaction(() => {
        db.exec("INSERT INTO items VALUES (1, 'one')");
        throw new Error('boom');
      });

      expect(() => failingTx()).toThrow('boom');

      // Subsequent transaction should work normally, demonstrating _txDepth reset to 0
      const successTx = db.transaction(() => {
        db.exec("INSERT INTO items VALUES (2, 'two')");
      });
      expect(() => successTx()).not.toThrow();

      const rows = db.prepare('SELECT * FROM items').all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).id).toBe(2);
      conn.close();
    });

    it('resets transaction depth to 0 even if ROLLBACK fails or transaction was already aborted', () => {
      const conn = DatabaseConnection.initialize(path.join(dir, 'tx-abort-test.db'));
      const db = (conn as any).db;
      db.exec('CREATE TABLE items (id INT, val TEXT)');

      // Simulate a case where SQLite aborts the transaction or ROLLBACK is invoked when no tx is active
      const doubleAbortTx = db.transaction(() => {
        db.exec("INSERT INTO items VALUES (1, 'one')");
        // Manually rollback inside, so when the outer transaction block tries to ROLLBACK, it errors:
        (db as any)._db.exec('ROLLBACK');
        throw new Error('closure error after manual abort');
      });

      expect(() => doubleAbortTx()).toThrow('closure error after manual abort');

      // Verify that _txDepth is safely reset to 0 and a new transaction can be created and committed
      const nextTx = db.transaction(() => {
        db.exec("INSERT INTO items VALUES (3, 'three')");
      });
      expect(() => nextTx()).not.toThrow();

      const rows = db.prepare('SELECT * FROM items').all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).id).toBe(3);
      conn.close();
    });
  });
});
