/**
 * `codegraph orphans`: what it reads is what it claims. The edge cases of
 * the text-mention check, the nested-in-test rule, the source reads and the
 * changed-line read, run on real CodeGraph indexes of fixture git repos.
 *
 * Repo A (C1 tagged, C2 adds every symbol below in new files, so each is added
 * by rule 1), read through `runOrphans`:
 *   - the mention search's cap: `bigOwn` (a/big.ts) names itself on more lines
 *     of its own span than the search keeps in one run, and its file sorts
 *     first, so a capped run holds only its own lines. Its one mention outside,
 *     z/use.ts:1, must still be found: guessed, not orphaned;
 *   - the nested-in-test rule reads Rust with the parser: `nested_helper`
 *     (src/rawmod.rs) is inside a `#[cfg(test)] mod` whose raw string holds a
 *     `}`, and must stay excluded; `live_lonely` (src/fakemod.rs) follows a
 *     `#[cfg(test)] mod fake {` that is only text in a block comment, and must
 *     stay an orphan;
 *   - the attribute checks are language-gated and never read a comment as an
 *     attribute: in Sources/Marks/Marks.swift a `@Test` in a line comment, a
 *     doc comment, a one-line block comment or a block comment's star line
 *     excludes nothing, while `@Test func
 *     swiftRealTest` is excluded; in src/commented.rs a `#[test]` in a `//` or
 *     `///` comment excludes nothing, while `#[tokio::test]` does; in
 *     src/py_marks.py (Python, neither Rust nor Swift) a `#[test]` line and a
 *     `@Test` or `@main` decorator exclude nothing.
 * Repo E, read through `runOrphans`: an attribute line that also holds code
 * (`#[test] fn smoke() {}`, `@Test func smoke() {}`, `@main struct MainApp {}`)
 * belongs to that code, so a function or type added below it is not marked by
 * that attribute. A `#[test]` on its own line still marks the function below it,
 * also when a `#[doc = "]"]` or `#[cfg_attr(...)]` line sits between them, and a
 * `@main` on its own line still marks the type below it.
 * Repo F, read through `runOrphans`: a closed block comment after the attributes
 * of a line does not end the line, so a `#[test]`, a comment, then `fn smoke2() {}`
 * on one line still has code after its attributes and ends the look-back. A raw string in an attribute
 * (`#[doc = r#"a "]" marker"#]`) holds its own quotes and brackets, so a
 * `#[test]` above it still marks the function below. A block comment inside an
 * attribute's argument list may hold a raw-string opener that is never closed on
 * the line; the attribute still closes and the code after it is read. Rust block
 * comments nest, so a `#[test]` followed by one nested comment still marks the
 * function below it.
 * Repo C (POSIX only), read through `runOrphans`: source reads stay inside the
 * project. src/out.swift is an indexed symlink to a file outside the root whose
 * `@Test func outsideFn` would exclude `outsideFn` as a test if orphans read it.
 * It must not. src/in.swift holds the same attribute inside the root, so
 * `insideSwiftFn` is excluded, which shows the rule read source in that run.
 * src/in.ts holds a `// @Test` comment above `insideFn`, a TypeScript function:
 * a comment is no attribute, and `@Test` is Swift's, so `insideFn` is orphaned.
 * A file symlink on Windows needs the symlink privilege (Developer Mode), so
 * repo C is built only off Windows; there this case is not tested. It is kept
 * out of repo A so the other suites still run on Windows.
 * Repo D, read through `runOrphans`: the only mention
 * of `lostOnly` is in m/gone.ts. With the file present, `lostOnly` is guessed
 * on that mention and `searchUnread` is 0; with it deleted after indexing (the
 * search cannot read it), `lostOnly` is orphaned and the report says the
 * search could not read one indexed file, in JSON and in text.
 * Repo B: 1500 added functions with 96-byte names, three of them named in a
 * comment in src/many-use.ts, run through `findOrphans` with an io that
 * records every pattern handed to the search: no pattern reaches Linux's
 * single-argument limit, and the result is what one search would give.
 * Then a search that never completes: `findOrphans` must refuse to call
 * anything orphaned rather than report a check it could not finish.
 * Hunk repo, read through `runOrphans`: C1 tagged, then C2 adds `lonelyNew` to
 * a file that already existed, so its changed lines are what make it added.
 * The `vi.mock` of `node:child_process` at the top of this file fails the hunk
 * pass alone (`git diff --unified=0`) while `failHunkPass.on` is set; the
 * statuses still come back. The run must fail on the changed lines, and the
 * control run with the mock off lists `lonelyNew`. A second repo, whose C2 only
 * adds a new file, must still run with the pass failing: an added file needs no
 * changed lines.
 *
 * The "fixture:" tests assert the index facts a case depends on first.
 *
 * Indexing takes most of the time here: a/big.ts's 10 002 lines and repo B's
 * 1500 functions are the smallest sizes that cross the mention search's
 * 10 000-hit cap and the 128 KiB argument limit.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { changedFiles } from '../src/graph/git-diff';
import { grepIndex } from '../src/search/grep';
import {
  MENTION_PATTERN_BYTES, findOrphans, mentionBatches, mentionPattern, type OrphansIO, type OrphansReport,
} from '../src/graph/orphans';
import { runOrphans, type OrphansArgs } from '../src/graph/orphans-run';
import { openOrphansStore } from '../src/graph/orphans-store';

// The hunk pass is the one `git diff --unified=0` call. While `failHunkPass.on` is set, that call fails the
// way an output over the buffer limit does (ENOBUFS, no status); every other call passes through to git.
const failHunkPass = vi.hoisted(() => ({ on: false, hits: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = ((...call: Parameters<typeof actual.spawnSync>) => {
    const args = call[1];
    if (failHunkPass.on && args?.includes('--unified=0')) {
      failHunkPass.hits++;
      const error = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
      return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error };
    }
    return (actual.spawnSync as (...a: Parameters<typeof actual.spawnSync>) => unknown)(...call);
  }) as typeof actual.spawnSync;
  return { ...actual, spawnSync };
});

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

/** A repo with `c1` committed and tagged C1, then `c2` committed, indexed at C2. */
async function fixtureRepo(prefix: string, c1: Record<string, string>, c2: (root: string) => void): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(c1)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  c2(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
  return root;
}

