/**
 * Suspect call edges: name-only `calls` edges ranked by how likely they are wrong
 * (std-collision, missing-import, several-definitions, low-confidence).
 *
 * Each describe builds one real project in a temp dir, indexes it with a real CodeGraph,
 * closes it, and then reads it back through `findSuspects` (which opens the DB read-only).
 * Where a fixture depends on how the resolver binds an edge, the expected resolvedBy and
 * confidence are noted inline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import {
  candidateEdgeSql,
  findSuspects,
  formatSuspects,
  isCandidateEdge,
  stdCollision,
  suspectsToJson,
  type Suspect,
} from '../src/graph/suspects';
import { swiftModuleName } from '../src/graph/swift-module';

const RUST_APP_CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n';
/** Root workspace: crates a and b are members, so each has a known crate. */
const RUST_AB_WORKSPACE = '[workspace]\nmembers = ["a", "b"]\n';

/** Writes `files` into a fresh temp dir, indexes it, closes the graph, and returns the dir. */
async function buildProject(files: Record<string, string>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspects-'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  const cg = await CodeGraph.init(dir, { index: true });
  cg.close();
  return dir;
}

function removeProject(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function byName(suspects: Suspect[], name: string): Suspect {
  const found = suspects.filter((s) => s.targetName === name);
  expect(found, `suspect targets named ${name}`).toHaveLength(1);
  return found[0]!;
}

describe('stdCollision', () => {
  it('flags a Rust standard-library method name', () => {
    expect(stdCollision('rust', 'push')).toBe(true);
    expect(stdCollision('rust', 'clear')).toBe(true);
  });

  it('does not flag a project-only Rust name', () => {
    expect(stdCollision('rust', 'render_all')).toBe(false);
  });

  it('is false for a language with no list', () => {
    expect(stdCollision('typescript', 'push')).toBe(false);
  });

  // The default predicate's Swift list is swift-builtins.ts's SWIFT_STD_METHODS.
  it('flags a Swift standard-library method name', () => {
    expect(stdCollision('swift', 'sorted')).toBe(true);
  });
});

describe('suspects: Swift std collision', () => {
  let dir: string;
  beforeAll(async () => {
    // `sorter` has no declared type; the resolver keeps the std-named `sorted()` on Sorter
    // only because the receiver's name shares a word with it (instance-method 0.8, below the
    // 0.9 declared bar, so a name-only candidate). A plain stdlib receiver (`[3, 1].sorted()`)
    // does not bind to Sorter at all, and a typed one (`let s = Sorter()`) binds at 0.9.
    dir = await buildProject({
      'Sources/App/Main.swift': 'import Util\n\nfunc run() {\n    let sorter = makeSorter()\n    let out = sorter.sorted()\n    print(out)\n}\n',
      'Sources/Util/Sorter.swift': 'public struct Sorter {\n    public func sorted() -> [Int] { return [] }\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags sorted as a std collision with an injected predicate, not low confidence, and no missing import', () => {
    const suspects = findSuspects(dir, { isStdMethod: (l, n) => l === 'swift' && n === 'sorted' });
    const sorted = byName(suspects, 'sorted');
    expect(sorted.language).toBe('swift');
    // App imports Util, so the cross-module edge is not a missing import; confidence 0.8 is
    // not below the low-confidence bar.
    expect(sorted.flags).toEqual(['std-collision']);
    expect(sorted.score).toBe(4);
    expect(sorted.definitions).toBe(1);
    expect(sorted.edgeCount).toBe(1);
    expect(sorted.edges).toHaveLength(1);
    expect(sorted.edges[0]).toMatchObject({
      callerName: 'run', refName: 'sorter.sorted', resolvedBy: 'instance-method', confidence: 0.8, flags: ['std-collision'],
    });
  });

  // The default predicate knows Swift's `sorted` (swift-builtins.ts's SWIFT_STD_METHODS).
  it('flags sorted as a std collision with the default predicate', () => {
    const sorted = byName(findSuspects(dir), 'sorted');
    expect(sorted.flags).toContain('std-collision');
  });
});

describe('suspects: Rust std collision', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod stack;\n\nfn run() {\n    let mut stack = build();\n    stack.push(1);\n    stack.clear();\n}\n',
      'src/stack.rs': 'pub struct Stack { items: Vec<i32> }\n\nimpl Stack {\n    pub fn push(&mut self, x: i32) { }\n    pub fn clear(&mut self) { }\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags push and clear as std collisions only (same crate, confidence 0.8)', () => {
    const suspects = findSuspects(dir);
    for (const name of ['push', 'clear']) {
      const s = byName(suspects, name);
      expect(s.flags, name).toEqual(['std-collision']);
      expect(s.score, name).toBe(4);
      expect(s.language, name).toBe('rust');
      expect(s.edges[0], name).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method', confidence: 0.8 });
    }
  });
});

describe('suspects: Rust missing import', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_AB_WORKSPACE,
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags a call from crate a into crate b with no use of b as a missing import', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).toEqual(['missing-import']);
    expect(s.score).toBe(3);
    expect(s.edges[0]).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method', confidence: 0.8 });
    expect(s.edges[0]!.flags).toEqual(['missing-import']);
  });
});

