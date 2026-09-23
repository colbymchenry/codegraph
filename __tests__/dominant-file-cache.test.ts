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
import CodeGraph, { createExtensionProject, packExtension } from '../src';
import { ExtensionManager } from '../src/plugins/manager';
import type { QueryBuilder } from '../src/db/queries';

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
    const cg = await setup();
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
  it('does not cache uncommitted results across rollback', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const before = q.getDominantFile();
    const db = (cg as any).db.getDb();
    db.exec('BEGIN');
    try { db.exec('DELETE FROM edges'); expect(q.getDominantFile()).toBeNull(); }
    finally { db.exec('ROLLBACK'); }
    expect(q.getDominantFile()).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')('invalidates when a replacement database is reopened', async () => {
    const reader = await setup();
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');
    fs.writeFileSync(path.join(dir, 'ext/plugin.ts'), chain('pluginStep', 120));
    const rebuilt = await CodeGraph.recreate(dir);
    try { await rebuilt.indexAll(); } finally { rebuilt.close(); }
    expect(await reader.reopenIfReplacedAsync()).toBe(true);
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
  });

  it('sees an extension graph commit and its removal', async () => {
    const cg = await setup();
    expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');
    fs.writeFileSync(path.join(dir, 'ext/plugin.ts'), chain('pluginStep', 15));
    await cg.sync();
    const authorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-author-'));
    const author = path.join(authorRoot, 'extension');
    try {
      createExtensionProject(author, 'cache-edges');
      const file = path.join(author, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.codegraph.capabilities = ['synthPasses']; fs.writeFileSync(file, JSON.stringify(manifest));
      fs.writeFileSync(path.join(author, 'index.cjs'), `module.exports=()=>({synthPasses:[{name:'dense',languages:['typescript'],run(ctx){
        const nodes=Array.from({length:15},(_,i)=>ctx.getNodesByName('pluginStep'+i)[0]).filter(Boolean);
        return nodes.flatMap((a,i)=>nodes.map((b,j)=>({source:a.id,target:b.id,kind:'calls',line:i+1,metadata:{label:'test '+j}})));
      }}]});`);
      const manager = new ExtensionManager(dir);
      await manager.install({bytes:packExtension(author)});
      await cg.reopenIfReplacedAsync();
      expect(queriesOf(cg).getDominantFile()?.filePath).toBe('ext/plugin.ts');
      await manager.remove('cache-edges');
      await cg.reopenIfReplacedAsync();
      expect(queriesOf(cg).getDominantFile()?.filePath).toBe('core/engine.ts');
    } finally { fs.rmSync(authorRoot,{recursive:true,force:true}); }
  });

});
