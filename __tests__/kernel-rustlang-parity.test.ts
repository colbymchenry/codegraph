/**
 * Kernel↔wasm Rust extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/rustlang.rs) produces the
 * SAME ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixture (torture.rs: impl/trait quirks incl. the
 * `impl Trait for Generic<T>` trait-receiver bug, unit-struct skip, phantom
 * const identifiers, use-binding refs incl. nested groups + wildcard-emits-
 * nothing, chained-call re-encode, turbofish, Rocket route macros body-only,
 * fn-ref shapes, value-ref shadowing, attribute-broken docstrings, dead-code
 * isAsync) and its CRLF variant (derived in-memory — #1329 docstring
 * semantics).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (ripgrep/tokio/
 * rust-analyzer for the §5 gate); this suite keeps the invariant alive in
 * `npm test`. Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1
 * turns that into a failure (kernel-scaffold.test.ts).
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

describe.skipIf(!kernelBuilt)('kernel Rust extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['rust']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'rust');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'rust');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  it('torture fixture: impl/trait quirks, use bindings, chains, fn-refs, value-refs, route macros', () => {
    const file = path.join(FIXTURE_DIR, 'torture.rs');
    assertParity('fixtures/torture.rs', fs.readFileSync(file, 'utf8'), 20);
  });

  // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
  // memory so no platform or editor can silently normalize it away; pins the
  // JS-multiline-^ docstring semantics for `///` runs (#1329).
  it('torture fixture CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.rs');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.rs (crlf)', crlf, 20);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = 'fn f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.rs', broken, 'rust')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.rs', broken, 'rust');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
