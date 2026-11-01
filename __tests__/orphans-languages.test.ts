/**
 * `codegraph orphans` on Rust and Swift: the entry-point, nested-in-test and
 * requirement rules, run on a real CodeGraph index of a fixture git repo
 * through `runOrphans`. The last four describes cover same-named types outside
 * Swift: classes in separate files, classes under different outer classes or
 * TypeScript namespaces, and a new part of a C# partial class.
 *
 * One repo: commit C1 (tagged), then C2 adds every symbol below in new files,
 * so each is added by rule 1. Indexed once at C2 in beforeAll.
 *
 *   - Entry points: `fn main` in src/bin/x.rs; `@main struct App` with its
 *     `static func main()` (Sources/App/App.swift).
 *   - Nested in tests: `struct Inner` and its impl method `helper` declared
 *     inside a `#[test] fn t()` (src/nested.rs); `util_fn` inside a
 *     `#[cfg(test)] mod tests` (src/tmod.rs; Rust modules are not nodes, so
 *     only the source text marks it).
 *   - Requirements: trait `Tr`'s `req` (src/tr.rs), reached through
 *     `impl Tr for S`.
 *   - Same-name type group, guess rule per edge: `enum Gadget` in
 *     Sources/App/GadgetA.swift and another `enum Gadget` in
 *     Sources/App/GadgetB.swift, whose only use is a same-file exact-match
 *     `calls` edge from `makeGadget` (GadgetB.swift, `Gadget(rawValue:)`)
 *     onto GadgetB's node. GadgetA's enum counts that use through its group;
 *     the guess rule must judge the edge by its own target file (GadgetB.swift:
 *     same file, certain), not GadgetA's. An enum, not a struct or an
 *     extension: resolution turns a `calls` onto a class / struct / union into
 *     `instantiates`, and an `extension`'s `rawValue` call resolves to the
 *     enum's declaration in the other file, so neither gives the shape.
 *   - Controls: an uncalled `fn lonely_rs` and an uncalled Swift
 *     `func lonelySwift` stay orphans, so the rules do not swallow
 *     everything.
 *
 * The "fixture:" tests assert the index facts a case depends on first, so a
 * change in extraction fails there rather than at the orphans assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { runOrphans, type OrphansArgs } from '../src/graph/orphans-run';
import { isGuess } from '../src/graph/orphans';

/** The report text of a run that must succeed. */
async function output(root: string, args: OrphansArgs): Promise<string> {
  const r = await runOrphans(root, args);
  if (!r.ok) throw new Error(`orphans failed: ${r.message}`);
  return r.output;
}

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

interface Entry { id: string; name: string; kind: string; path: string; span: string }
interface OrphansJson {
  added: number;
  orphans: Entry[];
  guessed: Entry[];
  excluded: { test: number; implementation: number; constructor: number; entry: number };
}

const C1_FILES: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub mod tr;\n\npub fn existing() -> tr::S {\n    tr::S\n}\n',
  'src/tr.rs': '',
  'Sources/App/Old.swift': 'func oldThing() -> Int {\n    return 1\n}\n',
};

const C2_FILES: Record<string, string> = {
  'src/bin/x.rs': 'fn main() {\n    println!("x");\n}\n',
  'src/nested.rs':
    '#[test]\nfn t() {\n    struct Inner;\n    impl Inner {\n        fn helper(&self) {}\n    }\n    Inner.helper();\n}\n',
  'src/tmod.rs': '#[cfg(test)]\nmod tests {\n    fn util_fn() {}\n}\n',
  'src/tr.rs':
    'pub trait Tr {\n    fn req(&self);\n}\n\npub struct S;\n\nimpl Tr for S {\n    fn req(&self) {}\n}\n',
  'src/lonely.rs': 'pub fn lonely_rs() -> u32 {\n    7\n}\n',
  'Sources/App/App.swift': '@main\nstruct App {\n    static func main() {\n        print("app")\n    }\n}\n',
  'Sources/App/Extra.swift': 'func lonelySwift() -> Int {\n    return 2\n}\n',
  'Sources/App/GadgetA.swift': 'enum Gadget: Int {\n    case a = 1\n}\n',
  'Sources/App/GadgetB.swift':
    'enum Gadget: Int {\n    case b = 2\n}\n\nfunc makeGadget() -> Int {\n    return Gadget(rawValue: 1)!.rawValue\n}\n',
};

