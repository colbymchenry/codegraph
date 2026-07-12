/**
 * Batch-boundary edge loss in resolveAndPersistBatched.
 *
 * The batched resolver reads pending refs in LIMIT/OFFSET pages (offset always
 * 0) and, after each batch, deletes the resolved rows. The delete used to key
 * only on (from_node_id, reference_name, reference_kind) — but edge identity
 * ALSO includes line/col (idx_edges_identity, migration v6), so every call site
 * is a distinct edge. When a same-key group of resolvable refs (one caller
 * invoking the same target from many call sites) is larger than the batch size,
 * the first batch resolves its slice, then the 3-tuple delete wipes the WHOLE
 * group — including the tail rows a later batch hasn't read yet. Those edges are
 * silently lost and the index still reports pending=0.
 *
 * This pins the fix: the per-batch delete must remove only the rows actually
 * resolved in that batch (full call-site identity, line/col included), so a
 * straddling group's tail stays pending and is resolved by the next batch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import type { Edge } from '../src/types';

describe('Batch-boundary edge loss (resolveAndPersistBatched)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-batch-boundary-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function findFunction(name: string) {
    const hit = cg
      .searchNodes(name)
      .find((r) => (r.node.kind === 'function' || r.node.kind === 'method') && r.node.name === name);
    expect(hit, `expected an indexed definition of ${name}`).toBeDefined();
    return hit!.node;
  }

  it('keeps every call-site edge when a resolvable same-key group straddles the batch boundary', async () => {
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'target.ts'), 'export function target(): number { return 1; }\n');

    // One caller invoking `target()` from CALL_COUNT distinct call sites. This
    // is a single same-key group (from=run, name=target, kind=calls) of
    // CALL_COUNT rows with distinct line/col — CALL_COUNT expected `calls`
    // edges.
    const CALL_COUNT = 15;
    const lines: string[] = ["import { target } from './target';", 'export function run(): number {', '  let n = 0;'];
    for (let i = 0; i < CALL_COUNT; i++) {
      lines.push('  n += target();');
    }
    lines.push('  return n;', '}', '');
    fs.writeFileSync(path.join(srcDir, 'caller.ts'), lines.join('\n'));

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    // Re-extract the caller without resolving, so all CALL_COUNT refs are back
    // in the pending set for a fresh batched pass.
    fs.appendFileSync(path.join(srcDir, 'caller.ts'), '\n// requeue\n');
    await cg.indexFiles(['src/caller.ts']);
    expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);

    // batchSize 10 < CALL_COUNT 15: the group straddles the boundary.
    const resolver = (
      cg as unknown as {
        resolver: { resolveAndPersistBatched(p?: unknown, b?: number): Promise<unknown> };
      }
    ).resolver;
    await resolver.resolveAndPersistBatched(undefined, 10);

    const run = findFunction('run');
    const target = findFunction('target');
    const callEdges = cg
      .getOutgoingEdges(run.id)
      .filter((e: Edge) => e.kind === 'calls' && e.target === target.id);

    expect(callEdges.length).toBe(CALL_COUNT);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });

  // Control: a same-key group that fits within a single batch never straddles
  // the boundary, so the per-batch 3-tuple delete only ever sees the whole
  // group after it was fully resolved — there is no unread tail to clobber.
  // Zero loss is expected BOTH pre- and post-fix; this guards against a future
  // change regressing the exact-fit case. Here batchSize === total pending, so
  // everything (the whole call group included) resolves in one batch.
  it('keeps every call-site edge when the pending set fills the batch exactly', async () => {
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'target.ts'), 'export function target(): number { return 1; }\n');

    const CALL_COUNT = 10;
    const lines: string[] = ["import { target } from './target';", 'export function run(): number {', '  let n = 0;'];
    for (let i = 0; i < CALL_COUNT; i++) {
      lines.push('  n += target();');
    }
    lines.push('  return n;', '}', '');
    fs.writeFileSync(path.join(srcDir, 'caller.ts'), lines.join('\n'));

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    fs.appendFileSync(path.join(srcDir, 'caller.ts'), '\n// requeue\n');
    await cg.indexFiles(['src/caller.ts']);
    // Pending = the CALL_COUNT-row call group plus the file's import ref(s).
    const pendingTotal = cg.getPendingReferenceCount();
    expect(pendingTotal).toBeGreaterThanOrEqual(CALL_COUNT);

    const resolver = (
      cg as unknown as {
        resolver: { resolveAndPersistBatched(p?: unknown, b?: number): Promise<unknown> };
      }
    ).resolver;
    // batchSize === total pending: exact fit, single batch, no straddle.
    await resolver.resolveAndPersistBatched(undefined, pendingTotal);

    const run = findFunction('run');
    const target = findFunction('target');
    const callEdges = cg
      .getOutgoingEdges(run.id)
      .filter((e: Edge) => e.kind === 'calls' && e.target === target.id);

    expect(callEdges.length).toBe(CALL_COUNT);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });

  // Retry-path clobber (resolveAndPersistListYielding — the #1240 failed-ref
  // retry path). That path resolves a CALLER-SUPPLIED list of refs and then
  // deletes the resolved rows; pre-fix its delete keyed on the 3-tuple
  // (from_node_id, reference_name, reference_kind) with no line/col AND no
  // status filter, so resolving a SUBSET of a same-key group wiped the WHOLE
  // group — including sibling rows the retry list never touched, which stayed
  // pending. Their edges were then silently lost.
  //
  // A genuine failed+pending split of ONE same-key group isn't naturally
  // constructible: refs are stored per source file and re-extraction rewrites
  // a file's whole ref set at once (all pending or all failed together), so no
  // ordinary index/sync leaves one caller's identical call sites in mixed
  // status. We therefore drive the exact vulnerable call the way #1240 does —
  // handing resolveAndPersistListYielding a caller-supplied UnresolvedReference
  // list that is a SUBSET of a pending same-key group — and assert the rows it
  // was NOT given survive and later resolve into their edges. The pre-fix
  // delete has no status filter, so it clobbers those pending siblings exactly
  // as it would clobber pending siblings of a failed retry set.
  it('does not clobber pending siblings when resolveAndPersistListYielding resolves a subset of a same-key group', async () => {
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'target.ts'), 'export function target(): number { return 1; }\n');

    const CALL_COUNT = 12;
    const RETRY_SUBSET = 4; // handed to the list path; the other 8 stay pending
    const lines: string[] = ["import { target } from './target';", 'export function run(): number {', '  let n = 0;'];
    for (let i = 0; i < CALL_COUNT; i++) {
      lines.push('  n += target();');
    }
    lines.push('  return n;', '}', '');
    fs.writeFileSync(path.join(srcDir, 'caller.ts'), lines.join('\n'));

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    fs.appendFileSync(path.join(srcDir, 'caller.ts'), '\n// requeue\n');
    await cg.indexFiles(['src/caller.ts']);
    const pendingBefore = cg.getPendingReferenceCount();
    expect(pendingBefore).toBeGreaterThanOrEqual(CALL_COUNT);

    const internals = cg as unknown as {
      resolver: {
        resolveAndPersistListYielding(refs: unknown[]): Promise<unknown>;
        resolveAndPersistBatched(p?: unknown, b?: number): Promise<unknown>;
      };
      queries: {
        getUnresolvedReferencesBatch(
          offset: number,
          limit: number
        ): Array<{ referenceName: string; referenceKind: string }>;
      };
    };

    // Isolate the same-key call group (from=run, name=target, kind=calls) from
    // the file's other pending refs (the import), then hand only a subset to
    // the retry-list path.
    const pending = internals.queries.getUnresolvedReferencesBatch(0, pendingBefore);
    const callGroup = pending.filter(
      (r) => r.referenceName === 'target' && r.referenceKind === 'calls'
    );
    expect(callGroup.length).toBe(CALL_COUNT);
    const subset = callGroup.slice(0, RETRY_SUBSET);

    // Resolve ONLY the subset through the retry-list path. Pre-fix, the 3-tuple
    // delete here also removes the other 8 pending call siblings; post-fix it
    // removes only these 4 (matched by line/col).
    await internals.resolver.resolveAndPersistListYielding(subset);

    // The call siblings the retry list never touched must still be pending.
    expect(cg.getPendingReferenceCount()).toBe(pendingBefore - RETRY_SUBSET);

    // A later resolution pass must turn every survivor into its edge.
    await internals.resolver.resolveAndPersistBatched(undefined, 10);

    const run = findFunction('run');
    const target = findFunction('target');
    const callEdges = cg
      .getOutgoingEdges(run.id)
      .filter((e: Edge) => e.kind === 'calls' && e.target === target.id);

    expect(callEdges.length).toBe(CALL_COUNT);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });
});
