import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';

describe('instance-result owner index', () => {
  let dir: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-instance-owner-index-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes(['a', 'b'].map(id => ({
      id, name: id, qualifiedName: id, kind: 'function', language: 'typescript',
      filePath: `${id}.ts`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
      updatedAt: 0,
    })));
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 1, metadata: { instanceTypeOwner: 'Maker' } });
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function expectIndexedOwnerLookup(): void {
    const prepare = vi.spyOn(connection.getDb(), 'prepare');
    expect(queries.getEdgesWithInstanceTypeOwner().map(edge => edge.line)).toEqual([1]);
    const sql = prepare.mock.calls.map(([text]) => text).find(text => text.includes('instanceTypeOwner'))!;
    prepare.mockRestore();
    expect(sql).toBeDefined();
    const plan = connection.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    expect(plan.map(row => row.detail).join('\n')).toMatch(/USING INDEX idx_edges_instance_type_owner/);
  }

  it('uses the partial index for new and migrated databases', () => {
    expectIndexedOwnerLookup();
    const db = connection.getDb();
    db.exec('DROP INDEX idx_edges_instance_type_owner; DELETE FROM schema_versions WHERE version >= 17');
    runMigrations(db, 16);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expectIndexedOwnerLookup();
    runMigrations(db, 16);
    expectIndexedOwnerLookup();
  });

  it('recreates the index after a bulk edge load', async () => {
    connection.beginBulkEdgeLoad();
    expect(connection.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_edges_instance_type_owner'"
    ).get()).toBeUndefined();
    await connection.endBulkEdgeLoad();
    expectIndexedOwnerLookup();
  });
});