describe('suspects: Rust import present', () => {
  let dir: string;
  beforeAll(async () => {
    // The edge still forms (instance-method 0.8), and a/src/lib.rs has an import node named `b`.
    dir = await buildProject({
      'Cargo.toml': RUST_AB_WORKSPACE,
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'use b::Widget;\n\npub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not flag a missing import when the caller uses the target crate', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).not.toContain('missing-import');
    // Name-only alone still lists the edge, at score 0.
    expect(s.flags).toEqual([]);
    expect(s.score).toBe(0);
  });
});

/**
 * A kit layout: every crate lives in `<Kit>/rust/`, so a crate named by its directory
 * is `rust` on both sides. The crate name must come from the member's package name instead.
 */
function rustKitApp(appLib: string): Record<string, string> {
  return {
    'Cargo.toml': '[workspace]\nmembers = ["app/rust", "kit/rust"]\n',
    'app/rust/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
    'app/rust/src/lib.rs': appLib,
    'kit/rust/Cargo.toml': '[package]\nname = "my-kit"\nversion = "0.1.0"\n',
    'kit/rust/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
  };
}

describe('suspects: Rust crates in same-named directories (package name, not directory)', () => {
  let withUse: string;
  let withoutUse: string;
  beforeAll(async () => {
    withUse = await buildProject(rustKitApp(
      'use my_kit::Widget;\n\npub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
    ));
    withoutUse = await buildProject(rustKitApp(
      'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
    ));
  });
  afterAll(() => {
    removeProject(withUse);
    removeProject(withoutUse);
  });

  it('does not flag a missing import when the caller uses the kit by its package name', () => {
    const s = byName(findSuspects(withUse), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', callerFile: 'app/rust/src/lib.rs' });
    expect(s.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not use the kit', () => {
    const s = byName(findSuspects(withoutUse), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', callerFile: 'app/rust/src/lib.rs' });
    expect(s.flags).toContain('missing-import');
  });
});

describe('suspects: Rust crates with no root workspace (abstain)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not flag a missing import when neither crate is a workspace member', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method' });
    expect(s.flags).not.toContain('missing-import');
  });
});

describe('suspects: Swift missing import + several definitions', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Sources/App/Main.swift': 'import Foundation\n\nfunc run() {\n    let x = makeWidget()\n    print(x)\n}\n',
      'Sources/Util/Widget.swift': 'public func makeWidget() -> Int { return 1 }\n',
      'Sources/Other/Widget2.swift': 'public func makeWidget() -> Int { return 2 }\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags makeWidget as missing-import, several-definitions and low-confidence', () => {
    const s = byName(findSuspects(dir), 'makeWidget');
    expect(s.flags).toEqual(['missing-import', 'several-definitions', 'low-confidence']);
    expect(s.definitions).toBe(2);
    expect(s.score).toBe(6);
    expect(s.edges[0]).toMatchObject({
      callerName: 'run', refName: 'makeWidget', resolvedBy: 'exact-match', confidence: 0.4,
    });
  });
});

describe('swiftModuleName', () => {
  // SwiftPM's c99name (`spm_mangledToC99ExtendedIdentifier`, swift-tools-support-core
  // StringMangling.swift @ c574915f): every Unicode scalar outside its C99 Annex D allowed
  // range table becomes `_`, and a first scalar that is a digit is replaced by `_` (not
  // prefixed; '1abc' -> '_abc' measured with Swift 6.4).
  it('replaces a hyphen with an underscore', () => {
    expect(swiftModuleName('mcp-benchmarker')).toBe('mcp_benchmarker');
  });

  it('replaces a dot and a space with underscores', () => {
    expect(swiftModuleName('a.b c')).toBe('a_b_c');
  });

  it('replaces a leading digit with an underscore', () => {
    expect(swiftModuleName('1abc')).toBe('_abc');
  });

  it('keeps a non-ASCII letter and replaces a plus sign', () => {
    expect(swiftModuleName('na\u00efve+x')).toBe('na\u00efve_x');
  });

  it('leaves a plain identifier unchanged', () => {
    expect(swiftModuleName('Util')).toBe('Util');
  });

  it('replaces a character outside the table (a fraction, U+00BD) with an underscore', () => {
    expect(swiftModuleName('a½b')).toBe('a_b');
  });

  it('keeps a Roman numeral (U+2163, in the table range U+2160-U+2182)', () => {
    expect(swiftModuleName('aⅣb')).toBe('aⅣb');
  });

  it('replaces a combining mark outside the table (U+0308) with an underscore', () => {
    // 'i' + COMBINING DIAERESIS: the table allows precomposed U+00EF but not U+0308.
    expect(swiftModuleName('naïve')).toBe('nai_ve');
  });
});

