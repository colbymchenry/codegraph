/**
 * Exercise `codegraph orphans` against real fixture git repositories and SQLite indexes.
 * The Swift parser switch is the only mock. `findOrphans` receives the selected changed
 * files while searching all indexed files for mentions; `runOrphans` returns CLI output.
 * Fixture tests verify index facts; probes write tables to the OS temp directory and assert
 * nothing. Fixtures are built once per describe and removed in afterAll so they outlive tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Node as TsNode } from 'web-tree-sitter';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { changedFiles, type ChangedFile } from '../src/graph/git-diff';
import { grepIndex } from '../src/search/grep';
import { runOrphans as runOrphansPublished, type OrphansArgs } from '../src/graph/orphans-run';
import {
  findOrphans, type GuessedEntry, type OrphanEntry, type OrphansIO, type OrphansReport,
} from '../src/graph/orphans';
import { openOrphansStore } from '../src/graph/orphans-store';

/** Adapt the CLI result to an exit code and output (the message on failure). */
async function runOrphans(root: string, args: OrphansArgs): Promise<{ exitCode: number; output: string }> {
  const r = await runOrphansPublished(root, args);
  return r.ok ? { exitCode: 0, output: r.output } : { exitCode: 1, output: r.message };
}

/**
 * Flipped on by the requirements unavailable-parse case only: while it is up, `getParser('swift')` is null, so
 * the orphans check has no Swift parse. Off, the hook passes through.
 */
const grammarHooks = vi.hoisted(() => ({ swiftParserOff: false }));

vi.mock('../src/extraction/grammars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/extraction/grammars')>();
  return {
    ...actual,
    getParser: (language: Parameters<typeof actual.getParser>[0]) =>
      grammarHooks.swiftParserOff && language === 'swift' ? null : actual.getParser(language),
  };
});

/** The most evidence lines one guessed entry keeps per kind (the contract's EVIDENCE_KEPT; render's JSON cap is the same 20). */
const EVIDENCE_KEPT = 20;
/** How many same-named symbols or failed references the mention and unresolved fixtures hold. */
const MANY = 60;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// --- fixture plumbing -------------------------------------------------------------

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

/** `git show <spec>` (the pre-image the orphans check reads), or null when git cannot read it. */
function gitShowOrNull(root: string, spec: string): string | null {
  const res = spawnSync('git', ['show', spec], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
}

/** A repo with `c1` committed and tagged C1, then `c2` applied and committed, indexed at C2. */
async function fixtureRepo(prefix: string, c1: Record<string, string>, c2: (root: string) => void): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  git(root, 'init', '-q');
  writeAll(root, c1);
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

interface NodeRow {
  id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number; language: string; qualified_name: string;
}
interface EdgeRow { source: string; target: string; kind: string; line: number | null }
interface UnresolvedRow {
  from_node_id: string; reference_name: string; reference_kind: string; file_path: string; line: number; status: string; name_tail: string; language: string;
}
interface IndexRows { nodes: NodeRow[]; edges: EdgeRow[]; unresolved: UnresolvedRow[] }

/** The index's symbols, edges and unresolved references, read once per fixture. */
function indexRows(root: string): IndexRows {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    return {
      nodes: db.prepare(
        "SELECT id, name, kind, file_path, start_line, end_line, language, qualified_name FROM nodes WHERE kind NOT IN ('file','import','parameter')",
      ).all() as unknown as NodeRow[],
      edges: db.prepare('SELECT source, target, kind, line FROM edges').all() as unknown as EdgeRow[],
      unresolved: db.prepare(
        'SELECT from_node_id, reference_name, reference_kind, file_path, line, status, name_tail, language FROM unresolved_refs',
      ).all() as unknown as UnresolvedRow[],
    };
  } finally {
    conn.close();
  }
}

const byName = (ix: IndexRows, name: string, file?: string): NodeRow[] =>
  ix.nodes.filter((n) => n.name === name && (file === undefined || n.file_path === file));
const incomingUses = (ix: IndexRows, id: string): EdgeRow[] =>
  ix.edges.filter((e) => e.target === id && e.kind !== 'contains' && e.kind !== 'exports');
const failedNamed = (ix: IndexRows, tail: string): UnresolvedRow[] =>
  ix.unresolved.filter((u) => u.status === 'failed' && u.name_tail === tail);

/**
 * The text-mention search as runOrphans wires it (grep-by-symbol's grepIndex over the indexed files).
 * `source` returns null for a path in `unreadable`, so a case can make a file's current text unreadable
 * to the orphans check while the file stays in the diff.
 */
function ioFor(root: string, unreadable: ReadonlySet<string> = new Set()): OrphansIO {
  return {
    preImage: (file: ChangedFile) => gitShowOrNull(root, `C1:./${file.oldPath ?? file.path}`),
    source: (rel) => {
      if (unreadable.has(rel)) return null;
      try {
        return fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    search: async (pattern, maxHits) => {
      const r = await grepIndex(root, pattern, { maxHits });
      return {
        hits: r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text }))),
        truncated: r.truncated.hits > 0,
        unread: r.truncated.files,
      };
    },
  };
}

/** What one findOrphans call returned, or the message it threw for the test to assert against. */
interface Outcome { report: OrphansReport | null; error: string | null }

/**
 * findOrphans over the C1...HEAD files of `root` that `only` admits (all of them by default), or over
 * `files` when given (a synthetic ChangedFile, for the failed-patch-pass case). `unreadable` names the
 * paths whose current text the check cannot read (see ioFor).
 */