interface NodeRow { id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number }
function nodesOf(root: string): NodeRow[] {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    return conn.getDb()
      .prepare("SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE kind NOT IN ('file','import','parameter')")
      .all() as unknown as NodeRow[];
  } finally {
    conn.close();
  }
}

/** The project's text-mention search as `runOrphans` wires it, recording every pattern. */
function recordingIO(root: string, patterns: string[], search?: OrphansIO['search']): OrphansIO {
  return {
    preImage: () => null,
    source: (rel) => {
      try {
        return fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    search: search ?? (async (pattern, maxHits) => {
      patterns.push(pattern);
      const r = await grepIndex(root, pattern, { maxHits });
      return {
        hits: r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text }))),
        truncated: r.truncated.hits > 0,
        unread: r.truncated.files,
      };
    }),
  };
}

async function findIn(root: string, io: OrphansIO): Promise<OrphansReport> {
  const diff = changedFiles(root, 'C1');
  if (!diff) throw new Error('fixture: no diff');
  const store = openOrphansStore(root);
  try {
    return await findOrphans(store, diff.files, io);
  } finally {
    store.close();
  }
}

/** Own-span mentions of `bigOwn`: more than the mention search's 10 000-hit cap. */
const BIG_OWN_LINES = 10_000;

/** Swift: `@Test` in each comment form above a function, then one real `@Test` function. */
const MARKS_SWIFT =
  '// @Test\nfunc swiftLineComment() {}\n\n' +
  '/// @Test\nfunc swiftDocComment() {}\n\n' +
  '/* @Test */\nfunc swiftBlockComment() {}\n\n' +
  '/**\n * @Test\n */\nfunc swiftStarComment() {}\n\n' +
  '@Test func swiftRealTest() {}\n';
/** Rust: `#[test]` in a line and a doc comment above a function, then a real `#[tokio::test]` one. */
const COMMENTED_RS =
  '// #[test]\nfn rust_line_commented() {}\n\n' +
  '/// #[test]\nfn rust_doc_commented() {}\n\n' +
  '#[tokio::test]\nasync fn rust_real_tokio() {}\n';