interface NodeRow { id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number }
interface QualifiedNodeRow extends NodeRow { qualified_name: string }
interface EdgeRow { source: string; target: string; kind: string; metadata: string | null }

let root = '';
let report: OrphansJson;
let text = '';
let nodes: NodeRow[] = [];
let edges: EdgeRow[] = [];

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-lang-')));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  for (const [rel, content] of Object.entries(C2_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');

  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();

  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    nodes = db.prepare("SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as NodeRow[];
    edges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
  } finally {
    conn.close();
  }

  report = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
  text = await output(root, { base: 'C1', format: 'text' });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const listedIds = (): string[] => [...report.orphans, ...report.guessed].map((e) => e.id);
const listedNames = (): string[] => [...report.orphans, ...report.guessed].map((e) => e.name);
const nodeAt = (name: string, file: string): NodeRow | undefined =>
  nodes.find((n) => n.name === name && n.file_path === file);

describe('orphans entry points', () => {
  it('fixture: fn main, @main struct App and its main are nodes', () => {
    expect(nodeAt('main', 'src/bin/x.rs')?.kind).toBe('function');
    expect(nodeAt('App', 'Sources/App/App.swift')).toBeDefined();
    expect(nodeAt('main', 'Sources/App/App.swift')?.kind).toBe('method');
  });

  it('a Rust fn main is not listed and is counted as entry', () => {
    expect(listedIds()).not.toContain(nodeAt('main', 'src/bin/x.rs')!.id);
    expect(report.excluded.entry).toBeGreaterThanOrEqual(1);
  });

  it('a Swift @main type and its main are not listed', () => {
    expect(listedNames()).not.toContain('App');
    expect(listedIds()).not.toContain(nodeAt('main', 'Sources/App/App.swift')!.id);
    expect(report.excluded.entry).toBeGreaterThanOrEqual(3);
  });

  it('the text excluded line carries the entry count', () => {
    expect(text).toMatch(/^excluded: test \d+, implementation \d+, constructor \d+, entry \d+$/m);
  });
});

describe('orphans nested in tests', () => {
  it('fixture: Inner and helper are nodes inside the span of the #[test] fn t', () => {
    const t = nodeAt('t', 'src/nested.rs')!;
    expect(t).toBeDefined();
    for (const name of ['Inner', 'helper']) {
      const n = nodeAt(name, 'src/nested.rs');
      expect(n, name).toBeDefined();
      expect(n!.start_line).toBeGreaterThan(t.start_line);
      expect(n!.end_line).toBeLessThanOrEqual(t.end_line);
    }
  });

  it('a type and its method declared inside a #[test] fn are not listed', () => {
    expect(listedNames()).not.toContain('Inner');
    expect(listedNames()).not.toContain('helper');
  });

  it('fixture: util_fn is a node (the cfg(test) module is not)', () => {
    expect(nodeAt('util_fn', 'src/tmod.rs')).toBeDefined();
  });

  it('a function inside a #[cfg(test)] mod is not listed', () => {
    expect(listedNames()).not.toContain('util_fn');
  });
});

describe('orphans requirements', () => {
  it('fixture: trait Tr holds req, and S implements Tr', () => {
    const tr = nodeAt('Tr', 'src/tr.rs');
    expect(tr?.kind).toBe('trait');
    const reqs = nodes.filter((n) => n.name === 'req' && n.file_path === 'src/tr.rs');
    expect(reqs.length).toBe(2);
    expect(edges.some((e) => e.target === tr!.id && (e.kind === 'implements' || e.kind === 'extends'))).toBe(true);
  });

  it('a trait member whose trait is implemented is not listed', () => {
    const tr = nodeAt('Tr', 'src/tr.rs')!;
    const traitReq = nodes.find((n) => n.name === 'req' && n.file_path === 'src/tr.rs' && n.start_line > tr.start_line && n.end_line <= tr.end_line);
    expect(traitReq).toBeDefined();
    expect(listedIds()).not.toContain(traitReq!.id);
    expect(listedNames()).not.toContain('req');
  });
});

