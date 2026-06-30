/**
 * Regression test for #874 — `codegraph index` reported "0 nodes, 0 edges"
 * on a re-index of unchanged files.
 *
 * `indexAll()` reports `nodesCreated`/`edgesCreated` as the *net delta* of the
 * run. When `init` has already populated the index and `index` is re-run with
 * no file changes, every file's content hash matches, so no nodes are
 * re-inserted and the delta is 0 — even though the index is fully populated.
 *
 * The fix adds absolute `totalNodes`/`totalEdges` to the result so the CLI can
 * show the real index size instead of a misleading 0. These tests pin that
 * `indexAll` keeps the index populated across a re-index and surfaces the
 * absolute totals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('#874 — re-index of unchanged files reports absolute totals', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reindex-totals-'));
    fs.writeFileSync(
      path.join(testDir, 'app.ts'),
      `export function hello(name: string) { return 'hi ' + name; }\n` +
        `export class Greeter {\n` +
        `  constructor(private prefix: string) {}\n` +
        `  greet(name: string) { return this.prefix + hello(name); }\n` +
        `}\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('populates totals on the first full index', async () => {
    const first = await cg.indexAll();

    expect(first.success).toBe(true);
    expect(first.filesIndexed).toBeGreaterThan(0);
    // First index into an empty DB: delta == absolute total.
    expect(first.nodesCreated).toBeGreaterThan(0);
    expect(first.totalNodes).toBe(first.nodesCreated);
    expect(first.totalEdges).toBe(first.edgesCreated);
  });

  it('re-index of unchanged files: delta is 0 but totals stay populated (#874)', async () => {
    const first = await cg.indexAll();
    const firstTotalNodes = first.totalNodes;
    const firstTotalEdges = first.totalEdges;

    // Re-run with no file changes — every content hash matches, so nothing is
    // re-inserted and the net delta is 0.
    const second = await cg.indexAll();

    expect(second.success).toBe(true);
    expect(second.filesIndexed).toBeGreaterThan(0);
    // The misleading part the user saw: net delta is 0...
    expect(second.nodesCreated).toBe(0);
    expect(second.edgesCreated).toBe(0);
    // ...but the index is NOT empty — absolute totals match the first index.
    expect(second.totalNodes).toBe(firstTotalNodes);
    expect(second.totalEdges).toBe(firstTotalEdges);
    expect(second.totalNodes).toBeGreaterThan(0);

    // And the data really is still queryable.
    const results = cg.searchNodes('Greeter');
    expect(results.length).toBeGreaterThan(0);
  });
});
