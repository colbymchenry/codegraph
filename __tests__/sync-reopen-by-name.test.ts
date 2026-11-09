/**
 * A sync re-opens everything a name that gained or lost a definition can
 * answer, however many there are. These pin the query layer under the engine
 * cases in sync-rebuild-convergence.test.ts: the batches the edges are read in
 * (a boundary must neither skip nor repeat an edge), what is left alone, and
 * that the pass yields to the event loop between batches while staying ONE
 * transaction: readers see the old graph until it commits, and an interruption
 * leaves it where it was.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { MaybeYield } from '../src/resolution/cooperative-yield';
import type { Edge, Node } from '../src/types';

const roots: string[] = [];
let db: DatabaseConnection | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function open(): QueryBuilder {
  db?.close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-reopen-by-name-'));
  roots.push(root);
  db = DatabaseConnection.initialize(path.join(root, 'test.db'));
  return new QueryBuilder(db.getDb());
}

const node = (id: string, kind: Node['kind'], name: string, filePath: string): Node => ({
  id, kind, name, qualifiedName: name, filePath, language: 'python',
  startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
});

const rows = <T>(sql: string, ...params: unknown[]): T[] => db!.getDb().prepare(sql).all(...params) as T[];

interface GraphState {
  edges: number;
  pending: number;
  failed: number;
}

/** What a reader on the caller's own connection sees of the graph right now. */
const graph = (): GraphState => ({
  edges: rows<{ n: number }>('SELECT COUNT(*) AS n FROM edges')[0]!.n,
  pending: rows<{ n: number }>(`SELECT COUNT(*) AS n FROM unresolved_refs WHERE status = 'pending'`)[0]!.n,
  failed: rows<{ n: number }>(`SELECT COUNT(*) AS n FROM unresolved_refs WHERE status = 'failed'`)[0]!.n,
});

/**
 * A yielder that gives the event loop a real turn at every offer, runs
 * `observe` there, and rejects at the `failAt`th offer (0: never).
 */
function yielder(observe: () => void = () => {}, failAt = 0): MaybeYield {
  let offers = 0;
  return () => {
    if (++offers === failAt) return Promise.reject(new Error('interrupted'));
    observe();
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    return turn.promise;
  };
}

/** Whether the caller's connection can write right now, without waiting for a lock. */
function canWrite(queries: QueryBuilder): boolean {
  db!.getDb().pragma('busy_timeout = 0');
  try {
    queries.setMetadata('probe', '1');
    return true;
  } catch {
    return false;
  } finally {
    db!.getDb().pragma('busy_timeout = 5000');
  }
}

