import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type CodeGraph from '../../src/index';
import type { Edge } from '../../src/types';
import type { SqliteDatabase } from '../../src/db/sqlite-adapter';
import { importScipFile, scipStatus } from '../../src/scip';
import { scipVerdict } from '../../src/scip/notes';
import { ROLE_DEFINITION, encodeDocument, encodeMetadata, loadScipIndex } from '../../src/scip/reader';
import { SILENT_EDGE, STALE_EDGE, indexPath, needsMerge, scipDir } from '../../src/scip/store';
import { FIXTURES, FixtureProject, importFixtureIndex, indexedFixture, merge, nodeId as sharedNodeId } from './helpers';

/** The merge's rules (src/scip/merge.ts, index.ts), `scip import` and `scip status`, on the TypeScript fixture. */
const FIXTURE = path.join(FIXTURES, 'scip-ts');

interface EdgeRow { id: number; src: string; tgt: string; kind: string; line: number; provenance: string | null; metadata: string | null }

describe('SCIP merge (TypeScript fixture)', () => {
  let p: FixtureProject;
  let dir: string;
  let cg: CodeGraph;

  const edges = (): EdgeRow[] => cg.scipReadDb().prepare(`
    SELECT e.id, s.qualified_name AS src, t.qualified_name AS tgt, e.kind, e.line, e.provenance, e.metadata
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind IN ('calls', 'instantiates') ORDER BY e.line, t.qualified_name`).all() as EdgeRow[];
  const edge = (src: string, tgt: string) => edges().find(e => e.src === src && e.tgt === tgt);
  const flags = (e: EdgeRow | undefined) => (e?.metadata ? JSON.parse(e.metadata) : {}) as Record<string, unknown>;
  const nodeId = (qn: string) => sharedNodeId(cg.scipReadDb(), qn);
  const inject = (src: string, tgt: string, line: number, provenance: string | null = null) =>
    cg.scipReadDb().prepare(`INSERT INTO edges (source, target, kind, line, col, provenance) VALUES (?, ?, 'calls', ?, 2, ?)`)
      .run(nodeId(src), nodeId(tgt), line, provenance);
  const pass = () => merge(p);
  const importFixture = () => importFixtureIndex(dir, 'scip-ts');

  beforeEach(async () => {
    p = await indexedFixture('scip-ts');
    ({ dir, cg } = p);
  });

  afterEach(() => p.close());

  it('a merge in chunks (here a file each) ends where a whole merge does', async () => {
    const graph = (g: CodeGraph) => g.scipReadDb().prepare(`SELECT s.qualified_name || '>' || t.qualified_name || ':' || e.kind || ':' ||
      IFNULL(e.line, '') || ':' || IFNULL(e.provenance, '-') || ':' || IFNULL(e.metadata, '') AS e
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target ORDER BY 1`).all().map(r => (r as { e: string }).e);
    importFixture();
    await pass();
    const whole = graph(cg);
    expect(whole.some(e => e.includes(':scip:'))).toBe(true);

    const other = await indexedFixture('scip-ts');
    process.env.CODEGRAPH_SCIP_MERGE_CHUNK = '1';
    try {
      importFixtureIndex(other.dir, 'scip-ts');
      const report = await merge(other);
      expect(report!.judgedDocuments).toBeGreaterThan(1); // more than one chunk
      expect(graph(other.cg)).toEqual(whole);
    } finally {
      delete process.env.CODEGRAPH_SCIP_MERGE_CHUNK;
      other.close();
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
    const status = scipStatus(cg.scipReadDb(), dir);
    expect(status.edges.stale).toBeGreaterThan(0);
    // verified count must not include stale (same rule as scipVerdict / explore call-sites)
    const allScip = (cg.scipReadDb().prepare(`SELECT COUNT(*) AS n FROM edges WHERE provenance = 'scip'`).get() as { n: number }).n;
    expect(status.edges.scip + status.edges.stale).toBe(allScip);
    expect(status.edges.scip).toBe(allScip - status.edges.stale);

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

  it('a re-index whose merge fails leaves the index awaiting a merge, not stamped merged from before', async () => {
    importFixture();
    await merge(p);
    expect(needsMerge(dir)).toBe(false);
    fs.writeFileSync(indexPath(dir, 'typescript'), 'not a scip index'); // the merge after the index throws
    await cg.indexAll(); // a failed merge never fails the index
    expect(needsMerge(dir)).toBe(true); // the next round merges it
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

  it('status counts unverified edges through its partial index, not a scan of every edge', async () => {
    importFixture();
    await pass();
    const db = cg.scipReadDb();
    const silent = (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE metadata LIKE '%scipSilent%'`).get() as { n: number }).n;
    expect(silent).toBeGreaterThan(0);
    expect(scipStatus(db, dir).edges.silent).toBe(silent);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM edges WHERE ${SILENT_EDGE}`).all() as { detail: string }[];
    expect(plan.map(r => r.detail).join()).toContain('scip_silent_edges');
  });

  it('null-metadata scip edges count as verified (SQLite NULL LIKE must not drop them)', async () => {
    importFixture();
    await pass();
    const db = cg.scipReadDb();
    const existing = db.prepare(
      `SELECT id FROM edges WHERE provenance = 'scip' AND metadata IS NULL LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (!existing) {
      const e = db.prepare(
        `SELECT id FROM edges WHERE provenance = 'scip' AND NOT (${SILENT_EDGE}) AND NOT (${STALE_EDGE}) LIMIT 1`,
      ).get() as { id: number };
      db.prepare(`UPDATE edges SET metadata = NULL WHERE id = ?`).run(e.id);
    }
    const nullMeta = (db.prepare(
      `SELECT COUNT(*) AS n FROM edges WHERE provenance = 'scip' AND metadata IS NULL`,
    ).get() as { n: number }).n;
    expect(nullMeta).toBeGreaterThan(0);
    const allScip = (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE provenance = 'scip'`).get() as { n: number }).n;
    const status = scipStatus(db, dir).edges;
    expect(status.scip + status.stale).toBe(allScip);
  });

});