describe('suspects: Swift import of a hyphenated target names its c99name', () => {
  // The target sits in Sources/mcp-benchmarker, so `import` must name mcp_benchmarker.
  // benchTargetRun has one definition, so both edges are name-only (exact-match) and differ
  // only in whether the caller imports the target's module.
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Sources/mcp-benchmarker/Bench.swift': 'public func benchTargetRun() -> Int { return 1 }\n',
      'Sources/bench-cli/Main.swift':
        'import mcp_benchmarker\n\nfunc cliRun() {\n    let x = benchTargetRun()\n    print(x)\n}\n',
      'Sources/Other/Main.swift': 'import Foundation\n\nfunc otherRun() {\n    let x = benchTargetRun()\n    print(x)\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  function edgeFrom(callerName: string) {
    const s = byName(findSuspects(dir), 'benchTargetRun');
    const edges = s.edges.filter((e) => e.callerName === callerName);
    expect(edges, `edges from ${callerName}`).toHaveLength(1);
    return edges[0]!;
  }

  it('does not flag a missing import when the caller imports mcp_benchmarker', () => {
    const e = edgeFrom('cliRun');
    expect(e).toMatchObject({ callerFile: 'Sources/bench-cli/Main.swift', refName: 'benchTargetRun' });
    expect(e.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not import the target', () => {
    const e = edgeFrom('otherRun');
    expect(e).toMatchObject({ callerFile: 'Sources/Other/Main.swift', refName: 'benchTargetRun' });
    expect(e.flags).toContain('missing-import');
  });
});

describe('suspects: Swift import of a target named with a Roman numeral keeps it', () => {
  // The target sits in Sources/aⅣb; U+2163 is in SwiftPM's allowed table, so the c99name
  // is the directory itself and `import aⅣb` names it. romanTargetRun has one definition,
  // so both edges are name-only (exact-match) and differ only in the caller's import.
  const MODULE = 'aⅣb';
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      [`Sources/${MODULE}/Roman.swift`]: 'public func romanTargetRun() -> Int { return 1 }\n',
      'Sources/RomanCli/Main.swift':
        `import ${MODULE}\n\nfunc romanCliRun() {\n    let x = romanTargetRun()\n    print(x)\n}\n`,
      'Sources/RomanOther/Main.swift':
        'import Foundation\n\nfunc romanOtherRun() {\n    let x = romanTargetRun()\n    print(x)\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  function edgeFrom(callerName: string) {
    const s = byName(findSuspects(dir), 'romanTargetRun');
    const edges = s.edges.filter((e) => e.callerName === callerName);
    expect(edges, `edges from ${callerName}`).toHaveLength(1);
    return edges[0]!;
  }

  it(`does not flag a missing import when the caller imports ${MODULE}`, () => {
    const e = edgeFrom('romanCliRun');
    expect(e).toMatchObject({ callerFile: 'Sources/RomanCli/Main.swift', refName: 'romanTargetRun' });
    expect(e.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not import the target', () => {
    const e = edgeFrom('romanOtherRun');
    expect(e).toMatchObject({ callerFile: 'Sources/RomanOther/Main.swift', refName: 'romanTargetRun' });
    expect(e.flags).toContain('missing-import');
  });
});

describe('suspects: Rust several definitions', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod a;\nmod b;\n\nfn run() {\n    let thing = make();\n    thing.render_all();\n}\n',
      'src/a.rs': 'pub struct Thing;\nimpl Thing {\n    pub fn render_all(&self) {}\n}\n',
      'src/b.rs': 'pub struct Other;\nimpl Other {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags render_all as several-definitions only, with definitions=2', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).toEqual(['several-definitions']);
    expect(s.definitions).toBe(2);
    expect(s.score).toBe(2);
    expect(s.targetQualifiedName).toBe('Thing::render_all');
  });
});

