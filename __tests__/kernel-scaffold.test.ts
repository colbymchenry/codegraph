/**
 * Native-kernel scaffold tests (R1, docs/design/rust-kernel-migration-plan.md).
 *
 * Covers the wire contract, decoder, routing policy, kill switch, and
 * per-file fallback. These are SCAFFOLD tests — behavioral parity with the
 * wasm extractors is R3's equivalence gate, not asserted here.
 *
 * The kernel binary is optional: without a staged .node
 * (scripts/build-kernel.sh) the suite skips. CI that builds the kernel sets
 * CODEGRAPH_KERNEL_EXPECT=1, which turns "missing binary" into a FAILURE so
 * the gate can't silently pass by not building the kernel.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NODE_KINDS, EDGE_KINDS } from '../src/types';
import { generateNodeId } from '../src/extraction/tree-sitter-helpers';
import { getKernel, tryKernelExtract, kernelRoutes, resetKernelForTests } from '../src/extraction/kernel';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);
const expectKernel = process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const FIXTURE = [
  'export class MathHelper {',
  '  calculateTotal(a: number): number { return helper(a); }',
  '}',
  'function helper(x: number): number { return x * 2; }',
  'helper(3);',
  '',
].join('\n');

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetKernelForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetKernelForTests();
});

it.runIf(expectKernel)('kernel binary must exist when CODEGRAPH_KERNEL_EXPECT=1', () => {
  expect(kernelBuilt, `expected kernel at ${KERNEL_PATH} — run scripts/build-kernel.sh`).toBe(true);
});

describe.skipIf(!kernelBuilt)('kernel scaffold', () => {
  it('loads and its kind tables match src/types.ts exactly', () => {
    const kernel = getKernel();
    expect(kernel).not.toBeNull();
    const info = kernel!.contractInfo();
    expect(info.nodeKinds).toEqual([...NODE_KINDS]);
    expect(info.edgeKinds).toEqual([...EDGE_KINDS]);
    expect(info.languages).toContain('typescript');
    expect(info.languages).toContain('javascript');
  });

  it('TS/JS family + Java + Python + Go route to the kernel by default; others stay wasm', () => {
    for (const lang of ['typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go'] as const) {
      expect(kernelRoutes(lang), lang).toBe(true);
    }
    expect(kernelRoutes('ruby')).toBe(false);
    expect(tryKernelExtract('src/a.rb', 'def f\nend\n', 'ruby')).toBeNull();
    // CODEGRAPH_KERNEL_LANGS REPLACES the default set when present.
    process.env.CODEGRAPH_KERNEL_LANGS = 'tsx';
    expect(kernelRoutes('typescript')).toBe(false);
    expect(kernelRoutes('tsx')).toBe(true);
  });

  describe('with typescript routed (CODEGRAPH_KERNEL_LANGS)', () => {
    beforeEach(() => {
      process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    });

    it('decodes nodes, contains edges, and calls refs from the buffers', () => {
      const result = tryKernelExtract('src/utils.ts', FIXTURE, 'typescript');
      expect(result).not.toBeNull();
      const { nodes, edges, unresolvedReferences, errors } = result!;
      expect(errors).toEqual([]);

      const byKind = (kind: string) => nodes.filter((n) => n.kind === kind);
      expect(byKind('file')).toHaveLength(1);
      expect(byKind('class').map((n) => n.name)).toEqual(['MathHelper']);
      expect(byKind('method').map((n) => n.qualifiedName)).toEqual(['MathHelper::calculateTotal']);
      expect(byKind('function').map((n) => n.name)).toEqual(['helper']);

      const file = byKind('file')[0]!;
      expect(file.id).toBe('file:src/utils.ts');
      expect(file.qualifiedName).toBe('src/utils.ts');
      expect(file.endLine).toBe(FIXTURE.split('\n').length);
      expect(file.isExported).toBe(false);

      // Every node carries the decode-call constants.
      for (const n of nodes) {
        expect(n.filePath).toBe('src/utils.ts');
        expect(n.language).toBe('typescript');
        expect(n.updatedAt).toBeGreaterThan(0);
      }

      // contains: file→class, class→method, file→function.
      const contains = edges.filter((e) => e.kind === 'contains');
      const cls = byKind('class')[0]!;
      const method = byKind('method')[0]!;
      const fn = byKind('function')[0]!;
      expect(contains).toContainEqual({ source: file.id, target: cls.id, kind: 'contains' });
      expect(contains).toContainEqual({ source: cls.id, target: method.id, kind: 'contains' });
      expect(contains).toContainEqual({ source: file.id, target: fn.id, kind: 'contains' });

      // calls refs attach to the innermost enclosing symbol (method for the
      // in-body call, file node for the top-level call).
      const calls = unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.map((r) => [r.fromNodeId, r.referenceName])).toEqual([
        [method.id, 'helper'],
        [file.id, 'helper'],
      ]);
      for (const r of calls) {
        // No denormalized filePath/language at the extraction seam — the wasm
        // extractors leave them unset (the store fills them, `?? filePath`),
        // and the kernel matches that exactly (see decode.ts).
        expect(r.filePath).toBeUndefined();
        expect(r.language).toBeUndefined();
        expect(r.line).toBeGreaterThan(0);
      }
    });

    it('kernel node ids are byte-identical to generateNodeId', () => {
      const result = tryKernelExtract('src/utils.ts', FIXTURE, 'typescript')!;
      for (const n of result.nodes) {
        if (n.kind === 'file') continue;
        expect(n.id).toBe(generateNodeId('src/utils.ts', n.kind, n.name, n.startLine));
      }
    });

    it('CODEGRAPH_KERNEL=0 kill switch disables routing', () => {
      process.env.CODEGRAPH_KERNEL = '0';
      expect(kernelRoutes('typescript')).toBe(false);
      expect(tryKernelExtract('src/a.ts', FIXTURE, 'typescript')).toBeNull();
    });

    it('languages outside the route stay on the wasm path', () => {
      expect(kernelRoutes('javascript')).toBe(false);
      expect(tryKernelExtract('src/a.js', 'function f() {}', 'javascript')).toBeNull();
    });

    it('tsx routes with its own entry and returns a graph', () => {
      process.env.CODEGRAPH_KERNEL_LANGS = 'typescript,tsx';
      const result = tryKernelExtract(
        'src/App.tsx',
        'export function App() { return render(); }\n',
        'tsx'
      );
      expect(result).not.toBeNull();
      expect(result!.nodes.some((n) => n.kind === 'function' && n.name === 'App')).toBe(true);
    });
  });

  describe('extractFromSource seam', () => {
    beforeAll(async () => {
      await initGrammars();
      await loadGrammarsForLanguages(['typescript']);
    });

    it('kill switch routes through the wasm extractor unchanged', () => {
      process.env.CODEGRAPH_KERNEL = '0';
      const result = extractFromSource('src/a.ts', 'export const f = () => 1;\n', 'typescript');
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'f')).toBe(true);
      delete process.env.CODEGRAPH_KERNEL;
      // Default-routed path produces the same node (R2 parity).
      const viaKernel = extractFromSource('src/a.ts', 'export const f = () => 1;\n', 'typescript');
      expect(viaKernel.nodes.some((n) => n.kind === 'function' && n.name === 'f')).toBe(true);
    });

    it('routed language takes the kernel and falls back per file on kernel absence', () => {
      process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
      const viaKernel = extractFromSource('src/utils.ts', FIXTURE, 'typescript');
      expect(viaKernel.nodes.map((n) => n.kind)).toContain('method');

      // Point the loader at a nonexistent binary: routing is requested but the
      // kernel can't load, so the SAME call must fall back to wasm, not fail.
      process.env.CODEGRAPH_KERNEL_PATH = path.join(__dirname, 'nope', 'missing.node');
      process.env.CODEGRAPH_KERNEL = '0'; // and belt-and-braces the kill switch
      resetKernelForTests();
      const viaWasm = extractFromSource('src/utils.ts', FIXTURE, 'typescript');
      expect(viaWasm.nodes.some((n) => n.kind === 'class' && n.name === 'MathHelper')).toBe(true);
    });
  });
});
