/**
 * `codegraph blast` run on a real CodeGraph index of a fixture git repository:
 * seeding, the walk, the grouping, the renderers and the checks before them.
 *
 * Two indexed repos share one base commit (tag `C1`), each with its own
 * second commit, because `C1...HEAD` is cumulative and the cases need
 * different diffs:
 *   - repo A: C2 edits only the body of `helper`;
 *   - repo B: C2 edits the body of `Cache.get`, adds a top-of-file comment to
 *     src/b.ts, deletes lib/standalone.ts and adds README.md.
 * The working-tree cases and the no-index message need no index, so they use a
 * plain git repository. A fourth fixture indexes a subdirectory of its
 * repository.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { changedFiles, refExists } from '../src/graph/git-diff';
import { BLAST_WALK_KINDS, blastRadius, type BlastReport } from '../src/graph/blast';
import { markdownReport, textReport } from '../src/graph/blast-render';
import { runBlast, type BlastArgs } from '../src/graph/blast-run';
import { openBlastStore } from '../src/graph/blast-store';

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
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

/** The C1 tree. Line numbers matter: `helper` spans L1-L3 of src/util.ts, `Cache.get` L2-L4 of src/cache.ts. */
const C1_FILES: Record<string, string> = {
  'src/util.ts': 'export function helper(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n',
  'src/a.ts': "import { helper } from './util';\n\nexport function useA(): number {\n  return helper();\n}\n",
  'src/b.ts': "import { useA } from './a';\n\nexport function useB(): number {\n  return useA();\n}\n",
  'src/c.ts': "import { useB } from './b';\n\nexport function useC(): number {\n  return useB();\n}\n",
  // Calls `other`, so a walk that wrongly seeds `other` (or the whole util.ts) reaches it.
  'src/d.ts': "import { other } from './util';\n\nexport function useOther(): number {\n  return other();\n}\n",
  'src/cache.ts': 'export class Cache {\n  get(): number {\n    return 1;\n  }\n\n  put(): void {\n    return;\n  }\n}\n',
  'tests/util.test.ts': "import { helper } from '../src/util';\n\nexport function checkHelper(): boolean {\n  return helper() === 1;\n}\n",
  'lib/standalone.ts': 'export function lonely(): number {\n  return 0;\n}\n',
};

/** A temp git repo at commit C1 (tagged `C1`). */
function repoAtC1(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  return root;
}

