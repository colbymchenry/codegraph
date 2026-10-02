import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { importScipFile, runScipPass } from '../../src/scip';
import { onPath } from '../../src/scip/indexers';
import { produceIndex } from '../../src/scip/produce';
import { ROLE_DEFINITION, encodeDocument, encodeMetadata, loadScipIndex } from '../../src/scip/reader';
import type { ScipLanguage } from '../../src/scip/store';
import { EdgeRow, FIXTURES, FixtureProject, edgesBetween, importFixtureIndex, indexedFixture, merge, nodeId } from './helpers';

type Check = (p: FixtureProject) => Promise<void>;

interface Language {
  lang: ScipLanguage;
  fixture: string;
  /** a chain whose callee sits below the line its expression starts on (the invariants) */
  chain: { file: string; caller: string; callee: string; starts: string };
  /** what this language's merge must do, beyond the invariants */
  checks: Record<string, Check>;
}

/** The one edge `src` → `tgt` of `kind`, or undefined; two would mean a call keyed twice. */
const only = (p: FixtureProject, src: string, tgt: string, kind = 'calls'): EdgeRow | undefined => {
  const rows = edgesBetween(p.cg.scipReadDb(), src, tgt, [kind]);
  if (rows.length > 1) throw new Error(`${rows.length} ${kind} edges ${src} → ${tgt}: ${JSON.stringify(rows)}`);
  return rows[0];
};
const callOrNew = (p: FixtureProject, src: string, tgt: string): EdgeRow | undefined =>
  edgesBetween(p.cg.scipReadDb(), src, tgt, ['calls', 'instantiates'])[0];

