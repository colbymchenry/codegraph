/**
 * getAllNodeNames() is read once per database state (#2184).
 *
 * The fuzzy search fallback scans the distinct name list, and a long prose
 * prompt runs it once per query term that FTS and LIKE miss — hundreds of
 * re-reads of `SELECT DISTINCT name FROM nodes` per retrieval. The list is now
 * memoized against the same change stamp as the dominant-file memo (#1864).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

describe('node names — read once per index state (#2184)', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a many-term query reads the name list once, and a sync is seen', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-names-'));
    fs.writeFileSync(path.join(dir, 'engine.ts'), 'export function startEngine(): void {}\n');
    cg = await CodeGraph.init(dir, { index: true });
    const read = vi.spyOn(queriesOf(cg) as unknown as { readAllNodeNames: () => string[] }, 'readAllNodeNames');

    // Every word misses FTS and LIKE, so each one falls through to the fuzzy pass.
    await cg.findRelevantContext('how does zorblax quuxify the wibbler and frobnicate glorp');
    expect(read).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(dir, 'engine.ts'), 'export function stopEngine(): void {}\n');
    await cg.sync();
    expect(queriesOf(cg).getAllNodeNames()).toContain('stopEngine');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
