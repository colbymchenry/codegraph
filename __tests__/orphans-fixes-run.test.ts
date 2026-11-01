/**
 * `codegraph orphans`: the index freshness check and raw indexed-search stage, run through
 * `runOrphans` on real CodeGraph indexes of fixture git repos. Every fixture is
 * its own repo, built in its describe's beforeAll; the runs happen there too, so
 * each `it` only asserts.
 * Result shape here is `{ ok: true, output } | { ok: false, message }`.
 *
 * The diff runs from the merge base to the working tree, so an
 * uncommitted edit is part of the diff and is fine as long as the index has
 * synced it. What must fail is a changed file whose content on disk hashes
 * differently from the index's `files.content_hash`.
 *
 * vectors:
 *   (1) C2 adds addedFn at lines 9-11 of src/mod.ts, the index is built at
 *       C2, then an uncommitted edit prepends 4 lines with no sync. The run
 *       must fail, naming src/mod.ts and telling the caller to sync.
 *   (2) the index is built at C1, C2 adds addedFn, nothing syncs. The run
 *       must fail, naming src/mod.ts.
 *   (3) the (1) edit, synced: addedFn sits at 13-15 in the index and in
 *       the working-tree diff, so the run reports it as before.
 *   (4) clean tree, index at C2: addedFn listed.
 *   (5) a file deleted from the working tree after indexing is skipped.
 *   (6) control, POSIX: a committed symlink out of the root does not trip it.
 *   (7) the project is app/, a subdirectory of the git repo; the (1) edit
 *       fails, naming the project-relative path.
 *   (8) a changed file with no `files` row is skipped.
 *   (9) a file rewritten with the same content (new mtime) is fresh.
 *  (10) a changed file over the index's size limit is compared by the
 *       indexer's hash input (its size stamp), so it is fresh.
 *  (11) over 100 KiB of changed paths (more than one git batch), the stale
 *       file last in diff order is still named.
 *
 * the orphans search adapter uses the raw stage `searchIndexText`, never
 * `grepIndex`.
 *   (1) `grepIndex` is mocked (importOriginal spread, so `instanceof
 *       GrepIndexError` still holds) to throw while the flag is up. runOrphans
 *       must still succeed and list addedFn as guessed, mention z/use.ts:1.
 *   (2)-(4) the new export `searchIndexText`, read through the module namespace
 *       so a missing export fails each case at its own assertion, not at import.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { runOrphans } from '../src/graph/orphans-run';
import * as grepMod from '../src/search/grep';
import { GrepPatternError, GrepScopeError, grepIndex, type GrepOptions } from '../src/search/grep';

/** When enabled, make `grepIndex` throw to verify the raw search path. */
const grepHooks = vi.hoisted(() => ({ throwGrepIndex: false }));

vi.mock('../src/search/grep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/search/grep')>();
  return {
    ...actual,
    grepIndex: (...args: Parameters<typeof actual.grepIndex>) => {
      if (grepHooks.throwGrepIndex) throw new Error('grepIndex must not run for the orphans search');
      return actual.grepIndex(...args);
    },
  };
});

type RunResult = Awaited<ReturnType<typeof runOrphans>>;

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Stage everything except CodeGraph's own folder, then commit. */
function commitAll(root: string, message: string): void {
  git(root, 'add', '-A', '--', '.', ':(exclude).codegraph');
  git(root, 'commit', '-q', '-m', message);
}

/** A git repo whose first commit holds `c1`, tagged C1. Nothing is indexed. */
function newRepo(prefix: string, c1: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(c1)) write(root, rel, content);
  commitAll(root, 'C1');
  git(root, 'tag', 'C1');
  return root;
}