async function orphansOf(
  root: string,
  only: (p: string) => boolean = () => true,
  files?: ChangedFile[],
  unreadable: readonly string[] = [],
): Promise<Outcome> {
  const diff = changedFiles(root, 'C1');
  if (!diff) throw new Error('fixture: no diff against C1');
  const chosen = files ?? diff.files.filter((f) => only(f.path));
  const store = openOrphansStore(root);
  try {
    return { report: await findOrphans(store, chosen, ioFor(root, new Set(unreadable))), error: null };
  } catch (err) {
    return { report: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  } finally {
    store.close();
  }
}

/** The case's report; fails the test with the thrown message when findOrphans threw. */
function reportOf(o: Outcome): OrphansReport {
  expect(o.error, 'findOrphans threw').toBeNull();
  return o.report as OrphansReport;
}
const listed = (r: OrphansReport): OrphanEntry[] => [...r.orphans, ...r.guessed];
/** `path:name` of every listed symbol, orphaned or guessed. */
const keysOf = (r: OrphansReport): string[] => listed(r).map((e) => `${e.path}:${e.name}`);
const guessedRuns = (o: Outcome, name: string): GuessedEntry[] => reportOf(o).guessed.filter((e) => e.name === name);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// =====================================================================================
// mention evidence: MANY same-named methods that nothing calls.
// =====================================================================================

const M_C1 = { 'src/base.ts': 'export const base = 0;\n' };
const M_MANY = `${Array.from({ length: MANY }, (_, i) => `class C${i + 1} { run() {} }`).join('\n')}\n`;

describe('mention evidence: 60 same-named methods that nothing calls', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let text = { exitCode: -1, output: '' };
  let json = { exitCode: -1, output: '' };

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-mentions-', M_C1, (r) => write(r, 'src/many.ts', M_MANY));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === 'src/many.ts');
    text = await runOrphans(root, { base: 'C1', format: 'text' });
    json = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  it('60 run methods in src/many.ts, none with an incoming use', () => {
    const runs = byName(ix, 'run', 'src/many.ts');
    expect(runs).toHaveLength(MANY);
    expect(runs.filter((n) => incomingUses(ix, n.id).length > 0)).toEqual([]);
  });

  it('a guessed run entry keeps at most 20 mention lines', () => {
    const runs = guessedRuns(outcome, 'run');
    expect(runs).toHaveLength(MANY);
    expect(Math.max(...runs.map((e) => e.mentions.length))).toBeLessThanOrEqual(EVIDENCE_KEPT);
  });

  it('the mention lines kept across all run entries stay within 60 x 20', () => {
    const kept = guessedRuns(outcome, 'run').reduce((sum, e) => sum + e.mentions.length, 0);
    expect(kept).toBeLessThanOrEqual(MANY * EVIDENCE_KEPT);
  });

  it('mentionCount keeps the full count, the 59 other lines, for every run entry', () => {
    expect(guessedRuns(outcome, 'run').map((e) => e.mentionCount)).toEqual(Array(MANY).fill(MANY - 1));
  });

  it('a run entry keeps its mention lines in path then line order', () => {
    const e = guessedRuns(outcome, 'run').find((x) => x.span === 'L5-L5');
    expect(e).toBeDefined();
    const at = e!.mentions.map((m) => m.line);
    expect(e!.mentions.every((m) => m.path === 'src/many.ts')).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('the text report prints 3 mention lines, then "+56 more", for a run entry', () => {
    expect(text.exitCode).toBe(0);
    const lines = text.output.split('\n');
    const at = lines.findIndex((l) => /^  src\/many\.ts:5-5  \w+  run$/.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    const ev = lines.slice(at + 1, at + 5);
    expect(ev[0]).toMatch(/^\s+mention\s+src\/many\.ts:1$/);
    expect(ev[1]).toMatch(/^\s+mention\s+src\/many\.ts:2$/);
    expect(ev[2]).toMatch(/^\s+mention\s+src\/many\.ts:3$/);
    expect(ev[3]).toMatch(/^\s+mention\s+\+56 more$/);
  });

  it('the JSON report keeps 20 mention lines and the full count of 59 for a run entry', () => {
    expect(json.exitCode).toBe(0);
    const r = JSON.parse(json.output) as { guessed: GuessedEntry[] };
    const e = r.guessed.find((x) => x.name === 'run' && x.span === 'L5-L5');
    expect(e?.mentions).toHaveLength(EVIDENCE_KEPT);
    expect(e?.mentionCount).toBe(MANY - 1);
  });
});

// =====================================================================================
// unresolved evidence: MANY failed Rust references to one name, in another file.
// =====================================================================================

const U_C1 = {
  'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
  'a/Cargo.toml': '[package]\nname = "a_crate"\nversion = "0.1.0"\nedition = "2021"\n',
  'a/src/lib.rs': 'pub fn existing_a() -> u32 {\n    1\n}\n',
  'b/Cargo.toml': '[package]\nname = "b_crate"\nversion = "0.1.0"\nedition = "2021"\n',
};
/** `other_crate` is named by no crate, so each call stays a FAILED reference (the same shape the evidence suite pins). */
const U_C2 = {
  'a/src/cross.rs': 'pub fn cross_target() -> u32 {\n    2\n}\n',
  'b/src/many.rs': Array.from(
    { length: MANY },
    (_, i) => `pub fn drive_${i + 1}() -> u32 {\n    other_crate::cross_target()\n}\n`,
  ).join('\n'),
};

describe('unresolved evidence: 60 failed references to one name, in another file', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let text = { exitCode: -1, output: '' };
  let json = { exitCode: -1, output: '' };

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-unresolved-', U_C1, (r) => writeAll(r, U_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
    text = await runOrphans(root, { base: 'C1', format: 'text' });
    json = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  const cross = (o: Outcome): GuessedEntry | undefined => reportOf(o).guessed.find((e) => e.name === 'cross_target');

  it('cross_target has 60 failed references, one from each drive_k in b/src/many.rs, and no incoming edge', () => {
    const c = byName(ix, 'cross_target', 'a/src/cross.rs');
    expect(c).toHaveLength(1);
    expect(incomingUses(ix, c[0]!.id)).toEqual([]);
    const rows = failedNamed(ix, 'cross_target');
    expect(rows).toHaveLength(MANY);
    expect(rows.every((u) => u.file_path === 'b/src/many.rs')).toBe(true);
  });

  it('a guessed cross_target keeps at most 20 unresolved references', () => {
    const g = cross(outcome);
    expect(g).toBeDefined();
    expect(g!.unresolved.length).toBeLessThanOrEqual(EVIDENCE_KEPT);
  });

  it('unresolvedCount keeps the full count of 60', () => {
    expect(cross(outcome)?.unresolvedCount).toBe(MANY);
  });

  it('the kept unresolved references are the first 20 by path then line', () => {
    const all = failedNamed(ix, 'cross_target')
      .map((u): [string, number] => [u.file_path, u.line])
      .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
    const g = cross(outcome);
    expect(g?.unresolved.map((u): [string, number] => [u.path, u.line])).toEqual(all.slice(0, EVIDENCE_KEPT));
  });

  it('the text report prints 3 unresolved lines, then "+57 more", for cross_target', () => {
    expect(text.exitCode).toBe(0);
    const lines = text.output.split('\n');
    const at = lines.findIndex((l) => /^  a\/src\/cross\.rs:1-3  \w+  cross_target$/.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    const ev = lines.slice(at + 1, at + 5);
    for (const l of ev.slice(0, 3)) {
      expect(l).toMatch(/^\s+unresolved\s+← calls other_crate::cross_target\s+b\/src\/many\.rs:\d+$/);
    }
    expect(ev[3]).toMatch(/^\s+unresolved\s+\+57 more$/);
  });

  it('the JSON report keeps 20 unresolved references and the full count of 60', () => {
    expect(json.exitCode).toBe(0);
    const r = JSON.parse(json.output) as { guessed: GuessedEntry[] };
    const e = r.guessed.find((x) => x.name === 'cross_target');
    expect(e?.unresolved).toHaveLength(EVIDENCE_KEPT);
    expect(e?.unresolvedCount).toBe(MANY);
  });
});

// =====================================================================================
// Rust and Swift: test attributes, multi-line attributes, cfg(test) modules, entry points and requirements.
// One fixture repo; every changed file is read in one findOrphans run.
// =====================================================================================

const R_C1 = {
  'Cargo.toml': '[package]\nname = "attrs"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn existing() -> u32 {\n    1\n}\n',
  'Sources/Attrs/Seed.swift': 'func seedSwift() -> Int {\n    return 1\n}\n',
};

const R_C2: Record<string, string> = {
  // attributes: read from the parse tree, not from the text of the line.
  // a_one_liner has #[test] on the same line; b_after_oneliner is on the next line.
  'src/attrs.rs': [
    'pub fn production() { let message = "#[test]"; }',
    '',
    'pub fn trailing() {} // #[test]',
    '',
    '#[test] fn a_one_liner() {}',
    'fn b_after_oneliner() {}',
    '',
    '#[test]',
    'fn t1() {}',
    '',
    '#[tokio::test]',
    'async fn t2() {}',
    '',
    '#[rstest]',
    'fn t3() {}',
    '',
    '// #[test]',
    'fn commented_line_only() {}',
    '',
    '/// #[test]',
    'fn commented_doc_only() {}',
    '',
  ].join('\n'),
  // multiline attributes: a multi-line attribute.
  'src/multiline.rs': '#[tokio::test(\n    flavor = "multi_thread"\n)]\nasync fn smoke() {}\n',
  // test configuration: #[cfg(test ...)] with a comment inside its argument list, and the plain form.
  'src/cfg.rs': [
    '#[cfg(test /* unit tests */)]',
    'mod checks {',
    '    fn helper() {}',
    '}',
    '',
    '#[cfg(/* c */ test)]',
    'mod checks2 {',
    '    fn helper2() {}',
    '}',
    '',
    '#[cfg(test)]',
    'mod plain {',
    '    fn plain_helper() {}',
    '}',
    '',
  ].join('\n'),
  // requirements: a Rust trait method and its impl.
  'src/speak.rs': 'pub trait Speak {\n    fn speak_now(&self);\n}\n\npub struct Mouth;\n\nimpl Speak for Mouth {\n    fn speak_now(&self) {}\n}\n',
  // attributes Swift: "@Test" inside a string, the real attribute, and comment forms.
  'Sources/Attrs/Marks.swift': [
    'func productionSwift() { print("@Test") }',
    '',
    '@Test func swiftTestReal() {}',
    '',
    '@Test',
    'func swiftTestSeparate() {}',
    '',
    '// @Test',
    'func swiftLineCommentMarks() {}',
    '',
  ].join('\n'),
  // requirements: a Swift @main type and its static main.
  'Sources/Attrs/App.swift': '@main struct App { static func main() {} }\n',
  // requirements: a Swift protocol requirement excludes the conforming method.
  'Sources/Attrs/Proto.swift': 'protocol Serving {\n    func serve()\n}\n\nstruct Server: Serving {\n    func serve() {}\n}\n',
  // requirements Swift: a protocol holding only a comment that names stop.
  'Sources/Attrs/Stop.swift': 'protocol Stopping {\n    // stop later\n}\n\nstruct Stopper: Stopping {\n    func stop() {}\n}\n',
};

/** The symbols the attribute fixture must index, so every verdict below is about a real node. */
const R_NODES: readonly (readonly [string, string])[] = [
  ['production', 'src/attrs.rs'], ['trailing', 'src/attrs.rs'], ['a_one_liner', 'src/attrs.rs'],
  ['b_after_oneliner', 'src/attrs.rs'], ['t1', 'src/attrs.rs'], ['t2', 'src/attrs.rs'], ['t3', 'src/attrs.rs'],
  ['commented_line_only', 'src/attrs.rs'], ['commented_doc_only', 'src/attrs.rs'], ['smoke', 'src/multiline.rs'],
  ['helper', 'src/cfg.rs'], ['helper2', 'src/cfg.rs'], ['plain_helper', 'src/cfg.rs'], ['speak_now', 'src/speak.rs'],
  ['productionSwift', 'Sources/Attrs/Marks.swift'], ['swiftTestReal', 'Sources/Attrs/Marks.swift'],
  ['swiftTestSeparate', 'Sources/Attrs/Marks.swift'], ['swiftLineCommentMarks', 'Sources/Attrs/Marks.swift'],
  ['App', 'Sources/Attrs/App.swift'], ['main', 'Sources/Attrs/App.swift'], ['serve', 'Sources/Attrs/Proto.swift'],
  ['Server', 'Sources/Attrs/Proto.swift'], ['stop', 'Sources/Attrs/Stop.swift'], ['Stopper', 'Sources/Attrs/Stop.swift'],
];

describe('Rust and Swift: test attributes, comments, cfg(test) modules and requirements', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-attrs-', R_C1, (r) => writeAll(r, R_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('attributes: every symbol of the attribute fixture is an indexed node in its file', () => {
    const missing = R_NODES.filter(([name, file]) => byName(ix, name, file).length === 0).map(([n, f]) => `${f}:${n}`);
    expect(missing).toEqual([]);
  });

  it('attributes: pub fn production, whose line holds "#[test]" in a string, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:production');
  });

  it('attributes: pub fn trailing, with a trailing "// #[test]" comment, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:trailing');
  });

  it('attributes: fn b_after_oneliner, on the line after a one-line #[test] fn, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:b_after_oneliner');
  });

  it('attributes: the one-line #[test] fn a_one_liner itself is excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/attrs.rs:a_one_liner');
  });

  it('attributes: func productionSwift, whose line holds "@Test" in a string, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Marks.swift:productionSwift');
  });

  it('attributes: a #[test] on its own line above a fn excludes it (t1)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/attrs.rs:t1');
  });

  it('attributes: #[tokio::test] and #[rstest] above a fn exclude it (t2, t3)', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).not.toContain('src/attrs.rs:t2');
    expect(keys).not.toContain('src/attrs.rs:t3');
  });

  it('attributes: a // #[test] line comment and a /// #[test] doc comment above a fn mark nothing', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).toContain('src/attrs.rs:commented_line_only');
    expect(keys).toContain('src/attrs.rs:commented_doc_only');
  });

  it('attributes: a Swift @Test func and a @Test on its own line above a func exclude it', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).not.toContain('Sources/Attrs/Marks.swift:swiftTestReal');
    expect(keys).not.toContain('Sources/Attrs/Marks.swift:swiftTestSeparate');
  });

  it('attributes: a Swift // @Test line comment above a func marks nothing', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Marks.swift:swiftLineCommentMarks');
  });

  it('multiline attributes: a multi-line #[tokio::test(...)] attribute still excludes smoke as a test', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/multiline.rs:smoke');
  });

  it('test configuration: a fn in #[cfg(test /* unit tests */)] mod checks is excluded as a test (helper)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:helper');
  });

  it('test configuration: a fn in #[cfg(/* c */ test)] mod checks2 is excluded as a test (helper2)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:helper2');
  });

  it('test configuration: a fn in a plain #[cfg(test)] mod is still excluded as a test (plain_helper)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:plain_helper');
  });

  it('requirements: a @main struct App and its static main are excluded as entry points', () => {
    const r = reportOf(outcome);
    const keys = keysOf(r);
    expect(keys).not.toContain('Sources/Attrs/App.swift:App');
    expect(keys).not.toContain('Sources/Attrs/App.swift:main');
    expect(r.excluded.entry).toBeGreaterThanOrEqual(2);
  });

  it('requirements: a Rust trait method and its impl (Speak.speak_now, Mouth.speak_now) are excluded as implementations', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/speak.rs:speak_now');
  });

  it('requirements: a Swift protocol requirement excludes the conforming struct\'s method (Server.serve)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Attrs/Proto.swift:serve');
  });

  it('requirements Swift: a protocol whose body is only a comment naming stop does not exclude the struct\'s stop()', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Stop.swift:stop');
  });
});

