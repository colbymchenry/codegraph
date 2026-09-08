/**
 * Kernel↔wasm Scala extraction parity (R7b batch 4 of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/scala.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * fixtures (torture.scala: first-segment imports, defs-as-methods with the
 * top-level function fallback, curried/type-params-first signatures, the
 * val/var hook with object-vs-class kinds and initializer invisibility,
 * companion pairs sharing a QN namespace, the bodiless-header asymmetry,
 * enum cases at case-node positions with invisible tails, extends
 * with-chains, `@deprecated(args)` decorates, the #750 capitalized-chain
 * re-encode, literal-receiver silence, static reads incl. the write-LHS
 * emission, nested-def invisibility with body-local classes extracting
 * fully; TortureDocs: scaladoc retention + the CRLF `\r` pin; TortureVref:
 * value-ref targets, shadow prune, interpolation reads, the last-wins
 * mis-target; TortureFnref: all five capture channels + var-init
 * non-capture + eta expansion; TortureGiven/TortureExt: the anon-body and
 * extension leak asymmetries — the port's likeliest regression sites;
 * TortureIndent: Scala-3 indentation syntax through the external scanner;
 * TortureMisc: package objects/braced packages/self-types/super-ctor args/
 * unicode columns; TortureScript.sc: top-level statements from the FILE)
 * and their CRLF variants (derived in-memory — #1329), plus phantom and
 * real-error defer pins.
 *
 * The full-repo sweeps live in scripts/kernel-parity.mjs (os-lib/cats +
 * scala3 compiler/src + library/src with --max-deferral 0.3); this suite
 * keeps the invariant alive in `npm test`. Skips when no kernel binary is
 * staged; CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure.
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

describe.skipIf(!kernelBuilt)('kernel Scala extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['scala']);
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

  function assertParity(filePath: string, source: string, minNodes = 2): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, 'scala');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'scala');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
    return viaKernel!;
  }

  const FIXTURES = [
    ['torture.scala', 40],
    ['TortureDocs.scala', 3],
    ['TortureVref.scala', 4],
    ['TortureFnref.scala', 4],
    ['TortureGiven.scala', 3],
    ['TortureExt.scala', 1],
    ['TortureIndent.scala', 3],
    ['TortureMisc.scala', 4],
    ['TortureScript.sc', 1],
  ] as const;

  for (const [file, minNodes] of FIXTURES) {
    it(`${file}: parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      assertParity(`fixtures/${file}`, src, minNodes);
    });

    it(`${file}: CRLF parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const crlf = src.replace(/(?<!\r)\n/g, '\r\n');
      assertParity(`fixtures/${file} (crlf)`, crlf, minNodes);
    });
  }

  it('torture pins: import first-segment names, companion pairs, value-ref edges', () => {
    const src = fs.readFileSync(path.join(FIXTURE_DIR, 'torture.scala'), 'utf8');
    const result = assertParity('fixtures/torture.scala', src, 40);
    // Imports are named the FIRST path segment.
    const imports = result.nodes.filter((n) => n.kind === 'import');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((n) => !n.name.includes('.'))).toBe(true);
    // No namespace node, ever (package headers ignored).
    expect(result.nodes.some((n) => n.kind === 'namespace')).toBe(false);
    // Value-ref edges exist and are metadata-tagged.
    expect(result.edges.some((e) => e.kind === 'references' && e.metadata?.valueRef === true)).toBe(
      true
    );
  });

  it('scala-3 PHANTOM hasError defers (flag-true, zero ERROR nodes)', () => {
    // Capture-checking postfix `^` — a complete, correct CST whose hasError
    // flag is still true. The kernel must defer on the FLAG.
    const phantom = 'def f(x: List[Int]^): Int = 1\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/phantom.scala', phantom, 'scala')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/phantom.scala', phantom, 'scala');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('real parse errors defer (given-with syntax)', () => {
    const broken = 'trait C\ngiven x: C with { def y = 1 }\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/gw.scala', broken, 'scala')).toBeNull();
  });
});
