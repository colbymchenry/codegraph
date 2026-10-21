/**
 * A grammar that fails to load is an environment failure, not a parse result
 * (#2335).
 *
 * A long-running daemon loads tree-sitter grammars lazily from its install
 * directory. When an upgrade deletes that directory underneath it, every later
 * grammar load fails (ENOENT) and the extractor answers `parser_error` with no
 * nodes. That used to be STORED: the file's good symbols were replaced by a
 * zero-node row carrying the new content hash, so `sync` never revisited it
 * and `status` stayed green. Now nothing is stored for such a result — the
 * file keeps its previous index data and the next sync or index retries it —
 * and rows an older engine already wrote that way are re-indexed by `sync`.
 *
 * The failure is simulated at `getParser` (what a failed load leaves behind:
 * no parser for the language), with the native kernel switched off so every
 * file goes through the grammar path regardless of whether a kernel is built.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import type { Language } from '../src/types';

const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }));

vi.mock('../src/extraction/grammars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/extraction/grammars')>();
  return {
    ...actual,
    getParser: (language: Language) => (failing.has(language) ? null : actual.getParser(language)),
  };
});

const MATH_TS =
  'export function add(a: number, b: number): number {\n' +
  '  return a + b;\n' +
  '}\n' +
  'export class Calculator {\n' +
  '  total = 0;\n' +
  '  plus(n: number): this { this.total = add(this.total, n); return this; }\n' +
  '}\n';

const VIEW_TS =
  "import { Calculator } from './math';\n" +
  'export function total(n: number): number {\n' +
  '  return new Calculator().plus(n).total;\n' +
  '}\n';

const SUB_TS = '\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n';

function names(cg: CodeGraph, file: string): string[] {
  return cg.getNodesInFile(file).map((n) => n.name);
}

describe('grammar load failures are never stored (#2335)', () => {
  let dir: string;
  let cg: CodeGraph;
  let kernelEnv: string | undefined;

  beforeEach(() => {
    kernelEnv = process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL = '0';
    failing.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grammar-load-failure-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'math.ts'), MATH_TS);
    fs.writeFileSync(path.join(dir, 'src', 'view.ts'), VIEW_TS);
  });

  afterEach(() => {
    failing.clear();
    cg?.destroy();
    if (kernelEnv === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernelEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sync keeps the previous symbols of a file whose grammar failed to load, then retries it', async () => {
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const before = cg.getFile('src/math.ts')!;
    expect(before.nodeCount).toBeGreaterThan(1);
    expect(names(cg, 'src/math.ts')).toEqual(expect.arrayContaining(['add', 'Calculator']));

    // The upgrade removed the grammar; the watcher then re-indexes an edit.
    failing.add('typescript');
    fs.appendFileSync(path.join(dir, 'src', 'math.ts'), SUB_TS);
    const failed = await cg.sync();

    expect(failed.failedFilePaths).toContain('src/math.ts');
    const kept = cg.getFile('src/math.ts')!;
    expect(kept.nodeCount).toBe(before.nodeCount);
    expect(kept.contentHash).toBe(before.contentHash);
    expect(kept.errors ?? []).toEqual([]);
    expect(names(cg, 'src/math.ts')).toEqual(expect.arrayContaining(['add', 'Calculator']));

    // Grammar available again (a fresh process from the new install): the
    // next sync sees the file as still changed and indexes the edit.
    failing.clear();
    const retried = await cg.sync();
    expect(retried.filesModified).toBe(1);
    expect(names(cg, 'src/math.ts')).toEqual(expect.arrayContaining(['add', 'Calculator', 'sub']));
    expect(cg.getFile('src/math.ts')!.nodeCount).toBeGreaterThan(before.nodeCount);
  });

  it('a full index stores nothing for files whose grammar failed to load, and sync adds them later', async () => {
    failing.add('typescript');
    cg = await CodeGraph.init(dir);
    const result = await cg.indexAll();

    expect(result.filesErrored).toBe(2);
    expect(result.errors.filter((e) => e.code === 'parser_error')).toHaveLength(2);
    expect(cg.getFile('src/math.ts')).toBeNull();
    expect(cg.getFile('src/view.ts')).toBeNull();

    failing.clear();
    const synced = await cg.sync();
    expect(synced.filesAdded).toBe(2);
    expect(names(cg, 'src/math.ts')).toEqual(expect.arrayContaining(['add', 'Calculator']));
    expect(names(cg, 'src/view.ts')).toContain('total');
  });

  it('sync re-indexes rows an older engine stored while the grammar was missing', async () => {
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const before = cg.getFile('src/math.ts')!;

    // What v1.6.2 wrote for a file it re-indexed with no grammar: no nodes,
    // the parser error, and the CURRENT content hash — so a hash-based
    // reconcile considers it up to date forever.
    const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } } }).db.getDb();
    db.prepare('DELETE FROM nodes WHERE file_path = ?').run('src/math.ts');
    db.prepare('UPDATE files SET node_count = 0, errors = ? WHERE path = ?').run(
      JSON.stringify([{ message: 'Failed to get parser for language: typescript', filePath: 'src/math.ts', severity: 'error', code: 'parser_error' }]),
      'src/math.ts'
    );
    expect(cg.getFile('src/math.ts')!.nodeCount).toBe(0);

    await cg.sync();

    const healed = cg.getFile('src/math.ts')!;
    expect(healed.nodeCount).toBe(before.nodeCount);
    expect(healed.errors ?? []).toEqual([]);
    expect(names(cg, 'src/math.ts')).toEqual(expect.arrayContaining(['add', 'Calculator']));
  });

  it('a component whose script grammar failed keeps its previous symbols too', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'Counter.svelte'),
      '<script lang="ts">\n  export let start = 0;\n  function increment(): void { start += 1; }\n</script>\n<button on:click={increment}>{start}</button>\n'
    );
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const before = cg.getFile('src/Counter.svelte')!;
    expect(names(cg, 'src/Counter.svelte')).toContain('increment');

    failing.add('typescript');
    fs.appendFileSync(path.join(dir, 'src', 'Counter.svelte'), '<p>edited</p>\n');
    await cg.sync();

    // The component node alone would have been stored before: the script's
    // symbols gone, with a nonzero node count hiding it.
    expect(cg.getFile('src/Counter.svelte')!.nodeCount).toBe(before.nodeCount);
    expect(names(cg, 'src/Counter.svelte')).toContain('increment');
  });
});
