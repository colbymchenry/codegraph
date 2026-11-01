/**
 * `codegraph orphans` (symbols added since a base ref that nothing uses) run
 * on a real CodeGraph index of a fixture git repo, through `runOrphans`.
 *
 * One repo: commit C1 (tagged), then C2 adds the symbols the cases need.
 * Every case reads the same JSON report, so the repo is indexed once at C2
 * in beforeAll.
 *
 * Symbols C2 adds, by rule (13 in all, the exact `added` count asserted):
 *   - rule 2, appended to the pre-existing src/existing.ts: lonelyNew,
 *     calledNew, testSomething, selfOnly (sigChange's signature line also
 *     changes, but its name is in the pre-image, so it is not added);
 *   - rule 1, new files: Impl + area (src/impl.ts), checkThing
 *     (tests/x.test.ts), dupName x2 (src/dup1.ts, src/dup2.ts),
 *     noImportTarget (src/glob1.ts), freshOne (src/fresh.ts),
 *     Widget + constructor (src/widget.ts).
 * The callers that reach the added symbols (useStable, caller3, caller1, make)
 * are already in C1, so they are not added themselves.
 *
 * The guess-edge cases first assert the edge metadata the index holds,
 * so a resolver change that alters the fixture's edges fails at the fixture
 * proof, not at the orphans assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { isGuess } from '../src/graph/orphans';
import { runOrphans, type OrphansArgs } from '../src/graph/orphans-run';
import { isCandidateEdge } from '../src/graph/suspects';

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

interface Entry {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  externalConformances?: string[];
}
interface GuessEdge {
  source: string;
  sourceName: string;
  sourcePath: string;
  line: number;
  kind: string;
  resolvedBy: string;
  confidence: number;
}
interface OrphansJson {
  basis: string;
  mergeBase: string;
  added: number;
  orphans: Entry[];
  guessed: (Entry & { edges: GuessEdge[]; mentions: { path: string; line: number }[] })[];
  excluded: { test: number; implementation: number; constructor: number };
  preImageUnread: number;
}

/** src/existing.ts at C1. sigChange is uncalled, so it would be an orphan if it were wrongly counted as added. */
const EXISTING_C1 =
  'export function stable(): number {\n  return 1;\n}\n\n' +
  'export function sigChange(a: number): number {\n  return a;\n}\n';

/** src/existing.ts at C2: sigChange's signature line changes; five functions are appended. */
const EXISTING_C2 =
  'export function stable(): number {\n  return 1;\n}\n\n' +
  'export function sigChange(a: number, b: number): number {\n  return a + b;\n}\n\n' +
  'export function lonelyNew(): number {\n  return 5;\n}\n\n' +
  'export function calledNew(): number {\n  return 6;\n}\n\n' +
  'export function testSomething(): void {\n  return;\n}\n\n' +
  'export function selfOnly(n: number): number {\n  return n <= 0 ? 0 : selfOnly(n - 1);\n}\n';

const C1_FILES: Record<string, string> = {
  'src/existing.ts': EXISTING_C1,
  'src/user.ts': "import { stable } from './existing';\n\nexport function useStable(): number {\n  return stable();\n}\n",
  'src/shape.ts': 'export interface Shape {\n  area(): number;\n}\n',
  // Calls dupName without an import; C2 declares dupName in two files, so the
  // resolver can only match by name among two candidates (exact-match, 0.4).
  'src/dup3.ts': 'export function caller3() { dupName(); }\n',
  // Calls noImportTarget without an import; C2 declares it once (exact-match, 0.9).
  'src/glob2.ts': 'export function caller1() { return noImportTarget(); }\n',
  'src/make.ts': "import { Widget } from './widget';\n\nexport function make(): unknown {\n  return new Widget();\n}\n",
};

const C2_FILES: Record<string, string> = {
  'src/existing.ts': EXISTING_C2,
  // useStable's body (not its declaration) now also calls calledNew, from another file.
  'src/user.ts':
    "import { stable, calledNew } from './existing';\n\nexport function useStable(): number {\n  return stable() + calledNew();\n}\n",
  'src/impl.ts': "import { Shape } from './shape';\n\nexport class Impl implements Shape {\n  area() { return 1; }\n}\n",
  'tests/x.test.ts': 'export function checkThing(): boolean {\n  return true;\n}\n',
  'src/dup1.ts': 'function dupName() {}\n',
  'src/dup2.ts': 'function dupName() {}\n',
  'src/glob1.ts': 'function noImportTarget() { return 1; }\n',
  'src/fresh.ts': 'export function freshOne(): number {\n  return 3;\n}\n',
  'src/widget.ts': 'export class Widget {\n  private n: number;\n  constructor() {\n    this.n = 1;\n  }\n}\n',
};

interface EdgeRow { source: string; target: string; kind: string; metadata: string | null }
interface NodeRow { id: string; name: string; kind: string; file_path: string; start_line: number }