async function indexAt(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

/** Bring the index up to the working tree (`codegraph sync`). */
async function syncAt(root: string): Promise<void> {
  const cg = await CodeGraph.open(root);
  await cg.sync();
  cg.close();
}

/** runOrphans, with a throw turned into a failure that names it (a throw is itself a defect here). */
async function run(root: string, args: { base?: string; format?: string }): Promise<RunResult> {
  return runOrphans(root, args).catch((e: unknown): RunResult => ({
    ok: false,
    message: `runOrphans threw: ${(e as Error).message}`,
  }));
}

interface IndexedNode { name: string; file_path: string; start_line: number; end_line: number }

function indexedNodes(root: string, name: string): IndexedNode[] {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    return conn.getDb()
      .prepare('SELECT name, file_path, start_line, end_line FROM nodes WHERE name = ? ORDER BY file_path, start_line')
      .all(name) as unknown as IndexedNode[];
  } finally {
    conn.close();
  }
}

function hasFilesRow(root: string, rel: string): boolean {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    return conn.getDb().prepare('SELECT 1 AS one FROM files WHERE path = ?').get(rel) !== undefined;
  } finally {
    conn.close();
  }
}

interface OrphansJson {
  added: number;
  orphans: { name: string }[];
  guessed: { name: string; mentions: { path: string; line: number }[] }[];
  searchUnread: number;
}

const listedNames = (r: OrphansJson): string[] => [...r.orphans, ...r.guessed].map((e) => e.name);
const messageOf = (r: RunResult): string => (r.ok ? '' : r.message);
const reportOf = (r: RunResult): OrphansJson => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return JSON.parse(r.output) as OrphansJson;
};

const BASE = 'export function base(): number {\n  return 0;\n}\n';
/** C1 of src/mod.ts: seven lines, then the blank line 8 that C2 leaves before addedFn. */
const MOD_C1 = 'export function keep(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n';
/** C2: addedFn at lines 9-11. */
const MOD_C2 = `${MOD_C1}\nexport function addedFn() {\n  return 3;\n}\n`;
/** An uncommitted edit that moves addedFn to lines 13-15. */
const PREPEND_4 = '// one\n// two\n// three\n// four\n';

// ---------------------------------------------------------------------------
// a changed file the index has not caught up with fails the run
// ---------------------------------------------------------------------------

describe('an uncommitted prepend, unsynced, fails the run naming the file and the sync', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-1-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    write(root, 'src/mod.ts', PREPEND_4 + MOD_C2);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: the index holds addedFn at lines 9-11, and src/mod.ts has an uncommitted edit', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD')).toContain('src/mod.ts');
    expect(indexedNodes(root, 'addedFn')).toEqual([
      { name: 'addedFn', file_path: 'src/mod.ts', start_line: 9, end_line: 11 },
    ]);
  });

  it('fails ok:false, with the message naming src/mod.ts', () => {
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('src/mod.ts');
  });

  it('the message tells the caller to sync the index', () => {
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toMatch(/sync/i);
    expect(messageOf(result)).not.toMatch(/runOrphans threw/);
  });
});

describe('a commit the index has not caught up with fails the run', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-2-', { 'src/mod.ts': MOD_C1 });
    // Indexed at C1: the index never sees C2's addedFn.
    await indexAt(root);
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn, no sync');
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: the tree is clean against HEAD, and the index is at C1 (no addedFn)', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD').trim()).toBe('');
    expect(indexedNodes(root, 'addedFn')).toEqual([]);
  });

  it('fails ok:false, naming src/mod.ts and the sync', () => {
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('src/mod.ts');
    expect(messageOf(result)).toMatch(/sync/i);
  });
});

describe('an uncommitted edit the index has synced is reported normally', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-3-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    write(root, 'src/mod.ts', PREPEND_4 + MOD_C2);
    await syncAt(root);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: the edit is uncommitted and the synced index puts addedFn at lines 13-15', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD')).toContain('src/mod.ts');
    expect(indexedNodes(root, 'addedFn')).toEqual([
      { name: 'addedFn', file_path: 'src/mod.ts', start_line: 13, end_line: 15 },
    ]);
  });

  it('lists the added symbol after syncing the edit', () => {
    expect(messageOf(result)).toBe('');
    expect(result.ok).toBe(true);
    const report = reportOf(result);
    expect(report.added).toBe(1);
    expect(listedNames(report)).toContain('addedFn');
  });
});

describe('a clean tree and a synced index run as before', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-4-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('succeeds and lists addedFn, one symbol added', () => {
    expect(messageOf(result)).toBe('');
    const report = reportOf(result);
    expect(report.added).toBe(1);
    expect(listedNames(report)).toContain('addedFn');
  });
});