describe('suspects: non-suspect controls', () => {
  let dir: string;
  beforeAll(async () => {
    // Rust: g.spin_up() on a typed parameter resolves instance-method 0.9.
    // TypeScript: assemble() resolves through its import (resolvedBy 'import', 0.9).
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod gadget;\nuse crate::gadget::Gadget;\n\nfn run(g: &Gadget) {\n    g.spin_up();\n}\n',
      'src/gadget.rs': 'pub struct Gadget;\nimpl Gadget {\n    pub fn spin_up(&self) {}\n}\n',
      'web/run.ts': "import { assemble } from './gadget';\n\nexport function run() {\n  assemble();\n}\n",
      'web/gadget.ts': 'export function assemble() {}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('lists neither a typed receiver call nor an import-resolved call', () => {
    const suspects = findSuspects(dir);
    expect(suspects.map((s) => s.targetName)).not.toContain('spin_up');
    expect(suspects.map((s) => s.targetName)).not.toContain('assemble');
    expect(suspects).toEqual([]);
  });
});

describe('suspects: ranking, options, JSON and text', () => {
  let dir: string;
  beforeAll(async () => {
    // Edges: run→Stack::push (line 7), run→Stack::clear (line 8), run→Thing::render_all (line 10),
    // run2→Stack::push (line 15); all instance-method 0.8. push and clear score 4 (std), render_all 2.
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs':
        'mod stack;\nmod a;\nmod b;\n\nfn run() {\n    let mut stack = build();\n    stack.push(1);\n    stack.clear();\n' +
        '    let thing = make();\n    thing.render_all();\n}\n\nfn run2() {\n    let mut stack = build();\n    stack.push(2);\n}\n',
      'src/stack.rs': 'pub struct Stack { items: Vec<i32> }\n\nimpl Stack {\n    pub fn push(&mut self, x: i32) { }\n    pub fn clear(&mut self) { }\n}\n',
      'src/a.rs': 'pub struct Thing;\nimpl Thing {\n    pub fn render_all(&self) {}\n}\n',
      'src/b.rs': 'pub struct Other;\nimpl Other {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('ranks std targets above a several-definitions target, and equal scores by edge count', () => {
    const suspects = findSuspects(dir);
    expect(suspects.map((s) => s.targetName)).toEqual(['push', 'clear', 'render_all']);
    expect(suspects.map((s) => s.score)).toEqual([4, 4, 2]);
    expect(suspects.map((s) => s.edgeCount)).toEqual([2, 1, 1]);
  });

  it('orders a target\'s edges by callerFile then line when scores tie', () => {
    const push = byName(findSuspects(dir), 'push');
    expect(push.edges.map((e) => [e.callerName, e.callerFile, e.line])).toEqual([
      ['run', 'src/main.rs', 7],
      ['run2', 'src/main.rs', 15],
    ]);
  });

  it('honours limit and maxEdgesPerTarget', () => {
    const limited = findSuspects(dir, { limit: 1 });
    expect(limited.map((s) => s.targetName)).toEqual(['push']);
    const capped = byName(findSuspects(dir, { maxEdgesPerTarget: 1 }), 'push');
    expect(capped.edgeCount).toBe(2);
    expect(capped.edges).toHaveLength(1);
  });

  it('serialises to version-1 JSON with exactly the Suspect and SuspectEdge keys', () => {
    const json = suspectsToJson(findSuspects(dir));
    const round = JSON.parse(JSON.stringify(json));
    expect(round).toEqual(json);
    expect(round.version).toBe(1);
    expect(round.suspects).toHaveLength(3);
    const suspectKeys = [
      'definitions', 'edgeCount', 'edges', 'flags', 'language', 'score', 'targetFile', 'targetId',
      'targetKind', 'targetLine', 'targetName', 'targetQualifiedName',
    ];
    const edgeKeys = ['callerFile', 'callerId', 'callerName', 'confidence', 'flags', 'line', 'refName', 'resolvedBy'];
    for (const s of round.suspects) {
      expect(Object.keys(s).sort()).toEqual(suspectKeys);
      for (const e of s.edges) expect(Object.keys(e).sort()).toEqual(edgeKeys);
    }
  });

  it('formats a header, rank lines and indented edge lines', () => {
    const lines = formatSuspects(findSuspects(dir)).split('\n');
    expect(lines[0]).toBe('3 suspect targets (4 call edges)');
    expect(lines).toContain('1. [score 4] Stack::push  src/stack.rs:4  2 call(s)  std-collision  defs=1');
    expect(lines).toContain('    run  src/main.rs:7  stack.push  instance-method 0.8');
    expect(lines).toContain('    run2  src/main.rs:15  stack.push  instance-method 0.8');
    expect(lines.some((l) => l.startsWith('3. [score 2] Thing::render_all ') && l.endsWith('several-definitions  defs=2')))
      .toBe(true);
  });

  it('formats an empty list', () => {
    expect(formatSuspects([])).toBe('No suspect call edges.');
  });
});

