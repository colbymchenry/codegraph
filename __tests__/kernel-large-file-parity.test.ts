/**
 * The native kernel and the wasm extractor agree on files of some thousand
 * declarations, and both read one in the time its size asks for.
 *
 * Both did work for each declaration that went through its siblings: finding
 * where a declaration stands among its parent's children before looking for
 * the decorators above it, walking back over every sibling for a Ruby method's
 * visibility, reading every child of a C++ parent for an access specifier,
 * searching the whole file for a later `export` of each JS constant, and
 * counting a line's characters for each column. Each is now read once, or
 * from where the last answer left off, in both extractors.
 *
 * These pin that the two still produce the same nodes, edges and references
 * on the shapes those paths decide: decorators and annotations in the eight
 * languages that have them, visibility by section in Ruby and C++, exports
 * written after the declaration, and columns on a long line that holds
 * characters wider in bytes than in UTF-16 units. The parity suites beside
 * this one pin the same on hand-written fixtures; these are the sizes where a
 * slip in what is remembered from one declaration to the next would show.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

/** What either extractor may take over one of these files. Each takes well under a second. */
const ALLOWED_MS = 30_000;

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

/** `unit(i)` for each of `count`, between a head and a tail. */
const repeat = (count: number, unit: (i: number) => string, head = '', tail = ''): string =>
  head + Array.from({ length: count }, (_, i) => unit(i)).join('') + tail;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

const LANGUAGES: Language[] = ['python', 'typescript', 'javascript', 'java', 'kotlin', 'swift', 'scala', 'dart', 'ruby', 'cpp'];

