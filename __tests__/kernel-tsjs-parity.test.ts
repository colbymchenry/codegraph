/**
 * Kernel↔wasm TS/JS extraction parity (R2 of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/tsjs/) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over:
 *   - the checked-in torture fixtures (every ported feature: components/HOCs,
 *     stores, RTK, vuex, fn-refs, value-ref shadowing, decorators, enums,
 *     type-alias members/tuple contracts, re-exports, JSX, field methods), and
 *   - this repo's own extraction sources (real-world TS).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (excalidraw et al.,
 * run for the §5 gate); this suite keeps the invariant alive in `npm test`.
 * Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1 turns that
 * into a failure (wired in kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'kernel-parity');
const REAL_SOURCES = [
  'src/extraction/kernel/loader.ts',
  'src/extraction/kernel/decode.ts',
  'src/extraction/parse-pool.ts',
  'src/extraction/function-ref.ts',
  'src/mcp/tools.ts',
];

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

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel TS/JS extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go']);
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

  function assertParity(filePath: string, source: string, language: Language): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, language);
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, language);
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    // Meaningful comparison, not empty-vs-empty.
    expect(viaWasm.nodes.length).toBeGreaterThan(3);
    return viaWasm;
  }

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('leaves nested identifier receivers unresolved and keeps argument calls: %s (#1566)', (ext, language) => {
    const result = assertParity(`fixture.${ext}`, `
function readKey() { return 'answer'; }
function local() {
  const values = new Map();
  return values.get(readKey());
}
function nested(holder) {
  holder.values.get(readKey());
  holder.values?.get(readKey());
  holder['values'].get(readKey());
  holder.deep.values.get(readKey());
}
`, language);
    const nested = result.nodes.find((n) => n.name === 'nested' && n.kind === 'function');
    expect(nested).toBeDefined();
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === nested!.id)
      // Qualified sites are retained for effects; computed keys still make no
      // receiver claim. All four calls inside arguments must also survive.
      .map((r) => r.referenceName)).toEqual([
        'holder.values.get', 'readKey', 'holder.values.get', 'readKey',
        'readKey', 'holder.deep.values.get', 'readKey',
      ]);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'values.get')).toBe(true);
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('peels transparent receivers and drops untyped expression receivers: %s', (ext, language) => {
    const typed = language === 'typescript' || language === 'tsx';
    const result = assertParity(`fixture.${ext}`, `
function list() { return []; }
class Runner { go() { return 1; } }
async function exprReceivers(x, y) {
  (await list()).map(g);
  (x).run();
  ${typed ? 'x!.run(); (y as X).run(); (x satisfies X).stop(); getTarget("a")!.install(); if (x && y!.c.has(1)) {} if (x && this.e!.c.has(1)) {}' : ''}
  (a ?? b).map(g);
  arr[0].run();
  f().list.map(g);
  (() => 1).call(null);
  this.a.b.run();
  super.stop();
  new Runner().go();
  window.Api.start();
}
`, language);
    const fn = result.nodes.find((n) => n.name === 'exprReceivers');
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === fn!.id)
      .map((r) => r.referenceName)).toEqual([
        'list().map', 'list', 'x.run',
        ...(typed ? ['x.run', 'y.run', 'x.stop', 'getTarget().install', 'getTarget', 'has'] : []),
        'f', 'run', 'stop', 'go', 'start',
      ]);
  });

  it('torture fixture (tsx): components, stores, RTK, fn-refs, value-refs, decorators', () => {
    const file = path.join(FIXTURE_DIR, 'torture.tsx');
    assertParity('fixtures/torture.tsx', fs.readFileSync(file, 'utf8'), 'tsx');
  });

  it('torture fixture (js): field methods, wrappers, vuex module shape', () => {
    const file = path.join(FIXTURE_DIR, 'torture.js');
    assertParity('fixtures/torture.js', fs.readFileSync(file, 'utf8'), 'javascript');
  });

  it('torture fixture (java): Lombok, anonymous classes, method refs, chains', () => {
    const file = path.join(FIXTURE_DIR, 'Torture.java');
    assertParity('fixtures/Torture.java', fs.readFileSync(file, 'utf8'), 'java');
  });

  it('torture fixture (python): decorators, self fn-refs, imports, shadowing', () => {
    const file = path.join(FIXTURE_DIR, 'torture.py');
    assertParity('fixtures/torture.py', fs.readFileSync(file, 'utf8'), 'python');
  });

  it('torture fixture (go): receivers, embedding, interfaces, composite literals', () => {
    const file = path.join(FIXTURE_DIR, 'torture.go');
    assertParity('fixtures/torture.go', fs.readFileSync(file, 'utf8'), 'go');
  });

  it.each(REAL_SOURCES)('real source parity: %s', (rel) => {
    const file = path.join(__dirname, '..', rel);
    assertParity(rel, fs.readFileSync(file, 'utf8'), 'typescript');
  });

  // Every torture fixture again with CRLF line endings — the shape every
  // Windows autocrlf checkout has. Derived in memory (not a checked-in CRLF
  // file) so no platform or editor can silently normalize it away. Pins the
  // JS-multiline-^ semantics in the kernel's docstring cleaning: JS `^`/m
  // anchors after \r too, so the block-continuation `\s*` eats the `\n` and
  // the cleaned docstring keeps a bare `\r` (caught on the Windows VM leg of
  // the O2 gate; diverged in the kernel until docstring.rs mirrored it).
  it.each([
    ['torture.tsx', 'tsx'],
    ['torture.js', 'javascript'],
    ['Torture.java', 'java'],
    ['torture.py', 'python'],
    ['torture.go', 'go'],
  ] as const)('torture fixture CRLF parity: %s', (name, lang) => {
    const file = path.join(FIXTURE_DIR, name);
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity(`fixtures/${name} (crlf)`, crlf, lang);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // tree-sitter error RECOVERY differs between UTF-8 (native) and UTF-16
    // (web-tree-sitter) parsing — same grammar, same core version — so the
    // kernel defers any erroring file to keep routing graph-neutral.
    const broken = 'export function f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.ts', broken, 'typescript')).toBeNull();
    // The seam still serves the file — through the wasm path.
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.ts', broken, 'typescript');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('typescript fixture parsed as plain typescript variant', () => {
    // Same content through the non-tsx grammar exercises the typescript
    // (vs tsx) LangSpec pairing.
    const file = path.join(__dirname, '..', 'src/extraction/kernel/index.ts');
    assertParity('src/extraction/kernel/index.ts', fs.readFileSync(file, 'utf8'), 'typescript');
  });
});
