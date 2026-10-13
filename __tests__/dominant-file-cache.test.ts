/**
 * getDominantFile() is computed once per database state (#1864).
 *
 * The dominant-file heuristic (context ranking's core-directory boost) is a
 * whole-graph aggregation whose answer does not depend on the query, yet it
 * ran on every generic explore — seconds per call on a large index. It is now
 * memoized against a database change stamp. These tests pin both halves:
 * repeated explores reuse the answer, and any write — by this connection or
 * by another process's sync — makes the next call see the new graph.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection, getDatabasePath } from '../src/db';

/** A file whose functions call each other in a chain: `n` in-file call edges. */
function chain(prefix: string, n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? `${prefix}${i + 1}();` : '';
    lines.push(`export function ${prefix}${i}(): void { ${next} }`);
  }
  return lines.join('\n') + '\n';
}

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function spyCompute(cg: CodeGraph) {
  return vi.spyOn(queriesOf(cg) as unknown as { computeDominantFile: () => unknown }, 'computeDominantFile');
}

describe('dominant file — computed once per index state (#1864)', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dominant-'));
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'ext'));
    fs.writeFileSync(path.join(dir, 'core', 'engine.ts'), chain('engineStep', 40));
    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 5));
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('reuses the answer across explores while the database is unchanged', async () => {
    // indexAll warmed the memo in memory and in the sidecar; start from neither.
    (await setup()).close();
    open.splice(0);
    fs.rmSync(getDatabasePath(dir) + '.memo.json', { force: true });
    const cg = await CodeGraph.open(dir);
    open.push(cg);
    const compute = spyCompute(cg);

    for (const q of ['engine step', 'plugin step', 'how does the engine run']) {
      await cg.findRelevantContext(q);
    }
    expect(compute).toHaveBeenCalledTimes(1);
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('sees a new dominant file after a sync changes the graph', async () => {
    const cg = await setup();
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');

    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    await cg.sync();

    const compute = spyCompute(cg);
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('ext/plugin.ts');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('sees a sync made through another connection (another process)', async () => {
    const writer = await setup();
    const reader = await CodeGraph.open(dir);
    open.push(reader);
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');

    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    await writer.sync();

    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
  });

  it('does not keep a result read inside a transaction that is rolled back', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const before = q.getDominantFile();
    const db = (cg as any).db.getDb();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM edges');
      expect(q.getDominantFile()).toBeNull();
    } finally {
      db.exec('ROLLBACK');
    }
    expect(q.getDominantFile()).toEqual(before);
  });

  it('forgets the answer when rebound to another connection (a pool worker following a rebuilt index)', async () => {
    await setup();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dominant-other-'));
    const conns: DatabaseConnection[] = [];
    try {
      fs.mkdirSync(path.join(other, 'ext'));
      fs.writeFileSync(path.join(other, 'ext', 'plugin.ts'), chain('pluginStep', 120));
      (await CodeGraph.init(other, { index: true })).close();
      conns.push(DatabaseConnection.open(getDatabasePath(dir)), DatabaseConnection.open(getDatabasePath(other)));
      const q = new QueryBuilder(conns[0]!.getDb());
      expect(q.getDominantFile()?.filePath).toBe('core/engine.ts');
      // Two fresh connections to different databases can report the same
      // change stamp, so only dropping the memo on rebind keeps this honest.
      q.rebind(conns[1]!.getDb());
      expect(q.getDominantFile()?.filePath).toBe('ext/plugin.ts');
    } finally {
      for (const c of conns) c.close();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('sees a database rebuilt and reopened under it', async () => {
    const reader = await setup();
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');
    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    const rebuilt = await CodeGraph.recreate(dir);
    try { await rebuilt.indexAll(); } finally { rebuilt.close(); }
    expect(reader.reopenIfReplaced()).toBe(true);
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
  });
});