// =====================================================================================
// external bases external bases, symbol spans same-line siblings, requirements comment-only bases and TypeScript
// interfaces, and the recursion pin. TypeScript.
// =====================================================================================

const C_C1 = { 'src/base.ts': 'export class Base {\n  // run once the API is ready\n}\n' };
const C_C2: Record<string, string> = {
  // requirements TS: a class whose base holds only a comment that names run.
  'src/derived.ts': "import { Base } from './base';\n\nexport class Derived extends Base { run() {} }\n",
  // requirements: a TS interface member and its implementation.
  'src/iface.ts': 'export interface IRunner {\n  exec(): void;\n}\n\nexport class ImplRunner implements IRunner {\n  exec() {}\n}\n',
  // external bases: an external base whose name is an Object.prototype property (constructor, toString, hasOwnProperty).
  'src/extra-ctor.ts': "import { constructor } from 'external-pkg';\n\nexport class ExtraCtor extends constructor {\n  workCtor() {}\n}\n",
  'src/extra-str.ts': "import { toString } from 'external-pkg';\n\nexport class ExtraStr extends toString {\n  workStr() {}\n}\n",
  'src/extra-own.ts': "import { hasOwnProperty } from 'external-pkg';\n\nexport class ExtraOwn extends hasOwnProperty {\n  workOwn() {}\n}\n",
  // symbol spans: caller and target on one line; the call from caller is target's only use.
  'src/same-line.ts': 'export function caller() { return target(); } export function target() { return 1; }\n',
  'src/use-same.ts': "import { caller } from './same-line';\n\nexport function driver(): number {\n  return caller();\n}\n",
  // symbol spans: a recursive call from a nested closure inside the function's own span.
  'src/recur.ts': 'export function pinRecurse(n: number): number {\n  const again = (): number => pinRecurse(n - 1);\n  return n > 0 ? again() : 0;\n}\n',
};
/** The files the main TypeScript run reads (the external bases files each run on their own, since one throw ends the run). */
const C_MAIN = ['src/derived.ts', 'src/iface.ts', 'src/same-line.ts', 'src/use-same.ts', 'src/recur.ts'];