describe('reopenResolutionEdgesByTargetName', () => {
  const STAMPED_CALLS = 600;
  const STAMPED_REFERENCES = 10;
  const STAMPED_KIND_OVERRIDE = 3;
  const REOPENED = STAMPED_CALLS + STAMPED_REFERENCES + STAMPED_KIND_OVERRIDE;
  const FRESH = new Set(['fresh.py']);

  const stamp = (refName: string, extra: Record<string, unknown> = {}) => ({ refName, resolvedBy: 'exact-match', confidence: 0.7, ...extra });
  const edge = (source: string, target: string, kind: Edge['kind'], line: number, metadata: Record<string, unknown>, provenance?: Edge['provenance']): Edge =>
    ({ source, target, kind, line, column: 0, metadata, ...(provenance ? { provenance } : {}) });

  /** `path` has 613 reopenable edges, and the shapes that must stay beside them. */
  function fixture(): QueryBuilder {
    const queries = open();
    queries.insertNodes([
      node('f', 'file', 'app.py', 'app.py'),
      node('g', 'file', 'fresh.py', 'fresh.py'),
      node('p', 'variable', 'path', 'conf.py'),
      node('q', 'variable', 'other', 'conf.py'),
    ]);
    const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
    queries.insertEdges([
      ...lines(1, STAMPED_CALLS).map((line) => edge('f', 'p', 'calls', line, stamp('path'))),
      ...lines(1, STAMPED_REFERENCES).map((line) => edge('f', 'p', 'references', line, stamp('path'))),
      // A reference whose kind differs from its edge's: the stamp says which.
      ...lines(1001, STAMPED_KIND_OVERRIDE).map((line) => edge('f', 'p', 'calls', line, stamp('path', { refKind: 'references' }))),
      // Kept: out of a file this sync re-extracted, with no stamp, synthesized,
      // to another name, and the structural edge into the node.
      ...lines(1, 5).map((line) => edge('g', 'p', 'calls', line, stamp('path'))),
      ...lines(2001, 4).map((line) => edge('f', 'p', 'calls', line, {})),
      ...lines(3001, 2).map((line) => edge('f', 'p', 'calls', line, stamp('path', { synthesizedBy: 'test' }), 'heuristic')),
      ...lines(1, 3).map((line) => edge('f', 'q', 'calls', line, stamp('other'))),
      edge('f', 'p', 'contains', 1, {}),
    ]);
    return queries;
  }
  const KEPT = 5 + 4 + 2 + 3 + 1;

  it.each([1, 7, REOPENED - 1, REOPENED, REOPENED + 1, 1000])(
    'reopens every reconstructable edge across batches of %i, and nothing else',
    async (batchSize) => {
      const queries = fixture();

      expect(await queries.reopenResolutionEdgesByTargetName(['path'], FRESH, { batchSize })).toBe(REOPENED);

      // Past the 500 the rebind used to stop at, and not one more or fewer.
      expect(graph().edges).toBe(KEPT);
      expect(rows('SELECT 1 FROM edges WHERE target = ? AND kind = ? AND source = ?', 'p', 'calls', 'f').length).toBe(4 + 2);

      const pending = rows<{ reference_kind: string; line: number; file_path: string }>(
        `SELECT reference_kind, line, file_path FROM unresolved_refs WHERE reference_name = 'path' AND status = 'pending'`
      );
      expect(pending).toHaveLength(REOPENED);
      expect(new Set(pending.map((r) => r.file_path))).toEqual(new Set(['app.py']));
      const callLines = pending.filter((r) => r.reference_kind === 'calls').map((r) => r.line).sort((a, b) => a - b);
      expect(callLines).toEqual(Array.from({ length: STAMPED_CALLS }, (_, i) => i + 1));
      // The stamped refKind wins over the edge's kind; without one the edge's kind is it.
      expect(pending.filter((r) => r.reference_kind === 'references')).toHaveLength(STAMPED_REFERENCES + STAMPED_KIND_OVERRIDE);

      // Nothing is left to re-open: a second pass is a no-op, not a repeat.
      expect(await queries.reopenResolutionEdgesByTargetName(['path'], FRESH, { batchSize })).toBe(0);
      expect(rows<{ n: number }>(`SELECT COUNT(*) AS n FROM unresolved_refs WHERE reference_name = 'path'`)[0]!.n).toBe(REOPENED);
    }
  );

  it('ignores empty, duplicate and unknown names', async () => {
    const queries = fixture();
    expect(await queries.reopenResolutionEdgesByTargetName([], new Set())).toBe(0);
    expect(await queries.reopenResolutionEdgesByTargetName(['nothing', 'path', 'path'], FRESH)).toBe(REOPENED);
    expect(await queries.reopenResolutionEdgesByTargetName(['other'], new Set())).toBe(3);
  });

  it.each([1, 4, 25, 26])('visits every node of a name, paged %i at a time', async (batchSize) => {
    const queries = open();
    const NODES = 25;
    const EDGES_EACH = 3;
    queries.insertNodes([
      node('f', 'file', 'app.py', 'app.py'),
      ...Array.from({ length: NODES }, (_, i) => node(`d${i}`, 'function', 'dup', `d${i}.py`)),
      node('o', 'function', 'neighbour', 'o.py'),
    ]);
    queries.insertEdges([
      ...Array.from({ length: NODES }, (_, n) =>
        Array.from({ length: EDGES_EACH }, (_, k) => edge('f', `d${n}`, 'calls', n * 10 + k + 1, stamp('dup')))
      ).flat(),
      edge('f', 'o', 'calls', 1, stamp('neighbour')),
    ]);

    expect(await queries.reopenResolutionEdgesByTargetName(['dup'], new Set(), { batchSize })).toBe(NODES * EDGES_EACH);
    expect(graph().edges).toBe(1);
  });

  it('yields between batches of ONE transaction: readers see the old graph until it commits', async () => {
    const queries = fixture();
    const before = graph();
    expect(before).toEqual({ edges: REOPENED + KEPT, pending: 0, failed: 0 });

    // Every offer is a real turn of the loop; a task that only runs on a turn
    // proves the loop was not held for the whole pass.
    let turns = 0;
    let running = true;
    const pump = (): void => {
      turns++;
      if (running) setImmediate(pump);
    };
    setImmediate(pump);

    const seen: GraphState[] = [];
    let blockedWhileOpen = true;
    const observe = (): void => {
      seen.push(graph());
      if (canWrite(queries)) blockedWhileOpen = false;
    };
    let reopened: number;
    try {
      reopened = await queries.reopenResolutionEdgesByTargetName(['path'], FRESH, { batchSize: 50, yieldToLoop: yielder(observe) });
    } finally {
      running = false;
    }

    expect(reopened).toBe(REOPENED);
    // Many batches were written before the last offer, and none showed.
    expect(seen.length).toBeGreaterThan(5);
    for (const state of seen) expect(state).toEqual(before);
    // The transaction held the write lock across the offers, not per batch.
    expect(blockedWhileOpen).toBe(true);
    expect(turns).toBeGreaterThan(5);
    expect(graph()).toEqual({ edges: KEPT, pending: REOPENED, failed: 0 });
    // And it released the lock and its connection.
    expect(canWrite(queries)).toBe(true);
  });

  it('leaves every edge where it was when the pass is interrupted between batches', async () => {
    const queries = fixture();
    const before = graph();
    const ids = rows<{ id: number }>('SELECT id FROM edges ORDER BY id').map((r) => r.id);

    const batches: GraphState[] = [];
    await expect(
      queries.reopenResolutionEdgesByTargetName(['path'], FRESH, { batchSize: 50, yieldToLoop: yielder(() => batches.push(graph()), 4) })
    ).rejects.toThrow('interrupted');

    // Three batches had been rewritten when the fourth offer failed: none of it stays.
    expect(batches).toHaveLength(3);
    expect(graph()).toEqual(before);
    expect(rows<{ id: number }>('SELECT id FROM edges ORDER BY id').map((r) => r.id)).toEqual(ids);
    expect(canWrite(queries)).toBe(true);

    // The same pass, uninterrupted, still does the whole job.
    expect(await queries.reopenResolutionEdgesByTargetName(['path'], FRESH, { batchSize: 50 })).toBe(REOPENED);
  });

  it.each([false, true])('refuses a caller transaction without changing it (transaction state unavailable: %s)', async (unknownState) => {
    const queries = fixture();
    const before = graph();
    if (unknownState) Object.defineProperty(db!.getDb(), 'inTransaction', { value: undefined });
    let attempt!: Promise<number>;
    queries.runInTransaction(() => {
      attempt = queries.reopenResolutionEdgesByTargetName(['path'], FRESH);
    });

    await expect(attempt).rejects.toThrow();
    expect(graph()).toEqual(before);
    expect(canWrite(queries)).toBe(true);
  });

  it('can reopen outside a transaction when the runtime does not expose transaction state', async () => {
    const queries = fixture();
    const before = graph();
    Object.defineProperty(db!.getDb(), 'inTransaction', { value: undefined });
    expect(await queries.reopenResolutionEdgesByTargetName(['path'], FRESH)).toBe(REOPENED);
    expect(graph()).toEqual({ edges: before.edges - REOPENED, pending: before.pending + REOPENED, failed: before.failed });
    expect(canWrite(queries)).toBe(true);
  });
});

