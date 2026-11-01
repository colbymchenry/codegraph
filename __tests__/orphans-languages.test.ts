/**
 * `codegraph orphans` on Rust and Swift: the entry-point, nested-in-test and
 * requirement rules, run on a real CodeGraph index of a fixture git repo
 * through `runOrphans`.
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