/** Python: a `#[test]` line (a Python comment) and `@Test` / `@main` decorators, none of them Rust's or Swift's. */
const PY_MARKS =
  '#[test]\ndef py_rust_mark():\n    pass\n\n\n' +
  '@Test\ndef py_test_decorator():\n    pass\n\n\n' +
  '@main\nclass PyMain:\n    pass\n';
/** Repo A's symbols a comment or another language's attribute must not exclude, by file. */
const UNMARKED: readonly (readonly [string, string])[] = [
  ['swiftLineComment', 'Sources/Marks/Marks.swift'],
  ['swiftDocComment', 'Sources/Marks/Marks.swift'],
  ['swiftBlockComment', 'Sources/Marks/Marks.swift'],
  ['swiftStarComment', 'Sources/Marks/Marks.swift'],
  ['rust_line_commented', 'src/commented.rs'],
  ['rust_doc_commented', 'src/commented.rs'],
  ['py_rust_mark', 'src/py_marks.py'],
  ['py_test_decorator', 'src/py_marks.py'],
  ['PyMain', 'src/py_marks.py'],
];

interface Mention { path: string; line: number }
interface Entry { id: string; name: string; kind: string; path: string; span: string }
interface Guessed extends Entry { mentions: Mention[]; mentionCount: number }
interface OrphansJson {
  added: number;
  orphans: Entry[];
  guessed: Guessed[];
  excluded: { test: number; implementation: number; constructor: number; entry: number };
  searchUnread: number;
}

let rootA = '';
let nodesA: NodeRow[] = [];
let reportA: OrphansJson;

let rootB = '';
const MANY = 1500;
/** Repo B's names: 96 bytes each, so 1500 of them make a pattern over 128 KiB. */
const manyName = (i: number): string => `m${'x'.repeat(91)}${String(i).padStart(4, '0')}`;
const MENTIONED = [0, 750, MANY - 1];

