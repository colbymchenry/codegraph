import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import { importScipFile, runScipPass } from '../../src/scip';
import { INDEXERS, resolveIndexer } from '../../src/scip/indexers';
import { planRuns, projectWeights, tsProjects } from '../../src/scip/indexers/typescript';
import { callShape } from '../../src/scip/syntax';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function fixtureSuite(name: string, lang: 'go' | 'rust', checks: (edge: EdgeLookup) => void) {
  describe(`SCIP merge (${lang} fixture)`, () => {
    let dir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-scip-${lang}-`));
      fs.cpSync(path.join(FIXTURES, name, 'project'), dir, { recursive: true });
      cg = await CodeGraph.init(dir);
      await cg.indexAll();
      const built = path.join(dir, 'built.scip'); // "built" after the sources were copied in
      fs.copyFileSync(path.join(FIXTURES, name, 'index.scip'), built);
      importScipFile(dir, built, lang);
      await cg.scipWrite(db => runScipPass(db, dir));
    });

    afterEach(() => {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('verifies, corrects and completes the heuristic call graph', () => {
      checks((src, tgt, kind) => cg.scipReadDb().prepare(`
        SELECT e.kind, e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = ? AND s.qualified_name = ? AND t.qualified_name = ?`).get(kind ?? 'calls', src, tgt) as EdgeRow | undefined);
    });
  });
}

interface EdgeRow { kind: string; line: number; provenance: string | null }
type EdgeLookup = (src: string, tgt: string, kind?: string) => EdgeRow | undefined;

fixtureSuite('scip-go', 'go', (edge) => {
  expect(edge('NewInvoice', 'Invoice', 'instantiates')?.provenance).toBe('scip'); // &Invoice{…}
  expect(edge('Promoted', 'Child', 'instantiates')?.provenance).toBe('scip'); // Child{}
  expect(edge('Promoted', 'Base::Step')?.provenance).toBe('scip'); // promoted through embedding
  expect(edge('Dyn', 'Pricer::TotalPrice')?.provenance).toBe('scip'); // interface method (a SCIP `term`)
  expect(edge('Total', 'Invoice::TotalPrice')?.provenance).toBe('scip'); // missed by the heuristic
  expect(edge('Pricer::TotalPrice', 'Invoice::TotalPrice')?.provenance).toBe('heuristic'); // synthesized, untouched
  expect(edge('Generic', 'Invoice', 'instantiates')).toBeUndefined(); // []*Invoice{…} builds a slice
});

fixtureSuite('scip-rust', 'rust', (edge) => {
  expect(edge('total', 'Invoice::new')).toBeUndefined(); // Vec::new()
  expect(edge('total', 'Stack::push')).toBeUndefined(); // items.push(1) is Vec::push
  expect(edge('literal', 'Invoice', 'instantiates')?.provenance).toBe('scip'); // Invoice { amount: 4 }
  expect(edge('dyn_call', 'Pricer::total_price')?.provenance).toBe('scip'); // &dyn Pricer
  expect(edge('total', 'Invoice::total_price')?.provenance).toBe('scip'); // inside a closure
  expect(edge('make', 'Invoice', 'instantiates')).toBeUndefined(); // `-> Invoice {` is a return type
  expect(edge('Service::run', 'Service', 'instantiates')).toBeUndefined(); // `impl Service {`
});

describe('literal call shapes', () => {
  const LANG: Record<string, keyof typeof INDEXERS> = { go: 'go', rs: 'rust', ts: 'typescript' };
  const shape = (file: string, line: string, name: string) => {
    const col = line.indexOf(name);
    const o = { range: { startLine: 0, startCol: col, endLine: 0, endCol: col + name.length }, symbol: '', roles: 0 };
    return callShape(o, 0, [line], INDEXERS[LANG[file.split('.').pop()!]!].literalShape);
  };

  it('Go: composite literals, not container element types or return types', () => {
    expect(shape('a.go', 'return &Invoice{Amount: 1}', 'Invoice')).toBe('literal');
    expect(shape('a.go', 'b := Box[int]{v: 1}', 'Box')).toBe('literal');
    expect(shape('a.go', 'xs := []*Invoice{a, b}', 'Invoice')).toBeNull();
    expect(shape('a.go', 'm := map[string]Invoice{}', 'Invoice')).toBeNull();
    expect(shape('a.go', 'func Make() *Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.go', 'func Make() *shop.Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.go', 'return shop.Invoice{Amount: 1}', 'Invoice')).toBe('literal');
  });

  it('Rust: struct literals, not impl headers, return types or patterns', () => {
    expect(shape('a.rs', '    Invoice { amount }', 'Invoice')).toBe('literal');
    expect(shape('a.rs', 'let v = Wrapper::<u8> { x: 1 };', 'Wrapper')).toBe('literal');
    expect(shape('a.rs', 'impl Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'impl Pricer for Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'pub fn make() -> Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'let Invoice { amount } = inv;', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    Invoice { amount: 0 } => 0,', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'pub fn make() -> models::Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    Some(Invoice { amount }) => amount,', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'for Invoice { amount } in all {', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    let v = models::Invoice { amount: 1 };', 'Invoice')).toBe('literal');
    expect(shape('a.ts', 'class A extends Invoice {', 'Invoice')).toBeNull(); // braces mean nothing in TS
  });
});

describe('go / rust adapters', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-adapters-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detect by go.mod / Cargo.toml and build the documented commands', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { go: { cmd: process.execPath }, rust: { cmd: process.execPath } } }));
    expect(resolveIndexer(dir, 'go', out)).toEqual({ skip: 'no go project markers found' });
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(resolveIndexer(dir, 'go', out)).toMatchObject({ runs: [{ args: ['index', '--quiet', '--output', out], output: out }] });
    expect(resolveIndexer(dir, 'rust', out)).toMatchObject({ runs: [{ args: ['scip', '.', '--output', out], output: out }] });
  });

  it('TS: one run per tsconfig/jsconfig project (node_modules ignored), a single project stays one run', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: process.execPath } } }));
    expect(resolveIndexer(dir, 'typescript', out)).toMatchObject({ runs: [{ label: 'typescript', output: out }] });

    for (const p of ['src', 'extensions/git', 'extensions/web', 'node_modules/dep']) fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/git/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/web/jsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'node_modules/dep/tsconfig.json'), '{}');
    expect(tsProjects(dir)).toEqual(['.', 'extensions/git', 'extensions/web', 'src']);
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    // All light: tsconfig projects share one batch (retried one by one if it fails); jsconfig ones infer theirs.
    expect(r.runs.map(x => x.args.slice(3))).toEqual([['.', 'extensions/git', 'src'], ['extensions/web', '--infer-tsconfig']]);
    expect(r.runs[0]!.fallback?.map(f => f.label)).toEqual(['.', 'extensions/git', 'src']);
    expect(r.runs.every(x => x.light && /--max-old-space-size=\d+/.test(x.env?.NODE_OPTIONS ?? ''))).toBe(true);
  });

  it('TS: heavy projects run alone with the big heap, light ones are batched by size', () => {
    const projects = ['core', 'a', 'b', 'c'];
    const weights = new Map([['core', 5000], ['a', 900], ['b', 900], ['c', 10]]);
    for (const p of projects) fs.mkdirSync(path.join(dir, p));
    for (const p of projects) fs.writeFileSync(path.join(dir, p, 'tsconfig.json'), '{}');
    const runs = planRuns(dir, projects, weights, path.join(dir, 'out'));
    expect(runs.map(r => [r.args.slice(3), !!r.light])).toEqual([
      [['core'], false], // heavy first, alone
      [['a'], true], // a + b would pass 1,500 files
      [['b', 'c'], true],
    ]);
    const heap = (r: typeof runs[number]) => Number(/--max-old-space-size=(\d+)/.exec(r.env?.NODE_OPTIONS ?? '')?.[1]);
    if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) expect(heap(runs[0]!)).toBeGreaterThanOrEqual(heap(runs[1]!));
    expect(projectWeights(['.', 'src', 'src/sub'], ['a.ts', 'src/x.ts', 'src/sub/y.ts', 'src/sub/z.js', 'README.md']))
      .toEqual(new Map([['.', 1], ['src', 1], ['src/sub', 2]])); // each file counted for its deepest project
  });

  it.runIf(process.platform !== 'win32')('skips a rust-analyzer that is on PATH but broken (the rustup shim without the component)', () => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'rust-analyzer'), "#!/bin/sh\necho \"error: Unknown binary 'rust-analyzer'\" >&2\nexit 1\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      expect(resolveIndexer(dir, 'rust', path.join(dir, 'out.tmp'))).toEqual({
        skip: expect.stringMatching(/rust-analyzer --version` failed \(error: Unknown binary/),
      });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
