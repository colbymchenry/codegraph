/**
 * Work every `codegraph_explore` repeated although its answer depends only on
 * the index: the graph's stats counts (explore sizes its output from them),
 * the distinct name list fuzzy search walks, and the `codegraph.json` probe
 * search ranking makes for each candidate path. The first two are now held per
 * database change stamp, like the dominant file (#1864).
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

function dbOf(cg: CodeGraph): any {
  return (cg as any).db.getDb();
}

/** Count statements run through this CodeGraph's connection whose SQL matches. */
function countStatements(cg: CodeGraph, pattern: RegExp): () => number {
  const db = dbOf(cg);
  const prepare = db.prepare.bind(db);
  let n = 0;
  vi.spyOn(db, 'prepare').mockImplementation((sql: unknown) => {
    const stmt = prepare(sql as string);
    if (!pattern.test(String(sql))) return stmt;
    for (const method of ['all', 'get'] as const) {
      const run = stmt[method].bind(stmt);
      stmt[method] = (...args: unknown[]) => { n++; return run(...args); };
    }
    return stmt;
  });
  // Statements prepared before the spy (lazily cached ones) must be re-prepared.
  (queriesOf(cg) as any).stmts = {};
  return () => n;
}

describe('explore repeat work — held per index state', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repeat-'));
    fs.writeFileSync(path.join(dir, 'engine.ts'), 'export function engineStart(): void { engineRun(); }\nexport function engineRun(): void {}\n');
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('counts the graph once across explores while the index is unchanged', async () => {
    const cg = await setup();
    const counted = countStatements(cg, /GROUP BY kind/);
    for (const q of ['engine start', 'how does the engine run', 'engineRun']) {
      await cg.findRelevantContext(q);
      cg.getStats();
    }
    expect(counted()).toBe(2); // nodes by kind + edges by kind, once
  });

  it('hands every caller its own stats object', async () => {
    const cg = await setup();
    const first = cg.getStats();
    first.nodesByKind.function = -1;
    first.fileCount = -1;
    const second = cg.getStats();
    expect(second.nodesByKind.function).toBe(2);
    expect(second.fileCount).toBe(1);
  });

  it('reuses the name list across fuzzy searches while the index is unchanged', async () => {
    const cg = await setup();
    const counted = countStatements(cg, /SELECT DISTINCT name FROM nodes$/);
    const q = queriesOf(cg);
    for (let i = 0; i < 3; i++) q.getAllNodeNames();
    expect(counted()).toBe(1);
  });

  it('sees new counts and names after a sync', async () => {
    const cg = await setup();
    expect(cg.getStats().fileCount).toBe(1);
    expect(queriesOf(cg).getAllNodeNames()).not.toContain('pluginLoad');
    fs.writeFileSync(path.join(dir, 'plugin.ts'), 'export function pluginLoad(): void {}\n');
    await cg.sync();
    expect(cg.getStats().fileCount).toBe(2);
    expect(queriesOf(cg).getAllNodeNames()).toContain('pluginLoad');
  });

  it('sees a sync made through another connection (another process)', async () => {
    const writer = await setup();
    const reader = await CodeGraph.open(dir);
    open.push(reader);
    expect(reader.getStats().fileCount).toBe(1);
    fs.writeFileSync(path.join(dir, 'plugin.ts'), 'export function pluginLoad(): void {}\n');
    await writer.sync();
    expect(reader.getStats().fileCount).toBe(2);
    expect(queriesOf(reader).getAllNodeNames()).toContain('pluginLoad');
  });
});