describe('reopenFailedReferencesByName', () => {
  /** 600 failed `get`, and the failures parked under a module that wait for the same names. */
  function fixture(): QueryBuilder {
    const queries = open();
    queries.insertNode(node('f', 'file', 'app.py', 'app.py'));
    const ref = (referenceName: string, count: number, offset = 0) =>
      Array.from({ length: count }, (_, i) => ({
        fromNodeId: 'f', referenceName, referenceKind: 'calls' as const,
        line: offset + i + 1, column: 0, filePath: 'app.py', language: 'python' as const,
      }));
    queries.insertUnresolvedRefsBatch([
      ...ref('get', 600),
      ...ref('store.get', 3, 1000),
      ...ref('store.run', 2, 2000),
      ...ref('FastAPI', 4, 3000),
      ...ref('other', 1, 4000),
    ]);
    db!.getDb().exec(`UPDATE unresolved_refs SET status = 'failed', name_tail = CASE reference_name
      WHEN 'get' THEN 'get' WHEN 'other' THEN 'other' WHEN 'FastAPI' THEN 'module:fastapi' ELSE 'module:store' END`);
    // A pending row is nobody's to re-open.
    queries.insertUnresolvedRefsBatch(ref('get', 1, 5000));
    return queries;
  }
  const failedNames = () =>
    rows<{ reference_name: string; n: number }>(
      `SELECT reference_name, COUNT(*) AS n FROM unresolved_refs WHERE status = 'failed' GROUP BY reference_name ORDER BY reference_name`
    ).map((r) => `${r.reference_name}:${r.n}`);

  it.each([1, 7, 100, 1000])('re-opens every failure a name can answer, in batches of %i, by tail, member, whole name and receiver', async (batchSize) => {
    const queries = fixture();

    // The 600 by their tail, and `store.get` by its member: a name past the
    // old ceiling of 500 is still every one of them.
    expect(await queries.reopenFailedReferencesByName(['get'], { batchSize })).toBe(603);
    expect(failedNames()).toEqual(['FastAPI:4', 'other:1', 'store.run:2']);

    // Nothing carries the name any more.
    expect(await queries.reopenFailedReferencesByName(['get'], { batchSize })).toBe(0);
    // `store.run` waits for its receiver, as a barrel's source declares it.
    expect(await queries.reopenFailedReferencesByName(['store'], { batchSize })).toBe(2);
    // A module-parked failure by its whole name.
    expect(await queries.reopenFailedReferencesByName(['FastAPI'], { batchSize })).toBe(4);
    // A name nothing waits for leaves the rest failed.
    expect(await queries.reopenFailedReferencesByName(['missing'], { batchSize })).toBe(0);
    expect(failedNames()).toEqual(['other:1']);
    expect(await queries.reopenFailedReferencesByName([], { batchSize })).toBe(0);
  });

  it('yields between batches of ONE transaction, and an interruption re-opens none', async () => {
    const queries = fixture();
    const before = graph();
    expect(before).toEqual({ edges: 0, pending: 1, failed: 610 });

    const seen: GraphState[] = [];
    expect(await queries.reopenFailedReferencesByName(['get'], { batchSize: 100, yieldToLoop: yielder(() => seen.push(graph())) })).toBe(603);
    expect(seen.length).toBeGreaterThan(5);
    for (const state of seen) expect(state).toEqual(before);
    expect(graph()).toEqual({ edges: 0, pending: 604, failed: 7 });
    expect(canWrite(queries)).toBe(true);

    const again = fixture();
    await expect(again.reopenFailedReferencesByName(['get'], { batchSize: 100, yieldToLoop: yielder(() => {}, 3) })).rejects.toThrow('interrupted');
    expect(graph()).toEqual(before);
    expect(canWrite(again)).toBe(true);
  });
});
