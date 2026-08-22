/**
 * Kernel↔wasm Ruby extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/ruby.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixture (torture.rb: the importTypes:['call'] funnel and its
 * class-body DSL blindness, mixin implements refs WITH filePath (the v2
 * ref-flag wire path), module nesting + the hook multiply-capture, the
 * sibling-scan visibility trio, require/require_relative path refs incl. the
 * Kernel.require and interpolated-path quirks, the ruby call branch
 * (`.new` instantiates, constant-receiver references, `&.` joins, raw chain
 * text), bare-call statements (do…end vs brace-block blindness), heredocs,
 * `=begin` docstring marker survival, value-ref targets + shadow prune,
 * `__END__` trailer) and its CRLF variant (derived in-memory — #1329).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (sinatra/jekyll/
 * rails for the §5 gate); this suite keeps the invariant alive in `npm test`.
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

describe.skipIf(!kernelBuilt)('kernel Ruby extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['ruby']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'ruby');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'ruby');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  it('torture fixture: modules/mixins, visibility scan, requires, call zoo, value refs', () => {
    const file = path.join(FIXTURE_DIR, 'torture.rb');
    assertParity('fixtures/torture.rb', fs.readFileSync(file, 'utf8'), 30);
  });

  // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
  // memory so no platform or editor can silently normalize it away; pins the
  // JS-multiline-^ docstring semantics for `#` runs and `=begin` bodies
  // (#1329), plus heredoc/`%`-literal CRLF parsing.
  it('torture fixture CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.rb');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.rb (crlf)', crlf, 30);
  });

  it('mixin implements refs carry filePath through the v2 ref-flag wire path', () => {
    const src = 'class Widget\n  include Comparable\nend\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('src/widget.rb', src, 'ruby');
    expect(viaKernel).not.toBeNull();
    const impl = viaKernel!.unresolvedReferences.find((r) => r.referenceKind === 'implements');
    expect(impl?.referenceName).toBe('Comparable');
    expect(impl?.filePath).toBe('src/widget.rb');
    // Ordinary refs stay un-denormalized.
    const other = viaKernel!.unresolvedReferences.find((r) => r.referenceKind !== 'implements');
    if (other) expect(other.filePath).toBeUndefined();
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = 'def broken(\n  x = [1,\nend\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.rb', broken, 'ruby')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.rb', broken, 'ruby');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
