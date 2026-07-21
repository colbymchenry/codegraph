/**
 * Kernel↔wasm Kotlin extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/kotlin.rs — grammar
 * compiled from the vendored fwcd 0.3.8 C sources, the arc's first
 * vendored-grammar-C language) produces the SAME ExtractionResult as the
 * wasm TreeSitterExtractor over the checked-in torture fixture (torture.kt:
 * the property hook's scope classification, extension-function receiver QNs
 * (`WidgetK::extend`, the qualified `com::qext` bug) + the owner-contains
 * fallback, expect/actual → node DECORATORS (the KMP synthesizer feed),
 * the bodiless-vs-bodied class header asymmetry, comment-glued
 * import/package extents, KDoc dropped-and-chain-breaking docstrings,
 * `@Marker` decorates vs `@Anno(args)` nothing, zero type-annotation refs,
 * zero instantiates, the #750 capitalized-chain re-encode, paren-then-
 * lambda garbage callees, `${X}`-reads-vs-`$X`-non-reads value refs and the
 * packaged-file target drop) plus a `.kts` script fixture (file-attributed
 * top-level calls), with in-memory CRLF variants (#1329), and two defer
 * fixtures — a `fun interface` file and a PHANTOM error (a one-line class
 * body sets hasError with a complete, ERROR-node-free CST; the kernel
 * trusts the flag).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (okio/okhttp/
 * kotlinx.coroutines — expected deferrals 23/49/51, grammar-inherent).
 * Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1 turns
 * that into a failure (kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

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

describe.skipIf(!kernelBuilt)('kernel Kotlin extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['kotlin']);
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

  function assertParity(filePath: string, source: string, minNodes = 3): void {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, 'kotlin');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'kotlin');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  const FIXTURES: Array<{ file: string; minNodes: number }> = [
    { file: 'torture.kt', minNodes: 40 },
    { file: 'TortureScript.kts', minNodes: 2 },
  ];

  for (const { file, minNodes } of FIXTURES) {
    it(`${file}: hook properties, receivers, decorators, calls, value refs`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      assertParity(`fixtures/${file}`, src, minNodes);
    });

    it(`${file} CRLF parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const crlf = src.replace(/(?<!\r)\n/g, '\r\n');
      assertParity(`fixtures/${file} (crlf)`, crlf, minNodes);
    });
  }

  it('fun-interface files defer to the wasm extractor (grammar-inherent error)', () => {
    const src = 'package p\n\nfun interface Transformer {\n    fun transform(x: Int): Int\n}\n\nfun after() { work() }\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/FunIface.kt', src, 'kotlin')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/FunIface.kt', src, 'kotlin');
    delete process.env.CODEGRAPH_KERNEL;
    // The wasm arm's misparse-recovery hook still mints the interface node.
    expect(viaWasm.nodes.some((n) => n.kind === 'interface' && n.name === 'Transformer')).toBe(true);
  });

  it('PHANTOM errors defer too — hasError with a complete, ERROR-node-free CST', () => {
    const src = 'abstract class A { abstract fun i(): Int }\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/Phantom.kt', src, 'kotlin')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/Phantom.kt', src, 'kotlin');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'class' && n.name === 'A')).toBe(true);
  });
});