describe('TypeScript: external bases, same-line siblings, comment-only bases, interfaces, recursion', () => {
  let root = '';
  let ix: IndexRows;
  let main: Outcome;
  let ctor: Outcome;
  let str: Outcome;
  let own: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-ts-', C_C1, (r) => writeAll(r, C_C2));
    ix = indexRows(root);
    main = await orphansOf(root, (p) => C_MAIN.includes(p));
    ctor = await orphansOf(root, (p) => p === 'src/extra-ctor.ts');
    str = await orphansOf(root, (p) => p === 'src/extra-str.ts');
    own = await orphansOf(root, (p) => p === 'src/extra-own.ts');
  }, 60_000);

  it('external bases: each extra class holds a failed reference to its external base, and its method is a node', () => {
    const want: [string, string, string, string][] = [
      ['ExtraCtor', 'constructor', 'workCtor', 'src/extra-ctor.ts'],
      ['ExtraStr', 'toString', 'workStr', 'src/extra-str.ts'],
      ['ExtraOwn', 'hasOwnProperty', 'workOwn', 'src/extra-own.ts'],
    ];
    const missing = want
      .filter(([cls, base, method, file]) => {
        const c = byName(ix, cls, file)[0];
        return !c || byName(ix, method, file).length === 0 || !ix.unresolved.some((u) => u.from_node_id === c.id && u.reference_name === base);
      })
      .map(([cls, base, method]) => `${cls} extends ${base} / ${method}`);
    expect(missing).toEqual([]);
  });

  it('external bases: findOrphans does not throw on a class extending constructor', () => {
    reportOf(ctor);
  });

  it('external bases: ExtraCtor.workCtor is listed with constructor as its external conformance', () => {
    const e = listed(reportOf(ctor)).find((x) => x.name === 'workCtor');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('constructor');
  });

  it('external bases: findOrphans does not throw on a class extending toString', () => {
    reportOf(str);
  });

  it('external bases: ExtraStr.workStr is listed with toString as its external conformance', () => {
    const e = listed(reportOf(str)).find((x) => x.name === 'workStr');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('toString');
  });

  it('external bases: findOrphans does not throw on a class extending hasOwnProperty', () => {
    reportOf(own);
  });

  it('external bases: ExtraOwn.workOwn is listed with hasOwnProperty as its external conformance', () => {
    const e = listed(reportOf(own)).find((x) => x.name === 'workOwn');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('hasOwnProperty');
  });

  it('symbol spans: caller and target are both on line 1 of src/same-line.ts, with a calls edge from caller to target', () => {
    const target = byName(ix, 'target', 'src/same-line.ts');
    const caller = byName(ix, 'caller', 'src/same-line.ts');
    expect(target).toHaveLength(1);
    expect(caller).toHaveLength(1);
    expect([target[0]!.start_line, target[0]!.end_line, caller[0]!.start_line, caller[0]!.end_line]).toEqual([1, 1, 1, 1]);
    expect(ix.edges.some((e) => e.kind === 'calls' && e.source === caller[0]!.id && e.target === target[0]!.id)).toBe(true);
  });

  it('requirements TS: ImplRunner.exec is a node at line 6 of src/iface.ts, so the interface pin is about a real symbol', () => {
    expect(ix.nodes.some((n) => n.name === 'exec' && n.file_path === 'src/iface.ts' && n.start_line === 6)).toBe(true);
  });

  it('symbol spans: target, called by its one-line sibling caller, is neither orphaned nor guessed', () => {
    expect(keysOf(reportOf(main))).not.toContain('src/same-line.ts:target');
  });

  it('symbol spans: pinRecurse, used only from a nested closure inside its own span, stays an orphan', () => {
    const r = reportOf(main);
    expect(r.orphans.map((e) => `${e.path}:${e.name}`)).toContain('src/recur.ts:pinRecurse');
    expect(r.guessed.map((e) => `${e.path}:${e.name}`)).not.toContain('src/recur.ts:pinRecurse');
  });

  it('requirements TS: Derived.run is listed, not excluded as implementing a base whose only comment names run', () => {
    expect(keysOf(reportOf(main))).toContain('src/derived.ts:run');
  });

  it('requirements TS: ImplRunner.exec, implementing IRunner, is excluded as an implementation', () => {
    expect(keysOf(reportOf(main))).not.toContain('src/iface.ts:exec');
  });
});

// =====================================================================================
// Swift full type paths: isolate the case so no other Widget or encode is near it.
//
// Known residual, deliberately not a test: the full type path has no module identity. Two
// SwiftPM targets that each declare the same path (say Sources/A/Widget.swift and
// Sources/B/Widget.swift, both `struct Widget`) still join, so one target's conformance can
// exclude the other target's member. A path read from the parse names no module, so the
// path alone cannot distinguish the two modules.
// =====================================================================================

const S1_C1 = { 'Sources/Pkg/A.swift': 'enum A {\n    struct Widget: Encodable {}\n}\n' };
const S1_C2 = { 'Sources/Pkg/B.swift': 'enum B {\n    struct Widget {\n        func encode() {}\n    }\n}\n' };

describe('Swift type paths, nested types: B.Widget.encode is not Encodable\'s implementation', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-swift-nested-', S1_C1, (r) => writeAll(r, S1_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('Swift type paths: A.swift nests a Widget with an unresolved Encodable conformance; B.swift nests an encode in a Widget', () => {
    const wa = byName(ix, 'Widget', 'Sources/Pkg/A.swift');
    expect(wa).toHaveLength(1);
    expect(ix.unresolved.some((u) => u.from_node_id === wa[0]!.id && u.reference_name === 'Encodable')).toBe(true);
    const enc = byName(ix, 'encode', 'Sources/Pkg/B.swift');
    expect(enc).toHaveLength(1);
    const parent = ix.edges.find((e) => e.kind === 'contains' && e.target === enc[0]!.id);
    const holder = ix.nodes.find((n) => n.id === parent?.source);
    expect(holder?.name).toBe('Widget');
    expect(holder?.file_path).toBe('Sources/Pkg/B.swift');
  });

  it('Swift type paths: B.Widget.encode is listed, not excluded as an Encodable implementation', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Pkg/B.swift:encode');
  });
});

// =====================================================================================
// Swift type paths, extensions: the pins, and the probe that records the index's names.
// =====================================================================================

const S2_C1 = { 'Sources/Pkg/Seed.swift': 'func seedFn() -> Int {\n    return 1\n}\n' };
const S2_C2 = {
  'Sources/Pkg/Widget.swift': 'struct Widget {}\n\nextension Widget: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n',
  'Sources/Pkg/Keys.swift': 'enum K {\n    struct Builder {}\n}\n\nextension K.Builder: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n',
};

describe('Swift type paths, extensions: the pins and the qualified-name probe', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-swift-ext-', S2_C1, (r) => writeAll(r, S2_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('Swift type paths: encode is a node in Widget.swift and in Keys.swift', () => {
    expect(byName(ix, 'encode', 'Sources/Pkg/Widget.swift')).toHaveLength(1);
    expect(byName(ix, 'encode', 'Sources/Pkg/Keys.swift')).toHaveLength(1);
  });

  it('Swift type paths: encode in extension Widget (of top-level struct Widget) is excluded as an implementation', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Pkg/Widget.swift:encode');
  });

  it('Swift type paths: encode in extension K.Builder (of nested K.Builder) is excluded as an implementation', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Pkg/Keys.swift:encode');
  });

  it('Swift type paths probe: the names the index gives nested types and extension K.Builder (writes a table, asserts nothing)', () => {
    const rows = ix.nodes.filter((n) => ['Widget', 'Builder', 'K', 'encode'].includes(n.name));
    const table = rows.map((n) => `${n.file_path}  ${n.kind}  name=${n.name}  qualified_name=${n.qualified_name}`).join('\n');
    fs.writeFileSync(path.join(os.tmpdir(), 'cg-orphans-core-published-o07-probe.txt'), `${table}\n`);
  });
});

