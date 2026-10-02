import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import CodeGraph from '../../src/index';
import type { Edge } from '../../src/types';
import type { SqliteDatabase } from '../../src/db/sqlite-adapter';
import { importScipFile, runScipPass, scipStatus } from '../../src/scip';
import { scipVerdict } from '../../src/scip/notes';
import { produceIndex } from '../../src/scip/produce';
import { ROLE_DEFINITION, encodeDocument, encodeMetadata, loadScipIndex } from '../../src/scip/reader';
import { ScipReindexScheduler } from '../../src/scip/reindex';
import { ToolHandler } from '../../src/mcp/tools';
import { SILENT_EDGE, indexPath, scipDir, tryReindexLock } from '../../src/scip/store';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scip-ts');

interface EdgeRow { id: number; src: string; tgt: string; kind: string; line: number; provenance: string | null; metadata: string | null }

describe('SCIP merge (TypeScript fixture)', () => {
  let dir: string;
  let cg: CodeGraph;

  const edges = (): EdgeRow[] => cg.scipReadDb().prepare(`
    SELECT e.id, s.qualified_name AS src, t.qualified_name AS tgt, e.kind, e.line, e.provenance, e.metadata
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind IN ('calls', 'instantiates') ORDER BY e.line, t.qualified_name`).all() as EdgeRow[];
  const edge = (src: string, tgt: string) => edges().find(e => e.src === src && e.tgt === tgt);
  const flags = (e: EdgeRow | undefined) => (e?.metadata ? JSON.parse(e.metadata) : {}) as Record<string, unknown>;
  const nodeId = (qn: string) => (cg.scipReadDb().prepare('SELECT id FROM nodes WHERE qualified_name = ?').get(qn) as { id: string }).id;
  const inject = (src: string, tgt: string, line: number, provenance: string | null = null) =>
    cg.scipReadDb().prepare(`INSERT INTO edges (source, target, kind, line, col, provenance) VALUES (?, ?, 'calls', ?, 2, ?)`)
      .run(nodeId(src), nodeId(tgt), line, provenance);
  const pass = () => cg.scipWrite(db => runScipPass(db, dir));
  /** `scip import` of the prebuilt index, "built" now — i.e. after the sources were copied in. */
  const importFixture = (index = 'index.scip') => {
    const copy = path.join(dir, `built-${index}`);
    fs.copyFileSync(path.join(FIXTURE, index), copy);
    return importScipFile(dir, copy);
  };
  const writeConfig = (scip: unknown) => fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip }));
  /** A fake indexer: copies a prebuilt index to `{out}` (and counts its runs), after `delayMs`. */
  const fakeIndexer = (index: string, delayMs = 0) => writeConfig({
    typescript: {
      cmd: process.execPath,
      args: ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delayMs});const fs=require("fs");fs.appendFileSync(process.argv[3],"x");fs.copyFileSync(process.argv[1],process.argv[2])`,
        path.join(FIXTURE, index), '{out}', path.join(dir, 'runs.log')],
    },
  });
  const runs = () => (fs.existsSync(path.join(dir, 'runs.log')) ? fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').length : 0);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-'));
    fs.cpSync(path.join(FIXTURE, 'project'), dir, { recursive: true });
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a merge in chunks (here a file each) ends where a whole merge does', async () => {
    const graph = (g: CodeGraph) => g.scipReadDb().prepare(`SELECT s.qualified_name || '>' || t.qualified_name || ':' || e.kind || ':' ||
      IFNULL(e.line, '') || ':' || IFNULL(e.provenance, '-') || ':' || IFNULL(e.metadata, '') AS e
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target ORDER BY 1`).all().map(r => (r as { e: string }).e);
    importFixture();
    await pass();
    const whole = graph(cg);
    expect(whole.some(e => e.includes(':scip:'))).toBe(true);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-chunks-'));
    fs.cpSync(path.join(FIXTURE, 'project'), other, { recursive: true });
    const cg2 = await CodeGraph.init(other);
    process.env.CODEGRAPH_SCIP_MERGE_CHUNK = '1';
    try {
      await cg2.indexAll();
      const copy = path.join(other, 'built-index.scip');
      fs.copyFileSync(path.join(FIXTURE, 'index.scip'), copy);
      importScipFile(other, copy);
      const report = await cg2.scipWrite(db => runScipPass(db, other));
      expect(report!.judgedDocuments).toBeGreaterThan(1); // more than one chunk
      expect(graph(cg2)).toEqual(whole);
    } finally {
      delete process.env.CODEGRAPH_SCIP_MERGE_CHUNK;
      cg2.close();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('is a no-op without an installed index', async () => {
    expect(await pass()).toBeNull();
  });

  it('verifies agreeing edges and adds the calls the heuristic missed', async () => {
    expect(edge('sum', 'Invoice::totalPrice')).toBeUndefined(); // call inside a reduce() callback
    importFixture();
    const report = (await pass())!;
    expect(report.freshDocuments).toBe(2);
    expect(edge('sum', 'helper')?.provenance).toBe('scip');
    expect(edge('make', 'Invoice')).toMatchObject({ kind: 'instantiates', provenance: 'scip' });
    expect(edge('Service::run', 'Service::step')?.provenance).toBe('scip');
    expect(edge('sum', 'Invoice::totalPrice')).toMatchObject({ provenance: 'scip', line: 6 });
    expect(scipVerdict({ provenance: 'scip' } as Edge)).toBe('verified');
  });

  // The compiled worker only exists in dist/ (from source, mergeInstalled merges in process).
  it.runIf(fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'scip', 'merge-worker.js')))(
    'the merge after a reindex runs on its own thread and connection; the caller sees it once committed', async () => {
      importFixture();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mergeInstalled } = require('../../dist/scip/index.js') as typeof import('../../src/scip/index');
      const untouchable = new Proxy({}, { get: () => { throw new Error('the caller\'s connection was used'); } }) as SqliteDatabase;
      const report = await mergeInstalled({
        getProjectRoot: () => dir,
        scipDbPath: () => cg.scipDbPath(),
        scipReadDb: () => untouchable,
        scipWrite: async fn => fn(untouchable),
      }, [{ status: 'installed', lang: 'typescript', documents: 2, resolvedCalls: 0, durationMs: 0, warnings: [] }]);
      expect(report?.outcome.edgesUpdated).toBeGreaterThan(0);
      expect(edge('sum', 'helper')?.provenance).toBe('scip');
    });

  it('explore lists every compiler-verified call site of the symbol a query names', async () => {
    const explore = async (query: string) =>
      ((await new ToolHandler(cg).execute('codegraph_explore', { query })).content[0] as { text: string }).text;
    expect(await explore('Invoice totalPrice callers')).not.toContain('**Call sites of'); // no compiler data yet: unchanged
    importFixture();
    await pass();
    const text = await explore('Invoice totalPrice callers');
    expect(text).toMatch(/\*\*Call sites of `Invoice::totalPrice` \(src\/models\.ts:\d+\) — \d+: \d+ compiler-verified\*\*/);
    expect(text).toContain('`src/main.ts`\n- 6 — `return invoices.reduce((acc, inv) => acc + inv.totalPrice(), 0) + helper(2);` (in `sum`)');
    expect(text).toMatch(/\n- \d+ — `return new Invoice\(4\)` \(in `chained`\)/); // a chain: keyed where its expression starts
    // what a grep for the name would add, accounted for: `o.totalPrice()` on an Order
    expect(text).toMatch(/Other calls named `totalPrice`, which neither the compiler nor codegraph resolved to this one: \d+ to `Order::totalPrice` \(compiler-verified\)/);
  });

  it('replaces a wrong heuristic target with the compiler-resolved one', async () => {
    inject('sum', 'Order::totalPrice', 6);
    importFixture();
    const report = (await pass())!;
    expect(report.outcome.conflict).toBeGreaterThanOrEqual(1);
    expect(edge('sum', 'Order::totalPrice')).toBeUndefined();
    expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip');
  });

  it('removes a heuristic edge where SCIP resolved the call outside the project', async () => {
    inject('sum', 'Stack::push', 5); // `list.push(1)` is Array#push
    importFixture();
    await pass();
    expect(edge('sum', 'Stack::push')).toBeUndefined();
  });

  it('never touches synthesized dynamic-dispatch edges', async () => {
    inject('sum', 'Stack::push', 5, 'heuristic');
    importFixture();
    await pass();
    expect(edge('sum', 'Stack::push')?.provenance).toBe('heuristic');
  });

  it('keeps a heuristic edge SCIP could not judge, flagged unverified', async () => {
    importFixture();
    await pass();
    const e = edge('dyn', 'Solo::soloMethod'); // `o: any` — no type to resolve through
    expect(e?.provenance).toBeNull();
    expect(flags(e).scipSilent).toBe(true);
    expect(scipVerdict({ provenance: undefined, metadata: flags(e) } as unknown as Edge)).toBe('unverified');
    // status counts it through the partial index, not a scan of every edge
    const db = cg.scipReadDb();
    const silent = (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE metadata LIKE '%scipSilent%'`).get() as { n: number }).n;
    expect(scipStatus(db, dir).edges.silent).toBe(silent);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM edges WHERE ${SILENT_EDGE}`).all() as { detail: string }[];
    expect(plan.map(r => r.detail).join()).toContain('scip_silent_edges');
  });

  it('is idempotent', async () => {
    importFixture();
    await pass();
    const first = edges();
    const again = (await pass())!;
    expect(edges()).toEqual(first);
    expect(again.outcome).toMatchObject({ edgesInserted: 0, edgesDeleted: 0, edgesUpdated: 0, scipEdgesDropped: 0 });
  });

  it('hash gate: a file edited after the index was built is left to the heuristic', async () => {
    importFixture();
    fs.appendFileSync(path.join(dir, 'src/main.ts'), '\nexport const later = () => helper(3);\n');
    await cg.sync();
    const report = (await pass())!;
    expect(report.staleDocuments).toEqual(['src/main.ts']);
    const dyn = edge('dyn', 'Solo::soloMethod');
    expect(dyn?.provenance).toBeNull(); // re-extracted by sync, not re-judged
    expect(flags(dyn).scipSilent).toBeUndefined();
    expect(edge('sum', 'Invoice::totalPrice')).toBeUndefined(); // the SCIP-only add is gone with the rewrite
  });

  it('sync demotes SCIP edges into a rewritten file, and re-verifies once it matches the index again', async () => {
    const models = path.join(dir, 'src/models.ts');
    const original = fs.readFileSync(models, 'utf8');
    importFixture();
    await pass();

    fs.writeFileSync(models, `// shifted\n${original}`);
    await cg.sync();
    expect(flags(edge('sum', 'helper')).scipStale).toBe(true); // re-attached onto the moved node
    expect(flags(edge('make', 'Invoice')).scipStale).toBe(true);
    expect(flags(edge('Service::run', 'Service::step')).scipStale).toBeUndefined(); // untouched file
    expect(scipStatus(cg.scipReadDb(), dir).edges.stale).toBeGreaterThan(0);

    fs.writeFileSync(models, original);
    await cg.sync(); // content matches the installed index again → full pass
    expect(flags(edge('sum', 'helper')).scipStale).toBeUndefined();
    expect(edge('sum', 'helper')?.provenance).toBe('scip');
    expect(scipStatus(cg.scipReadDb(), dir).edges.stale).toBe(0);
  });

  it('a full re-index re-merges the installed index', async () => {
    importFixture();
    await cg.indexAll();
    expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip');
  });

  it('regression guard keeps the old index when resolution collapses; the swap is atomic', async () => {
    fakeIndexer('index.scip');
    const ok = await produceIndex(cg.scipReadDb(), dir, 'typescript');
    expect(ok.status).toBe('installed');
    const installed = fs.readFileSync(indexPath(dir, 'typescript'));

    fakeIndexer('index-broken.scip'); // main.ts failed to compile away
    const bad = await produceIndex(cg.scipReadDb(), dir, 'typescript');
    expect(bad.status).toBe('rejected');
    expect(fs.readFileSync(indexPath(dir, 'typescript')).equals(installed)).toBe(true);
    expect(fs.readdirSync(scipDir(dir)).filter(f => /\.(tmp|raw)$/.test(f))).toEqual([]);

    const forced = await produceIndex(cg.scipReadDb(), dir, 'typescript', { force: true });
    expect(forced.status).toBe('installed');
  });

  it('scip import vouches only for sources not modified after the index was written', async () => {
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src/models.ts'), later, later);
    const r = importFixture();
    expect(r.newerThanIndex).toEqual(['src/models.ts']);
    const report = (await pass())!;
    expect(report.staleDocuments).toEqual(['src/models.ts']);
    expect(edge('sum', 'helper')?.provenance).toBeNull(); // target file unvouched → call left unjudged
  });

  it('scip import rebases an index rooted at a subfolder onto the project', async () => {
    const ix = loadScipIndex(path.join(FIXTURE, 'index.scip'));
    const sub = path.join(dir, 'built-sub.scip');
    fs.writeFileSync(sub, Buffer.concat([
      encodeMetadata({ toolName: ix.toolName, toolVersion: ix.toolVersion, projectRoot: pathToFileURL(path.join(dir, 'src')).href }),
      ...ix.documents.map(d => encodeDocument({ ...d, relativePath: path.posix.relative('src', d.relativePath) }, s => Buffer.from(s))),
    ]));
    const { documents } = importScipFile(dir, sub);
    expect(documents).toBe(ix.documents.length);
    expect(loadScipIndex(indexPath(dir, 'typescript')).documents.map(d => d.relativePath).sort())
      .toEqual(ix.documents.map(d => d.relativePath).sort());
    await pass();
    expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip');
  });

  it('the regression guard counts resolved calls, not every reference', () => {
    const r = importFixture();
    expect(r.documents).toBe(2);
    // main.ts: helper(2), inv.totalPrice(), o.totalPrice(), new Invoice(3), this.step(), sum(), make(), helper(1),
    // r.lookup('a'), r.lookup(1), new Invoice(4), .totalPrice(). Imports, `Invoice[]` annotations and
    // `this.amount` don't count; `o.soloMethod()` on `any` is unresolved.
    expect(JSON.parse(fs.readFileSync(path.join(scipDir(dir), 'typescript.meta.json'), 'utf8')).resolvedCalls).toBe(12);
  });

  it('maps an overloaded method to its first signature, like the heuristic', async () => {
    importFixture();
    await pass();
    const lookups = cg.scipReadDb().prepare(`
      SELECT t.start_line AS line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE s.name = 'usesOverloads' AND t.name = 'lookup' ORDER BY e.line`).all();
    expect(lookups).toEqual([{ line: 31, provenance: 'scip' }, { line: 31, provenance: 'scip' }]); // verified, not moved
  });

  it('leaves a symbol shared by distinct functions unjudged (rust-analyzer names nested `fn imp`s alike)', async () => {
    // One symbol defined at both Invoice.totalPrice and Order.totalPrice, called from sum() and arrow().
    const symbol = 'scip-typescript npm fixture 1.0.0 src/models/totalPrice().';
    const occ = (line: number, col: number, roles = 0) => ({ range: { startLine: line, startCol: col, endLine: line, endCol: col + 10 }, symbol, roles });
    const doc = (relativePath: string, occurrences: ReturnType<typeof occ>[]) =>
      encodeDocument({ relativePath, language: 'typescript', positionEncoding: 0, occurrences }, s => Buffer.from(s));
    const file = path.join(dir, 'shared.scip');
    fs.writeFileSync(file, Buffer.concat([
      encodeMetadata({ toolName: 'scip-typescript', toolVersion: '0', projectRoot: `file://${dir}` }),
      doc('src/models.ts', [occ(2, 2, ROLE_DEFINITION), occ(8, 2, ROLE_DEFINITION)]),
      doc('src/main.ts', [occ(5, 49), occ(8, 37)]),
    ]));
    importScipFile(dir, file);
    const report = (await pass())!;
    expect(report.stats.def_ambiguous).toBe(1);
    expect(edge('sum', 'Invoice::totalPrice')).toBeUndefined(); // not added on a guess
    expect(edge('arrow', 'Order::totalPrice')?.provenance).toBeNull(); // not "corrected" to Invoice's
  });

  it('installs a compact index: definitions and call-shaped references only, same outcome', async () => {
    const raw = fs.statSync(path.join(FIXTURE, 'index.scip')).size;
    importFixture();
    const installed = loadScipIndex(indexPath(dir, 'typescript'));
    expect(fs.statSync(indexPath(dir, 'typescript')).size).toBeLessThan(raw);
    const symbols = installed.documents.flatMap(d => d.occurrences.map(o => o.symbol));
    expect(symbols.some(s => s.startsWith('local '))).toBe(false); // locals dropped
    expect(symbols.some(s => s.endsWith('(invoices)'))).toBe(false); // parameters dropped
    expect(symbols.some(s => s.endsWith('Invoice#totalPrice().'))).toBe(true); // callables kept
    await pass();
    expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip');
  });

  it('status reads without creating tables', () => {
    const tables = () => cg.scipReadDb().prepare("SELECT name FROM sqlite_master WHERE name = 'scip_documents'").all();
    expect(tables()).toEqual([]);
    expect(scipStatus(cg.scipReadDb(), dir).indexes).toEqual([]);
    expect(tables()).toEqual([]);
  });

  it('a malformed codegraph.json or override is reported, never silently ignored', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), '{ "scip": ');
    expect(await produceIndex(cg.scipReadDb(), dir, 'typescript')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not valid JSON/) });
    writeConfig({ typescript: { cmd: process.execPath, env: { N: 1 } } });
    expect(await produceIndex(cg.scipReadDb(), dir, 'typescript')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/env/) });
    writeConfig({ typescript: { cmd: 42 } });
    expect(await produceIndex(cg.scipReadDb(), dir, 'typescript')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/cmd/) });
  });

  it('indexes a multi-project repo one project per process; a failed project is a warning, not a failure', async () => {
    for (const p of ['packages/a', 'packages/bad']) {
      fs.mkdirSync(path.join(dir, p), { recursive: true });
      fs.writeFileSync(path.join(dir, p, 'tsconfig.json'), '{}');
    }
    // Each run gets its own `{out}`; `{args}` carries the project dir, so the fake fails for one of them.
    writeConfig({
      typescript: {
        cmd: process.execPath,
        args: ['-e', 'const fs=require("fs");fs.appendFileSync(process.argv[3],"x");if(process.argv.includes("packages/bad"))process.exit(3);fs.copyFileSync(process.argv[1],process.argv[2])',
          path.join(FIXTURE, 'index.scip'), '{out}', path.join(dir, 'runs.log'), '{args}'],
      },
    });
    const r = await produceIndex(cg.scipReadDb(), dir, 'typescript');
    expect(runs()).toBe(4); // the light batch ('.', packages/a, packages/bad) fails, then each project alone
    expect(r).toMatchObject({ status: 'installed', documents: 2 }); // two copies of the same index, deduplicated
    expect(r.status === 'installed' && r.warnings).toEqual([expect.stringMatching(/^packages\/bad: .*exited 3/)]);
    expect(fs.readdirSync(scipDir(dir)).filter(f => /\.tmp|\.raw|\.part\d/.test(f))).toEqual([]);
    await cg.scipWrite(db => runScipPass(db, dir));
    expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip');
  });

  it('a split run fails only when every project fails', async () => {
    fs.mkdirSync(path.join(dir, 'packages/a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/a/tsconfig.json'), '{}');
    writeConfig({ typescript: { cmd: process.execPath, args: ['-e', 'process.exit(2)'] } });
    expect(await produceIndex(cg.scipReadDb(), dir, 'typescript')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/all 2 runs failed/) }); // both retried projects
  });

  it('skips (never installs) an indexer that is not on PATH', async () => {
    writeConfig({ typescript: { cmd: 'definitely-not-a-scip-indexer' } });
    const r = await produceIndex(cg.scipReadDb(), dir, 'typescript');
    expect(r).toMatchObject({ status: 'skipped' });
    writeConfig({ typescript: false });
    expect(await produceIndex(cg.scipReadDb(), dir, 'typescript')).toMatchObject({ status: 'skipped' });
  });

  it('background reindex waits for quiet, coalesces bursts, and respects the minimum interval', async () => {
    fakeIndexer('index.scip');
    await produceIndex(cg.scipReadDb(), dir, 'typescript');
    const before = runs();
    fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export const e = 1;\n'); // something to reindex
    await cg.sync();
    const s = new ScipReindexScheduler(cg, { idleMs: 30, minIntervalMs: 60_000, log: () => {} });
    try {
      s.notifyChange();
      s.notifyChange();
      await new Promise(r => setTimeout(r, 80));
      await s.idle();
      expect(runs() - before).toBe(1);
      expect(edge('sum', 'Invoice::totalPrice')?.provenance).toBe('scip'); // merged after reindex

      s.notifyChange(); // inside the minimum interval
      await new Promise(r => setTimeout(r, 80));
      await s.idle();
      expect(runs() - before).toBe(1);
    } finally {
      s.stop();
    }
  });

  it('one reindex per project at a time: a second scheduler skips while the first runs', async () => {
    fakeIndexer('index.scip');
    await produceIndex(cg.scipReadDb(), dir, 'typescript');
    fakeIndexer('index.scip', 300);
    fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export const e = 1;\n'); // something to reindex
    await cg.sync();
    const before = runs();
    const logs: string[] = [];
    const a = new ScipReindexScheduler(cg, { idleMs: 30, minIntervalMs: 60_000, log: () => {} });
    const b = new ScipReindexScheduler(cg, { idleMs: 30, minIntervalMs: 60_000, log: m => logs.push(m) });
    try {
      a.notifyChange();
      await new Promise(r => setTimeout(r, 80)); // a is inside its indexer run
      b.notifyChange();
      await new Promise(r => setTimeout(r, 80));
      await Promise.all([a.idle(), b.idle()]);
      expect(runs() - before).toBe(1);
      expect(logs.some(m => m.includes('reindex skipped'))).toBe(true);
      expect(tryReindexLock(dir)?.release()).toBeUndefined(); // released afterwards
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('the reindex lock is exclusive and a dead holder\'s lock is taken over', () => {
    const held = tryReindexLock(dir)!;
    expect(held).not.toBeNull();
    expect(tryReindexLock(dir)).toBeNull();
    held.release();
    fs.writeFileSync(path.join(scipDir(dir), 'reindex.lock'), '2147483646'); // no such pid
    const taken = tryReindexLock(dir);
    expect(taken).not.toBeNull();
    taken!.release();
  });
});