const LANGUAGES: Language[] = [
  {
    lang: 'typescript', fixture: 'scip-ts',
    chain: { file: 'src/main.ts', caller: 'chained', callee: 'totalPrice', starts: 'return new Invoice(4)' },
    checks: {}, // merge.test.ts: the merge rules, on this fixture
  },
  {
    lang: 'go', fixture: 'scip-go',
    chain: { file: 'shop/main.go', caller: 'Chained', callee: 'TotalPrice', starts: 'return NewInvoice(4).' },
    checks: {
      'verifies, corrects and completes the heuristic call graph': async (p) => {
        await merge(p);
        expect(only(p, 'NewInvoice', 'Invoice', 'instantiates')?.provenance).toBe('scip'); // &Invoice{…}
        expect(only(p, 'Promoted', 'Child', 'instantiates')?.provenance).toBe('scip'); // Child{}
        expect(only(p, 'Promoted', 'Base::Step')?.provenance).toBe('scip'); // promoted through embedding
        expect(only(p, 'Dyn', 'Pricer::TotalPrice')?.provenance).toBe('scip'); // interface method (a SCIP `term`)
        expect(only(p, 'Total', 'Invoice::TotalPrice')?.provenance).toBe('scip'); // missed by the heuristic
        expect(only(p, 'Pricer::TotalPrice', 'Invoice::TotalPrice')?.provenance).toBe('heuristic'); // synthesized, untouched
        expect(only(p, 'Generic', 'Invoice', 'instantiates')).toBeUndefined(); // []*Invoice{…} builds a slice
        // Structural `implements`: codegraph synthesizes it, SCIP states it too — one edge, not two.
        expect(only(p, 'Invoice', 'Pricer', 'implements')?.provenance).toBe('heuristic');
        expect(only(p, 'Order', 'Pricer', 'implements')?.provenance).toBe('heuristic');
      },
      'a reference to an undefined method/term twin reads as the defined one': async (p) => {
        // scip-go names an interface method two ways: a run that only imports the interface's package
        // names it `Pricer#TotalPrice().`, not `Pricer#TotalPrice.`.
        const ix = loadScipIndex(path.join(FIXTURES, 'scip-go', 'index.scip'));
        const twin = (s: string) => (s.endsWith('Pricer#TotalPrice.') ? `${s.slice(0, -1)}().` : s);
        let renamed = 0;
        const docs = ix.documents.map(d => ({
          ...d, occurrences: d.occurrences.map(o => (o.roles & ROLE_DEFINITION || twin(o.symbol) === o.symbol ? o : (renamed++, { ...o, symbol: twin(o.symbol) }))),
        }));
        expect(renamed).toBeGreaterThan(0);
        const built = path.join(p.dir, 'built-twin.scip');
        fs.writeFileSync(built, Buffer.concat([encodeMetadata(ix), ...docs.map(d => encodeDocument(d, s => Buffer.from(s)))]));
        importScipFile(p.dir, built, 'go');
        await merge(p);
        expect(only(p, 'Dyn', 'Pricer::TotalPrice')?.provenance).toBe('scip');
      },
    },
  },
  {
    lang: 'rust', fixture: 'scip-rust',
    chain: { file: 'src/lib.rs', caller: 'chained', callee: 'total_price', starts: 'Invoice::new(5)' },
    checks: {
      'verifies, corrects and completes the heuristic call graph': async (p) => {
        await merge(p);
        expect(only(p, 'total', 'Invoice::new')).toBeUndefined(); // Vec::new()
        expect(only(p, 'total', 'Stack::push')).toBeUndefined(); // items.push(1) is Vec::push
        expect(only(p, 'literal', 'Invoice', 'instantiates')?.provenance).toBe('scip'); // Invoice { amount: 4 }
        expect(only(p, 'dyn_call', 'Pricer::total_price')?.provenance).toBe('scip'); // &dyn Pricer
        expect(only(p, 'total', 'Invoice::total_price')?.provenance).toBe('scip'); // inside a closure
        expect(only(p, 'make', 'Invoice', 'instantiates')).toBeUndefined(); // `-> Invoice {` is a return type
        expect(only(p, 'Service::run', 'Service', 'instantiates')).toBeUndefined(); // `impl Service {`
        expect(only(p, 'shapes', 'Shape::Circle')?.provenance).toBe('scip'); // a variant built like a call is a call
        expect(only(p, 'shapes', 'Shape::Square', 'instantiates')?.provenance).toBe('scip'); // a struct-like variant literal
        expect(only(p, 'wrapped', 'Maybe::Some')).toBeUndefined(); // std's Some, not the project's
        expect(only(p, 'chained', 'Invoice::total_price')).toMatchObject({ line: 56, provenance: 'scip' }); // keyed where the chain starts, once
        // rust-analyzer emits no relationships: `impl Pricer for Invoice {` itself is the edge, at the header's line.
        expect(only(p, 'Invoice', 'Pricer', 'implements')).toMatchObject({ line: 15, provenance: 'scip' });
        expect(only(p, 'Order', 'Pricer', 'implements')).toMatchObject({ line: 23, provenance: 'scip' });
      },
    },
  },
  {
    lang: 'python', fixture: 'scip-py',
    chain: { file: 'shop/main.py', caller: 'chained', callee: 'total_price', starts: 'return (Invoice(4)' },
    checks: {
      'verifies `Foo()` as instantiates and adds calls the heuristic missed': async (p) => {
        expect(callOrNew(p, 'total', 'Invoice::total_price')).toBeUndefined(); // call inside a generator expression
        await merge(p);
        expect(callOrNew(p, 'make', 'Invoice')).toEqual({ kind: 'instantiates', line: 11, provenance: 'scip' });
        expect(callOrNew(p, 'total', 'Invoice::total_price')?.provenance).toBe('scip');
        expect(callOrNew(p, 'Service::run', 'Child::step')?.provenance).toBe('scip'); // Child().step()
        expect(callOrNew(p, 'Child::step', 'Base::step')?.provenance).toBe('scip'); // super().step()
        expect(edgesBetween(p.cg.scipReadDb(), 'Child', 'Base', ['extends']).map(e => e.provenance))
          .toEqual(['scip']); // class Child(Base): verified from SCIP relationships
        expect(callOrNew(p, 'Service::run', 'Service::step')?.provenance).toBe('scip'); // self.step(), same line, same name
      },
      'keys calls by the caller codegraph names: decorators → class, nested class body → that class': async (p) => {
        await merge(p);
        // SCIP's range for `build` includes its decorator; codegraph's node starts at `def`.
        expect(callOrNew(p, 'Registry', 'register')).toEqual({ kind: 'calls', line: 34, provenance: 'scip' });
        expect(callOrNew(p, 'Registry::build', 'register')).toBeUndefined();
        expect(callOrNew(p, 'Registry::nested::Local', 'helper')?.provenance).toBe('scip');
        expect(callOrNew(p, 'Registry::nested', 'helper')).toBeUndefined();
      },
      'drops a heuristic guess where the call resolved to the standard library': async (p) => {
        // `items.append(1)` is list.append — the POC's classic false edge (ListMixin.append on Django).
        const db = p.cg.scipReadDb();
        db.prepare(`INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, 'calls', 6, 4)`).run(nodeId(db, 'total'), nodeId(db, 'Stack::append'));
        await merge(p);
        expect(callOrNew(p, 'total', 'Stack::append')).toBeUndefined();
      },
    },
  },
];