// =====================================================================================
// diff ranges: a .ts file git diffs as binary, a pure rename, a mode-only change, and a
// modified file whose changed-line ranges are empty.
// =====================================================================================

const G_C1: Record<string, string> = {
  '.gitattributes': '*.ts -diff\n',
  'src/ts-diffless.ts': 'export function existingOne(): number {\n  return 1;\n}\n',
  'src/renamed-old.ts': 'export function movedFn(): number {\n  return 2;\n}\n',
  'src/mode.ts': 'export function modeFn(): number {\n  return 3;\n}\n',
};

describe('diff ranges: a binary-diffed file, a rename, a mode-only change, and a file with no ranges', () => {
  let root = '';
  let ix: IndexRows;
  let files: ChangedFile[] = [];
  let gMain: Outcome;
  let gSynth: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-ranges-', G_C1, (r) => {
      fs.appendFileSync(path.join(r, 'src/ts-diffless.ts'), '\nexport function addedLater() {}\n');
      fs.renameSync(path.join(r, 'src/renamed-old.ts'), path.join(r, 'src/renamed-new.ts'));
      // A mode-only change is in the diff only where git tracks the executable bit. A Windows checkout
      // sets core.filemode=false, so there the chmod is no change and mode.ts is not in the diff.
      if (process.platform !== 'win32') fs.chmodSync(path.join(r, 'src/mode.ts'), 0o755);
    });
    ix = indexRows(root);
    files = changedFiles(root, 'C1')?.files ?? [];
    gMain = await orphansOf(root);
    // The failed-patch-pass shape: a modified file with no ranges, read straight into findOrphans.
    gSynth = await orphansOf(root, undefined, [{ path: 'src/ts-diffless.ts', status: 'modified', ranges: [], hunks: [] }]);
  }, 60_000);

  it('diff ranges: git gives ts-diffless.ts no ranges, renamed-new.ts as a rename of renamed-old.ts, and addedLater is indexed', () => {
    const at = (p: string): ChangedFile | undefined => files.find((f) => f.path === p);
    expect(at('src/ts-diffless.ts')).toMatchObject({ status: 'modified', ranges: [] });
    expect(at('src/renamed-new.ts')).toMatchObject({ status: 'renamed', oldPath: 'src/renamed-old.ts', ranges: [] });
    expect(byName(ix, 'addedLater', 'src/ts-diffless.ts')).toHaveLength(1);
    // The pins below are about these symbols: each must be an indexed node, or its pin is empty.
    expect(byName(ix, 'movedFn', 'src/renamed-new.ts')).toHaveLength(1);
    expect(byName(ix, 'modeFn', 'src/mode.ts')).toHaveLength(1);
    expect(byName(ix, 'existingOne', 'src/ts-diffless.ts')).toHaveLength(1);
  });

  it('diff ranges: addedLater, appended to a .ts file that git diffs as binary, is listed', () => {
    expect(keysOf(reportOf(gMain))).toContain('src/ts-diffless.ts:addedLater');
  });

  it('diff ranges: a pure rename (R100) of a file with symbols adds nothing (movedFn)', () => {
    expect(keysOf(reportOf(gMain))).not.toContain('src/renamed-new.ts:movedFn');
  });

  it.runIf(process.platform !== 'win32')('diff ranges: git gives mode.ts no ranges (a mode-only change, posix only)', () => {
    const at = (p: string): ChangedFile | undefined => files.find((f) => f.path === p);
    expect(at('src/mode.ts')).toMatchObject({ status: 'modified', ranges: [] });
  });

  it.runIf(process.platform !== 'win32')('diff ranges: a mode-only change (chmod +x) adds nothing (modeFn)', () => {
    expect(keysOf(reportOf(gMain))).not.toContain('src/mode.ts:modeFn');
  });

  it('diff ranges: a modified file with no ranges lists the function its pre-image lacks (addedLater)', () => {
    expect(keysOf(reportOf(gSynth))).toContain('src/ts-diffless.ts:addedLater');
  });

  it('diff ranges: a function whose name the pre-image holds (existingOne) is not listed', () => {
    expect(keysOf(reportOf(gSynth))).not.toContain('src/ts-diffless.ts:existingOne');
  });
});

// =====================================================================================
// requirements probe: interface and abstract members in other languages. Prints the table,
// asserts nothing; the table decides which languages keep the span fallback.
// =====================================================================================

const P_FILES: Record<string, string> = {
  'probe/Iface.java': 'public interface IProbeJava {\n    void probeJava();\n}\n\nabstract class AbsProbeJava {\n    abstract void absJava();\n}\n',
  'probe/IProbeCs.cs': 'public interface IProbeCs {\n    void ProbeCs();\n}\n',
  'probe/iface.kt': 'interface IProbeKt {\n    fun probeKt()\n}\n',
  'probe/iface.php': '<?php\ninterface IProbePhp {\n    public function probePhp();\n}\n',
  'probe/iface.go': 'package probe\n\ntype IProbeGo interface {\n\tProbeGo()\n}\n',
  'probe/iface.py': 'from abc import ABC, abstractmethod\n\n\nclass IProbePy(ABC):\n    @abstractmethod\n    def probe_py(self):\n        pass\n',
};
const P_MEMBERS = ['probeJava', 'absJava', 'ProbeCs', 'probeKt', 'probePhp', 'ProbeGo', 'probe_py'];

describe('requirements probe: is an interface or abstract member an indexed node held by its type?', () => {
  let ix: IndexRows;

  beforeAll(async () => {
    const root = await fixtureRepo('cg-orphans-core-probe-', { 'README.md': '# probe\n' }, (r) => writeAll(r, P_FILES));
    ix = indexRows(root);
  }, 60_000);

  it('requirements probe: writes, per member, the node kind and the container that holds it (asserts nothing)', () => {
    const lines = P_MEMBERS.map((member) => {
      const ns = byName(ix, member);
      if (ns.length === 0) return `${member}: no node`;
      return ns.map((n) => {
        const holders = ix.edges
          .filter((e) => e.kind === 'contains' && e.target === n.id)
          .map((e) => ix.nodes.find((p) => p.id === e.source));
        const held = holders.map((p) => (p ? `${p.kind} ${p.name}` : 'unknown')).join(', ') || 'no container';
        return `${member}: ${n.file_path} node kind=${n.kind}; held by ${held}`;
      }).join('\n');
    });
    fs.writeFileSync(path.join(os.tmpdir(), 'cg-orphans-core-published-o06-probe.txt'), `${lines.join('\n')}\n`);
  });
});

// =====================================================================================
// Each describe has its own fixture repo: cases share names such as Widget, Inner and
// encode, and one repo would join them. The beforeAll timeouts cover indexing a fixture
// repo on a loaded machine; the tests themselves only read the outcome.
// =====================================================================================

/**
 * The index's nodes of `files` with their line and column spans and qualified names, and every edge
 * touching them, by name (the facts a fix needs: columns, contains edges, path strings). Asserts nothing.
 */
