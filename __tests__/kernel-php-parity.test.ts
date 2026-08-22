/**
 * Kernel↔wasm PHP extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/php.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixtures:
 *
 *  - torture.php          — file-level namespace scoping, the use-import trio
 *    (single/aliased/bare/function/const + grouped incl. the nested `Sub\Deep`
 *    SKIP), include/require ×4 + dynamic (nothing), the visitNode hook (consts
 *    at every scope, trait-use implements WITH filePath — the v2 ref-flag wire
 *    path), interface multi-extends first-only drop, the call-encoding zoo
 *    (`this->prop.m`, DOT-joined scoped calls, `Cls::factory().m` fluent,
 *    nullsafe `?->` nothing, literal receivers kept), instantiation shapes
 *    (qualified verbatim, `new static/self/parent` literal, `$cls`, the
 *    anonymous-class garbage ref + file-level-function methods), static value
 *    reads, php type refs, HOF string/array callables, value-ref targets
 *    (namespaced top-level consts DROPPED), heredoc/nowdoc/interpolation,
 *    attributes shifting node lines without emitting.
 *  - TortureModule.module — drupal extension routing + un-namespaced
 *    top-level const value-ref target + hook-docblocked function.
 *  - TortureHtml.php      — leading/interleaved HTML (absolute row positions),
 *    `<?=` short echo.
 *
 * CRLF variants are derived in-memory (#1329 docblock semantics). The
 * full-repo sweep lives in scripts/kernel-parity.mjs (monolog /
 * laravel-framework / symfony for the §5 gate); this suite keeps the invariant
 * alive in `npm test`. Skips when no kernel binary is staged;
 * CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure (kernel-scaffold.test.ts).
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

describe.skipIf(!kernelBuilt)('kernel PHP extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['php']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'php');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'php');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  const FIXTURES: Array<{ file: string; minNodes: number }> = [
    { file: 'torture.php', minNodes: 45 },
    { file: 'TortureModule.module', minNodes: 3 },
    { file: 'TortureHtml.php', minNodes: 2 },
  ];

  for (const { file, minNodes } of FIXTURES) {
    it(`${file}: namespace, hook, imports, call zoo, value refs`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      assertParity(`fixtures/${file}`, src, minNodes);
    });

    // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
    // memory so no platform or editor can silently normalize it away; pins the
    // JS-multiline-^ docblock semantics (#1329) plus heredoc/nowdoc CRLF
    // parsing through the external scanner.
    it(`${file} CRLF parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const crlf = src.replace(/(?<!\r)\n/g, '\r\n');
      assertParity(`fixtures/${file} (crlf)`, crlf, minNodes);
    });
  }

  it('trait-use implements refs carry filePath through the v2 ref-flag wire path', () => {
    const src = '<?php\nclass W {\n  use SoftDeletes;\n}\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('src/W.php', src, 'php');
    expect(viaKernel).not.toBeNull();
    const impl = viaKernel!.unresolvedReferences.find((r) => r.referenceKind === 'implements');
    expect(impl?.referenceName).toBe('SoftDeletes');
    expect(impl?.filePath).toBe('src/W.php');
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = '<?php\nfunction f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.php', broken, 'php')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.php', broken, 'php');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
