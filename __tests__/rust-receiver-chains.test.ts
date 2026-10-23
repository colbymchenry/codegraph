/**
 * A Rust method call keeps the receiver chain it is written on (#2836): a
 * chain of fields and method calls on `self` or on a name —
 * `self.services.store.put(…)`, `self.store().put(…)`, `vis.map.get(…)` — is
 * recorded with that chain, calls written `name()`, as the one-field
 * `self.store.put(…)` always was. The extractor used to keep the bare method
 * name, so the edge's `refName` said nothing of which value the call goes
 * through, and the receiver of a call on a method call's value was never read.
 *
 * Resolution reads the receiver's type through the whole chain, where the
 * call is written: `self.services` is a `Services`, its `store` a
 * `Box<dyn Store>`, so the call is `Store::put`; `self.store()` is what
 * `Svc::store` returns. A later link calling the same name again is a call of
 * its own (`self.table.get("a").get(0)` is `Table::get`, then `Row::get`).
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

const roots: string[] = [];
const graphs: Record<'issue' | 'chains', CodeGraph> = {} as never;

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function index(name: keyof typeof graphs, files: Record<string, string>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-rust-chain-${name}-`));
  roots.push(root);
  write(root, files);
  graphs[name] = await CodeGraph.init(root, { index: true });
}

const crate = (name: string, deps = ''): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${deps}`;

beforeAll(async () => {
  // The issue's workspace, with the call on a method call's value it names.
  await index('issue', {
    'Cargo.toml': '[workspace]\nmembers = ["api", "app"]\nresolver = "2"\n',
    'api/Cargo.toml': crate('api'),
    'api/src/lib.rs': 'pub trait Store {\n    fn put(&self, key: &str);\n}\n',
    'app/Cargo.toml': crate('app', 'api = { path = "../api" }\n'),
    'app/src/lib.rs': [
      'use api::Store;',
      '',
      'pub struct Services { pub store: Box<dyn Store> }',
      'pub struct Svc { pub services: Services, pub store: Box<dyn Store> }',
      '',
      'impl Svc {',
      '    pub fn a(&self) { self.services.store.put("a"); }',
      '    pub fn b(&self) { let _ = self.services.store.put("b"); }',
      '    pub fn c(&self) {',
      '        self',
      '            .services',
      '            .store',
      '            .put("c");',
      '    }',
      '    pub fn d(&self) { self.store.put("d"); }',
      '    pub fn e(&self) {',
      '        self',
      '            .store',
      '            .put("e");',
      '    }',
      '    pub fn m(&self) { self.store().put("m"); }',
      '    pub fn store(&self) -> &dyn Store { &*self.store }',
      '}',
      '',
    ].join('\n'),
  });

  // Chains whose links call the same name, through `self`, a parameter and a
  // tuple field, and a call on a method call's std value — beside a project
  // namesake a guess by the name would take.
  await index('chains', {
    'Cargo.toml': crate('chains'),
    'src/lib.rs': [
      'pub struct Row { cells: Vec<u8> }',
      '',
      'impl Row {',
      '    pub fn get(&self, i: usize) -> u8 { self.cells[i] }',
      '}',
      '',
      'pub struct Table { rows: Vec<Row>, names: Vec<String> }',
      '',
      'impl Table {',
      '    pub fn get(&self, _k: &str) -> &Row { &self.rows[0] }',
      '    pub fn names(&self) -> &Vec<String> { &self.names }',
      '}',
      '',
      'pub struct Db { pub table: Table }',
      'pub struct Wrap(pub Table);',
      '',
      '/// A project namesake of std\'s `len`.',
      'pub struct Counter;',
      '',
      'impl Counter {',
      '    pub fn len(&self) -> usize { 0 }',
      '}',
      '',
      'impl Db {',
      '    pub fn cell(&self) -> u8 { self.table.get("a").get(0) }',
      '    pub fn count(&self) -> usize { self.table.names().len() }',
      '}',
      '',
      'impl Wrap {',
      '    pub fn first(&self) -> u8 { self.0.get("c").get(2) }',
      '}',
      '',
      'pub fn local(db: &Db) -> u8 {',
      '    db.table',
      '        .get("b")',
      '        .get(1)',
      '}',
      '',
    ].join('\n'),
  });
}, 120_000);

afterAll(() => {
  for (const cg of Object.values(graphs)) cg?.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** The calls on `line` of `file`, as `qualifiedName resolvedBy refName`, sorted. */