beforeAll(async () => {
  rootA = await fixtureRepo('cg-orphans-complete-a-', {
    'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
  }, (root) => {
    write(root, 'a/big.ts', `export function bigOwn(): number {\n${'  // bigOwn\n'.repeat(BIG_OWN_LINES)}  return 1;\n}\n`);
    write(root, 'z/use.ts', '// bigOwn is loaded by name at runtime\nexport const USE = 1;\n');
    write(root, 'src/rawmod.rs',
      '#[cfg(test)]\nmod checks {\n    const DATA: &str = r#"\n}\n"#;\n    fn nested_helper() {}\n}\n');
    write(root, 'src/fakemod.rs', '/*\n#[cfg(test)]\nmod fake {\n*/\npub fn live_lonely() -> u32 {\n    1\n}\n');
    write(root, 'Sources/Marks/Marks.swift', MARKS_SWIFT);
    write(root, 'src/commented.rs', COMMENTED_RS);
    write(root, 'src/py_marks.py', PY_MARKS);
  });
  nodesA = nodesOf(rootA);
  reportA = JSON.parse(await output(rootA, { base: 'C1', format: 'json' })) as OrphansJson;

  rootB = await fixtureRepo('cg-orphans-complete-b-', {
    'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
  }, (root) => {
    const fns = Array.from({ length: MANY }, (_, i) => `export function ${manyName(i)}(): number {\n  return ${i};\n}\n`);
    write(root, 'src/many.ts', fns.join(''));
    write(root, 'src/many-use.ts', `${MENTIONED.map((i) => `// ${manyName(i)} is registered by name`).join('\n')}\nexport const U = 1;\n`);
  });
}, 60_000);

afterAll(() => {
  for (const d of [rootA, rootB]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const listedNames = (r: OrphansJson | OrphansReport): string[] => [...r.orphans, ...r.guessed].map((e) => e.name);

describe('orphans mention search: a capped run does not end the check', () => {
  it('fixture: bigOwn spans its own mentions; z/use.ts names it outside', () => {
    const big = nodesA.find((n) => n.name === 'bigOwn');
    expect(big).toMatchObject({ file_path: 'a/big.ts', start_line: 1 });
    expect(big!.end_line).toBeGreaterThanOrEqual(BIG_OWN_LINES + 2);
  });

  it('bigOwn, named once outside its own span, is guessed with that mention, not orphaned', () => {
    expect(reportA.orphans.map((o) => o.name)).not.toContain('bigOwn');
    const g = reportA.guessed.find((e) => e.name === 'bigOwn');
    expect(g?.mentions).toEqual([{ path: 'z/use.ts', line: 1 }]);
  });

  it('a search that never completes is refused, not reported as orphaned', async () => {
    const io = recordingIO(rootA, [], async () => ({ hits: [], truncated: true, unread: 0 }));
    await expect(findIn(rootA, io)).rejects.toThrow(/mention/i);
  });
});

describe('orphans nested-in-test rule reads Rust with the parser', () => {
  it('fixture: nested_helper and live_lonely are Rust function nodes', () => {
    expect(nodesA.find((n) => n.name === 'nested_helper')).toMatchObject({ file_path: 'src/rawmod.rs', kind: 'function' });
    expect(nodesA.find((n) => n.name === 'live_lonely')).toMatchObject({ file_path: 'src/fakemod.rs', kind: 'function' });
  });

  it('a fn after a raw string holding `}` in a #[cfg(test)] mod is still excluded', () => {
    expect(listedNames(reportA)).not.toContain('nested_helper');
  });

  it('a #[cfg(test)] mod that is only text in a block comment excludes nothing', () => {
    expect(reportA.orphans.find((o) => o.name === 'live_lonely')).toMatchObject({ path: 'src/fakemod.rs', kind: 'function' });
  });
});

describe('orphans attribute checks are language-gated, and a comment is never an attribute', () => {
  it('fixture: every marked symbol is a node of its file', () => {
    for (const [name, file] of [...UNMARKED, ['swiftRealTest', 'Sources/Marks/Marks.swift'], ['rust_real_tokio', 'src/commented.rs']]) {
      expect(nodesA.find((n) => n.name === name), name).toMatchObject({ file_path: file });
    }
  });

  it('a @Test in a //, ///, /* */ or * comment line above a Swift function excludes nothing: each is orphaned', () => {
    const orphaned = reportA.orphans.map((o) => o.name);
    for (const name of ['swiftLineComment', 'swiftDocComment', 'swiftBlockComment', 'swiftStarComment']) {
      expect(orphaned, name).toContain(name);
    }
  });

  it('a #[test] in a // or /// comment line above a Rust function excludes nothing: each is orphaned', () => {
    const orphaned = reportA.orphans.map((o) => o.name);
    for (const name of ['rust_line_commented', 'rust_doc_commented']) expect(orphaned, name).toContain(name);
  });

  it('in a Python file a #[test] line and @Test / @main decorators exclude nothing: each is orphaned', () => {
    const orphaned = reportA.orphans.map((o) => o.name);
    for (const name of ['py_rust_mark', 'py_test_decorator', 'PyMain']) expect(orphaned, name).toContain(name);
  });

  it('a real Swift @Test function and a real Rust #[tokio::test] function are still excluded', () => {
    expect(listedNames(reportA)).not.toContain('swiftRealTest');
    expect(listedNames(reportA)).not.toContain('rust_real_tokio');
  });
});

// The look-back above a symbol passes over attribute and comment lines. An
// attribute line that also holds code (`#[test] fn smoke() {}`) belongs to that
// code: the walk stops there, and the declaration below it is not marked by that
// attribute. Repo E's C2 appends one declaration to each file that C1 commits.
describe('orphans attribute look-back ends at a line that carries code after its attributes', () => {
  let rootE = '';
  let nodesE: NodeRow[] = [];
  let reportE: OrphansJson;

  beforeAll(async () => {
    rootE = await fixtureRepo('cg-orphans-complete-e-', {
      'Cargo.toml': '[package]\nname = "attrs"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn used() -> i32 { 1 }\n\n#[test] fn smoke() {}\n',
      'src/own_line.rs': 'pub fn anchor_own() -> i32 { 2 }\n',
      'src/bracket.rs': 'pub fn anchor_bracket() -> i32 { 3 }\n',
      'src/cfg_attr.rs': 'pub fn anchor_cfg() -> i32 { 4 }\n',
      'Sources/Feature/Feature.swift': 'func anchorSwift() -> Int { 1 }\n\n@Test func smoke() {}\n',
      'Sources/App/App.swift': '@main struct MainApp {}\n',
      'Sources/App/Own.swift': 'struct Anchor {}\n',
    }, (root) => {
      const append = (rel: string, text: string): void => fs.appendFileSync(path.join(root, rel), text);
      append('src/lib.rs', 'fn never_called_xyz() {}\n');
      append('src/own_line.rs', '\n#[test]\nfn own_line_test() {}\n');
      append('src/bracket.rs', '\n#[test]\n#[doc = "]"]\nfn doc_bracket_test() {}\n');
      append('src/cfg_attr.rs', '\n#[test]\n#[cfg_attr(test, allow(dead_code))]\nfn cfg_attr_test() {}\n');
      append('Sources/Feature/Feature.swift', 'func neverCalled() {}\n');
      append('Sources/App/App.swift', 'struct NotMain {}\n');
      append('Sources/App/Own.swift', '@main\nstruct OwnLineMain {}\n');
    });
    nodesE = nodesOf(rootE);
    reportE = JSON.parse(await output(rootE, { base: 'C1', format: 'json' })) as OrphansJson;
  }, 60_000);

  afterAll(() => {
    if (rootE) fs.rmSync(rootE, { recursive: true, force: true });
  });

  it('fixture: each added function and type is a node of its file, with the kind the rules read', () => {
    expect(nodesE.find((n) => n.name === 'never_called_xyz')).toMatchObject({ file_path: 'src/lib.rs', kind: 'function' });
    expect(nodesE.find((n) => n.name === 'own_line_test')).toMatchObject({ file_path: 'src/own_line.rs', kind: 'function' });
    expect(nodesE.find((n) => n.name === 'doc_bracket_test')).toMatchObject({ file_path: 'src/bracket.rs', kind: 'function' });
    expect(nodesE.find((n) => n.name === 'cfg_attr_test')).toMatchObject({ file_path: 'src/cfg_attr.rs', kind: 'function' });
    expect(nodesE.find((n) => n.name === 'neverCalled')).toMatchObject({ file_path: 'Sources/Feature/Feature.swift', kind: 'function' });
    expect(nodesE.find((n) => n.name === 'NotMain')).toMatchObject({ file_path: 'Sources/App/App.swift', kind: 'struct' });
    expect(nodesE.find((n) => n.name === 'OwnLineMain')).toMatchObject({ file_path: 'Sources/App/Own.swift', kind: 'struct' });
  });

  it('a Rust function added below a line `#[test] fn smoke() {}` is listed as an orphan, not excluded as a test', () => {
    expect(reportE.orphans.map((o) => o.name)).toContain('never_called_xyz');
  });

  it('a Swift function added below a line `@Test func smoke() {}` is listed as an orphan, not excluded as a test', () => {
    expect(reportE.orphans.map((o) => o.name)).toContain('neverCalled');
  });

  it('a struct added below a line `@main struct MainApp {}` is not an entry point: it is listed as an orphan', () => {
    expect(reportE.orphans.map((o) => o.name)).toContain('NotMain');
  });

  it('exactly three functions are excluded as tests: the ones under their own test attribute lines', () => {
    expect(reportE.excluded.test).toBe(3);
  });

  it('a `#[test]` on its own line still excludes the function below it', () => {
    expect(listedNames(reportE)).not.toContain('own_line_test');
  });

  it('a `#[test]` still excludes the function below an attribute line that holds `]` in a string', () => {
    expect(listedNames(reportE)).not.toContain('doc_bracket_test');
  });

  it('a `#[test]` still excludes the function below a `#[cfg_attr(...)]` line', () => {
    expect(listedNames(reportE)).not.toContain('cfg_attr_test');
  });

  it('a `@main` on its own line still makes the struct below it an entry point', () => {
    expect(listedNames(reportE)).not.toContain('OwnLineMain');
  });
});

// Repo F: the look-back reads an attribute line past a block comment and a raw string. The first declaration
// line holds `#[test] /* explanation */ fn smoke2() {}`, so the code after the comment ends the walk. The second
// holds a raw string whose inner quote and `]` do not end its attribute, so the `#[test]` above it is still read.
describe('orphans attribute look-back reads past a block comment and a raw string on an attribute line', () => {
  let rootF = '';
  let nodesF: NodeRow[] = [];
  let reportF: OrphansJson;

  beforeAll(async () => {
    rootF = await fixtureRepo('cg-orphans-complete-f-', {
      'Cargo.toml': '[package]\nname = "attrs-raw"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn used() -> i32 { 1 }\n\n#[test] /* explanation */ fn smoke2() {}\n',
      'src/raw.rs': 'pub fn anchor_raw() -> i32 { 2 }\n',
      'src/comment_attr.rs': 'pub fn anchor_comment() -> i32 { 5 }\n\n#[test] #[allow(dead_code /* r#"example" */)] fn smoke3() {}\n',
      'src/nested.rs': 'pub fn anchor_nested() -> i32 { 6 }\n',
    }, (root) => {
      const append = (rel: string, text: string): void => fs.appendFileSync(path.join(root, rel), text);
      append('src/lib.rs', 'fn never_called_block() {}\n');
      append('src/raw.rs', '\n#[test]\n#[doc = r#"a "]" marker"#]\nfn raw_doc_test() {}\n');
      append('src/comment_attr.rs', 'fn never_called_c() {}\n');
      append('src/nested.rs', '\n#[test] /* outer /* inner */ outer */\nfn smoke4() {}\n');
    });
    nodesF = nodesOf(rootF);
    reportF = JSON.parse(await output(rootF, { base: 'C1', format: 'json' })) as OrphansJson;
  }, 60_000);

  afterAll(() => {
    if (rootF) fs.rmSync(rootF, { recursive: true, force: true });
  });

  it('fixture: never_called_block and raw_doc_test are Rust function nodes of their files', () => {
    expect(nodesF.find((n) => n.name === 'never_called_block')).toMatchObject({ file_path: 'src/lib.rs', kind: 'function' });
    expect(nodesF.find((n) => n.name === 'raw_doc_test')).toMatchObject({ file_path: 'src/raw.rs', kind: 'function' });
  });

  it('a Rust function added below `#[test] /* explanation */ fn smoke2() {}` is listed as an orphan, not excluded as a test', () => {
    expect(reportF.orphans.map((o) => o.name)).toContain('never_called_block');
  });

  it('a `#[test]` still excludes the function below a `#[doc = r#"a "]" marker"#]` line that sits under it', () => {
    expect(listedNames(reportF)).not.toContain('raw_doc_test');
  });

  it('fixture: never_called_c and smoke4 are Rust function nodes of their files', () => {
    expect(nodesF.find((n) => n.name === 'never_called_c')).toMatchObject({ file_path: 'src/comment_attr.rs', kind: 'function' });
    expect(nodesF.find((n) => n.name === 'smoke4')).toMatchObject({ file_path: 'src/nested.rs', kind: 'function' });
  });

  it('a Rust function added below `#[test] #[allow(dead_code /* r#"example" */)] fn smoke3() {}` is listed as an orphan, not excluded as a test', () => {
    expect(reportF.orphans.map((o) => o.name)).toContain('never_called_c');
  });

  it('a `#[test]` on a line with a nested block comment still excludes the function below it', () => {
    expect(listedNames(reportF)).not.toContain('smoke4');
  });
});

// POSIX only: the fixture's file symlink needs the symlink privilege on Windows (see the header).
describe.runIf(process.platform !== 'win32')('orphans source reads stay inside the project', () => {
  let rootC = '';
  let outside = '';
  let nodesC: NodeRow[] = [];
  let reportC: OrphansJson;

  beforeAll(async () => {
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-outside-')));
    fs.writeFileSync(path.join(outside, 'out.swift'), '@Test func outsideFn() {}\n');
    rootC = await fixtureRepo('cg-orphans-complete-c-', {
      'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
    }, (root) => {
      write(root, 'src/in.swift', '@Test func insideSwiftFn() {}\n');
      write(root, 'src/in.ts', '// @Test\nexport function insideFn(): number {\n  return 2;\n}\n');
      fs.symlinkSync(path.join(outside, 'out.swift'), path.join(root, 'src', 'out.swift'));
    });
    nodesC = nodesOf(rootC);
    reportC = JSON.parse(await output(rootC, { base: 'C1', format: 'json' })) as OrphansJson;
  }, 60_000);

  afterAll(() => {
    for (const d of [rootC, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fixture: src/out.swift is a symlink out of the root, and outsideFn is indexed from it; insideSwiftFn from src/in.swift, insideFn from src/in.ts', () => {
    expect(fs.lstatSync(path.join(rootC, 'src', 'out.swift')).isSymbolicLink()).toBe(true);
    expect(nodesC.find((n) => n.name === 'outsideFn')).toMatchObject({ file_path: 'src/out.swift' });
    expect(nodesC.find((n) => n.name === 'insideSwiftFn')).toMatchObject({ file_path: 'src/in.swift' });
    expect(nodesC.find((n) => n.name === 'insideFn')).toMatchObject({ file_path: 'src/in.ts' });
  });

  it('the @Test only the out-of-root file holds is never read: outsideFn is not excluded as a test', () => {
    expect(reportC.excluded.test).toBe(1); // insideSwiftFn alone: the same attribute inside the root is read
    expect(listedNames(reportC)).not.toContain('insideSwiftFn');
    expect(listedNames(reportC)).toContain('outsideFn');
  });

  it('a `// @Test` comment above a TypeScript function is no test attribute: insideFn is orphaned', () => {
    expect(reportC.orphans.map((o) => o.name)).toContain('insideFn');
  });
});

describe('orphans says when the text search could not read an indexed file', () => {
  let rootD = '';
  const WARNING = 'text search could not read 1 indexed file(s); a mention there would be missed';
  let before: { json: OrphansJson; text: string };
  let after: { json: OrphansJson; text: string };

  async function both(root: string): Promise<{ json: OrphansJson; text: string }> {
    const json = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
    return { json, text: await output(root, { base: 'C1', format: 'text' }) };
  }

  beforeAll(async () => {
    rootD = await fixtureRepo('cg-orphans-complete-d-', {
      'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
    }, (root) => {
      write(root, 'src/lost.ts', 'export function lostOnly(): number {\n  return 3;\n}\n');
      write(root, 'm/gone.ts', '// lostOnly is wired by name at runtime\nexport const GONE = 1;\n');
    });
    before = await both(rootD);
    // Deleted after indexing: the index still lists m/gone.ts, and the search cannot read it.
    fs.rmSync(path.join(rootD, 'm', 'gone.ts'));
    after = await both(rootD);
  }, 60_000);

  afterAll(() => {
    if (rootD) fs.rmSync(rootD, { recursive: true, force: true });
  });

  it('fixture: with m/gone.ts present, lostOnly is guessed on its one mention there and nothing is unread', () => {
    expect(before.json.guessed.find((g) => g.name === 'lostOnly')?.mentions).toEqual([{ path: 'm/gone.ts', line: 1 }]);
    expect(before.json.searchUnread).toBe(0);
    expect(before.text).not.toContain('text search could not read');
  });

  it('with m/gone.ts deleted, lostOnly is orphaned and the JSON counts the unread file', () => {
    expect(after.json.orphans.map((o) => o.name)).toContain('lostOnly');
    expect(after.json.searchUnread).toBe(1);
  });

  it('the text report says so on the line right after the orphaned section', () => {
    const lines = after.text.split('\n');
    const head = lines.findIndex((l) => l.startsWith('orphaned ('));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(lines[head + 1 + after.json.orphans.length]).toBe(WARNING);
  });
});

describe('orphans mention search: patterns stay under the single-argument limit', () => {
  /** Linux's MAX_ARG_STRLEN: one argv string, its NUL included, is at most 32 pages (128 KiB). */
  const LINUX_MAX_ARG_STRLEN = 128 * 1024;
  let patterns: string[] = [];
  let report: OrphansReport;

  beforeAll(async () => {
    patterns = [];
    report = await findIn(rootB, recordingIO(rootB, patterns));
  }, 60_000);

  it('fixture: the names together are longer than one argument may be', () => {
    expect(Array.from({ length: MANY }, (_, i) => manyName(i)).join('|').length).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
  });

  it('every pattern handed to the search fits in one argument', () => {
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(Buffer.byteLength(p) + 1).toBeLessThanOrEqual(LINUX_MAX_ARG_STRLEN);
  });

  it('mentionBatches keeps every name, in order, each batch within the byte bound; an oversize name stands alone', () => {
    const names = ['a', 'b$c', 'ü'.repeat(30), 'x'.repeat(200), 'd', 'e'];
    const bound = Buffer.byteLength(mentionPattern(['x'.repeat(40)])) + 1;
    const batches = mentionBatches(names, bound);
    expect(batches.flat()).toEqual(names);
    for (const b of batches) {
      expect(b.length).toBeGreaterThan(0);
      if (b.length > 1) expect(Buffer.byteLength(mentionPattern(b))).toBeLessThanOrEqual(bound);
    }
    expect(batches).toContainEqual(['x'.repeat(200)]);
    expect(mentionBatches(Array.from({ length: MANY }, (_, i) => manyName(i))).length).toBeGreaterThan(1);
    for (const b of mentionBatches(Array.from({ length: MANY }, (_, i) => manyName(i)))) {
      expect(Buffer.byteLength(mentionPattern(b))).toBeLessThanOrEqual(MENTION_PATTERN_BYTES);
    }
  });

  it('the batched searches give what one search would: the three mentioned names guessed, the rest orphaned', () => {
    const guessed = report.guessed.map((g) => g.name).sort();
    expect(guessed).toEqual(MENTIONED.map(manyName).sort());
    MENTIONED.forEach((i, k) => {
      expect(report.guessed.find((g) => g.name === manyName(i))?.mentions).toEqual([{ path: 'src/many-use.ts', line: k + 1 }]);
    });
    expect(report.orphans.length).toBe(MANY - MENTIONED.length);
  });
});

// The statuses of the diff succeed and the hunk pass fails: the run must fail and say the changed lines are unknown,
// not return an empty success in which no added symbol was checked.
describe('orphans when git cannot read the changed lines of the diff', () => {
  let root = '';

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-hunks-', {
      'src/existing.ts': 'export function stable(): number {\n  return 1;\n}\n',
    }, (r) => {
      write(r, 'src/existing.ts',
        'export function stable(): number {\n  return 1;\n}\n\nexport function lonelyNew(): number {\n  return 5;\n}\n');
    });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    failHunkPass.on = false;
  });

  it('lists the added function when git reads the changed lines (control)', async () => {
    const json = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
    expect(json.orphans.map((o) => o.name)).toContain('lonelyNew');
  });

  it('fails rather than reporting nothing when git cannot read the changed lines', async () => {
    failHunkPass.on = true;
    failHunkPass.hits = 0;
    const r = await runOrphans(root, { base: 'C1', format: 'json' });
    expect(failHunkPass.hits).toBeGreaterThan(0);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed lines/) });
  });
});

// A file that is new needs no changed lines: all of its symbols are added. With the hunk pass failing, a diff
// whose only change is a new file runs normally and lists its unused function.
describe('orphans when git cannot read the changed lines of a diff that only adds a file', () => {
  let root = '';

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-hunks-new-', {
      'src/existing.ts': 'export function stable(): number {\n  return 1;\n}\n',
    }, (r) => {
      write(r, 'src/fresh.ts', 'export function lonelyFresh(): number {\n  return 5;\n}\n');
    });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    failHunkPass.on = false;
  });

  it('still lists the function of the new file', async () => {
    failHunkPass.on = true;
    failHunkPass.hits = 0;
    const r = await runOrphans(root, { base: 'C1', format: 'json' });
    expect(failHunkPass.hits).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((JSON.parse(r.output) as OrphansJson).orphans.map((o) => o.name)).toContain('lonelyFresh');
  });
});
