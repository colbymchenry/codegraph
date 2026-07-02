/**
 * DB Performance / Correctness Tests
 *
 * Regression tests for three changes:
 *   1. Batch `getNodesByIds` collapses graph-traversal N+1 reads.
 *   2. `insertNode` invalidates the LRU cache so INSERT OR REPLACE
 *      doesn't serve a stale cached row on next `getNodeById`.
 *   3. `runMaintenance` runs `PRAGMA optimize` + `wal_checkpoint(PASSIVE)`
 *      after indexAll/sync without throwing.
 *   4. `insertEdges` validates endpoints from the DB, not stale node cache.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { runMigrations, getCurrentVersion } from '../src/db/migrations';
import { Node, Edge } from '../src/types';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('getNodesByIds (batch lookup)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-batch-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a Map keyed by id, with one entry per existing node', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2'), makeNode('n3')]);
    const out = q.getNodesByIds(['n1', 'n2', 'n3']);
    expect(out.size).toBe(3);
    expect(out.get('n1')!.name).toBe('n1');
    expect(out.get('n3')!.name).toBe('n3');
  });

  it('omits missing IDs from the result map (no nulls, no exceptions)', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    const out = q.getNodesByIds(['n1', 'missing', 'n2']);
    expect(out.size).toBe(2);
    expect(out.has('missing')).toBe(false);
    expect(out.has('n1')).toBe(true);
    expect(out.has('n2')).toBe(true);
  });

  it('handles an empty input array', () => {
    expect(q.getNodesByIds([]).size).toBe(0);
  });

  it('handles batches over the SQLite parameter limit (chunking)', () => {
    // Insert 1500 nodes; the helper chunks at 500 internally.
    const nodes = Array.from({ length: 1500 }, (_, i) => makeNode(`n${i}`));
    q.insertNodes(nodes);
    const ids = nodes.map((n) => n.id);
    const out = q.getNodesByIds(ids);
    expect(out.size).toBe(1500);
    // Spot-check a few from the first / middle / last chunk.
    expect(out.has('n0')).toBe(true);
    expect(out.has('n750')).toBe(true);
    expect(out.has('n1499')).toBe(true);
  });

  it('serves cache hits from memory and queries only the misses', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2'), makeNode('n3')]);
    // Warm the cache for n1 only.
    q.getNodeById('n1');
    // Replace the underlying row to make a miss-vs-cache-hit detectable.
    db.getDb().prepare('UPDATE nodes SET name = ? WHERE id = ?').run('changed', 'n1');
    const out = q.getNodesByIds(['n1', 'n2']);
    // The cached n1 (still 'n1', not 'changed') must be returned.
    expect(out.get('n1')!.name).toBe('n1');
    expect(out.get('n2')!.name).toBe('n2');
  });
});

describe('deleteResolvedReferences (chunking)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-delref-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes unresolved refs for more ids than the SQLite parameter limit (#1001)', () => {
    // Regression: this method bound every id as one parameter in a single
    // IN (...), so passing more ids than SQLITE_MAX_VARIABLE_NUMBER (32766 on
    // the bundled node:sqlite) threw "too many SQL variables". Use 33000 to
    // clear that ceiling. from_node_id has a FK to nodes, so insert nodes first.
    const nodes = Array.from({ length: 33000 }, (_, i) => makeNode(`n${i}`));
    q.insertNodes(nodes);
    q.insertUnresolvedRefsBatch(
      nodes.map((n) => ({
        fromNodeId: n.id,
        referenceName: 'someName',
        referenceKind: 'calls',
        line: 1,
        column: 0,
      }))
    );
    expect(q.getUnresolvedReferencesCount()).toBe(33000);

    const ids = nodes.map((n) => n.id);
    expect(() => q.deleteResolvedReferences(ids)).not.toThrow();
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  it('handles an empty input array', () => {
    expect(() => q.deleteResolvedReferences([])).not.toThrow();
  });
});

describe('insertNode cache invalidation', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-cache-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not serve a stale cached node after INSERT OR REPLACE', () => {
    // Regression: insertNode (which uses INSERT OR REPLACE) used to skip
    // cache invalidation, so the next getNodeById returned the pre-replace
    // version until LRU eviction.
    const original = makeNode('n1', 'oldName');
    q.insertNode(original);
    const beforeReplace = q.getNodeById('n1');
    expect(beforeReplace!.name).toBe('oldName');

    // Replace via insertNode (the bug path).
    q.insertNode({ ...original, name: 'newName', updatedAt: Date.now() });
    const afterReplace = q.getNodeById('n1');
    expect(afterReplace!.name).toBe('newName');
  });
});

describe('insertEdges endpoint validation', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-edges-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips edges with missing endpoints instead of failing the whole batch', () => {
    q.insertNodes([makeNode('source'), makeNode('target'), makeNode('other')]);

    expect(() =>
      q.insertEdges([
        { source: 'source', target: 'target', kind: 'calls' },
        { source: 'source', target: 'missing-target', kind: 'calls' },
        { source: 'missing-source', target: 'other', kind: 'references' },
      ])
    ).not.toThrow();

    const edges = q.getOutgoingEdges('source');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'source', target: 'target', kind: 'calls' });
  });

  it('does not trust stale cached nodes when validating edge endpoints', () => {
    q.insertNodes([makeNode('source'), makeNode('target')]);
    expect(q.getNodeById('target')!.id).toBe('target');

    db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run('target');

    expect(() =>
      q.insertEdges([{ source: 'source', target: 'target', kind: 'calls' }])
    ).not.toThrow();
    expect(q.getOutgoingEdges('source')).toEqual([]);
  });
});

describe('runMaintenance', () => {
  let dir: string;
  let db: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-maint-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs without throwing on a fresh database', () => {
    expect(() => db.runMaintenance()).not.toThrow();
  });

  it('runs without throwing after writes', () => {
    const q = new QueryBuilder(db.getDb());
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    expect(() => db.runMaintenance()).not.toThrow();
  });

  it('swallows failures rather than propagating (best-effort)', () => {
    // Close the DB so the underlying handle would normally throw on any
    // exec(). runMaintenance must still not propagate.
    db.close();
    expect(() => db.runMaintenance()).not.toThrow();
  });
});

// The edges table carried no UNIQUE constraint, so `insertEdge`'s
// `INSERT OR IGNORE` had nothing to conflict on and silently admitted
// byte-identical duplicate rows when two passes emitted the same edge (#1034).
// A UNIQUE identity index — `(source, target, kind, IFNULL(line,-1),
// IFNULL(col,-1))` — makes OR IGNORE actually dedup.
describe('edge identity uniqueness (#1034)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-edge-uniq-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    q.insertNodes([makeNode('A'), makeNode('B')]);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgeCount = () =>
    (db.getDb().prepare('SELECT count(*) AS c FROM edges').get() as { c: number }).c;
  const mk = (over: Partial<Edge> = {}): Edge => ({
    source: 'A',
    target: 'B',
    kind: 'references',
    line: 153,
    column: 12,
    metadata: { resolvedBy: 'exact-match' },
    ...over,
  });

  it('a fresh database has the identity index', () => {
    const idx = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_identity'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('collapses byte-identical edges to a single row', () => {
    q.insertEdges([mk(), mk(), mk()]);
    expect(edgeCount()).toBe(1);
  });

  it('dedups even when only the metadata differs (same structural identity)', () => {
    q.insertEdges([mk({ metadata: { resolvedBy: 'exact-match' } }), mk({ metadata: { resolvedBy: 'import' } })]);
    expect(edgeCount()).toBe(1);
  });

  it('keeps edges that differ in line/col — distinct call sites are not duplicates', () => {
    q.insertEdges([mk({ column: 12 }), mk({ column: 99 }), mk({ line: 200, column: 1 })]);
    expect(edgeCount()).toBe(3);
  });

  it('dedups coordinate-less edges, folding NULL line/col via IFNULL', () => {
    q.insertEdges([mk({ line: undefined, column: undefined }), mk({ line: undefined, column: undefined })]);
    expect(edgeCount()).toBe(1);
  });

  it('dedups across separate insert calls (storage constraint, not a per-batch dedup)', () => {
    q.insertEdges([mk()]);
    q.insertEdges([mk()]);
    expect(edgeCount()).toBe(1);
  });
});

describe('migration v6: dedup edges + add identity index on upgrade (#1034)', () => {
  it('collapses pre-existing duplicate rows, keeps distinct ones, and restores the constraint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mig6-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    // Recreate a pre-v6 database: without the identity index, `INSERT OR IGNORE`
    // admits duplicates. Revert the recorded version so migration v6 will re-run.
    raw.exec('DROP INDEX IF EXISTS idx_edges_identity');
    raw.prepare('DELETE FROM schema_versions WHERE version >= 6').run();
    q.insertEdges([
      { source: 'A', target: 'B', kind: 'references', line: 153, column: 12, metadata: { resolvedBy: 'exact-match' } },
      { source: 'A', target: 'B', kind: 'references', line: 153, column: 12, metadata: { resolvedBy: 'exact-match' } },
      { source: 'A', target: 'B', kind: 'calls', line: 200, column: 4 },
    ]);
    const count = () => (raw.prepare('SELECT count(*) AS c FROM edges').get() as { c: number }).c;
    expect(count()).toBe(3); // duplicate admitted while the index was absent

    runMigrations(raw, 5);

    expect(count()).toBe(2); // duplicate collapsed, the distinct `calls` edge kept
    expect(getCurrentVersion(raw)).toBe(7);
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_identity'")
      .get();
    expect(idx).toBeTruthy();
    // The constraint now holds — re-inserting the duplicate is a no-op.
    q.insertEdges([
      { source: 'A', target: 'B', kind: 'references', line: 153, column: 12, metadata: { resolvedBy: 'x' } },
    ]);
    expect(count()).toBe(2);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
