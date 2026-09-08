/**
 * Kernel↔wasm C/C++ extraction parity (R7a of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/ccpp/) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over:
 *   - the checked-in torture fixtures (torture.c / torture.cpp / torture.hpp:
 *     fn-ptr tables, typedef enum/struct, multi-declarator consts, namespaces
 *     incl. C++17 nested, out-of-line Cls::method defs, templates + template
 *     bases, operators, stack construction, local fn-ptrs, UE-macro shapes
 *     through the hoisted preParse, using-aliases, value-ref shadowing), and
 *   - Metal/CUDA-shaped sources arriving as language 'cpp' — pinning that the
 *     route point applies the SAME extension/content-gated preParse blanks to
 *     the kernel arm (docs/design/ccpp-kernel-port-checklist.md, decision 1/2).
 *
 * Files with parse errors — including the spaced explicit-operator CALL-SITE
 * shape (#1247), which rides an ERROR node — must DEFER to wasm (`defer:`),
 * asserted below. The full-repo sweep lives in scripts/kernel-parity.mjs
 * (redis/git/fmt et al., run for the §5 gate); this suite keeps the invariant
 * alive in `npm test`. Skips when no kernel binary is staged;
 * CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure (kernel-scaffold.test.ts).
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

describe.skipIf(!kernelBuilt)('kernel C/C++ extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp']);
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

  function assertParity(filePath: string, source: string, language: Language, minNodes = 3): void {
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
    // Meaningful comparison, not empty-vs-empty (the inline Metal/CUDA
    // sources are deliberately small — they pass their exact node count).
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  it('torture fixture (c): fn-ptr tables, typedefs, file-scope consts, value-refs', () => {
    const file = path.join(FIXTURE_DIR, 'torture.c');
    assertParity('fixtures/torture.c', fs.readFileSync(file, 'utf8'), 'c');
  });

  it('torture fixture (cpp): namespaces, out-of-line methods, templates, fn-ptrs, UE macros', () => {
    const file = path.join(FIXTURE_DIR, 'torture.cpp');
    assertParity('fixtures/torture.cpp', fs.readFileSync(file, 'utf8'), 'cpp');
  });

  it('torture fixture (hpp): fwd decls, extern "C", header templates, reflection markup', () => {
    const file = path.join(FIXTURE_DIR, 'torture.hpp');
    assertParity('fixtures/torture.hpp', fs.readFileSync(file, 'utf8'), 'cpp');
  });

  // Metal rides the cpp route: `.metal` maps to language 'cpp' and the
  // extension-gated `[[attribute]]` blank must reach the kernel arm through
  // the route-point preParse hoist (filePath rides along for the gate).
  it('metal-shaped source (.metal → cpp): attribute blanks applied on both arms', () => {
    const metal = [
      'struct VertexIn {',
      '  float3 position [[attribute(0)]];',
      '  float2 uv [[attribute(1)]];',
      '};',
      'static float2 scale_uv(float2 uv) { return uv; }',
      '',
    ].join('\n');
    assertParity('fixtures/shader.metal', metal, 'cpp');
  });

  // CUDA rides the cpp route too: specifier + launch-config blanks are gated
  // by extension OR content, and both fire before the kernel call.
  it('cuda-shaped source (.cu → cpp): specifier + launch blanks applied on both arms', () => {
    const cuda = [
      '__global__ void step_kernel(float *data) { data[0] += 1.0f; }',
      'void launch(float *data) { step_kernel<<<1, 256>>>(data); }',
      '',
    ].join('\n');
    assertParity('fixtures/kern.cu', cuda, 'cpp');
  });

  // Every torture fixture again with CRLF line endings — the shape every
  // Windows autocrlf checkout has. Derived in memory (not a checked-in CRLF
  // file) so no platform or editor can silently normalize it away. Pins the
  // JS-multiline-^ docstring semantics for the C comment markers (#1329).
  it.each([
    ['torture.c', 'c'],
    ['torture.cpp', 'cpp'],
    ['torture.hpp', 'cpp'],
  ] as const)('torture fixture CRLF parity: %s', (name, lang) => {
    const file = path.join(FIXTURE_DIR, name);
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity(`fixtures/${name} (crlf)`, crlf, lang);
  });

  it('spaced explicit-operator call sites defer to the wasm extractor (#1247 rides an ERROR node)', () => {
    const source = [
      'struct It { int operator*() const { return 1; } };',
      'int read_it(const It &it) { return it.operator *(); }',
      '',
    ].join('\n');
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/op.cpp', source, 'cpp')).toBeNull();
    // The seam still serves the file — through the wasm path, where the
    // operator-call recovery emits the `it.operator*` ref.
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/op.cpp', source, 'cpp');
    delete process.env.CODEGRAPH_KERNEL;
    expect(
      viaWasm.unresolvedReferences.some((r) => r.referenceName === 'it.operator*')
    ).toBe(true);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = 'void f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.c', broken, 'c')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.c', broken, 'c');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