interface CallEdgeRow {
  kind: string;
  metadata: string | null;
  srcFile: string | null;
  tgtFile: string | null;
  candidate: number;
}

/**
 * The one `calls` edge from the node named `caller` to the node named `target`, read from the
 * index read-only, with `candidateEdgeSql('edges')` evaluated on that row.
 */
function callEdge(dir: string, caller: string, target: string): CallEdgeRow {
  const conn = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
  try {
    const rows = conn.getDb().prepare(
      `SELECT edges.kind AS kind, edges.metadata AS metadata,
              (SELECT file_path FROM nodes WHERE id = edges.source) AS srcFile,
              (SELECT file_path FROM nodes WHERE id = edges.target) AS tgtFile,
              ${candidateEdgeSql('edges')} AS candidate
         FROM edges
        WHERE edges.kind = 'calls'
          AND edges.source IN (SELECT id FROM nodes WHERE name = ?)
          AND edges.target IN (SELECT id FROM nodes WHERE name = ?)`,
    ).all(caller, target) as CallEdgeRow[];
    expect(rows, `calls edges ${caller} -> ${target}`).toHaveLength(1);
    return rows[0]!;
  } finally {
    conn.close();
  }
}

describe('suspects: a same-file exact-match call is certain, a cross-file one is a candidate', () => {
  let dir: string;
  beforeAll(async () => {
    // a.ts: a() calls b(), defined in the same file: exact-match, same file, so certain.
    // caller.ts: run() calls helper(), defined in helper.ts and NOT imported, so the resolver
    // binds it by name alone (exact-match) across files: still a candidate.
    dir = await buildProject({
      'a.ts': 'export function a() { b() }\nfunction b() {}\n',
      'caller.ts': 'export function run() {\n  helper();\n}\n',
      'helper.ts': 'export function helper() {}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not list the same-file exact-match target', () => {
    const edge = callEdge(dir, 'a', 'b');
    const metadata = JSON.parse(edge.metadata ?? 'null') as Record<string, unknown> | null;
    expect(metadata?.resolvedBy).toBe('exact-match');
    expect(edge.srcFile).toBe('a.ts');
    expect(edge.tgtFile).toBe('a.ts');
    expect(findSuspects(dir).map((s) => s.targetName)).not.toContain('b');
    expect(isCandidateEdge(edge.kind, metadata, edge.srcFile, edge.tgtFile)).toBe(false);
    expect(edge.candidate).toBe(0);
  });

  it('lists the cross-file exact-match target', () => {
    const edge = callEdge(dir, 'run', 'helper');
    const metadata = JSON.parse(edge.metadata ?? 'null') as Record<string, unknown> | null;
    expect(metadata?.resolvedBy).toBe('exact-match');
    expect(edge.srcFile).toBe('caller.ts');
    expect(edge.tgtFile).toBe('helper.ts');
    expect(findSuspects(dir).map((s) => s.targetName)).toContain('helper');
    expect(isCandidateEdge(edge.kind, metadata, edge.srcFile, edge.tgtFile)).toBe(true);
    expect(edge.candidate).toBe(1);
  });
});

describe('isCandidateEdge', () => {
  it('flags a fuzzy edge even within one file', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'fuzzy' }, 'a.ts', 'a.ts')).toBe(true);
  });

  it('flags an instance-method edge below 0.9 and not one at 0.95', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: 0.85 }, 'a.rs', 'b.rs')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: 0.95 }, 'a.rs', 'b.rs')).toBe(false);
  });

  it('reads a boolean confidence as 1 or 0 and a missing or string one as 1', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: false }, 'a.rs', 'b.rs')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: true }, 'a.rs', 'b.rs')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method' }, 'a.rs', 'b.rs')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: '0.5' }, 'a.rs', 'b.rs')).toBe(false);
  });

  it('never flags a non-calls edge or an edge with no resolvedBy', () => {
    expect(isCandidateEdge('references', { resolvedBy: 'fuzzy' }, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', {}, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', null, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'import' }, 'a.ts', 'b.ts')).toBe(false);
  });

  it('flags an exact-match edge whose files are unknown, and not one within one file', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, null, null)).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', undefined)).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', 'b.ts')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', 'a.ts')).toBe(false);
  });
});