describe('a file deleted from the working tree after indexing is skipped', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-5-', { 'src/base.ts': BASE });
    write(root, 'src/gone.ts', 'export function gone(): number {\n  return 4;\n}\n');
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add gone.ts and mod.ts');
    await indexAt(root);
    fs.rmSync(path.join(root, 'src', 'gone.ts'));
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: gone is still indexed, and its file is gone from the working tree', () => {
    expect(indexedNodes(root, 'gone')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'src', 'gone.ts'))).toBe(false);
  });

  it('succeeds: a deleted path is neither read nor compared', () => {
    expect(messageOf(result)).toBe('');
    expect(listedNames(reportOf(result))).toContain('addedFn');
  });
});

describe.runIf(process.platform !== 'win32')('a committed symlink out of the root does not trip the check', () => {
  let root = '';
  let outside = '';
  let result: RunResult;

  beforeAll(async () => {
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-pub-6-outside-')));
    fs.writeFileSync(path.join(outside, 'out.ts'), 'export function outsideFn(): number {\n  return 5;\n}\n');
    root = newRepo('cg-oi-pub-6-', { 'src/base.ts': BASE });
    write(root, 'src/mod.ts', MOD_C2);
    fs.symlinkSync(path.join(outside, 'out.ts'), path.join(root, 'src', 'out.ts'));
    commitAll(root, 'C2: add addedFn and a symlink out of the root');
    await indexAt(root);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    for (const d of [root, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fixture: src/out.ts is a committed symlink out of the root, and the indexer reads outsideFn through it', () => {
    expect(fs.lstatSync(path.join(root, 'src', 'out.ts')).isSymbolicLink()).toBe(true);
    expect(indexedNodes(root, 'outsideFn').map((n) => n.file_path)).toEqual(['src/out.ts']);
  });

  it('lists addedFn despite the external symlink', () => {
    expect(messageOf(result)).toBe('');
    expect(listedNames(reportOf(result))).toContain('addedFn');
  });
});

describe('a stale edit in a project subdirectory fails naming the project-relative path', () => {
  let repo = '';
  let app = '';
  let result: RunResult;

  beforeAll(async () => {
    repo = newRepo('cg-oi-pub-7-', { 'app/src/mod.ts': MOD_C1, 'outside/readme.txt': 'not code\n' });
    write(repo, 'app/src/mod.ts', MOD_C2);
    commitAll(repo, 'C2: add addedFn under app/');
    app = path.join(repo, 'app');
    await indexAt(app);
    write(repo, 'app/src/mod.ts', PREPEND_4 + MOD_C2);
    result = await run(app, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fixture: the project index at app/ places addedFn at lines 9-11 in src/mod.ts', () => {
    expect(indexedNodes(app, 'addedFn')).toEqual([
      { name: 'addedFn', file_path: 'src/mod.ts', start_line: 9, end_line: 11 },
    ]);
  });

  it('runOrphans on app/ fails ok:false, naming src/mod.ts relative to the project, not the git repo', () => {
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('src/mod.ts');
    expect(messageOf(result)).not.toContain('app/src/mod.ts');
  });
});

describe('a changed file with no files row is not checked', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-8-', { 'src/base.ts': BASE, 'notes.txt': 'first\n' });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    // Changed in the diff (uncommitted), never indexed.
    write(root, 'notes.txt', 'first\nsecond\n');
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: notes.txt is changed against C1 and has no files row', () => {
    expect(git(root, 'diff', '--name-only', 'C1')).toContain('notes.txt');
    expect(hasFilesRow(root, 'notes.txt')).toBe(false);
    expect(hasFilesRow(root, 'src/mod.ts')).toBe(true);
  });

  it('lists addedFn when an unindexed file changes', () => {
    expect(messageOf(result)).toBe('');
    expect(listedNames(reportOf(result))).toContain('addedFn');
  });
});

