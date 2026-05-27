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
import { Node } from '../src/types';

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
