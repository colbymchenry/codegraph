import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { generateNodeId } from '../src/extraction/tree-sitter-helpers';
import type { ExtractionResult, Language } from '../src/types';

// Exercise every sibling walker with a same-line collision after BMP + astral Unicode.
const fixtures: Array<[Language, string]> = [
  ['java', '/* é😀 */ class A { void x() {} void x(int n) {} }'],
  ['python', 'label = "é😀"; x = 1; x = 2'],
  ['go', 'package p\n/* é😀 */ type A struct{}; type B struct{}; func (a A) x(){}; func (b B) x(){}'],
  ['c', '/* é😀 */ enum A { x }; void f() { enum B { x }; }'],
  ['cpp', '/* é😀 */ int x() { return 1; } int x(int n) { return n; }'],
  ['rust', '/* é😀 */ struct A; struct B; impl A { fn x() {} } impl B { fn x() {} }'],
  ['csharp', '/* é😀 */ class A { void x() {} void x(int n) {} }'],
  ['ruby', 'label = "é😀"; class A; def x; end; end; class B; def x; end; end'],
  ['php', '<?php /* é😀 */ class A { function x() {} } class B { function x() {} }'],
  ['swift', '/* é😀 */ func x() {}; func x(_ n: Int) {}'],
  ['kotlin', '/* é😀 */ fun x() {}; fun x(n: Int) {}'],
  ['scala', '/* é😀 */ object A { def x(): Int = 1; def x(n: Int): Int = n }'],
  ['dart', '/* é😀 */ class A { void x() {} } class B { void x() {} }'],
  ['lua', 'local label = "é😀"; local x = 1; local x = 2'],
  ['luau', 'local label = "é😀"; local x = 1; local x = 2'],
  ['r', 'label <- "é😀"; x <- function() {}; x <- function() {}'],
];

function canon(result: ExtractionResult) {
  return {
    nodes: result.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort(),
  };
}

const kernelBuilt = fs.existsSync(path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));
const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('collision-only node identity parity (#1349)', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(fixtures.map(([language]) => language));
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

  it.each(fixtures)('%s keeps distinct same-line symbols and UTF-16 identity suffixes', (language, source) => {
    const file = `fixture.${language}`;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const native = tryKernelExtract(file, source, language);
    expect(native, 'must exercise the native walker, not fallback').not.toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const wasm = extractFromSource(file, source, language);
    expect(canon(native!)).toEqual(canon(wasm));
    const xs = wasm.nodes.filter((n) => n.name === 'x');
    expect(xs).toHaveLength(2);
    expect(xs[0]!.startLine).toBe(xs[1]!.startLine);
    expect(xs[0]!.id).toBe(generateNodeId(file, xs[0]!.kind, 'x', xs[0]!.startLine));
    expect(xs[1]!.id).toBe(`${xs[0]!.id}:${xs[1]!.startColumn}`);
    expect(new Set(wasm.nodes.map((n) => n.id)).size).toBe(wasm.nodes.length);
    const ids = new Set(wasm.nodes.map((n) => n.id));
    for (const edge of wasm.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });
});