function writeNodeProbe(root: string, files: readonly string[], outName: string): void {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    const marks = files.map(() => '?').join(', ');
    const nodes = db.prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, start_column, end_column, qualified_name
         FROM nodes WHERE file_path IN (${marks}) AND kind NOT IN ('file', 'import', 'parameter')
         ORDER BY file_path, start_line, start_column`,
    ).all(...files) as unknown as {
      id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number;
      start_column: number; end_column: number; qualified_name: string;
    }[];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (db.prepare('SELECT source, target, kind, line FROM edges').all() as unknown as EdgeRow[])
      .filter((e) => byId.has(e.source) || byId.has(e.target));
    const label = (id: string): string => {
      const n = byId.get(id);
      return n ? `${n.name}@L${n.start_line}C${n.start_column}` : id;
    };
    const out = [
      ...nodes.map((n) => `${n.file_path}  ${n.kind}  ${n.name}  L${n.start_line}-L${n.end_line}  C${n.start_column}-C${n.end_column}  qualified=${n.qualified_name}`),
      ...edges.map((e) => `edge ${e.kind}: ${label(e.source)} -> ${label(e.target)}  line=${e.line ?? 'none'}`),
    ];
    fs.writeFileSync(path.join(os.tmpdir(), outName), `${out.join('\n')}\n`);
  } finally {
    conn.close();
  }
}

// --- comment-only protocol (requirements): a protocol requirement is read from the parse; no parse proves nothing ----------

const STOP_FILE = 'Sources/Pkg/Stop.swift';
const PROTO_C1: Record<string, string> = { 'Sources/Pkg/Seed.swift': 'func seedStop() -> Int {\n    return 1\n}\n' };
const PROTO_C2: Record<string, string> = {
  // A protocol whose body is only a comment naming stop, and a struct conforming to it with stop().
  [STOP_FILE]: 'protocol Stopping {\n    // stop later\n}\n\nstruct Stopper: Stopping {\n    func stop() {}\n}\n',
};

describe('requirements (comment-only protocol): a Swift protocol whose body only comments on stop proves no requirement, with or without the parse', () => {
  let root = '';
  let ix: IndexRows;
  let withParse: Outcome;
  let withoutParse: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-proto-', PROTO_C1, (r) => writeAll(r, PROTO_C2));
    ix = indexRows(root);
    const onlyStop = (p: string): boolean => p === STOP_FILE;
    withParse = await orphansOf(root, onlyStop);
    // getParser('swift') is null for this one findOrphans call: the Swift parse is unavailable.
    grammarHooks.swiftParserOff = true;
    try {
      withoutParse = await orphansOf(root, onlyStop);
    } finally {
      grammarHooks.swiftParserOff = false;
    }
  }, 120_000);

  it('requirements (comment-only protocol): stop and the protocol Stopping are indexed nodes of Stop.swift', () => {
    expect(byName(ix, 'stop', STOP_FILE)).toHaveLength(1);
    expect(byName(ix, 'Stopping', STOP_FILE)).toHaveLength(1);
  });

  it('requirements (comment-only protocol): with the Swift parse available, stop is listed and no method is excluded as an implementation', () => {
    expect(keysOf(reportOf(withParse))).toContain(`${STOP_FILE}:stop`);
    expect(reportOf(withParse).excluded.implementation).toBe(0);
  });

  it('requirements (comment-only protocol): with the Swift parse unavailable, a comment naming stop does not prove it: stop is listed', () => {
    expect(keysOf(reportOf(withoutParse))).toContain(`${STOP_FILE}:stop`);
  });

  it('requirements (comment-only protocol): with the Swift parse unavailable, no method is excluded as an implementation', () => {
    expect(reportOf(withoutParse).excluded.implementation).toBe(0);
  });
});

// --- unreadable Swift source (Swift type paths): a same-named Swift type whose full path cannot be read joins no other type ----

describe('Swift type paths (unreadable Swift source): a same-named Swift type whose full path cannot be read joins no other type', () => {
  const A_FILE = 'Sources/Pkg/A.swift';
  const B_FILE = 'Sources/Pkg/B.swift';
  let rootA = '';
  let rootB = '';
  let ixA: IndexRows;
  let unknownA: Outcome;
  let unknownB: Outcome;

  beforeAll(async () => {
    // A's path is unknown: A.swift is indexed, then made unreadable (deleted from the working tree).
    rootA = await fixtureRepo('cg-orphans-pr-r1-unknown-a-', S1_C1, (r) => writeAll(r, S1_C2));
    ixA = indexRows(rootA);
    fs.rmSync(path.join(rootA, A_FILE));
    unknownA = await orphansOf(rootA, (p) => p === B_FILE);
    // B's path is unknown: B.swift is indexed and stays in the working tree, so it stays in the diff
    // (the diff runs from the merge base to the working tree, and a deleted B.swift would
    // drop out of it, leaving no encode to judge); only the check's read of its source returns null.
    rootB = await fixtureRepo('cg-orphans-pr-r1-unknown-b-', S1_C1, (r) => writeAll(r, S1_C2));
    unknownB = await orphansOf(rootB, (p) => p === B_FILE, undefined, [B_FILE]);
  }, 120_000);

  it('Swift type paths (unreadable Swift source): B.swift is an added file in the diff of both repos, so its encode is a candidate in each', () => {
    for (const root of [rootA, rootB]) {
      expect(changedFiles(root, 'C1')?.files.find((f) => f.path === B_FILE)).toMatchObject({ status: 'added' });
    }
  });

  it('Swift type paths (unreadable Swift source): A.Widget holds a failed Encodable reference, and A.swift is gone from the working tree', () => {
    const wa = byName(ixA, 'Widget', A_FILE);
    expect(wa).toHaveLength(1);
    expect(ixA.unresolved.some((u) => u.from_node_id === wa[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
    expect(fs.existsSync(path.join(rootA, A_FILE))).toBe(false);
  });

  it('Swift type paths (unreadable Swift source) A unknown: B.Widget.encode is not excluded through the unreadable A.Widget (Encodable)', () => {
    expect(keysOf(reportOf(unknownA))).toContain(`${B_FILE}:encode`);
    expect(reportOf(unknownA).excluded.implementation).toBe(0);
  });

  it('Swift type paths (unreadable Swift source) B unknown: encode in the unreadable B.swift is not excluded through A.Widget (Encodable)', () => {
    expect(keysOf(reportOf(unknownB))).toContain(`${B_FILE}:encode`);
    expect(reportOf(unknownB).excluded.implementation).toBe(0);
  });
});

// --- same-line failed reference (symbol spans): a failed reference from a same-line sibling is evidence; one from inside S is not ---

const FAILED_C1: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "oneline"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn seed() -> u32 {\n    1\n}\n',
};
const FAILED_C2: Record<string, string> = {
  // caller and target share line 1; the failed `other_crate::target` comes from caller, the sibling.
  'src/same.rs': 'fn caller() { other_crate::target(); } fn target() {}\n',
  // The: the one failed reference is from inside own_target's own span.
  'src/own.rs': 'fn own_target() { other_crate::own_target(); }\n',
};

describe('symbol spans (same-line failed reference): a failed reference from a same-line sibling is evidence for its target', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-failed-', FAILED_C1, (r) => writeAll(r, FAILED_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === 'src/same.rs' || p === 'src/own.rs');
  }, 120_000);

  it('symbol spans (same-line failed reference): caller and target share line 1 of src/same.rs, and the failed other_crate::target comes from caller', () => {
    const target = byName(ix, 'target', 'src/same.rs');
    const caller = byName(ix, 'caller', 'src/same.rs');
    expect(target).toHaveLength(1);
    expect(caller).toHaveLength(1);
    expect([target[0]!.start_line, target[0]!.end_line, caller[0]!.start_line, caller[0]!.end_line]).toEqual([1, 1, 1, 1]);
    const ref = failedNamed(ix, 'target').find((u) => u.reference_name === 'other_crate::target');
    expect(ref?.from_node_id).toBe(caller[0]!.id);
    expect(incomingUses(ix, target[0]!.id)).toEqual([]);
  });

  it('symbol spans (same-line failed reference): target, whose only reference is the failed call from its one-line sibling, is guessed with that evidence, not orphaned', () => {
    expect(reportOf(outcome).orphans.map((e) => `${e.path}:${e.name}`)).not.toContain('src/same.rs:target');
    const g = guessedRuns(outcome, 'target').find((e) => e.path === 'src/same.rs');
    expect(g).toBeDefined();
    expect(g?.unresolved).toContainEqual({ name: 'other_crate::target', kind: 'calls', path: 'src/same.rs', line: 1 });
  });

  it('symbol spans (same-line failed reference): own_target, whose only failed reference is from inside its own span, stays orphaned', () => {
    const r = reportOf(outcome);
    expect(r.orphans.map((e) => `${e.path}:${e.name}`)).toContain('src/own.rs:own_target');
    expect(r.guessed.map((e) => `${e.path}:${e.name}`)).not.toContain('src/own.rs:own_target');
  });
});

// --- nested function (symbol spans, Dart): a nested one-line function inside S is inside S ------------------------

const DART_FILE = 'lib/lonely.dart';
const DART_C1: Record<string, string> = { 'lib/base.dart': 'int base() => 0;\n' };
const DART_C2: Record<string, string> = {
  // lonely's only use is its nested local function again(), on the same line; again() calls lonely() from inside lonely.
  [DART_FILE]: 'int lonely() { int again() => lonely(); return again(); }\n',
};

describe('symbol spans (nested function, Dart): a one-line nested function does not make its enclosing function used', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-dart-', DART_C1, (r) => writeAll(r, DART_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === DART_FILE);
  }, 120_000);

  it('symbol spans (nested function): lonely is an indexed node on line 1 of lib/lonely.dart', () => {
    const lonely = byName(ix, 'lonely', DART_FILE);
    expect(lonely).toHaveLength(1);
    expect([lonely[0]!.start_line, lonely[0]!.end_line]).toEqual([1, 1]);
  });

  it('symbol spans (nested function) probe: writes the Dart nodes with their columns and every edge among them (asserts nothing)', () => {
    writeNodeProbe(root, [DART_FILE], 'cg-orphans-pr-r1-dart-probe.txt');
  });

  it('symbol spans (nested function): lonely, whose only use is the nested again() on the same line, is listed, not treated as used', () => {
    expect(keysOf(reportOf(outcome))).toContain(`${DART_FILE}:lonely`);
  });
});

// --- composition continuation (attributes, entry rule, Swift): a composition continuation line must not hide @main --------

const APP_FILE = 'Sources/Pkg/App.swift';
const AMP_C1: Record<string, string> = { 'Sources/Pkg/Seed.swift': 'func seedApp() -> Int {\n    return 1\n}\n' };
const AMP_C2: Record<string, string> = {
  // An @main type whose body holds a composition type continued on a line that starts with `&`.
  [APP_FILE]: '@main struct App {\n    let handler: Serving\n        & Stopping\n    static func main() {}\n}\n',
};

describe('attributes (composition continuation, Swift entry rule): @main and static main survive a composition continuation line', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-swift-amp-', AMP_C1, (r) => writeAll(r, AMP_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === APP_FILE);
  }, 120_000);

  it('attributes (composition continuation): App and its static main are indexed nodes of App.swift', () => {
    expect(byName(ix, 'App', APP_FILE)).toHaveLength(1);
    expect(byName(ix, 'main', APP_FILE)).toHaveLength(1);
  });

  it('attributes (composition continuation): App is excluded as an entry point, so the & continuation line does not hide its @main', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${APP_FILE}:App`);
  });

  it('attributes (composition continuation): static main of App is excluded as an entry point', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${APP_FILE}:main`);
  });

  it('attributes (composition continuation): both are counted as entry exclusions', () => {
    expect(reportOf(outcome).excluded.entry).toBe(2);
  });
});

// --- nested extension (Swift type paths): a member of an extension of a nested type joins that type's conformances -----

const JOINED_FILE = 'Sources/Q/Joined.swift';
const OTHER_FILE = 'Sources/Q/Other.swift';
const QUAL_C1: Record<string, string> = {
  'Sources/Q/API.swift': 'enum API {\n    struct Outer {}\n}\n',
  'Sources/Q/Ext.swift': 'extension API.Outer {\n    struct Inner: Encodable {}\n}\n',
};
const QUAL_C2: Record<string, string> = {
  // encode in an extension of the nested type: it joins API.Outer.Inner, whose Encodable the struct declares.
  [JOINED_FILE]: 'extension API.Outer.Inner {\n    func encode(to e: Encoder) throws {}\n}\n',
  // An unrelated Other.Inner with no conformance; its encode must not join API.Outer.Inner.
  [OTHER_FILE]: 'enum Other {\n    struct Inner {}\n}\n\nextension Other.Inner {\n    func encode(to e: Encoder) throws {}\n}\n',
};

describe('Swift type paths (nested extension): a member of an extension of a nested type joins that type\'s conformances, and only that type\'s', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-qualified-', QUAL_C1, (r) => writeAll(r, QUAL_C2));
    ix = indexRows(root);
    writeNodeProbe(root, ['Sources/Q/API.swift', 'Sources/Q/Ext.swift', JOINED_FILE, OTHER_FILE], 'cg-orphans-pr-r1-qualified-probe.txt');
    outcome = await orphansOf(root);
  }, 120_000);

  it('Swift type paths (nested extension): encode is indexed in both extension files, and struct Inner in Ext.swift holds a failed Encodable reference', () => {
    expect(byName(ix, 'encode', JOINED_FILE)).toHaveLength(1);
    expect(byName(ix, 'encode', OTHER_FILE)).toHaveLength(1);
    const inner = byName(ix, 'Inner', 'Sources/Q/Ext.swift');
    expect(inner).toHaveLength(1);
    expect(ix.unresolved.some((u) => u.from_node_id === inner[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
  });

  it('Swift type paths (nested extension): encode in extension API.Outer.Inner is excluded as an implementation (joined to the Encodable of struct Inner)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${JOINED_FILE}:encode`);
  });

  it('Swift type paths (nested extension): encode in extension Other.Inner is listed, since API.Outer.Inner does not join the unrelated Other.Inner', () => {
    expect(keysOf(reportOf(outcome))).toContain(`${OTHER_FILE}:encode`);
  });
});