describe('orphans language controls', () => {
  it('an uncalled Rust fn is still an orphan', () => {
    expect(report.orphans.find((o) => o.name === 'lonely_rs')).toMatchObject({ path: 'src/lonely.rs', kind: 'function' });
  });

  it('an uncalled Swift func is still an orphan', () => {
    expect(report.orphans.find((o) => o.name === 'lonelySwift')).toMatchObject({ path: 'Sources/App/Extra.swift', kind: 'function' });
  });
});

describe('orphans guess rule on a same-name type group', () => {
  const A = 'Sources/App/GadgetA.swift';
  const B = 'Sources/App/GadgetB.swift';
  const byId = (id: string): NodeRow | undefined => nodes.find((n) => n.id === id);

  it('fixture: Gadget is an enum in both files, and its only use is a same-file exact-match calls edge in GadgetB.swift onto GadgetB\'s enum', () => {
    const a = nodeAt('Gadget', A);
    const b = nodeAt('Gadget', B);
    expect(a?.kind).toBe('enum');
    expect(b?.kind).toBe('enum');
    const gadgetIds = new Set(nodes.filter((n) => n.name === 'Gadget').map((n) => n.id));
    const uses = edges.filter((e) => gadgetIds.has(e.target));
    const dump = JSON.stringify(uses.map((e) => ({ ...e, from: byId(e.source), to: byId(e.target) })));
    expect(uses.length, dump).toBe(1);
    const [call] = uses;
    expect(call.kind, dump).toBe('calls');
    expect(byId(call.source)?.name, dump).toBe('makeGadget');
    expect(byId(call.source)?.file_path, dump).toBe(B);
    expect(call.target, dump).toBe(b!.id);
    expect((JSON.parse(call.metadata ?? '{}') as { resolvedBy?: string }).resolvedBy, dump).toBe('exact-match');
  });

  it('GadgetA\'s enum is neither guessed nor orphaned: its group\'s one use is certain by that edge\'s own files', () => {
    const a = nodeAt('Gadget', A)!;
    expect(report.guessed.map((e) => e.id)).not.toContain(a.id);
    expect(report.orphans.map((e) => e.id)).not.toContain(a.id);
  });
});

/**
 * Outside Swift, a type counts only its own uses. The index cannot identify declaration-merging
 * partners reliably, so another declaration of the name supplies text evidence, not shared uses.
 * Here src/use.ts uses the Widget in src/a/widget.ts; C2 adds an unrelated, unused Widget in
 * src/b/widget.ts. Swift alone groups same-named type nodes, including extensions.
 */
describe('orphans independent uses of same-named types outside Swift', () => {
  let tsRoot = '';
  let tsReport: {
    added: number;
    orphans: Entry[];
    guessed: (Entry & { edges: unknown[] })[];
    excluded: OrphansJson['excluded'];
  };
  let tsNodes: NodeRow[] = [];
  let tsEdges: EdgeRow[] = [];

  beforeAll(async () => {
    tsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-same-name-')));
    git(tsRoot, 'init', '-q');
    write(tsRoot, 'src/a/widget.ts', 'export class Widget {}\n');
    write(tsRoot, 'src/use.ts', "import { Widget } from './a/widget';\n\nexport function make(): Widget {\n  return new Widget();\n}\n");
    git(tsRoot, 'add', '-A');
    git(tsRoot, 'commit', '-q', '-m', 'C1');
    git(tsRoot, 'tag', 'C1');
    write(tsRoot, 'src/b/widget.ts', 'export class Widget {}\n');
    git(tsRoot, 'add', '-A');
    git(tsRoot, 'commit', '-q', '-m', 'C2: add an unrelated Widget');

    const cg = await CodeGraph.init(tsRoot);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(tsRoot), { readOnly: true });
    try {
      const db = conn.getDb();
      tsNodes = db.prepare("SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as NodeRow[];
      tsEdges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
    } finally {
      conn.close();
    }

    tsReport = JSON.parse(await output(tsRoot, { base: 'C1', format: 'json' })) as typeof tsReport;
  }, 60_000);

  afterAll(() => {
    if (tsRoot) fs.rmSync(tsRoot, { recursive: true, force: true });
  });

  it('fixture: the only added symbol is the new Widget, and its use reaches src/a/widget.ts\'s class by a certain edge', () => {
    expect(tsReport.added).toBe(1);
    const a = tsNodes.find((n) => n.name === 'Widget' && n.file_path === 'src/a/widget.ts');
    const b = tsNodes.find((n) => n.name === 'Widget' && n.file_path === 'src/b/widget.ts');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const toA = tsEdges.filter((e) => e.target === a!.id);
    expect(toA.length).toBeGreaterThanOrEqual(1);
    for (const e of toA) {
      const from = tsNodes.find((n) => n.id === e.source)?.file_path ?? '';
      const meta = (e.metadata ? JSON.parse(e.metadata) : {}) as Record<string, unknown>;
      expect(isGuess(e.kind, meta, from, 'src/a/widget.ts')).toBe(false);
    }
    expect(tsEdges.some((e) => e.target === b!.id)).toBe(false);
  });

  it('the unrelated Widget in src/b/widget.ts is listed, its evidence is text rather than the other class\'s use, and no exclusion takes it', () => {
    const guessed = tsReport.guessed.find((e) => e.name === 'Widget' && e.path === 'src/b/widget.ts');
    const orphan = tsReport.orphans.find((e) => e.name === 'Widget' && e.path === 'src/b/widget.ts');
    expect(guessed ?? orphan).toBeDefined();
    if (guessed) expect(guessed.edges).toEqual([]);
    expect(tsReport.excluded).toEqual({ test: 0, implementation: 0, constructor: 0, entry: 0 });
  });
});