describe('a file rewritten with the same content after indexing is fresh (content hash, not mtime)', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-9-', { 'src/base.ts': BASE });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    const abs = path.join(root, 'src', 'mod.ts');
    fs.writeFileSync(abs, MOD_C2);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, later, later);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists addedFn when only the timestamp changes', () => {
    expect(messageOf(result)).toBe('');
    expect(listedNames(reportOf(result))).toContain('addedFn');
  });
});

describe('a changed file over the size limit compares by the indexer\'s hash input', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-10-', { 'src/base.ts': BASE });
    write(root, 'src/mod.ts', MOD_C2);
    // Over MAX_SOURCE_FILE_SIZE_BYTES (1 MiB): the index stores its size stamp, not a hash of its text.
    write(root, 'src/big.ts', `export const BIG = 1;\n${'// filler line for the size limit\n'.repeat(40_000)}`);
    commitAll(root, 'C2: add addedFn and an oversize file');
    await indexAt(root);
    result = await run(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: src/big.ts is over 1 MiB and has a files row', () => {
    expect(fs.statSync(path.join(root, 'src', 'big.ts')).size).toBeGreaterThan(1024 * 1024);
    expect(hasFilesRow(root, 'src/big.ts')).toBe(true);
  });

  it('succeeds with addedFn listed', () => {
    expect(messageOf(result)).toBe('');
    expect(listedNames(reportOf(result))).toContain('addedFn');
  });
});

describe('more changed paths than one git batch holds, the stale one last, still fails naming it', () => {
  // Slow by design (over 5 s under load): 640 indexed files whose paths total over 100 KiB, so the
  // check's git path arguments need more than one batch on every platform.
  let root = '';
  let result: RunResult;
  const DIR = `src/${'d'.repeat(150)}`;
  const names = Array.from({ length: 640 }, (_, i) => `${DIR}/m${String(i).padStart(4, '0')}.ts`);
  const last = names[names.length - 1] as string;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-11-', { 'src/base.ts': BASE });
    names.forEach((rel, i) => write(root, rel, `export const v${i} = ${i};\n`));
    commitAll(root, 'C2: add many files');
    await indexAt(root);
    write(root, last, 'export const vLast = -1;\nexport const vMore = -2;\n');
    result = await run(root, { base: 'C1', format: 'json' });
  }, 180_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: the changed paths total over 100 KiB and the last one has a files row', () => {
    expect(names.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0)).toBeGreaterThan(100 * 1024);
    expect(hasFilesRow(root, last)).toBe(true);
  });

  it('fails ok:false, naming the stale file at the end of the diff', () => {
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('m0639.ts');
  });
});

// ---------------------------------------------------------------------------
// the orphans search adapter uses searchIndexText, never grepIndex
// ---------------------------------------------------------------------------

describe('the orphans search does not call grepIndex', () => {
  let root = '';
  let result: RunResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-o11-', {
      'src/base.ts': BASE,
      'z/use.ts': '// addedFn is wired by name at runtime\nexport const USE = 1;\n',
    });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    grepHooks.throwGrepIndex = true;
    try {
      result = await run(root, { base: 'C1', format: 'json' });
    } finally {
      grepHooks.throwGrepIndex = false;
    }
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('with grepIndex throwing, runOrphans succeeds', () => {
    expect(messageOf(result)).toBe('');
    expect(result.ok).toBe(true);
  });

  it('lists addedFn as guessed, with its mention at z/use.ts:1', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = JSON.parse(result.output) as OrphansJson;
    expect(report.guessed.find((g) => g.name === 'addedFn')?.mentions).toEqual([{ path: 'z/use.ts', line: 1 }]);
  });
});

// The new API, read through the namespace: a missing export fails at the case's own assertion.
type Hit = { path: string; line: number; text: string };
interface RawSearchResult {
  pattern: string;
  filesSearched: number;
  hits: Hit[];
  truncated: { files: number; hits: number };
}
type SearchIndexText = (projectRoot: string, pattern: string, opts?: GrepOptions) => Promise<RawSearchResult>;

function searchIndexTextApi(): SearchIndexText {
  // `in` rather than a property read: the vi.mock module proxy throws on a read of a name it does not define.
  // An expect, not a throw: a missing export fails the case at an assertion.
  expect('searchIndexText' in grepMod, 'src/search/grep exports searchIndexText').toBe(true);
  return (grepMod as unknown as { searchIndexText: SearchIndexText }).searchIndexText;
}

