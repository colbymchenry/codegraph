/**
 * getUnresolvedReferencesByFiles must survive dense result sets (#1558).
 *
 * The input file-path list is chunked under SQLite's parameter limit, but the
 * ROWS a chunk returns are unbounded — and appending them with
 * `rows.push(...chunkRows)` passes every row as a call argument, so a dense
 * chunk (a recovery sync re-indexing many files at once, e.g. the #1541
 * self-heal) exceeded V8's argument limit and killed the whole sync with
 * "Maximum call stack size exceeded" after the store phase, leaving every
 * re-indexed file's references unresolved. Reproduced for real on a
 * cpython-stdlib-sized heal (919 files, 234k refs). The append is now a loop;
 * this pins it with a result set well past V8's argument ceiling (~124k).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import type { UnresolvedReference } from '../src/types';

describe('unresolved-ref loads with dense result sets (#1558)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-spread-'));
    fs.writeFileSync(path.join(dir, 'anchor.py'), 'def anchor():\n    return 1\n');
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns 200k pending refs from few files without exhausting the call stack', () => {
    const queries = (cg as unknown as {
      queries: {
        insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void;
        getUnresolvedReferencesByFiles(paths: string[]): UnresolvedReference[];
      };
    }).queries;

    const FILES = 200;
    const TOTAL = 200_000;
    const paths: string[] = Array.from({ length: FILES }, (_, i) => `src/f${i}.py`);
    // unresolved_refs.from_node_id is FK-constrained — anchor on a real node.
    const anchorId = cg.getNodesInFile('anchor.py')[0]!.id;

    const batch: UnresolvedReference[] = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({
        fromNodeId: anchorId,
        referenceName: `ref_${i}`,
        referenceKind: 'call',
        line: (i % 1000) + 1,
        column: 0,
        filePath: paths[i % FILES]!,
        language: 'python',
      });
      if (batch.length === 20_000) {
        queries.insertUnresolvedRefsBatch(batch);
        batch.length = 0;
      }
    }
    if (batch.length > 0) queries.insertUnresolvedRefsBatch(batch);

    // All 200 paths fit in ONE SQLite parameter chunk, so a single query
    // returns all 200k rows — the exact shape that blew the argument limit.
    const rows = queries.getUnresolvedReferencesByFiles(paths);
    expect(rows.length).toBe(TOTAL);
  });
});