const callsAt = (name: keyof typeof graphs, file: string, line: number): string[] => {
  const cg = graphs[name];
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls' || edge.line !== line || edge.provenance === 'heuristic') continue;
      out.push(`${cg.getNode(edge.target)!.qualifiedName} ${String(edge.metadata?.resolvedBy)} ${String(edge.metadata?.refName)}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('the issue\'s workspace (#2836)', () => {
  it('a call on two fields keeps its receiver: on one line, after `let _ =`, split by rustfmt', () => {
    expect(callsAt('issue', 'app/src/lib.rs', 7)).toEqual(['Store::put instance-method self.services.store.put']);
    expect(callsAt('issue', 'app/src/lib.rs', 8)).toEqual(['Store::put instance-method self.services.store.put']);
    expect(callsAt('issue', 'app/src/lib.rs', 10)).toEqual(['Store::put instance-method self.services.store.put']);
  });

  it('a call on a method call\'s value keeps the path up to that call, and reaches what it returns', () => {
    expect(callsAt('issue', 'app/src/lib.rs', 21)).toEqual([
      'Store::put instance-method self.store().put',
      'Svc::store qualified-name self.store',
    ]);
  });

  it('a call on one field keeps what it had', () => {
    expect(callsAt('issue', 'app/src/lib.rs', 15)).toEqual(['Store::put instance-method self.store.put']);
    expect(callsAt('issue', 'app/src/lib.rs', 17)).toEqual(['Store::put instance-method self.store.put']);
  });

  it('leaves no call unresolved', () => {
    expect(graphs.issue.getUnresolvedReferencesInFile('app/src/lib.rs').filter((r) => r.referenceKind === 'calls')).toEqual([]);
  });
});

describe('a Rust call on a receiver chain', () => {
  it('is told from a later link calling the same name: through `self`, a tuple field and a parameter', () => {
    expect(callsAt('chains', 'src/lib.rs', 25)).toEqual([
      'Row::get instance-method self.table.get().get',
      'Table::get instance-method self.table.get',
    ]);
    expect(callsAt('chains', 'src/lib.rs', 30)).toEqual([
      'Row::get instance-method self.0.get().get',
      'Table::get instance-method self.0.get',
    ]);
    expect(callsAt('chains', 'src/lib.rs', 34)).toEqual([
      'Row::get instance-method db.table.get().get',
      'Table::get instance-method db.table.get',
    ]);
  });

  it('on a method call\'s std value is no project method', () => {
    expect(callsAt('chains', 'src/lib.rs', 26)).toEqual(['Table::names instance-method self.table.names']);
  });
});

describe('Rust call references keep their receiver chain', () => {
  const ENV_KEYS = ['CODEGRAPH_KERNEL'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['rust']);
  });
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.CODEGRAPH_KERNEL = '0';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** The names of the `calls` references extraction records for `body`, a method body's statements, sorted. */
  const callNames = (body: string): string[] => {
    const source = `impl Svc {\n    fn shapes(&self, x: &X) {\n${body}\n    }\n}\n`;
    return extractFromSource('shapes.rs', source, 'rust').unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName)
      .sort();
  };

  it('of fields and method calls on `self` or a name, calls written `name()`', () => {
    expect(callNames('self.services.store.put("a");')).toEqual(['self.services.store.put']);
    expect(callNames('self.store().put("m");')).toEqual(['self.store', 'self.store().put']);
    expect(callNames('self.0.len();')).toEqual(['self.0.len']);
    expect(callNames('x.map.get("k");')).toEqual(['x.map.get']);
    expect(callNames('x.get::<u8>(1).put(2);')).toEqual(['x.get', 'x.get().put']);
    expect(callNames('self\n            .services // the services\n            .store\n            .put("c");')).toEqual(['self.services.store.put']);
  });

  it('and keep the shapes they had', () => {
    expect(callNames('self.store.put("d");')).toEqual(['self.store.put']);
    expect(callNames('x.put(1);')).toEqual(['x.put']);
    expect(callNames('self.put(1);')).toEqual(['self.put']);
    expect(callNames('Foo::new().a().b();')).toEqual(['Foo::new', 'Foo::new().a', 'b']);
  });

  it('but not through parentheses, `?` or `.await`, nor past sixteen links', () => {
    expect(callNames('(x).a.b();')).toEqual(['b']);
    expect(callNames('self.a?.b();')).toEqual(['b']);
    expect(callNames('self.a.b().await.c();')).toEqual(['c', 'self.a.b']);
    const links = Array.from({ length: 17 }, (_, i) => `l${i}()`);
    const names = callNames(`x.${links.join('.')}.m();`);
    expect(names).toHaveLength(18);
    expect(names).toContain('x.l0');
    expect(names).toContain(`x.${links.slice(0, 16).join('.')}.l16`);
    expect(names).toContain('m');
  });
});

describe('a Rust call on a receiver chain that names no method yet', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-chain-sync-')); });
  afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

  it('waits under its method\'s name, and resolves once a sync adds the method', async () => {
    write(root, {
      'Cargo.toml': crate('later'),
      'src/lib.rs': [
        'pub mod disk;',
        '',
        'pub struct Services { pub disk: disk::Disk }',
        'pub struct Svc { pub services: Services }',
        '',
        'impl Svc {',
        '    pub fn save(&self) { self.services.disk.flush(); }',
        '}',
        '',
      ].join('\n'),
      'src/disk.rs': 'pub struct Disk;\n',
    });
    cg = await CodeGraph.init(root, { index: true });
    const parked = cg.getUnresolvedReferencesInFile('src/lib.rs').filter((r) => r.referenceKind === 'calls');
    expect(parked.map((r) => r.referenceName)).toEqual(['self.services.disk.flush']);

    fs.writeFileSync(path.join(root, 'src/disk.rs'), 'pub struct Disk;\n\nimpl Disk {\n    pub fn flush(&self) {}\n}\n');
    await cg.sync();
    const save = cg.getNodesInFile('src/lib.rs').find((n) => n.name === 'save')!;
    const calls = cg.getOutgoingEdges(save.id).filter((e) => e.kind === 'calls');
    expect(calls.map((e) => `${cg!.getNode(e.target)!.qualifiedName} ${String(e.metadata?.refName)}`)).toEqual([
      'Disk::flush self.services.disk.flush',
    ]);
  });
});