const collator = new Intl.Collator();
const byPathThenLine = (a: Hit, b: Hit): number => collator.compare(a.path, b.path) || a.line - b.line;
/** path, line and text only: a raw hit may also carry a match column. */
const plain = (hits: readonly Hit[]): Hit[] => hits.map(({ path: p, line, text }) => ({ path: p, line, text }));
const sortHits = (hits: readonly Hit[]): Hit[] => plain(hits).sort(byPathThenLine);

/** The hits of a grepIndex result, flattened out of their symbol groups. */
function flattenGroups(r: Awaited<ReturnType<typeof grepIndex>>): Hit[] {
  return r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text })));
}

/** The error a run throws, as the parts the two engines must agree on; null when it returns. */
async function errorOf(fn: () => Promise<unknown>): Promise<{ ctor: string; message: string; reason?: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as Error & { reason?: string };
    return { ctor: err.constructor.name, message: err.message, reason: err.reason };
  }
}

describe('searchIndexText, the raw search stage (new API)', () => {
  let root = '';
  let unindexed = '';
  let toolsDir = '';

  beforeAll(async () => {
    root = newRepo('cg-oi-pub-search-', {
      'src/a.ts': 'export const a1 = "TOKEN";\nexport const a2 = "TOKEN";\n',
      'src/ab.ts': 'export const b1 = "TOKEN";\nexport const b2 = "TOKEN";\n',
      'src/b.ts': 'export function bf(): string {\n  return "TOKEN";\n  // TOKEN again\n}\n',
      'gone.ts': 'export const gone = "TOKEN";\n',
    });
    await indexAt(root);
    // Still in the index, no longer readable: the search counts it as unread.
    fs.rmSync(path.join(root, 'gone.ts'));
    unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-pub-search-none-')));
    toolsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-pub-search-tools-')));
  }, 60_000);

  afterAll(() => {
    for (const d of [root, unindexed, toolsDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A ripgrep stand-in that prints something that is not JSON. */
  function fakeRg(): string {
    const p = path.join(toolsDir, 'fake-rg.sh');
    fs.writeFileSync(p, '#!/bin/sh\necho -x\nexit 0\n', { mode: 0o755 });
    return p;
  }

  it('fixture: grepIndex finds six TOKEN lines in four indexed files, one of them unreadable', async () => {
    const r = await grepIndex(root, 'TOKEN');
    expect(flattenGroups(r)).toHaveLength(6);
    expect(r.filesSearched).toBe(4);
    expect(r.truncated).toEqual({ files: 1, hits: 0 });
  });

  it('grepIndex still groups each hit under its enclosing symbol', async () => {
    const r = await grepIndex(root, 'TOKEN');
    const names = r.groups.map((g) => g.symbol?.name).sort();
    expect(names).toEqual(['a1', 'a2', 'b1', 'b2', 'bf']);
    expect(r.groups.find((g) => g.symbol?.name === 'bf')?.hits.map((h) => h.line)).toEqual([2, 3]);
  });

  it('searchIndexText hits are grepIndex hits flattened, with the same pattern, cap and unread counts', async () => {
    const grep = await grepIndex(root, 'TOKEN', { maxHits: 3 });
    const raw = await searchIndexTextApi()(root, 'TOKEN', { maxHits: 3 });
    expect(raw.pattern).toBe('TOKEN');
    expect(raw.filesSearched).toBe(grep.filesSearched);
    expect(raw.truncated).toEqual(grep.truncated);
    expect(raw.truncated).toEqual({ files: 1, hits: 3 });
    expect(raw.hits).toHaveLength(3);
    expect(sortHits(raw.hits)).toEqual(sortHits(flattenGroups(grep)));
  });

  it('searchIndexText returns raw hits, not symbol groups', async () => {
    const raw = (await searchIndexTextApi()(root, 'TOKEN')) as RawSearchResult & { groups?: unknown };
    expect(raw.groups).toBeUndefined();
    expect(plain(raw.hits)).toHaveLength(6);
  });

  it('the hits come back already in (path rank, line) order', async () => {
    const raw = await searchIndexTextApi()(root, 'TOKEN', { maxHits: 3 });
    expect(plain(raw.hits)).toEqual(sortHits(raw.hits));
  });

  describe('one DatabaseConnection close per call, grepIndex and searchIndexText alike', () => {
    afterEach(() => vi.restoreAllMocks());

    // Spy on the prototype's close and count the calls one run makes.
    const closes = async (fn: () => Promise<unknown>): Promise<number> => {
      const spy = vi.spyOn(DatabaseConnection.prototype, 'close');
      await fn().catch(() => undefined);
      return spy.mock.calls.length;
    };
    const opens = async (fn: () => Promise<unknown>): Promise<number> => {
      const spy = vi.spyOn(DatabaseConnection, 'open');
      await fn().catch(() => undefined);
      return spy.mock.calls.length;
    };

    const engines: [string, (r: string, p: string, o?: GrepOptions) => Promise<unknown>][] = [
      ['grepIndex', (r, p, o) => grepIndex(r, p, o)],
      ['searchIndexText', (r, p, o) => searchIndexTextApi()(r, p, o)],
    ];

    for (const [name, engine] of engines) {
      it(`${name}: success opens and closes the database once`, async () => {
        expect(await opens(() => engine(root, 'TOKEN'))).toBe(1);
        vi.restoreAllMocks();
        expect(await closes(() => engine(root, 'TOKEN'))).toBe(1);
      });

      it(`${name}: GrepScopeError closes the database once`, async () => {
        await expect(engine(root, 'TOKEN', { in: 'src/nope' })).rejects.toBeInstanceOf(GrepScopeError);
        expect(await closes(() => engine(root, 'TOKEN', { in: 'src/nope' }))).toBe(1);
      });

      it(`${name}: a pattern JS accepts and rg refuses (lookbehind) closes the database once`, async () => {
        await expect(engine(root, '(?<=a)b')).rejects.toBeInstanceOf(GrepPatternError);
        expect(await closes(() => engine(root, '(?<=a)b'))).toBe(1);
      });

      it.runIf(process.platform !== 'win32')(`${name}: malformed rg output closes the database once`, async () => {
        expect(await closes(() => engine(root, 'TOKEN', { rgPath: fakeRg() }))).toBe(1);
      });
    }
  });

  describe('searchIndexText fails the way grepIndex does', () => {
    async function sameError(
      grepRun: () => Promise<unknown>,
      searchRun: () => Promise<unknown>,
      ctor: string,
    ): Promise<void> {
      const want = await errorOf(grepRun);
      expect(want?.ctor).toBe(ctor);
      expect(await errorOf(searchRun)).toEqual(want);
    }

    it('no index: the same GrepIndexError (not-indexed)', async () => {
      const want = await errorOf(() => grepIndex(unindexed, 'TOKEN'));
      expect(want).toMatchObject({ ctor: 'GrepIndexError', reason: 'not-indexed' });
      expect(await errorOf(() => searchIndexTextApi()(unindexed, 'TOKEN'))).toEqual(want);
    });

    it('a bad regex: the same GrepPatternError', async () => {
      await sameError(
        () => grepIndex(root, '('),
        () => searchIndexTextApi()(root, '('),
        'GrepPatternError',
      );
    });

    it('maxHits -1: the same TypeError', async () => {
      await sameError(
        () => grepIndex(root, 'TOKEN', { maxHits: -1 }),
        () => searchIndexTextApi()(root, 'TOKEN', { maxHits: -1 }),
        'TypeError',
      );
      expect(await errorOf(() => searchIndexTextApi()(root, 'TOKEN', { maxHits: -1 }))).toMatchObject({
        message: 'maxHits must be a non-negative integer, got -1',
      });
    });

    it('an in prefix with nothing indexed under it: the same GrepScopeError', async () => {
      await sameError(
        () => grepIndex(root, 'TOKEN', { in: 'src/nope' }),
        () => searchIndexTextApi()(root, 'TOKEN', { in: 'src/nope' }),
        'GrepScopeError',
      );
    });
  });
});
