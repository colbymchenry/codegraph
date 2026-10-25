import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/**
 * #1214 — perf tuning must never change indexed results. This pins that
 * bulk indexing a project twice (independent, fresh DBs) yields identical
 * node/edge counts and identical resolution outcomes, so the optimizations
 * that ship with the issue (e.g. the raised FILE_IO_BATCH_SIZE / parse-pool
 * constants) can't silently alter the graph.
 */
describe('bulk index output determinism (#1214)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    }
    dirs.length = 0;
  });

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-identity-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function add(x, y) { return x + y; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.js'),
      "import { add } from './a.js';\n" +
      'export function run() {\n' +
      '  return add(1, 2);\n' +
      '}\n'
    );
    fs.writeFileSync(path.join(dir, 'c.py'), 'def helper(n):\n    return n * 2\n');
    return dir;
  }

  async function index(dir: string): Promise<CodeGraph> {
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    return cg;
  }

  it('produces identical node/edge counts and cross-file resolution across runs', async () => {
    const cg1 = await index(makeProject());
    const cg2 = await index(makeProject());

    const q1 = (cg1 as unknown as { queries: { getNodeAndEdgeCount(): { nodes: number; edges: number } } }).queries;
    const q2 = (cg2 as unknown as { queries: { getNodeAndEdgeCount(): { nodes: number; edges: number } } }).queries;
    const c1 = q1.getNodeAndEdgeCount();
    const c2 = q2.getNodeAndEdgeCount();
    expect(c2.nodes).toBe(c1.nodes);
    expect(c2.edges).toBe(c1.edges);
    expect(c1.nodes).toBeGreaterThan(0);
    expect(c1.edges).toBeGreaterThan(0);

    // Same resolution outcome: b.js's `run` reaches a.js's `add` in both.
    for (const cg of [cg1, cg2]) {
      const add = cg.getNodesByName('add').find((n) => n.filePath === 'a.js' && n.kind === 'function')!;
      const run = cg.getNodesByName('run').find((n) => n.filePath === 'b.js' && n.kind === 'function')!;
      const callersOfAdd = cg.getIncomingEdges(add.id).filter((e) => e.kind === 'calls').map((e) => e.source);
      expect(callersOfAdd).toContain(run.id);
    }

    cg1.close();
    cg2.close();
  });
});