// --- long comment run (attributes): the Rust attribute walk over a long run of comment lines --------------------

const LONG_COMMENTS = 3000;
const LONG_FILE = 'src/long.rs';
const WALK_C1: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "walk"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn seed() -> u32 {\n    1\n}\n',
};
const WALK_C2: Record<string, string> = {
  // A run of consecutive comment lines, then an added fn with no attribute and a #[test] fn after it.
  [LONG_FILE]: `${Array.from({ length: LONG_COMMENTS }, (_, i) => `// comment line ${i + 1}`).join('\n')}\n` +
    'pub fn tail_plain() -> u32 {\n    1\n}\n\n#[test]\nfn tail_test() {}\n',
};

describe('attributes (long comment run): the Rust attribute walk over a long run of comment lines', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let siblingReads = -1;

  // slow: indexes a 3000-line file, and the attribute walk under test runs over it.
  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-pr-r1-rust-walk-', WALK_C1, (r) => writeAll(r, WALK_C2));
    ix = indexRows(root);
    // The deterministic count: reads of previousNamedSibling on web-tree-sitter's Node while findOrphans
    // runs. A plain counter on the prototype getter (no call recording).
    const desc = Object.getOwnPropertyDescriptor(TsNode.prototype, 'previousNamedSibling');
    if (!desc?.get) throw new Error('web-tree-sitter Node has no previousNamedSibling getter');
    let reads = 0;
    Object.defineProperty(TsNode.prototype, 'previousNamedSibling', {
      ...desc,
      get(this: TsNode) {
        reads += 1;
        return desc.get!.call(this);
      },
    });
    try {
      outcome = await orphansOf(root);
    } finally {
      Object.defineProperty(TsNode.prototype, 'previousNamedSibling', desc);
      siblingReads = reads;
    }
  }, 180_000);

  it('attributes (long comment run): tail_plain and tail_test are indexed in src/long.rs, after the comment run', () => {
    expect(byName(ix, 'tail_plain', LONG_FILE)).toHaveLength(1);
    expect(byName(ix, 'tail_test', LONG_FILE)).toHaveLength(1);
    expect(byName(ix, 'tail_plain', LONG_FILE)[0]!.start_line).toBe(LONG_COMMENTS + 1);
  });

  it('attributes (long comment run): both are added, tail_plain is listed, tail_test is excluded as a test', () => {
    const r = reportOf(outcome);
    expect(r.added).toBe(2);
    expect(keysOf(r)).toContain(`${LONG_FILE}:tail_plain`);
    expect(keysOf(r)).not.toContain(`${LONG_FILE}:tail_test`);
    expect(r.excluded.test).toBe(1);
  });

  // The parse-based attribute walk must stay linear in the comment run.
  it('attributes (long comment run): the attribute walk reads previousNamedSibling at most 10 times per node (linear, not quadratic in the comment run)', () => {
    expect(siblingReads).toBeLessThanOrEqual(10 * (LONG_COMMENTS + 20));
  });
});