describe.skipIf(!kernelBuilt)('kernel and wasm extraction agree on files of some thousand declarations', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(LANGUAGES);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  /** Both extractors' results for `source`, having checked they are the same and neither took long. */
  function assertParity(filePath: string, source: string, language: Language, minNodes: number): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    let started = Date.now();
    const viaKernel = tryKernelExtract(filePath, source, language);
    expect(Date.now() - started, `${filePath}: kernel time`).toBeLessThan(ALLOWED_MS);
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    started = Date.now();
    const viaWasm = extractFromSource(filePath, source, language);
    expect(Date.now() - started, `${filePath}: wasm time`).toBeLessThan(ALLOWED_MS);
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes.length, `${filePath}: node count`).toBe(w.nodes.length);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
    return viaWasm;
  }

  /** How many `decorates` references each decorated name got. */
  const decorations = (result: ExtractionResult): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const ref of result.unresolvedReferences) {
      if (ref.referenceKind === 'decorates') counts.set(ref.referenceName, (counts.get(ref.referenceName) ?? 0) + 1);
    }
    return counts;
  };

  const N = 3000;

  it('Python: a decorator, or two, on the function or the method under them', () => {
    const source = repeat(N, (i) => (i % 3 === 0
      ? `@cached\n@traced(level=${i})\ndef thing${i}(name):\n    return name\n\n`
      : i % 3 === 1 ? `@cached\ndef thing${i}(name):\n    return name\n\n` : `def thing${i}(name):\n    return name\n\n`),
    'def cached(f):\n    return f\n\ndef traced(level):\n    return cached\n\n',
    `class Big:\n${repeat(N, (i) => `    @staticmethod\n    def method${i}(name):\n        return name\n\n`)}`);
    const result = assertParity('big.py', source, 'python', N * 2);
    const counts = decorations(result);
    expect(counts.get('cached')).toBe(N / 3 * 2);
    // A decorator written as a call is recorded as the call it is.
    expect(counts.get('traced')).toBeUndefined();
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.referenceName === 'traced')).toHaveLength(N / 3);
    expect(counts.get('staticmethod')).toBe(N);
  });

  it('TypeScript: decorators on a class and its methods', () => {
    const source = repeat(N, (i) => (i % 2 === 0
      ? `  @cached()\n  @traced\n  thing${i}(name: string): string {\n    return name;\n  }\n\n`
      : `  thing${i}(name: string): string {\n    return name;\n  }\n\n`),
    'declare function cached(): any;\ndeclare const traced: any;\ndeclare const component: any;\n\n@component\nexport class Big {\n', '}\n');
    const counts = decorations(assertParity('big.ts', source, 'typescript', N));
    expect(counts.get('cached')).toBe(N / 2);
    expect(counts.get('traced')).toBe(N / 2);
    expect(counts.get('component')).toBe(1);
  });

  it('Java: annotations on methods', () => {
    const source = repeat(N, (i) => (i % 2 === 0
      ? `  @Deprecated\n  @Tagged("t${i}")\n  String thing${i}(String name) {\n    return name;\n  }\n\n`
      : `  String thing${i}(String name) {\n    return name;\n  }\n\n`),
    'public class Big {\n', '}\n');
    const counts = decorations(assertParity('Big.java', source, 'java', N));
    expect(counts.get('Deprecated')).toBe(N / 2);
    expect(counts.get('Tagged')).toBe(N / 2);
  });

  it('Kotlin, Swift, Scala and Dart: annotations on top-level functions', () => {
    const cases: Array<[string, Language, (i: number) => string, string, string]> = [
      ['big.kt', 'kotlin', (i) => `${i % 2 ? '' : '@Tagged\n'}fun thing${i}(name: String): String {\n    return name\n}\n\n`, '', ''],
      ['big.swift', 'swift', (i) => `${i % 2 ? '' : '@discardableResult\n'}func thing${i}(name: String) -> String {\n    return name\n}\n\n`, '', ''],
      ['big.scala', 'scala', (i) => `${i % 2 ? '' : '  @deprecated\n'}  def thing${i}(name: String): String = {\n    name\n  }\n\n`, 'object Big {\n', '}\n'],
      // Dart lets a comment stand between an annotation and what it annotates.
      ['big.dart', 'dart', (i) => `${i % 2 ? '' : `@deprecated\n${i % 4 ? '' : '// kept for callers\n'}`}String thing${i}(String name) {\n  return name;\n}\n\n`, '', ''],
    ];
    for (const [file, language, unit, head, tail] of cases) {
      const counts = decorations(assertParity(file, repeat(N, unit, head, tail), language, N));
      expect([...counts.values()].reduce((a, b) => a + b, 0), file).toBe(N / 2);
    }
  });

  it('Ruby: methods under visibility calls, in classes one after another and one inside another', () => {
    // A visibility is read from a call with arguments (`private :name`); the
    // bare word alone is not one to either extractor, and never was.
    const section = (from: number, count: number, indent = '  ') => repeat(count, (i) => `${indent}def thing${from + i}(name)\n${indent}  name\n${indent}end\n\n`);
    const cls = (name: string, from: number) =>
      `class ${name}\n${section(from, 400)}  private :thing${from}\n\n${section(from + 400, 400)}  protected :thing${from}\n\n${section(from + 800, 200)}  public :thing${from}\n\n${section(from + 1000, 200)}` +
      `  class Inner\n${section(from + 1200, 100, '    ')}    private :thing${from + 1200}\n\n${section(from + 1300, 100, '    ')}  end\n\n${section(from + 1400, 100)}  private\n\n${section(from + 1500, 100)}end\n\n`;
    const source = `${repeat(200, (i) => `def top${i}(name)\n  name\nend\n\n`)}private :top0\n\n${repeat(200, (i) => `def hidden${i}(name)\n  name\nend\n\n`)}${cls('First', 0)}${cls('Second', 2000)}`;
    const result = assertParity('big.rb', source, 'ruby', 3000);
    const visibility = (name: string) => result.nodes.find((n) => n.name === name)?.visibility;
    expect(['top0', 'top199', 'hidden0', 'hidden199'].map(visibility)).toEqual(['public', 'public', 'private', 'private']);
    expect(['thing0', 'thing399', 'thing400', 'thing799', 'thing800', 'thing999', 'thing1000', 'thing1199'].map(visibility))
      .toEqual(['public', 'public', 'private', 'private', 'protected', 'protected', 'public', 'public']);
    // The inner class has its own calls, and the outer one goes on as it was after it; a bare `private` changes nothing.
    expect(['thing1200', 'thing1299', 'thing1300', 'thing1399', 'thing1400', 'thing1499', 'thing1500', 'thing1599'].map(visibility))
      .toEqual(['public', 'public', 'private', 'private', 'public', 'public', 'public', 'public']);
    expect(['thing2000', 'thing2400', 'thing2800', 'thing3000'].map(visibility)).toEqual(['public', 'private', 'protected', 'public']);
  });

  it('C++: free functions, and classes with and without access specifiers', () => {
    const source = repeat(N, (i) => `int thing${i}(int name) {\n  return name + ${i};\n}\n\n`,
      'class Marked {\n  int unmarked() { return 1; }\nprivate:\n  int hidden() { return 2; }\npublic:\n  int open() { return 3; }\n};\n\nclass Plain {\n  int bare() { return 4; }\n};\n\nstruct Opened {\npublic:\n  int shown() { return 5; }\n};\n\n',
      `class Wide {\npublic:\n${repeat(N, (i) => `  int method${i}(int name) {\n    return name + ${i};\n  }\n\n`)}};\n`);
    const result = assertParity('big.cpp', source, 'cpp', N * 2);
    const visibility = (name: string) => result.nodes.find((n) => n.name === name)?.visibility;
    // The first specifier among a parent's children decides for all of them.
    expect(['unmarked', 'hidden', 'open', 'bare', 'shown', 'thing0', `thing${N - 1}`, 'method0', `method${N - 1}`].map(visibility))
      .toEqual(['private', 'private', 'private', undefined, 'public', undefined, undefined, 'public', 'public']);
  });

  it('JavaScript: stores exported where they are declared, by a later statement, or not at all', () => {
    const stores = repeat(N, (i) => `${i % 10 === 0 ? 'export ' : ''}const store${i} = create((set) => ({ act${i}: () => set({ n: ${i} }) }));\n`,
      "import { create } from 'zustand';\n\n");
    const exportsOf = (lines: string[]) => `${stores}\n${lines.join('\n')}\n`;
    const later = ['export default store7;', 'export { store9, store11 as renamed, items$ };', '  export {\n  store13,\n  $store\n}', 'export default store1 ;'];
    for (const [file, source] of [
      ['big.js', exportsOf(later)],
      // As a Windows checkout has it.
      ['crlf.js', exportsOf(later).replace(/\n/g, '\r\n')],
      // Statements that export none of them: a longer name, a name in a string, an `export` that is not at a line's start.
      ['none.js', exportsOf(['export default store77x;', 'const text = "export default store3;";', 'if (ok) export_default(store5);', 'export { store150x, xstore151 };'])],
    ] as const) {
      const result = assertParity(file, source, 'javascript', N);
      const actions = result.nodes.filter((n) => /^act\d+$/.test(n.name)).map((n) => +n.name.slice(3)).sort((a, b) => a - b);
      const declared = Array.from({ length: N / 10 }, (_, i) => i * 10);
      const expected = file === 'none.js' ? declared : [...declared, 1, 7, 9, 11, 13].sort((a, b) => a - b);
      expect(actions, file).toEqual(expected);
    }
  });

  it('a long line: every column counts UTF-16 units, past characters wider in bytes', () => {
    const head = 'var s="é😀日本";function h(x){return x}';
    const source = `${repeat(N, (i) => `function t${i}(n){var v=h("ü${i}");return t${i ? i - 1 : 0}(v)}`, head)}\n`;
    const result = assertParity('min.js', source, 'javascript', N);
    for (const i of [0, 1, N / 2, N - 1]) {
      const fn = result.nodes.find((n) => n.name === `t${i}`)!;
      expect(fn.startColumn, `t${i}`).toBe(source.indexOf(`function t${i}(`));
    }
    const python = `${repeat(N, (i) => `v${i} = h("ü😀${i}"); `, 'def h(x): return x\ns = "é😀日本"; ')}\n`;
    assertParity('long.py', python, 'python', N);
  });
});
