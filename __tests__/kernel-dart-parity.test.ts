/**
 * Kernel↔wasm Dart extraction parity (R7b batch 4 of the kernel migration —
 * the final R7b language).
 *
 * Asserts the native walker (codegraph-kernel/src/dart.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * fixtures (torture.dart: the master inventory — imports incl. deferred
 * invisibility, dartdoc in all three comment forms with the
 * annotation-broken chain, stacked annotations in reverse order, the
 * static_final_declaration constants hook, the full ctor set with the
 * unnamed-ctor skip and named-ctor renaming, operator methods as
 * `<anonymous>`, the extractBareCall matrix incl. cascade invisibility and
 * `?.`-as-`.`, the `ConfigT.load()` calls+references double emission,
 * extends/with/implements ref kinds, enum `with` silence, anonymous
 * extensions named after the ON type, value-ref targets with the sibling
 * body pull; TortureDoubleWalk.dart: THE SIBLING-BODY DOUBLE-WALK — the
 * duplicate local-function nodes with the same id under different parents
 * and the exact duplicated-ref interleave; TortureFnrefDart.dart: fn-ref
 * capture channels incl. named-argument non-capture and the file/class
 * twins; TortureMini/TortureSigs/TortureCtors/TortureVrefDart: signatures
 * verbatim, prefixed-return-type prefix bug, const factories invisible,
 * value-ref matrix with `$X` vs `${X}` asymmetry) and their CRLF variants
 * (derived in-memory — #1329), plus defer and generated-file pins.
 *
 * The full-repo sweeps live in scripts/kernel-parity.mjs (shelf/bloc/flutter
 * with --max-deferral 0.3); this suite keeps the invariant alive in
 * `npm test`. Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1
 * turns that into a failure.
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

describe.skipIf(!kernelBuilt)('kernel Dart extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['dart']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'dart');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'dart');
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
    ['torture.dart', 30],
    ['TortureDoubleWalk.dart', 5],
    ['TortureFnrefDart.dart', 3],
    ['TortureMini.dart', 5],
    ['TortureSigs.dart', 4],
    ['TortureCtors.dart', 3],
    ['TortureVrefDart.dart', 4],
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

  it('double-walk pins: duplicate local-fn nodes share an id; refs interleave', () => {
    const src = fs.readFileSync(path.join(FIXTURE_DIR, 'TortureDoubleWalk.dart'), 'utf8');
    const result = assertParity('fixtures/TortureDoubleWalk.dart', src, 5);
    // Local functions are minted TWICE — same (kind,name,line) → the SAME id
    // — once under the enclosing function, once under the file/class (the
    // sibling-body revisit). A dedupe here would silently diverge.
    const byId = new Map<string, number>();
    for (const n of result.nodes) byId.set(n.id, (byId.get(n.id) ?? 0) + 1);
    const dupes = [...byId.values()].filter((c) => c > 1);
    expect(dupes.length).toBeGreaterThan(0);
  });

  it('generated files extract but skip fn-ref and value-ref flushes', () => {
    const src = fs.readFileSync(path.join(FIXTURE_DIR, 'TortureVrefDart.dart'), 'utf8');
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('lib/model.g.dart', src, 'dart');
    expect(viaKernel).not.toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('lib/model.g.dart', src, 'dart');
    delete process.env.CODEGRAPH_KERNEL;
    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes).toEqual(w.nodes);
    expect(k.edges).toEqual(w.edges);
    expect(k.refs).toEqual(w.refs);
    // The skips: no function_ref refs, no valueRef edges.
    expect(viaKernel!.unresolvedReferences.some((r) => r.referenceKind === 'function_ref')).toBe(
      false
    );
    expect(viaKernel!.edges.some((e) => e.metadata?.valueRef === true)).toBe(false);
  });

  it('empty object patterns defer (the dominant dart-3 error class)', () => {
    const broken = 'int f(Object x) => switch (x) { Init() => 1, _ => 0 };\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('lib/pat.dart', broken, 'dart')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('lib/pat.dart', broken, 'dart');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('unnamed `library;` defers', () => {
    const broken = '/// Doc.\nlibrary;\n\nvoid f() {}\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('lib/lib.dart', broken, 'dart')).toBeNull();
  });
});