// --- A Swift type declared in a code body joins nothing --------------------------

describe('Swift types declared in a code body', () => {
  describe('Swift type paths (function-local types): a Widget local to second() is not the Encodable Widget local to first()', () => {
    const FIRST = 'Sources/Loc/First.swift';
    const SECOND = 'Sources/Loc/Second.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-pr-r2-local-',
        { [FIRST]: 'func first() { struct Widget: Encodable {} }\n' },
        (r) => write(r, SECOND, 'func second() { struct Widget { func encode() {} } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('Swift type paths (function-local types): first() holds a Widget with a failed Encodable reference; second() holds a Widget that holds encode', () => {
      const first = byName(ix, 'Widget', FIRST);
      expect(first).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === first[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const second = byName(ix, 'Widget', SECOND);
      const enc = byName(ix, 'encode', SECOND);
      expect(second).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === second[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('Swift type paths (function-local types): encode in second()\'s Widget is listed, not excluded as the Encodable implementation of first()\'s Widget', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${SECOND}:encode`);
    });
  });

  describe('Swift type paths (closure-local type): a Widget local to a closure is not the top-level Encodable Widget', () => {
    const TOP = 'Sources/Loc/Top.swift';
    const CLOSURE = 'Sources/Loc/Closure.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      // The closure sits in a function: a top-level property's children are not indexed, so a
      // top-level closure would index no Widget.
      root = await fixtureRepo(
        'cg-orphans-pr-r2-closure-',
        { [TOP]: 'struct Widget: Encodable {}\n' },
        (r) => write(r, CLOSURE, 'func makeClosure() { let f = { struct Widget { func encode() {} } } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('Swift type paths (closure-local type): the top-level Widget holds a failed Encodable reference; the closure\'s Widget holds encode', () => {
      const top = byName(ix, 'Widget', TOP);
      expect(top).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === top[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const local = byName(ix, 'Widget', CLOSURE);
      const enc = byName(ix, 'encode', CLOSURE);
      expect(local).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === local[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('Swift type paths (closure-local type): encode in the closure-local Widget is listed, not excluded as the Encodable implementation of the top-level Widget', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${CLOSURE}:encode`);
    });
  });

  describe('Swift type paths (getter-local type): a Widget local to a computed getter, in a function or in a struct, is not the top-level Encodable Widget', () => {
    const TOP = 'Sources/Loc/Top.swift';
    const LOCAL = 'Sources/Loc/Local.swift';
    const MEMBER = 'Sources/Loc/Holder.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      // The local getter sits in a function, as the closure does; the member getter sits in a struct.
      root = await fixtureRepo(
        'cg-orphans-pr-r2-getter-',
        { [TOP]: 'struct Widget: Encodable {}\n' },
        (r) => writeAll(r, {
          [LOCAL]: 'func readX() { var x: Int { struct Widget { func encode() {} }; return 1 } }\n',
          [MEMBER]: 'struct Holder {\n    var x: Int { struct Widget { func encode() {} }; return 1 }\n}\n',
        }),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('Swift type paths (getter-local type): the top-level Widget holds a failed Encodable reference; each getter\'s Widget holds encode, and Holder is a struct', () => {
      const top = byName(ix, 'Widget', TOP);
      expect(top).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === top[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      for (const file of [LOCAL, MEMBER]) {
        const widget = byName(ix, 'Widget', file);
        const enc = byName(ix, 'encode', file);
        expect(widget).toHaveLength(1);
        expect(enc).toHaveLength(1);
        expect(ix.edges.some((e) => e.kind === 'contains' && e.source === widget[0]!.id && e.target === enc[0]!.id)).toBe(true);
      }
      expect(byName(ix, 'Holder', MEMBER).map((n) => n.kind)).toEqual(['struct']);
    });

    it('Swift type paths (getter-local type): encode in the Widget local to readX\'s getter is listed, not excluded as the top-level Widget\'s Encodable implementation', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${LOCAL}:encode`);
    });

    it('Swift type paths (getter-local type): encode in the Widget local to Holder\'s getter is listed, since a type declared in a getter body joins nothing', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${MEMBER}:encode`);
    });
  });

  describe('Swift type paths (nested function-local type): a type nested in a function-local type is not the nested type of another function-local type that conforms', () => {
    const CONFORMING = 'Sources/Loc/G.swift';
    const NESTED = 'Sources/Loc/F.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-pr-r2-nested-',
        { [CONFORMING]: 'func g() { struct W { struct In: Encodable {} } }\n' },
        (r) => write(r, NESTED, 'func f() { struct W { struct In { func encode() {} } } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('Swift type paths (nested function-local type): the In of g() holds a failed Encodable reference; the In of f() holds encode', () => {
      const conforming = byName(ix, 'In', CONFORMING);
      expect(conforming).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === conforming[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const nested = byName(ix, 'In', NESTED);
      const enc = byName(ix, 'encode', NESTED);
      expect(nested).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === nested[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('Swift type paths (nested function-local type): encode in the In of f() is listed, not excluded as the Encodable implementation of the In of g()', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${NESTED}:encode`);
    });
  });

  describe('Swift type paths (conditional declarations): an extension\'s encode is excluded when its struct is declared under #if and #else', () => {
    const GIZMO = 'Sources/Loc/Gizmo.swift';
    const CODABLE = 'Sources/Loc/GizmoCodable.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-pr-r2-ifdef-',
        { [GIZMO]: '#if DEBUG\nstruct Gizmo {}\n#else\nstruct Gizmo {}\n#endif\n' },
        (r) => write(r, CODABLE, 'extension Gizmo: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('Swift type paths (conditional declarations): both #if branches index a struct Gizmo; the extension holds a failed Encodable reference and encode', () => {
      const structs = byName(ix, 'Gizmo', GIZMO);
      expect(structs).toHaveLength(2);
      expect(structs.every((n) => n.kind === 'struct')).toBe(true);
      const ext = byName(ix, 'Gizmo', CODABLE);
      expect(ext).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === ext[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      expect(byName(ix, 'encode', CODABLE)).toHaveLength(1);
    });

    it('Swift type paths (conditional declarations): encode in the extension of Gizmo is excluded as an implementation, through the #if structs', () => {
      expect(keysOf(reportOf(outcome))).not.toContain(`${CODABLE}:encode`);
    });
  });
});