let root = '';
let report: OrphansJson;
let c1Sha = '';
let nodes: NodeRow[] = [];
let edges: EdgeRow[] = [];

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-')));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  c1Sha = git(root, 'rev-parse', 'C1').trim();
  for (const [rel, content] of Object.entries(C2_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');

  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();

  // The index facts the cases depend on, read once.
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    nodes = db.prepare("SELECT id, name, kind, file_path, start_line FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as NodeRow[];
    edges = db.prepare("SELECT source, target, kind, metadata FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
  } finally {
    conn.close();
  }

  report = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);
const listed = (): string[] => [...names(report.orphans), ...names(report.guessed)];
const meta = (e: EdgeRow): { resolvedBy?: string; confidence?: number } =>
  (e.metadata ? JSON.parse(e.metadata) : {}) as { resolvedBy?: string; confidence?: number };
const nodesNamed = (name: string): NodeRow[] => nodes.filter((n) => n.name === name);

describe('orphans report basics', () => {
  it('basis is C1...HEAD and mergeBase is the C1 commit', () => {
    expect(report.basis).toBe('C1...HEAD');
    expect(report.mergeBase.length).toBeGreaterThanOrEqual(7);
    expect(c1Sha.startsWith(report.mergeBase)).toBe(true);
  });

  it('counts exactly the 13 added symbols (the re-signed sigChange is not one)', () => {
    expect(report.added).toBe(13);
  });

  it('reads every pre-image it needs', () => {
    expect(report.preImageUnread).toBe(0);
  });

  it('sorts both lists by path, then start line', () => {
    const start = (e: Entry): number => Number(/^L(\d+)-L\d+$/.exec(e.span)![1]);
    for (const list of [report.orphans, report.guessed as Entry[]]) {
      const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : start(a) - start(b)));
      expect(list.map((e) => `${e.path}:${e.span}`)).toEqual(sorted.map((e) => `${e.path}:${e.span}`));
    }
  });

  it('text format leads with the header and carries every section anchor', async () => {
    const text = await output(root, { base: 'C1', format: 'text' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(`orphans — C1...HEAD (merge base ${c1Sha.slice(0, 7)})`);
    expect(lines.some((l) => l.startsWith('orphaned ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('orphaned unless the guess is right ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('excluded:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('added symbols:'))).toBe(true);
    expect(text).toContain('lonelyNew');
    expect(text).toContain('freshOne');
  });
});

describe('orphans cases', () => {
  it('an added, uncalled function in a modified file is an orphan', () => {
    const e = report.orphans.find((o) => o.name === 'lonelyNew');
    expect(e).toMatchObject({ kind: 'function', path: 'src/existing.ts', span: 'L9-L11' });
    expect(names(report.guessed)).not.toContain('lonelyNew');
  });

  it('an added function called from another file is in neither list', () => {
    expect(listed()).not.toContain('calledNew');
  });

  it('fixture: Shape.area reaches Impl.area by a synthesized calls edge', () => {
    const implArea = nodesNamed('area').find((n) => n.file_path === 'src/impl.ts');
    expect(implArea).toBeDefined();
    expect(edges.some((e) => e.target === implArea!.id && e.kind === 'calls')).toBe(true);
  });

  it('an added method implementing an interface member is excluded as implementation', () => {
    expect(listed()).not.toContain('area');
    expect(report.excluded.implementation).toBeGreaterThanOrEqual(1);
  });

  it('an added function in a test file and one named testSomething are excluded as tests', () => {
    expect(listed()).not.toContain('checkThing');
    expect(listed()).not.toContain('testSomething');
    expect(report.excluded.test).toBeGreaterThanOrEqual(2);
  });

  it('fixture: caller3 reaches a dupName only by a multi-candidate name match (confidence < 0.9)', () => {
    const dupIds = new Set(nodesNamed('dupName').map((n) => n.id));
    expect(dupIds.size).toBe(2);
    const caller3 = nodesNamed('caller3')[0];
    const guesses = edges.filter((e) => dupIds.has(e.target));
    expect(guesses.length).toBeGreaterThanOrEqual(1);
    for (const e of guesses) {
      expect(e.source).toBe(caller3.id);
      expect(meta(e).resolvedBy).toBe('exact-match');
      expect(meta(e).confidence).toBeLessThan(0.9);
    }
  });

  it('a dupName reached only by that guess is in guessed with the edge, not in orphans', () => {
    const dupIds = new Set(nodesNamed('dupName').map((n) => n.id));
    const targeted = new Set(edges.filter((e) => dupIds.has(e.target)).map((e) => e.target));
    for (const id of targeted) {
      expect(report.orphans.map((o) => o.id)).not.toContain(id);
      const g = report.guessed.find((x) => x.id === id);
      expect(g).toBeDefined();
      expect(g!.name).toBe('dupName');
      expect(g!.edges).toHaveLength(1);
      expect(g!.edges[0]).toMatchObject({
        sourceName: 'caller3', sourcePath: 'src/dup3.ts', kind: 'calls', resolvedBy: 'exact-match',
      });
      expect(g!.edges[0].confidence).toBeLessThan(0.9);
    }
    // A dupName the resolver did not pick has no incoming edge, but caller3's
    // `dupName()` names it: guessed with that mention, not orphaned.
    for (const id of dupIds) {
      if (targeted.has(id)) continue;
      expect(report.orphans.map((o) => o.id)).not.toContain(id);
      const g = report.guessed.find((x) => x.id === id);
      expect(g).toBeDefined();
      expect(g!.edges).toEqual([]);
      expect(g!.mentions).toContainEqual({ path: 'src/dup3.ts', line: 1 });
    }
  });

  it('fixture: caller1 reaches noImportTarget by a single-candidate name match (confidence 0.9)', () => {
    const target = nodesNamed('noImportTarget');
    expect(target).toHaveLength(1);
    const incoming = edges.filter((e) => e.target === target[0].id);
    expect(incoming).toHaveLength(1);
    expect(meta(incoming[0]).resolvedBy).toBe('exact-match');
    expect(meta(incoming[0]).confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('a single-candidate name match call is questionable (as in grep and blast), so noImportTarget is guessed, not orphaned', () => {
    expect(names(report.orphans)).not.toContain('noImportTarget');
    const g = report.guessed.find((x) => x.name === 'noImportTarget');
    expect(g).toBeDefined();
    expect(g!.edges).toHaveLength(1);
    expect(g!.edges[0]).toMatchObject({
      sourceName: 'caller1', sourcePath: 'src/glob2.ts', kind: 'calls', resolvedBy: 'exact-match',
    });
    expect(g!.edges[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('a pre-existing function whose signature line changed is not listed', () => {
    expect(listed()).not.toContain('sigChange');
    expect(listed()).not.toContain('stable');
  });

  it('fixture: selfOnly calls itself', () => {
    const self = nodesNamed('selfOnly');
    expect(self).toHaveLength(1);
    expect(edges.some((e) => e.source === self[0].id && e.target === self[0].id && e.kind === 'calls')).toBe(true);
  });

  it('a function that only calls itself is an orphan', () => {
    expect(report.orphans.find((o) => o.name === 'selfOnly')).toMatchObject({ path: 'src/existing.ts', kind: 'function' });
  });

  it('an uncalled symbol in a newly added file is an orphan', () => {
    expect(report.orphans.find((o) => o.name === 'freshOne')).toMatchObject({
      path: 'src/fresh.ts', kind: 'function', span: 'L1-L3',
    });
  });

  it('fixture: Widget has a constructor node and an incoming edge from make', () => {
    expect(nodesNamed('constructor').some((n) => n.file_path === 'src/widget.ts')).toBe(true);
    const widget = nodesNamed('Widget').find((n) => n.file_path === 'src/widget.ts');
    expect(widget).toBeDefined();
    expect(edges.some((e) => e.target === widget!.id)).toBe(true);
  });

  it('the constructor of an instantiated added class is excluded, and the class is not an orphan', () => {
    expect(listed()).not.toContain('constructor');
    expect(listed()).not.toContain('Widget');
    expect(report.excluded.constructor).toBeGreaterThanOrEqual(1);
  });
});

// grep, blast and orphans mark the same call edges: for `calls`, orphans' guess
// rule is isCandidateEdge exactly, files included (a same-file exact match is
// certain). Other kinds keep orphans' own rule, since the shared predicate is
// defined over calls only.
describe('orphans guess rule agrees with isCandidateEdge', () => {
  const callVectors: Array<[Record<string, unknown>, string, string, boolean]> = [
    [{ resolvedBy: 'exact-match', confidence: 0.9 }, 'src/a.ts', 'src/b.ts', true],
    [{ resolvedBy: 'exact-match', confidence: 0.9 }, 'src/a.ts', 'src/a.ts', false],
    [{ resolvedBy: 'import' }, 'src/a.ts', 'src/b.ts', false],
    [{ resolvedBy: 'instance-method', confidence: 0.85 }, 'src/a.ts', 'src/a.ts', true],
    [{ resolvedBy: 'instance-method', confidence: 0.9 }, 'src/a.ts', 'src/b.ts', false],
    [{ resolvedBy: 'fuzzy' }, 'src/a.ts', 'src/a.ts', true],
  ];
  it.each(callVectors)('calls %j from %s to %s: isGuess === isCandidateEdge === %s', (m, from, to, expected) => {
    expect(isCandidateEdge('calls', m, from, to)).toBe(expected);
    expect(isGuess('calls', m, from, to)).toBe(expected);
  });

  it('a non-call edge below LOW_CONFIDENCE is a guess under orphans\' own rule', () => {
    const m = { confidence: 0.5 };
    expect(isGuess('references', m, 'src/a.ts', 'src/a.ts')).toBe(true);
    expect(isCandidateEdge('references', m, 'src/a.ts', 'src/a.ts')).toBe(false);
  });
});