async function index(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

/** The report text of a run that must succeed. */
function output(root: string, args: BlastArgs): string {
  const r = runBlast(root, args);
  if (!r.ok) throw new Error(`blast failed: ${r.message}`);
  return r.output;
}

/** The message of a run that must fail. */
function message(root: string, args: BlastArgs): string {
  const r = runBlast(root, args);
  if (r.ok) throw new Error('blast succeeded where it should have failed');
  return r.message;
}

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe('blast on repo A (C2 edits the body of helper)', () => {
  let root = '';
  let report: BlastReport;

  beforeAll(async () => {
    root = repoAtC1('cg-blast-a-');
    write(root, 'src/util.ts', C1_FILES['src/util.ts'].replace('return 1;', 'return 42;'));
    git(root, 'commit', '-q', '-am', 'C2: helper body');
    await index(root);
    report = JSON.parse(output(root, { base: 'C1', format: 'json' })) as BlastReport;
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('walks exactly the seven dependency edge kinds', () => {
    expect([...BLAST_WALK_KINDS].sort()).toEqual(
      ['calls', 'decorates', 'extends', 'implements', 'imports', 'instantiates', 'references'],
    );
  });

  it('diffs the merge-base range C1...HEAD at the default depth 2', () => {
    expect(report.basis).toBe('C1...HEAD');
    expect(report.depth).toBe(2);
    expect(report.changed.map((c) => [c.path, c.status])).toEqual([['src/util.ts', 'modified']]);
    expect(report.changed[0].ranges).toEqual([{ start: 2, end: 2 }]);
  });

  it('seeds only helper, as a symbol seed, not other or the file', () => {
    expect(report.seeds).toHaveLength(1);
    expect(report.seeds[0]).toMatchObject({
      name: 'helper', kind: 'function', path: 'src/util.ts', span: 'L1-L3', wholeFile: false,
    });
  });

  it('reaches useA at depth 1 by calls and useB at depth 2, not useC', () => {
    const useA = report.impacted.find((i) => i.name === 'useA');
    const useB = report.impacted.find((i) => i.name === 'useB');
    expect(useA).toMatchObject({ path: 'src/a.ts', relation: 'calls', depth: 1 });
    expect(useB).toMatchObject({ path: 'src/b.ts', relation: 'calls', depth: 2 });
    expect(names(report.impacted)).not.toContain('useC');
    expect(report.impacted.every((i) => i.depth <= 2)).toBe(true);
  });

  it("does not reach other's callers", () => {
    expect(names(report.impacted)).not.toContain('useOther');
    expect(report.impacted.some((i) => i.path === 'src/d.ts')).toBe(false);
  });

  it('groups dependents into the src/ module, leaving out hits inside the changed file', () => {
    const src = report.modules.find((m) => m.key === 'src/');
    expect(src).toBeDefined();
    expect(src!.labelSource).toBe('symbol');
    expect(src!.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(src!.files).not.toContain('src/util.ts');
    expect(src!.from).toEqual(['src/util.ts']);
    for (const m of [...report.modules, ...report.testModules]) {
      expect(m.symbols.some((s) => s.path === 'src/util.ts')).toBe(false);
    }
  });

  it('splits the test file into testModules', () => {
    expect(report.testModules.flatMap((m) => m.files)).toContain('tests/util.test.ts');
    expect(report.modules.flatMap((m) => m.files)).not.toContain('tests/util.test.ts');
  });

  it('marks the src/ area as reached by an unchanged test (stale)', () => {
    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]).toMatchObject({
      key: 'src/', files: ['src/util.ts'], seeds: 1, behavioural: 1, reached: 1,
      tests: 'stale', testFiles: ['tests/util.test.ts'], changedTestFiles: [],
    });
  });

  it('depth all reaches useC at depth 3 and JSON prints depth as null', () => {
    const full = JSON.parse(output(root, { base: 'C1', depth: 'all', format: 'json' })) as {
      depth: unknown; impacted: { name: string; depth: number }[];
    };
    expect(full.depth).toBeNull();
    expect(full.impacted.find((i) => i.name === 'useC')).toMatchObject({ depth: 3 });
  });

  it('with no base on a clean tree diffs the last commit', () => {
    expect((JSON.parse(output(root, { format: 'json' })) as BlastReport).basis).toBe('HEAD~1...HEAD');
  });

  it('an unknown base fails with the not-in-checkout message', () => {
    expect(message(root, { base: 'no-such-ref' })).toContain('base ref "no-such-ref" is not in this checkout.');
  });

  it('refuses depth 0, a non-numeric depth and an unknown format', () => {
    expect(message(root, { base: 'C1', depth: '0' })).toContain('depth must be a positive number or "all"');
    expect(message(root, { base: 'C1', depth: 'deep' })).toContain('depth must be a positive number or "all"');
    expect(message(root, { base: 'C1', format: 'xml' })).toContain('format must be text, markdown or json');
  });

  it('refExists tells a known ref from an unknown one', () => {
    expect(refExists(root, 'C1')).toBe(true);
    expect(refExists(root, 'no-such-ref')).toBe(false);
  });

  it('the text report first line names the basis and the depth', () => {
    expect(output(root, { base: 'C1' }).split('\n')[0]).toBe('blast radius — C1...HEAD (depth 2)');
    expect(output(root, { base: 'C1', depth: 'all', format: 'text' }).split('\n')[0])
      .toBe('blast radius — C1...HEAD (full closure)');
  });

  it('textReport on the computed report matches the text run', () => {
    const text = output(root, { base: 'C1' });
    const store = openBlastStore(root);
    try {
      const cs = changedFiles(root, 'C1');
      expect(cs).not.toBeNull();
      expect(textReport(blastRadius(store, cs!.files, cs!.basis, 2))).toBe(text);
    } finally {
      store.close();
    }
  });

  it('the markdown report opens with its header and ends with a footer naming basis, depth and changed files', () => {
    const lines = output(root, { base: 'C1', format: 'markdown' }).trimEnd().split('\n');
    expect(lines[0]).toBe('### blast radius');
    expect(lines[lines.length - 1]).toBe('<sub>`codegraph blast` · C1...HEAD · depth 2 · 1 changed file</sub>');
  });

  it('the markdown table names the depth-1 dependent useA, reached from the helper area', () => {
    const md = output(root, { base: 'C1', format: 'markdown' });
    const row = md.split('\n').find((l) => l.startsWith('| useA |'));
    expect(row).toBeDefined();
    expect(row).toMatch(/useA — calls, depth 1/);
    expect(row).toMatch(/\| helper \|$/);
    expect(md).toContain('**helper**');
  });

  it('queries incoming edges once per depth level, not per node', () => {
    const store = openBlastStore(root);
    try {
      const cs = changedFiles(root, 'C1');
      expect(cs).not.toBeNull();
      const spy = vi.spyOn(store, 'incomingEdges');
      const depth = 2;
      const r = blastRadius(store, cs!.files, cs!.basis, depth);
      expect(r.impacted.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(depth * cs!.files.length);
    } finally {
      store.close();
    }
  });
});

describe('blast on repo B (method edit, top-of-file comment, deletion, added .md)', () => {
  let root = '';
  let report: BlastReport;

  beforeAll(async () => {
    root = repoAtC1('cg-blast-b-');
    write(root, 'src/cache.ts', C1_FILES['src/cache.ts'].replace('return 1;', 'return 7;'));
    write(root, 'src/b.ts', `// a note above the imports\n${C1_FILES['src/b.ts']}`);
    fs.rmSync(path.join(root, 'lib/standalone.ts'));
    write(root, 'README.md', '# fixture\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C2: method, comment, delete, readme');
    await index(root);
    report = JSON.parse(output(root, { base: 'C1', format: 'json' })) as BlastReport;
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('an edit inside a class method seeds the method, not the class', () => {
    const cacheSeeds = report.seeds.filter((s) => s.path === 'src/cache.ts');
    expect(cacheSeeds).toHaveLength(1);
    expect(cacheSeeds[0]).toMatchObject({ name: 'get', kind: 'method', span: 'L2-L4', wholeFile: false });
    expect(names(report.seeds)).not.toContain('Cache');
  });

  it('a change outside any symbol seeds the file node as wholeFile', () => {
    const bSeeds = report.seeds.filter((s) => s.path === 'src/b.ts');
    expect(bSeeds).toHaveLength(1);
    expect(bSeeds[0]).toMatchObject({ kind: 'file', wholeFile: true });
  });

  it('the file seed reaches its importers through imports edges', () => {
    const fromC = report.impacted.filter((i) => i.path === 'src/c.ts');
    expect(fromC.some((i) => i.relation === 'imports' && i.depth === 1)).toBe(true);
    // useB is in the changed file but was not edited, so it is not a seed.
    expect(names(report.seeds)).not.toContain('useB');
  });

  it('a deleted file is reported as deleted, not seeded', () => {
    expect(report.deleted).toEqual(['lib/standalone.ts']);
    expect(report.seeds.some((s) => s.path === 'lib/standalone.ts')).toBe(false);
  });

  it('an added file no parser claims is reported as unindexed', () => {
    expect(report.unindexed).toEqual(['README.md']);
    expect(report.seeds.some((s) => s.path === 'README.md')).toBe(false);
  });
});

describe('working-tree basis (git only, no index)', () => {
  let root = '';

  beforeAll(() => {
    root = repoAtC1('cg-blast-tree-');
    write(root, 'src/util.ts', C1_FILES['src/util.ts'].replace('return 2;', 'return 3;'));
    git(root, 'commit', '-q', '-am', 'C2');
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a clean tree falls back to HEAD~1...HEAD', () => {
    const cs = changedFiles(root);
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('HEAD~1...HEAD');
    expect(cs!.files.map((f) => f.path)).toEqual(['src/util.ts']);
    expect(cs!.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
  });

  // Runs after the clean-tree test above: it dirties the shared repo.
  it('a dirty tree diffs the working tree against HEAD', () => {
    write(root, 'src/a.ts', `${C1_FILES['src/a.ts']}// trailing note\n`);
    const cs = changedFiles(root);
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('working tree vs HEAD');
    expect(cs!.files.map((f) => [f.path, f.status])).toEqual([['src/a.ts', 'modified']]);
    expect(cs!.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
  });

  it('a base B uses B...HEAD', () => {
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD');
    expect(cs!.files.map((f) => f.path)).toEqual(['src/util.ts']);
  });

  it('with no index, blast fails with the not-initialized message', () => {
    expect(message(root, { base: 'C1' })).toContain(`CodeGraph not initialized in ${root}`);
  });

  it('changedFiles returns null outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-nogit-'));
    try {
      expect(changedFiles(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

/**
 * The repository holds `pkg/` (the indexed project) and `other/` (outside it).
 * C2 edits the body of `helper` in pkg/src/util.ts and a file in other/. File
 * ids are relative to `pkg/` (`src/util.ts`), so the diff has to be read
 * relative to `pkg/` and restricted to it: read from the repository root, the
 * changed file would be `pkg/src/util.ts`, match no index entry and be
 * reported unindexed, and other/ would leak into `changed`.
 */
describe('blast on a CodeGraph project in a subdirectory of the git repository', () => {
  const UTIL = 'export function helper(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n';
  const USE = "import { helper } from './util';\n\nexport function useHelper(): number {\n  return helper();\n}\n";
  let repo = '';
  let report: BlastReport;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-sub-'));
    git(repo, 'init', '-q');
    write(repo, 'pkg/src/util.ts', UTIL);
    write(repo, 'pkg/src/use.ts', USE);
    write(repo, 'other/outside.ts', 'export function outside(): number {\n  return 0;\n}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'C1');
    git(repo, 'tag', 'C1');
    write(repo, 'pkg/src/util.ts', UTIL.replace('return 1;', 'return 42;'));
    write(repo, 'other/outside.ts', 'export function outside(): number {\n  return 7;\n}\n');
    git(repo, 'commit', '-q', '-am', 'C2: helper body and a file outside pkg');
    const pkg = path.join(repo, 'pkg');
    await index(pkg);
    report = JSON.parse(output(pkg, { base: 'C1', format: 'json' })) as BlastReport;
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('seeds the changed function by name, from a project-relative path', () => {
    expect(report.seeds.map((s) => [s.name, s.wholeFile])).toEqual([['helper', false]]);
    expect(report.unindexed).toEqual([]);
  });

  it('lists only the project file in changed, relative to the project root', () => {
    expect(report.changed.map((c) => [c.path, c.ranges])).toEqual([['src/util.ts', [{ start: 2, end: 2 }]]]);
  });
});

describe('markdownReport collapsed symbol list', () => {
  /** A report with one module of `n` dependents of src/x.ts, and nothing else. */
  function reportWith(n: number): BlastReport {
    const symbols = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`, name: `dep${i}`, kind: 'function', path: 'lib/y.ts', span: `L${i + 1}-L${i + 1}`,
      relation: 'calls', depth: 1,
    }));
    return {
      basis: 'C1...HEAD', depth: 2,
      changed: [{ path: 'src/x.ts', status: 'modified', ranges: [{ start: 1, end: 1 }], hunks: [] }],
      unindexed: [], deleted: [], seeds: [], impacted: symbols,
      modules: [{ label: 'lib', labelSource: 'symbol', key: 'lib/', files: ['lib/y.ts'], symbols, from: ['src/x.ts'] }],
      testModules: [], areas: [],
    };
  }

  const rows = (md: string): string[] => md.split('\n').filter((l) => l.startsWith('- `lib/y.ts:'));

  it('with 61 dependents lists 60 and says 1 further symbol is not listed', () => {
    const md = markdownReport(reportWith(61));
    expect(rows(md)).toHaveLength(60);
    expect(md).toContain('…1 further symbol not listed.');
  });

  it('with exactly 60 dependents lists all 60 and prints no further-symbols line', () => {
    const md = markdownReport(reportWith(60));
    expect(rows(md)).toHaveLength(60);
    expect(md).not.toContain('further symbol');
  });
});

/**
 * The fixture is a real SQLite file at `.codegraph/codegraph.db` holding one
 * unrelated table, so the read-only open succeeds and the store's first
 * statement (`... FROM nodes`) fails to prepare.
 */
describe('openBlastStore on an index without the expected tables', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('throws the prepare error and closes the connection it opened', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-store-'));
    dirs.push(root);
    const dbPath = getDatabasePath(root);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { db } = createDatabase(dbPath);
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.close();

    // The spy calls through; it only records the connection openBlastStore got,
    // which the store never hands back once its setup throws.
    const open = vi.spyOn(DatabaseConnection, 'open');
    let conn: DatabaseConnection | undefined;
    try {
      expect(() => openBlastStore(root)).toThrow(/no such table: nodes/);
      expect(open).toHaveBeenCalledTimes(1);
      // The open itself returned, so the throw came from the store's setup.
      expect(open.mock.results[0]?.type).toBe('return');
      conn = open.mock.results[0]?.value as DatabaseConnection;
      expect(conn.isOpen()).toBe(false);
    } finally {
      // A failing run must not leave the handle open on the temp dir.
      if (conn?.isOpen()) conn.close();
    }
  });
});
