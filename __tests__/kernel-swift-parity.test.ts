/**
 * Kernel↔wasm Swift extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/swift.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixture (torture.swift: the DEDICATED in-class property branch
 * (#1020 — computed→property with getter walk, static let/var→constant/
 * variable, stored→field, owner-attributed decorator/type/attr-arg refs,
 * observed-property field + class-attributed observer calls), extensions
 * (multi-segment resolveName, sugar `[Proto]` names, where-clauses),
 * everything-is-extends inheritance, the full call matrix (subscript reads,
 * `defer`, optional-chaining receivers, #750 re-encode, literal-set
 * membership quirks, implicit members), positional return types with the
 * nested-generic failure, present-false isAsync, `open`→internal visibility,
 * multi-case enum first-only minting, `/** *​/` docs ignored-and-chain-
 * breaking, value-ref targets incl. the declared-then-assigned
 * assignment-prune case the swift-nio sweep caught, SWIFT_SPEC fn-refs with
 * the label-forward skip and #selector shapes) and its CRLF variant (derived
 * in-memory — #1329).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (Alamofire/vapor/
 * swift-nio, --max-deferral 0.3 — swift error incidence is structurally
 * 9–27% on BOTH arms); this suite keeps the invariant alive in `npm test`.
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

describe.skipIf(!kernelBuilt)('kernel Swift extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['swift']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'swift');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'swift');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  it('torture fixture: property branch, extensions, call matrix, value refs, fn-refs', () => {
    const file = path.join(FIXTURE_DIR, 'torture.swift');
    assertParity('fixtures/torture.swift', fs.readFileSync(file, 'utf8'), 40);
  });

  // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
  // memory so no platform or editor can silently normalize it away; pins the
  // JS-multiline-^ docstring semantics for `///` runs (#1329).
  it('torture fixture CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.swift');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.swift (crlf)', crlf, 40);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // A NEW-only regression construct (`#if` between enum cases — the swift
    // checklist's grammar-bump delta 5) — errors on the 0.7.3 grammar.
    const broken = 'enum E {\n  case a\n#if DEBUG\n  case b\n#endif\n}\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/Broken.swift', broken, 'swift')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/Broken.swift', broken, 'swift');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
