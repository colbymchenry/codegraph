import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import type { Edge } from '../../src/types';
import { importScipFile, runScipPass, scipStatus } from '../../src/scip';
import { scipVerdict } from '../../src/scip/notes';
import { produceIndex } from '../../src/scip/produce';
import { ROLE_DEFINITION, encodeDocument, encodeMetadata, loadScipIndex } from '../../src/scip/reader';
import { ScipReindexScheduler } from '../../src/scip/reindex';
import { indexPath, scipDir } from '../../src/scip/store';

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
  /** A fake indexer: copies a prebuilt index to `{out}` (and counts its runs). */
  const fakeIndexer = (index: string) => writeConfig({
    typescript: {
      cmd: process.execPath,
      args: ['-e', 'const fs=require("fs");fs.appendFileSync(process.argv[3],"x");fs.copyFileSync(process.argv[1],process.argv[2])',
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
    expect(fs.readdirSync(scipDir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([]);

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

  it('the regression guard counts resolved calls, not every reference', () => {
    const r = importFixture();
    expect(r.documents).toBe(2);
    // main.ts: helper(2), inv.totalPrice(), o.totalPrice(), new Invoice(3), this.step(), sum(), make(), helper(1),
    // r.lookup('a'), r.lookup(1). Imports, `Invoice[]` annotations and `this.amount` don't count;
    // `o.soloMethod()` on `any` is unresolved.
    expect(JSON.parse(fs.readFileSync(path.join(scipDir(dir), 'typescript.meta.json'), 'utf8')).resolvedCalls).toBe(10);
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
    expect(fs.readdirSync(scipDir(dir)).filter(f => /\.tmp|\.part\d/.test(f))).toEqual([]);
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
});
