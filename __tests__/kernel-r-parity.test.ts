/**
 * Kernel↔wasm R extraction parity (R7b batch 4 of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/rlang.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixture (torture.R: every visitNode-hook branch — function/variable/
 * constant assignments in all five operators, the class quartet
 * setClass/setRefClass/R6Class/ggproto with list()+direct methods and
 * extends refs, setGeneric/setMethod, the import quintet with its five
 * silent-consumption shapes, class-idiom variable suppression, chained/
 * right-assign/precedence-ghost gaps — plus the raw-text callee zoo
 * (`pkg::fn`, `obj$meth`, `"strfn"` quotes kept, `(handler)` conversion,
 * `calls "return"`), duplicate same-(kind,name,line) ids, parse-clean raw
 * strings/underscore-pipe/trailing commas, and UTF-16 emoji columns) and its
 * CRLF variant (derived in-memory — #1329).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (dplyr/ggplot2/shiny
 * for the §5 gate); this suite keeps the invariant alive in `npm test`.
 * Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1 turns that
 * into a failure (kernel-scaffold.test.ts).
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

describe.skipIf(!kernelBuilt)('kernel R extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['r']);
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

  function assertParity(filePath: string, source: string, minNodes = 3): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, 'r');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'r');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
    return viaKernel!;
  }

  it('torture fixture: hook branches, class quartet, import quintet, call zoo', () => {
    const file = path.join(FIXTURE_DIR, 'torture.R');
    const result = assertParity('fixtures/torture.R', fs.readFileSync(file, 'utf8'), 40);

    // Pin the R-distinctive quirks on the KERNEL arm so both arms drifting
    // together can't silently lose them (checklist §The visitNode hook):
    // return/next/break are named nodes in v1.2.0 — `return(g(x))` emits a
    // literal `calls "return"` ref alongside `calls g`.
    const refNames = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refNames).toContain('return');
    // Dynamic-arg imports are consumed SILENTLY — the `file.path` call inside
    // `source(file.path("R", "dyn.R"))` vanishes (subtree never visited).
    expect(refNames).not.toContain('file.path');
    // The named-first-argument bug: `library(help = docpkg)` imports docpkg.
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'docpkg')).toBe(true);
    // Class-idiom suppression: Account has a class node but NO variable twin.
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Account')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'Account')).toBe(false);
    // No R node ever carries a docstring (roxygen is dropped).
    expect(result.nodes.every((n) => n.docstring === undefined)).toBe(true);
  });

  // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
  // memory so no platform or editor can silently normalize it away. The only
  // LF↔CRLF extraction difference for R is `\r\n` bytes inside multi-line
  // import signatures — both arms must agree byte-for-byte.
  it('torture fixture CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.R');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.R (crlf)', crlf, 40);
  });

  // BOM variant — the err-battery pinned BOM sources as parse-clean; derive it
  // in-memory for the same reason as CRLF.
  it('torture fixture BOM parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.R');
    const bom = '﻿' + fs.readFileSync(file, 'utf8');
    assertParity('fixtures/torture.R (bom)', bom, 40);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // `x <-` with no rhs is a MISSING-node incomplete (genuinely broken).
    const broken = 'ok_fn <- function() 1\nx <-\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.R', broken, 'r')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.R', broken, 'r');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
