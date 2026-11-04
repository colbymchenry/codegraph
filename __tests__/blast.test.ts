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

describe('blast changed-line ownership', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  function fixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-lines-'));
    roots.push(root);
    git(root, 'init', '-q');
    for (const [rel, content] of Object.entries(files)) write(root, rel, content);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'tag', 'base');
    return root;
  }

  /** The post-image line numbers in 1..`last` that some range covers. */
  function coveredLines(ranges: { start: number; end: number }[], last: number): number[] {
    const out: number[] = [];
    for (let n = 1; n <= last; n++) if (ranges.some((r) => r.start <= n && n <= r.end)) out.push(n);
    return out;
  }

  it.each([false, true])('reads a base diff in working-tree line numbers when the tree has uncommitted edits (staged=%s)', async (staged) => {
    const original = 'export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n';
    const root = fixture({ 'src/value.ts': original });
    const committed = original.replace('return 2;', 'return 20;');
    write(root, 'src/value.ts', committed);
    git(root, 'commit', '-q', '-am', 'change second');
    // Four comment lines above the change move the changed line of `second` from 6 to 10 on disk.
    write(root, 'src/value.ts', '// one\n// two\n// three\n// four\n' + committed);
    if (staged) git(root, 'add', 'src/value.ts');
    await index(root);
    const diff = changedFiles(root, 'base')!;
    expect(diff.basis).toBe('base...HEAD plus uncommitted changes');
    const lines = coveredLines(diff.files[0].ranges, 12);
    expect(lines).toEqual(expect.arrayContaining([1, 2, 3, 4, 10]));
    expect(lines).not.toContain(6);
    const store = openBlastStore(root);
    try {
      expect(names(store.symbolsOverlapping('src/value.ts', 10, 10))).toEqual(['second']);
    } finally { store.close(); }
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(names(report.seeds)).toContain('second');
    expect(names(report.seeds)).not.toContain('first');
  });

  it('labels a base diff on a clean tree base...HEAD and seeds the changed function', async () => {
    const original = 'export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n';
    const root = fixture({ 'src/value.ts': original });
    write(root, 'src/value.ts', original.replace('return 2;', 'return 20;'));
    git(root, 'commit', '-q', '-am', 'change second');
    await index(root);
    const diff = changedFiles(root, 'base')!;
    expect(diff.basis).toBe('base...HEAD');
    expect(diff.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(names(report.seeds)).toEqual(['second']);
  });

  it('reports a committed change and an uncommitted edit to another tracked file together', () => {
    const root = fixture({
      'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
      'src/b.ts': 'export function beta(): number {\n  return 1;\n}\n',
    });
    write(root, 'src/a.ts', 'export function alpha(): number {\n  return 2;\n}\n');
    git(root, 'commit', '-q', '-am', 'change alpha');
    write(root, 'src/b.ts', 'export function beta(): number {\n  return 3;\n}\n');
    const diff = changedFiles(root, 'base')!;
    expect(diff.basis).toBe('base...HEAD plus uncommitted changes');
    expect(diff.files.map((f) => [f.path, f.ranges])).toEqual([
      ['src/a.ts', [{ start: 2, end: 2 }]],
      ['src/b.ts', [{ start: 2, end: 2 }]],
    ]);
  });

  it('keeps a changed class declaration and its changed method from the same hunk', async () => {
    const root = fixture({
      'src/value.ts': 'class First {}\nclass Second {}\nexport class Changed extends First {\n  run() { return 1; }\n}\n',
      'src/use.ts': "import { Changed } from './value';\nexport class Child extends Changed {}\nexport function construct() { return new Changed(); }\n",
    });
    write(root, 'src/value.ts', 'class First {}\nclass Second {}\nexport class Changed extends Second {\n  run() { return 2; }\n}\n');
    git(root, 'commit', '-q', '-am', 'change class and method');
    await index(root);
    expect(changedFiles(root, 'base')!.files[0].ranges).toEqual([{ start: 3, end: 4 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(names(report.seeds)).toEqual(['Changed', 'run']);
    expect(names(report.impacted)).toEqual(expect.arrayContaining(['Child', 'construct']));
  });

  it('a block comment followed by code on the same line is code', async () => {
    const root = fixture({
      'src/value.ts': 'class First {}\nclass Second {}\nexport class Changed extends First {\n  run() { return 1; }\n}\n',
      'src/use.ts': "import { Changed } from './value';\nexport class Child extends Changed {}\nexport function construct() { return new Changed(); }\n",
    });
    write(root, 'src/value.ts', 'class First {}\nclass Second {}\n/* base changed */ export class Changed extends Second {\n  run() { return 2; }\n}\n');
    git(root, 'commit', '-q', '-am', 'change class header and method');
    await index(root);
    expect(changedFiles(root, 'base')!.files[0].ranges).toEqual([{ start: 3, end: 4 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(names(report.seeds)).toEqual(['Changed', 'run']);
    expect(names(report.impacted)).toEqual(expect.arrayContaining(['Child', 'construct']));
  });

  it('adding a method to a class seeds the method and not the class', async () => {
    const before = 'export class Cache {\n  get(): number {\n    return 1;\n  }\n}\n';
    const root = fixture({ 'src/cache.ts': before });
    // The added blank line sits inside the class, so the hunk overlaps the class too; that
    // blank line is set aside, and the method is the innermost owner of the rest.
    write(root, 'src/cache.ts', 'export class Cache {\n  get(): number {\n    return 1;\n  }\n\n  put(): void {\n    return;\n  }\n}\n');
    git(root, 'commit', '-q', '-am', 'add put');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['put', 'method', false]]);
  });

  it('adding a function after another, with a blank line between, seeds only the new function', async () => {
    const before = 'export function first(): number {\n  return 1;\n}\n';
    const root = fixture({ 'src/value.ts': before });
    write(root, 'src/value.ts', `${before}\nexport function second(): number {\n  return 2;\n}\n`);
    git(root, 'commit', '-q', '-am', 'add second');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['second', 'function', false]]);
  });

  it('editing a function together with the comment above it seeds the function and the file', async () => {
    const before = '// Returns one.\nexport function value(): number {\n  return 1;\n}\n';
    const root = fixture({ 'src/value.ts': before });
    // A comment line outside every symbol counts as code.
    write(root, 'src/value.ts', "// Returns two.\nexport function value(): string {\n  return '2';\n}\n");
    git(root, 'commit', '-q', '-am', 'change value');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => s.wholeFile ? [s.kind, s.wholeFile] : [s.name, s.kind, s.wholeFile]))
      .toEqual([['value', 'function', false], ['file', true]]);
  });

  it('a line starting with * outside a block comment is code', async () => {
    const before = 'export const total = 1\nexport function scale(): number {\n  return 1;\n}\n';
    const root = fixture({ 'src/value.ts': before });
    // `* 2;` continues the initializer of `total` as a multiplication. A `*` line is
    // code here, so it owns its line rather than being set aside as a comment.
    write(root, 'src/value.ts', 'export const total = 1\n  * 2;\nexport function scale(n: number): number {\n  return 1;\n}\n');
    git(root, 'commit', '-q', '-am', 'continue the initializer and take a parameter');
    await index(root);
    expect(changedFiles(root, 'base')!.files[0].ranges).toEqual([{ start: 2, end: 3 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([
      ['total', 'constant', false],
      ['scale', 'function', false],
    ]);
  });

  it('a module-level statement changed in the same hunk as a function body seeds the function and the file', async () => {
    const before = 'export const registry = new Set<() => number>();\nexport function helper(): number { return 1; }\n';
    const root = fixture({ 'src/registry.ts': before });
    write(root, 'src/registry.ts', 'export const registry = new Set<() => number>();\nexport function helper(): number { return 2; }\nregistry.add(helper);\n');
    git(root, 'commit', '-q', '-am', 'register helper');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.kind, s.wholeFile])).toEqual([['function', false], ['file', true]]);
    expect(report.seeds[0].name).toBe('helper');
  });

  it.each([false, true])('seeds the file alongside a function for an uncovered import (one hunk=%s)', async (oneHunk) => {
    const before = oneHunk ? "import './before';\nexport function helper() { return 1; }\n"
      : "import './before';\n\nexport function helper() {\n  return 1;\n}\n";
    const root = fixture({
      'src/value.ts': before,
      'src/use.ts': "import './value';\nexport const ready = 1;\n",
      'src/before.ts': 'console.log(1);\n', 'src/after.ts': 'console.log(2);\n',
    });
    write(root, 'src/value.ts', before.replace('./before', './after').replace('return 1;', 'return 2;'));
    git(root, 'commit', '-q', '-am', 'change import and function');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map(s => [s.kind, s.wholeFile])).toEqual([['function', false], ['file', true]]);
    expect(report.impacted.some(n => n.path === 'src/use.ts')).toBe(true);
  });

  it('a blank line that replaces a removed line is code', async () => {
    const root = fixture({
      'src/value.ts': "import './before';\nexport function helper() { return 1; }\n",
      'src/use.ts': "import './value';\nexport const ready = 1;\n",
      'src/before.ts': 'console.log(1);\n',
    });
    write(root, 'src/value.ts', '\nexport function helper() { return 2; }\n');
    git(root, 'commit', '-q', '-am', 'remove the import and change helper');
    await index(root);
    expect(changedFiles(root, 'base')!.files[0].ranges).toEqual([{ start: 1, end: 2 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.kind, s.wholeFile])).toEqual([['function', false], ['file', true]]);
    expect(report.impacted.some((n) => n.path === 'src/use.ts')).toBe(true);
  });

  it('commenting out a module-level import beside a function edit seeds the file', async () => {
    const root = fixture({
      'src/value.ts': "import './before';\nexport function helper() { return 1; }\n",
      'src/use.ts': "import './value';\nexport const ready = 1;\n",
      'src/before.ts': 'console.log(1);\n',
    });
    write(root, 'src/value.ts', "// import './before';\nexport function helper() { return 2; }\n");
    git(root, 'commit', '-q', '-am', 'comment out the import and change helper');
    await index(root);
    expect(changedFiles(root, 'base')!.files[0].ranges).toEqual([{ start: 1, end: 2 }]);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.kind, s.wholeFile])).toEqual([['function', false], ['file', true]]);
    expect(report.impacted.some((n) => n.path === 'src/use.ts')).toBe(true);
  });

  it.each(['memo', 'forwardRef'])('counts a changed %s component as behavioural code reached by tests', async (wrapper) => {
    const source = `import { ${wrapper} } from 'react';\nexport const Card = ${wrapper}((props) => <div>before</div>);\n`;
    const root = fixture({
      'src/Card.tsx': source,
      'tests/Card.test.tsx': "import { Card } from '../src/Card';\nexport function check() { return <Card />; }\n",
    });
    write(root, 'src/Card.tsx', source.replace('before', 'after'));
    git(root, 'commit', '-q', '-am', 'change component');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds).toEqual([expect.objectContaining({ name: 'Card', kind: 'component' })]);
    expect(report.areas[0]).toMatchObject({ behavioural: 1, reached: 1, tests: 'stale', testFiles: ['tests/Card.test.tsx'] });
  });

  it('keeps a changed properties value out of the JSON report, and still lists the file with its hunk lines', async () => {
    const root = fixture({
      'src/main/resources/application.properties': 'db.password=OLDSECRET\n',
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\n',
    });
    write(root, 'src/main/resources/application.properties', 'db.password=NEWSECRET\n');
    git(root, 'commit', '-q', '-am', 'rotate the password');
    await index(root);
    const out = output(root, { base: 'base', format: 'json' });
    expect(out).not.toContain('OLDSECRET');
    expect(out).not.toContain('NEWSECRET');
    const props = (JSON.parse(out) as BlastReport).changed.find((c) => c.path === 'src/main/resources/application.properties');
    expect(props).toMatchObject({ status: 'modified', ranges: [{ start: 1, end: 1 }] });
    expect(props?.hunks.map((h) => ({ start: h.start, end: h.end, lines: h.lines }))).toEqual([
      { start: 1, end: 1, lines: [{ n: null, sign: '-' }, { n: 1, sign: '+' }] },
    ]);
  });

  it('writes each changed hunk line in the JSON with its number and sign only, for indexed code and other files alike', async () => {
    const root = fixture({
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\n',
      '.env': 'API_KEY=OLDSECRET\n',
    });
    write(root, 'src/u.ts', 'export function a(): number {\n  return 2;\n}\n');
    write(root, '.env', 'API_KEY=NEWSECRET\n');
    git(root, 'commit', '-q', '-am', 'change a and the key');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    const lines = report.changed.flatMap((c) => c.hunks.flatMap((h) => h.lines));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['n', 'sign']);
  });

  it('the text and markdown reports print no hunk text', async () => {
    const root = fixture({
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\n',
      'src/main/resources/application.properties': 'db.password=OLDSECRET\n',
    });
    write(root, 'src/main/resources/application.properties', 'db.password=NEWSECRET\n');
    git(root, 'commit', '-q', '-am', 'rotate the password');
    await index(root);
    for (const format of ['text', 'markdown']) {
      const out = output(root, { base: 'base', format });
      expect(out).toMatch(/blast radius/);
      expect(out).not.toContain('OLDSECRET');
      expect(out).not.toContain('NEWSECRET');
    }
  });

  /**
   * Index a repository whose second commit removes `b`, the function after `a`
   * in `src/u.ts`; `src/c.ts` imports `a` and calls it from `useA`.
   */
  async function indexAfterRemovingSecondFunction(): Promise<string> {
    const root = fixture({
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n',
      'src/c.ts': "import { a } from './u';\nexport function useA(): number {\n  return a();\n}\n",
    });
    write(root, 'src/u.ts', 'export function a(): number {\n  return 1;\n}\n');
    git(root, 'commit', '-q', '-am', 'remove b');
    await index(root);
    return root;
  }

  it('deleting a whole function after another seeds the file, not the function before it', async () => {
    const root = await indexAfterRemovingSecondFunction();
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds).toEqual([expect.objectContaining({ kind: 'file', path: 'src/u.ts', wholeFile: true })]);
  });

  it('deleting a whole function after another does not report the caller of the function before it', async () => {
    const root = await indexAfterRemovingSecondFunction();
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(names(report.impacted)).not.toContain('useA');
  });

  it('deleting a line inside a function body seeds that function and not the one before it', async () => {
    const root = fixture({
      'src/value.ts': 'export function first(): number {\n  return 1;\n}\n\nexport function compute(): number {\n  const a = 1;\n  const b = a;\n  return a;\n}\n',
    });
    write(root, 'src/value.ts', 'export function first(): number {\n  return 1;\n}\n\nexport function compute(): number {\n  const a = 1;\n  return a;\n}\n');
    git(root, 'commit', '-q', '-am', 'drop a line from compute');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['compute', 'function', false]]);
  });

  it('deleting a blank line inside a function body seeds that function', async () => {
    const root = fixture({
      'src/value.ts': 'export function compute(): number {\n  const a = 1;\n\n  return a;\n}\n',
    });
    write(root, 'src/value.ts', 'export function compute(): number {\n  const a = 1;\n  return a;\n}\n');
    git(root, 'commit', '-q', '-am', 'drop the blank line in compute');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['compute', 'function', false]]);
  });

  it('deleting only the blank line between two functions seeds nothing', async () => {
    const root = fixture({
      'src/value.ts': 'export function first(): number {\n  return 1;\n}\n\nexport function second(): number {\n  return 2;\n}\n',
    });
    write(root, 'src/value.ts', 'export function first(): number {\n  return 1;\n}\nexport function second(): number {\n  return 2;\n}\n');
    git(root, 'commit', '-q', '-am', 'remove the blank line between the functions');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.changed.map((c) => c.path)).toEqual(['src/value.ts']);
    expect(report.seeds).toEqual([]);
  });

  // git-diff.ts keeps MAX_HUNK_LINES = 24 edited lines per hunk and MAX_FILE_LINES = 200 per file (its counter takes
  // every added or removed line of the file, in patch order). Each hunk is judged on all its lines, not only the
  // text the caps keep. Each fixture's hunk header was checked with `git diff --unified=0`.

  /** A function `name` whose body is an array literal of `count` string elements, each named `<name>-<tag>-<i>`. */
  function arrayFunction(name: string, tag: string, count: number): string {
    const items = Array.from({ length: count }, (_, i) => `    '${name}-${tag}-${i + 1}',`);
    return [`export function ${name}(): string[] {`, '  return [', ...items, '  ];', '}'].join('\n') + '\n';
  }

  const EXISTING = 'export function existing(): number {\n  return 1;\n}\n';
  const IMPORTER = "import { existing } from './lib';\nexport function useExisting(): number {\n  return existing();\n}\n";
  // `fresh` (30 lines) and one blank go above `existing`: `@@ -0,0 +1,31 @@`, so the blank is line 31, past the
  // 24 added lines the hunk keeps.
  const FRESH_ABOVE = `${arrayFunction('fresh', 'new', 26)}\n${EXISTING}`;

  it('a 30-line function inserted above an exported function seeds that function, not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = fixture({ 'src/lib.ts': EXISTING, 'src/user.ts': IMPORTER });
    write(root, 'src/lib.ts', FRESH_ABOVE);
    git(root, 'commit', '-q', '-am', 'add fresh above existing');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['fresh', 'function', false]]);
  });

  it('a 30-line function inserted above an exported function does not reach the importer of the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // A file seed walks the imports edge from src/user.ts, so it would list src/user.ts among the impacted.
    const root = fixture({ 'src/lib.ts': EXISTING, 'src/user.ts': IMPORTER });
    write(root, 'src/lib.ts', FRESH_ABOVE);
    git(root, 'commit', '-q', '-am', 'add fresh above existing');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.impacted.map((i) => i.path)).not.toContain('src/user.ts');
  });

  it('a short function and its blank separator, after earlier edits fill the per-file cap, seed that function, not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // Base: f1..f4, 34 lines each (lines 1-136), then `last`. The change rewrites every element of f1..f4:
    // `@@ -3,30 +3,30 @@`, `@@ -37,30 +37,30 @@`, `@@ -71,30 +71,30 @@`, `@@ -105,30 +105,30 @@`, 240 edited
    // lines, past the 200-line file cap. Then `fresh` and a blank go above `last`: `@@ -136,0 +137,4 @@`, a hunk
    // the file cap drops whole, blank included.
    const last = 'export function last(): number {\n  return 1;\n}\n';
    const root = fixture({ 'src/lib.ts': ['f1', 'f2', 'f3', 'f4'].map((n) => arrayFunction(n, 'old', 30)).join('') + last });
    write(root, 'src/lib.ts', ['f1', 'f2', 'f3', 'f4'].map((n) => arrayFunction(n, 'new', 30)).join('')
      + 'export function fresh(): number {\n  return 2;\n}\n\n' + last);
    git(root, 'commit', '-q', '-am', 'rewrite f1..f4 and add fresh');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds.filter((s) => s.wholeFile)).toEqual([]);
    expect(names(report.seeds)).toContain('fresh');
  });

  it('deleting 30 blank lines between two functions seeds nothing', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // `@@ -4,30 +3,0 @@`: the hunk keeps 24 of its 30 removed lines.
    const first = 'export function first(): number {\n  return 1;\n}\n';
    const second = 'export function second(): number {\n  return 2;\n}\n';
    const root = fixture({ 'src/value.ts': first + '\n'.repeat(30) + second });
    write(root, 'src/value.ts', first + second);
    git(root, 'commit', '-q', '-am', 'remove the blank lines between the functions');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.changed.map((c) => c.path)).toEqual(['src/value.ts']);
    expect(report.seeds).toEqual([]);
  });

  // Control: the same insertion as above, but the line after `fresh` is code. A top-level `const` would not serve:
  // the extractor mints a constant node for it, which owns its own line.
  it('control: a 30-line function inserted above an exported function, followed by a code line, seeds the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // `@@ -0,0 +1,31 @@`, line 31 is `console.log('marker');`.
    const root = fixture({ 'src/lib.ts': EXISTING, 'src/user.ts': IMPORTER });
    write(root, 'src/lib.ts', `${arrayFunction('fresh', 'new', 26)}console.log('marker');\n${EXISTING}`);
    git(root, 'commit', '-q', '-am', 'add fresh and a marker above existing');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'file', path: 'src/lib.ts', wholeFile: true })]),
    );
  });

  // Control: a hunk that removes lines sets no blank line aside. Every non-blank added line lies inside `f` (L1-L34:
  // the `;` after its `}` is an empty statement, which mints no node), so only the blank on line 35, outside every
  // symbol, can seed the file. It passes with the fix because the hunk removed 33 lines; it would fail if the blank
  // lines of a hunk that removes lines were set aside.
  it('control: a blank replacing a module-level comment, in a hunk that removes lines, seeds the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // `@@ -3,33 +3,33 @@ export function f(): string[] {`: one hunk; the blank is line 35, past the 24 lines it keeps.
    const g = 'export function g(): number {\n  return 1;\n}\n';
    const root = fixture({ 'src/value.ts': arrayFunction('f', 'old', 30) + '// marker\n' + g });
    write(root, 'src/value.ts',
      arrayFunction('f', 'new', 30).replace('  ];\n}\n', '  ].slice();\n};\n') + '\n' + g);
    git(root, 'commit', '-q', '-am', 'rewrite f and replace the marker with a blank');
    await index(root);
    const report = JSON.parse(output(root, { base: 'base', format: 'json' })) as BlastReport;
    expect(report.seeds).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'file', path: 'src/value.ts', wholeFile: true })]),
    );
    expect(names(report.seeds)).toContain('f');  });
});

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

  // A base diff runs from the merge base to the working tree, so an uncommitted
  // edit is part of it. This test writes that edit itself rather than relying on
  // the dirty-tree test above having run first.
  it('a base B diffs from the merge base of B and HEAD to the working tree', () => {
    write(root, 'src/a.ts', `${C1_FILES['src/a.ts']}// trailing note\n`);
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD plus uncommitted changes');
    expect(cs!.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/util.ts']);
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
