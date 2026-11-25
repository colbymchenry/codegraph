/**
 * Batched resolution cleanup precision (#1269)
 *
 * Post-batch cleanup used to delete resolved refs (and park failed ones) by
 * (from_node_id, reference_name, reference_kind) — no line/col. When one
 * caller contains several call sites to the SAME callee and a batch boundary
 * splits them, resolving the first batch's sites deleted every row with that
 * key, including sibling rows in later batches that were never attempted —
 * their edges were silently never created. Observed on nlohmann/json:
 * `write_cbor` calls `to_char_type` at 11 lines; the batch boundary
 * deterministically dropped the last site's edge.
 *
 * Cleanup now targets the exact `unresolved_refs.id` for DB-loaded refs, with
 * the key-tuple delete kept only as the fallback for hand-built refs (public
 * resolveAndPersist API) that carry no row id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createResolver } from '../src/resolution';
import { Node, UnresolvedReference } from '../src/types';

function makeNode(id: string, name: string, kind: Node['kind'], filePath: string, startLine: number): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine,
    endLine: startLine + 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function makeRef(fromNodeId: string, name: string, line: number): UnresolvedReference {
  return {
    fromNodeId,
    referenceName: name,
    referenceKind: 'calls',
    line,
    column: 2,
    filePath: 'caller.ts',
    language: 'typescript',
  };
}

describe('Batched ref cleanup precision (#1269)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-refcleanup-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    // The files the refs/nodes point at must exist for resolution context.
    fs.writeFileSync(path.join(dir, 'caller.ts'), 'callee();\ncallee();\ncallee();\ncallee();\ncallee();\n');
    fs.writeFileSync(path.join(dir, 'callee.ts'), 'export function callee() {}\n');
    q.insertNode(makeNode('fn:caller', 'caller', 'function', 'caller.ts', 1));
    q.insertNode(makeNode('fn:callee', 'callee', 'function', 'callee.ts', 1));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates an edge for EVERY same-named call site when the sites straddle a batch boundary', async () => {
    // 5 call sites, batch size 2 → boundaries after sites 2 and 4. With the
    // key-tuple delete, batch 1's cleanup removed ALL five rows and only 2
    // edges ever existed.
    const lines = [1, 2, 3, 4, 5];
    q.insertUnresolvedRefsBatch(lines.map((line) => makeRef('fn:caller', 'callee', line)));
    expect(q.getUnresolvedReferencesCount()).toBe(5);

    const resolver = createResolver(dir, q);
    await resolver.resolveAndPersistBatched(undefined, 2);

    const edges = q
      .getOutgoingEdges('fn:caller')
      .filter((e) => e.kind === 'calls' && e.target === 'fn:callee');
    expect(edges.map((e) => e.line).sort()).toEqual(lines);
    // Every processed row left the pending set (drain terminated normally).
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  it('parks EVERY unresolvable same-named site as failed only after its own attempt', async () => {
    // 4 sites calling a name with no definition, batch size 2. Both halves
    // must drain to status='failed' (previously batch 1's key-tuple update
    // also flipped batch 2's rows before they were attempted — same outcome
    // here, but the loop must still terminate and leave nothing pending).
    q.insertUnresolvedRefsBatch([1, 2, 3, 4].map((line) => makeRef('fn:caller', 'missingCallee', line)));

    const resolver = createResolver(dir, q);
    await resolver.resolveAndPersistBatched(undefined, 2);

    expect(q.getUnresolvedReferencesCount()).toBe(0); // nothing pending
    const failed = q.getUnresolvedReferences().filter((r) => r.referenceName === 'missingCallee');
    expect(failed).toHaveLength(4); // all parked, none deleted
  });

  it('hand-built refs without a rowId still clean up through the key fallback', () => {
    // Public resolveAndPersist API: refs built in memory (no rowId) that also
    // exist as DB rows — the legacy key-tuple delete must still clear them.
    q.insertUnresolvedRefsBatch([makeRef('fn:caller', 'callee', 1)]);
    const resolver = createResolver(dir, q);
    const inMemory = makeRef('fn:caller', 'callee', 1); // no rowId
    const result = resolver.resolveAndPersist([inMemory]);

    expect(result.resolved).toHaveLength(1);
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });
});