describe.each(LANGUAGES)('SCIP merge ($lang fixture)', ({ lang, fixture, chain, checks }) => {
  let p: FixtureProject;

  beforeEach(async () => {
    p = await indexedFixture(fixture);
    importFixtureIndex(p.dir, fixture, 'index.scip', lang);
  });

  afterEach(() => p.close());

  /*
   * What every merge must hold, whatever the language: the compiler's site and codegraph's site for
   * one call are the same site. When they are keyed apart, a call ends up as two edges — a SCIP edge
   * plus the heuristic one left unverified beside it (commit 1748258: 90 such pairs on codegraph's
   * own source, from multi-line chains).
   */
  it('never leaves a call as a SCIP edge beside an unverified heuristic edge', async () => {
    await merge(p);
    const pairs = p.cg.scipReadDb().prepare(`
      SELECT s.name AS source, t.name AS target, a.kind, a.line AS scipLine, b.line AS heuristicLine
      FROM edges a JOIN edges b ON b.source = a.source AND b.target = a.target AND b.kind = a.kind AND b.id <> a.id
      JOIN nodes s ON s.id = a.source JOIN nodes t ON t.id = a.target
      WHERE a.provenance = 'scip' AND (b.provenance IS NULL OR b.provenance = 'tree-sitter')`).all();
    expect(pairs).toEqual([]);
  });

  it('verifies a chained call at the line its expression starts on', async () => {
    await merge(p);
    const lines = fs.readFileSync(path.join(p.dir, chain.file), 'utf8').split(/\r?\n/);
    const line = lines.findIndex(l => l.includes(chain.starts)) + 1;
    expect(line).toBeGreaterThan(0);
    expect(lines[line]).toContain(chain.callee); // the callee really sits on a later line
    const rows = p.cg.scipReadDb().prepare(`
      SELECT e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' AND s.name = ? AND t.name = ? AND s.file_path = ?`).all(chain.caller, chain.callee, chain.file);
    expect(rows).toEqual([{ line, provenance: 'scip' }]);
  });

  for (const [name, check] of Object.entries(checks)) it(name, () => check(p));
});

describe.runIf(onPath('scip-go') && onPath('go'))('a go module below the repo root (scip-go)', () => {
  let p: FixtureProject;
  beforeEach(async () => { p = await indexedFixture('scip-go', 'backend'); });
  afterEach(() => p.close());

  it('is indexed in its folder and its paths land on the repo\'s files', async () => {
    const { dir, cg } = p;
    const r = await produceIndex(cg.scipReadDb(), dir, 'go');
    expect(r).toMatchObject({ status: 'installed' });
    const report = await merge(p);
    expect(report?.staleDocuments).toEqual([]);
    expect(report?.freshDocuments).toBeGreaterThan(0);
    const edge = (src: string, tgt: string) => edgesBetween(cg.scipReadDb(), src, tgt, ['calls'])[0]?.provenance;
    expect(edge('Total', 'Invoice::TotalPrice')).toBe('scip');

    // A patch: the edited package alone, in the module's folder (a slow full run makes it worth it).
    const meta = path.join(dir, '.codegraph', 'scip', 'go.meta.json');
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), fullRunMs: 60_000 }));
    const file = fs.readdirSync(path.join(dir, 'backend', 'shop')).find(f => f.endsWith('.go') && !f.endsWith('_test.go'))!;
    fs.appendFileSync(path.join(dir, 'backend', 'shop', file), '\nfunc probe() int {\n\treturn Total(nil)\n}\n');
    await cg.sync();
    const patched = await produceIndex(cg.scipReadDb(), dir, 'go', { incremental: true });
    expect(patched).toMatchObject({ status: 'installed', incremental: 1 });
    await cg.scipWrite(db => runScipPass(db, dir, patched.status === 'installed' ? patched.scope : undefined));
    expect(edge('probe', 'Total')).toBe('scip');
  }, 120_000);
});
