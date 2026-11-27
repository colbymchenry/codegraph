/**
 * `codegraph.json` `maxFileSize` — the size limit a project sets for its own
 * source (#369, #1016).
 *
 * The default of 1 MiB keeps generated bundles and blobs out, but a project can
 * hold real source past it: a generated UI file, a test suite kept in one file.
 * The limit decides more than parsing — it is what change detection hashes (a
 * file over it is stored as its size stamp) — so it is a project setting every
 * process reads, never a per-run flag that a later sync or the watcher would
 * undo. Three layers under test:
 *   1. Loader: parse/validate/cache, with every failure degrading to the default.
 *   2. Index: a file within the project's limit is parsed, one over it is not.
 *   3. A changed limit: sync and status take the files that crossed it, though
 *      their bytes did not change, and the result matches a fresh index.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { MAX_FILE_SIZE_CEILING_BYTES, MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import { clearProjectConfigCache, loadExcludePatterns, loadMaxFileSize } from '../src/project-config';
import { fileDrift } from '../src/graph/file-drift';

const MIB = 1024 * 1024;

describe('maxFileSize loader (codegraph.json)', () => {
  let dir: string;
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, 'codegraph.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-size-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is 1 MiB when there is no codegraph.json (the default)', () => {
    expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
  });

  it('reads a whole number of bytes, higher or lower than the default', () => {
    writeConfig({ maxFileSize: 6 * MIB });
    expect(loadMaxFileSize(dir)).toBe(6 * MIB);
    clearProjectConfigCache();
    writeConfig({ maxFileSize: 1000 });
    expect(loadMaxFileSize(dir)).toBe(1000);
  });

  it.each([['a string', '4MB'], ['zero', 0], ['a negative number', -1], ['a fraction', 1.5], ['null', null], ['true', true]])(
    'keeps the default for %s, without throwing',
    (_name, value) => {
      writeConfig({ maxFileSize: value });
      expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
    }
  );

  it('uses the ceiling for a value over it', () => {
    writeConfig({ maxFileSize: MAX_FILE_SIZE_CEILING_BYTES + 1 });
    expect(loadMaxFileSize(dir)).toBe(MAX_FILE_SIZE_CEILING_BYTES);
  });

  it('keeps the default for malformed JSON, and sits beside the other keys', () => {
    writeConfig('{ not: valid json ');
    expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
    clearProjectConfigCache();
    writeConfig({ exclude: ['static/'], maxFileSize: 2 * MIB });
    expect(loadExcludePatterns(dir)).toEqual(['static/']);
    expect(loadMaxFileSize(dir)).toBe(2 * MIB);
  });
});

/**
 * A TypeScript file of at least `bytes` bytes that defines `f1`: short lines,
 * as real source has, past the head.
 */
const PADDING = '// a line of padding, to make the file large\n';
const sourceOf = (bytes: number) =>
  `export function f1(): number { return 1; }\n${PADDING.repeat(Math.ceil(bytes / PADDING.length))}`;
const BIG = sourceOf(MAX_SOURCE_FILE_SIZE_BYTES + 1000);
const USER = "import { f1 } from './big';\nexport const x = f1();\n";

describe('indexing under the project limit', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
  const symbolsOf = (file: string) => cg!.getNodesInFile(file).filter((n) => n.kind !== 'file').map((n) => n.name);
  const errorCodes = (file: string) => (cg!.getFiles().find((f) => f.path === file)?.errors ?? []).map((e) => e.code);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-size-index-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses a file over the default when the project raises the limit', async () => {
    write('codegraph.json', JSON.stringify({ maxFileSize: 4 * MIB }));
    write('big.ts', BIG);
    write('user.ts', USER);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(symbolsOf('big.ts')).toContain('f1');
    expect(errorCodes('big.ts')).toEqual([]);
    // A touch that keeps the bytes is no change, as for any file within the limit.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'big.ts'), later, later);
    expect(fileDrift(cg, 'big.ts')).toBe('current');
  }, 60_000);

  it('skips a file over a limit lowered below the default', async () => {
    write('codegraph.json', JSON.stringify({ maxFileSize: 100 }));
    write('small.ts', 'export function f1(): number { return 1; }\n');
    write('medium.ts', sourceOf(1000).replace('f1', 'f2'));
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(symbolsOf('small.ts')).toContain('f1');
    expect(symbolsOf('medium.ts')).toEqual([]);
    expect(errorCodes('medium.ts')).toEqual(['size_exceeded']);
  }, 60_000);
});

/** Every node and edge by natural key, so two indexes of the same files compare directly. */
function graphOf(cg: CodeGraph): { nodes: string[]; edges: string[] } {
  const keys = new Map(
    cg.getFiles()
      .flatMap((file) => cg.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = cg.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target}`);
  return { nodes: [...keys.values()].sort(), edges: edges.sort() };
}

describe.each([false, true])('a changed limit, in a project under git: %s', (underGit) => {
  // Small sizes keep these fast: what they test is a file crossing the limit
  // in force, wherever it sits. `big.ts` is about 2 KB.
  const SMALL_LIMIT = 1000;
  const LARGE_LIMIT = 10_000;
  const BIG_SMALL = sourceOf(2000);
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const importsOfUser = (): string[] => {
    const ids = cg.getNodesInFile('user.ts').map((n) => n.id);
    return cg.getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'imports')
      .map((e) => `${cg.getNode(e.target)?.kind}:${cg.getNode(e.target)?.name}`)
      .sort();
  };
  /** Rewrite codegraph.json with a fresh mtime, as an edit would leave it. */
  const setLimit = (limit: number) => {
    write('codegraph.json', JSON.stringify({ maxFileSize: limit }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), later, later);
  };
  const matchesFullIndex = async () => {
    const synced = graphOf(cg);
    cg.close();
    cg = await CodeGraph.recreate(dir);
    await cg.indexAll();
    expect(synced).toEqual(graphOf(cg));
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-size-change-'));
    clearProjectConfigCache();
    write('codegraph.json', JSON.stringify({ maxFileSize: SMALL_LIMIT }));
    write('big.ts', BIG_SMALL);
    write('user.ts', USER);
    if (underGit) {
      git('init');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'Test');
      write('.gitignore', '.codegraph/\n');
      git('add', '-A');
      git('commit', '-m', 'init');
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    // Over the limit: nothing in big.ts to import.
    expect(importsOfUser()).toEqual([]);
  }, 60_000);

  afterEach(() => {
    cg?.destroy();
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes in a file the raised limit now covers, though its bytes did not change', async () => {
    setLimit(LARGE_LIMIT);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: ['big.ts'], removed: [] });
    const result = await cg.sync();
    expect(result.filesModified).toBe(1);
    expect(importsOfUser()).toEqual(['file:big.ts', 'function:f1']);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    await matchesFullIndex();
  }, 60_000);

  it('drops the symbols of a file a lowered limit no longer covers', async () => {
    setLimit(LARGE_LIMIT);
    await cg.sync();
    expect(importsOfUser()).toEqual(['file:big.ts', 'function:f1']);
    setLimit(SMALL_LIMIT);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: ['big.ts'], removed: [] });
    await cg.sync();
    expect(importsOfUser()).toEqual([]);
    expect(cg.getNodesInFile('big.ts').filter((n) => n.kind !== 'file')).toEqual([]);
    await matchesFullIndex();
  }, 60_000);

  it('leaves the files the change does not cross alone', async () => {
    setLimit(LARGE_LIMIT);
    await cg.sync();
    setLimit(2 * LARGE_LIMIT);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    const result = await cg.sync();
    expect(result.filesModified).toBe(0);
  }, 60_000);
});