/**
 * Two classes of one name in one file, each inside a different outer class, are two types. A
 * TypeScript `namespace` block is not a node in the index, so the outer classes are what give the
 * two Widgets different qualified names. C1 adds src/runner.ts: an
 * interface `Runner` with a `run` member. C2 adds src/widgets.ts: class A and class B each have a
 * method `make` that declares a local class `Widget`; B's Widget implements Runner and A's does not.
 * Nothing calls the run of A's Widget.
 */
describe('orphans independent conformances of classes in different outer classes', () => {
  const WIDGETS = 'src/widgets.ts';
  let twRoot = '';
  let twReport: { orphans: Entry[]; guessed: Entry[]; excluded: OrphansJson['excluded'] };
  let twNodes: QualifiedNodeRow[] = [];
  let twEdges: EdgeRow[] = [];

  beforeAll(async () => {
    twRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-outer-')));
    git(twRoot, 'init', '-q');
    write(twRoot, 'src/runner.ts', 'export interface Runner {\n  run(): void;\n}\n');
    git(twRoot, 'add', '-A');
    git(twRoot, 'commit', '-q', '-m', 'C1');
    git(twRoot, 'tag', 'C1');
    write(twRoot, WIDGETS, [
      "import { Runner } from './runner';",
      '',
      'export class A {',
      '  make(): void {',
      '    class Widget {',
      '      run(): void {}',
      '    }',
      '  }',
      '}',
      '',
      'export class B {',
      '  make(): void {',
      '    class Widget implements Runner {',
      '      run(): void {}',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    git(twRoot, 'add', '-A');
    git(twRoot, 'commit', '-q', '-m', 'C2: add two Widget classes');

    const cg = await CodeGraph.init(twRoot);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(twRoot), { readOnly: true });
    try {
      const db = conn.getDb();
      twNodes = db.prepare("SELECT id, name, kind, file_path, start_line, end_line, qualified_name FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as QualifiedNodeRow[];
      twEdges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
    } finally {
      conn.close();
    }

    twReport = JSON.parse(await output(twRoot, { base: 'C1', format: 'json' })) as typeof twReport;
  }, 60_000);

  afterAll(() => {
    if (twRoot) fs.rmSync(twRoot, { recursive: true, force: true });
  });

  /** The nodes of `name` in src/widgets.ts, in source order (A's declarations before B's). */
  const inWidgets = (name: string): QualifiedNodeRow[] =>
    twNodes.filter((n) => n.name === name && n.file_path === WIDGETS).sort((a, b) => a.start_line - b.start_line);

  it('fixture: the two Widget classes qualify under A and under B, and only the B Widget implements Runner', () => {
    const widgets = inWidgets('Widget').filter((n) => n.kind === 'class');
    expect(widgets.length).toBe(2);
    const [aWidget, bWidget] = widgets as [QualifiedNodeRow, QualifiedNodeRow];
    expect(aWidget.qualified_name.startsWith('A::'), aWidget.qualified_name).toBe(true);
    expect(bWidget.qualified_name.startsWith('B::'), bWidget.qualified_name).toBe(true);
    const runner = twNodes.find((n) => n.name === 'Runner' && n.file_path === 'src/runner.ts');
    expect(runner?.kind).toBe('interface');
    const conformsTo = (id: string): string[] =>
      twEdges.filter((e) => e.source === id && (e.kind === 'implements' || e.kind === 'extends')).map((e) => e.target);
    expect(conformsTo(bWidget.id)).toEqual([runner!.id]);
    expect(conformsTo(aWidget.id)).toEqual([]);
    const [aRun] = inWidgets('run');
    expect(aRun).toBeDefined();
    expect(twEdges.some((e) => e.target === aRun!.id)).toBe(false);
  });

  it('two unrelated same-named classes in one file, declared in different outer classes, are separate types', () => {
    const [aRun] = inWidgets('run');
    expect(aRun).toBeDefined();
    const listed = [...twReport.orphans, ...twReport.guessed].map((e) => e.id);
    expect(listed, "the run of A's Widget is listed, not excluded through B's Widget").toContain(aRun!.id);
  });
});

/**
 * TypeScript namespace blocks are absent from stored qualified names. The two Widget classes in
 * src/widgets.ts therefore have the same qualified name despite belonging to different namespaces.
 * Only B's Widget implements Runner; A's uncalled run must not inherit that conformance.
 */
describe('orphans same-named classes in TypeScript namespace blocks', () => {
  const WIDGETS = 'src/widgets.ts';
  let nsRoot = '';
  let nsReport: OrphansJson;
  let nsNodes: QualifiedNodeRow[] = [];
  let nsEdges: EdgeRow[] = [];

  beforeAll(async () => {
    nsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-namespace-')));
    git(nsRoot, 'init', '-q');
    write(nsRoot, 'src/runner.ts', 'export interface Runner { run(): void; }\n');
    git(nsRoot, 'add', '-A');
    git(nsRoot, 'commit', '-q', '-m', 'C1');
    git(nsRoot, 'tag', 'C1');
    write(nsRoot, WIDGETS, [
      "import { Runner } from './runner';",
      '',
      'export namespace A { export class Widget { run(): void {} } }',
      'export namespace B { export class Widget implements Runner { run(): void {} } }',
      '',
    ].join('\n'));
    git(nsRoot, 'add', '-A');
    git(nsRoot, 'commit', '-q', '-m', 'C2: add Widgets in separate namespaces');

    const cg = await CodeGraph.init(nsRoot);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(nsRoot), { readOnly: true });
    try {
      const db = conn.getDb();
      nsNodes = db.prepare("SELECT id, name, kind, file_path, start_line, end_line, qualified_name FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as QualifiedNodeRow[];
      nsEdges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
    } finally {
      conn.close();
    }

    nsReport = JSON.parse(await output(nsRoot, { base: 'C1', format: 'json' })) as OrphansJson;
  }, 60_000);

  afterAll(() => {
    if (nsRoot) fs.rmSync(nsRoot, { recursive: true, force: true });
  });

  /** A's declarations precede B's in src/widgets.ts. */
  const inNamespaces = (name: string): QualifiedNodeRow[] =>
    nsNodes.filter((n) => n.name === name && n.file_path === WIDGETS).sort((a, b) => a.start_line - b.start_line);

  it('fixture: namespace Widgets have the same stored qualified name, and only B implements Runner', () => {
    const widgets = inNamespaces('Widget').filter((n) => n.kind === 'class');
    expect(widgets).toHaveLength(2);
    const [aWidget, bWidget] = widgets as [QualifiedNodeRow, QualifiedNodeRow];
    expect(aWidget.qualified_name).toBe(bWidget.qualified_name);
    const runner = nsNodes.find((n) => n.name === 'Runner' && n.file_path === 'src/runner.ts');
    expect(runner?.kind).toBe('interface');
    const conformsTo = (id: string): string[] =>
      nsEdges.filter((e) => e.source === id && (e.kind === 'implements' || e.kind === 'extends')).map((e) => e.target);
    expect(conformsTo(aWidget.id)).toEqual([]);
    expect(conformsTo(bWidget.id)).toEqual([runner!.id]);
    const runs = inNamespaces('run');
    expect(runs).toHaveLength(2);
    expect(nsEdges.some((e) => e.target === runs[0].id)).toBe(false);
  });

  it('lists the uncalled run of namespace A\'s Widget rather than excluding it through namespace B', () => {
    const [aRun] = inNamespaces('run');
    expect(aRun).toBeDefined();
    expect([...nsReport.orphans, ...nsReport.guessed].map((e) => e.id)).toContain(aRun!.id);
  });
});

/**
 * A C# partial class is one class split over files. Each part is its own class node, and the parts
 * share a qualified name (`App::Worker`, the namespace being a node). C1 has Worker.cs (the first
 * part, with `Run`) and Program.cs, which calls `new Worker().Run()`. C2 adds Worker.Extra.cs with
 * an empty second part, the only symbol the change adds. The index resolves the one `new Worker()`
 * onto the new part, as a low-confidence `instantiates` edge, and nothing onto the first part. That
 * use is a guess, so the new part is listed as guessed and never as orphaned.
 */
describe('orphans a new part of a used C# partial class', () => {
  let csRoot = '';
  let csReport: { added: number; orphans: Entry[]; guessed: Entry[]; excluded: OrphansJson['excluded'] };
  let csNodes: QualifiedNodeRow[] = [];
  let csEdges: EdgeRow[] = [];

  beforeAll(async () => {
    csRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-partial-')));
    git(csRoot, 'init', '-q');
    write(csRoot, 'Worker.cs', 'namespace App\n{\n    public partial class Worker\n    {\n        public void Run() {}\n    }\n}\n');
    write(csRoot, 'Program.cs', 'namespace App\n{\n    public class Program\n    {\n        public static void Start()\n        {\n            new Worker().Run();\n        }\n    }\n}\n');
    git(csRoot, 'add', '-A');
    git(csRoot, 'commit', '-q', '-m', 'C1');
    git(csRoot, 'tag', 'C1');
    write(csRoot, 'Worker.Extra.cs', 'namespace App\n{\n    public partial class Worker\n    {\n    }\n}\n');
    git(csRoot, 'add', '-A');
    git(csRoot, 'commit', '-q', '-m', 'C2: add a second part of Worker');

    const cg = await CodeGraph.init(csRoot);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(csRoot), { readOnly: true });
    try {
      const db = conn.getDb();
      csNodes = db.prepare("SELECT id, name, kind, file_path, start_line, end_line, qualified_name FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as QualifiedNodeRow[];
      csEdges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
    } finally {
      conn.close();
    }

    csReport = JSON.parse(await output(csRoot, { base: 'C1', format: 'json' })) as typeof csReport;
  }, 60_000);

  afterAll(() => {
    if (csRoot) fs.rmSync(csRoot, { recursive: true, force: true });
  });

  it('fixture: both parts are Worker classes qualified App::Worker, and the one use is a guessed edge onto the new part', () => {
    expect(csReport.added).toBe(1);
    const workers = csNodes.filter((n) => n.name === 'Worker' && n.kind === 'class');
    expect(workers.map((w) => w.file_path).sort()).toEqual(['Worker.Extra.cs', 'Worker.cs']);
    for (const w of workers) expect(w.qualified_name).toBe('App::Worker');
    const first = workers.find((w) => w.file_path === 'Worker.cs')!;
    const extra = workers.find((w) => w.file_path === 'Worker.Extra.cs')!;
    expect(csEdges.filter((e) => e.target === first.id)).toEqual([]);
    const uses = csEdges.filter((e) => e.target === extra.id);
    expect(uses).toHaveLength(1);
    const meta = (uses[0].metadata ? JSON.parse(uses[0].metadata) : {}) as Record<string, unknown>;
    expect(uses[0].kind).toBe('instantiates');
    expect(csNodes.find((n) => n.id === uses[0].source)?.file_path).toBe('Program.cs');
    expect(isGuess(uses[0].kind, meta, 'Program.cs', 'Worker.Extra.cs')).toBe(true);
  });

  it('a new part of a C# partial class is guessed, never called orphaned', () => {
    const extra = csNodes.find((n) => n.name === 'Worker' && n.kind === 'class' && n.file_path === 'Worker.Extra.cs');
    expect(extra).toBeDefined();
    expect(csReport.guessed.map((e) => e.id)).toContain(extra!.id);
    expect(csReport.orphans.map((e) => e.id)).not.toContain(extra!.id);
  });
});
