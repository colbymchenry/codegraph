/**
 * Tests for the CUDA kernel-launch post-processor.
 *
 * These tests exercise the post-processor at two levels:
 *
 *   1. `findLaunchSites` — pure regex/parser layer. Validates the launch
 *      pattern catcher in isolation across the common CUDA shapes
 *      (untyped, template-instantiated, qualified-name, 4-arg `<<<grid,
 *      block, smem, stream>>>`) plus the negative cases that have tripped
 *      hand-written grep patterns historically (`std::cout << x`, `<<` in
 *      comments / strings, kernel-name token bracketed by a regular
 *      template that does not lead into `<<<`).
 *
 *   2. `extractFromSource` end-to-end on a synthetic `.cu` blob — validates
 *      that the post-processor (a) actually runs through the dispatch in
 *      `tree-sitter.ts`, (b) attaches each launch to the smallest enclosing
 *      host function, and (c) emits a 'calls' UnresolvedReference that the
 *      resolver will later turn into an edge.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  findLaunchSites,
  addCudaKernelLaunchReferences,
} from '../src/extraction/cuda-kernel-launch-postprocess';
import { extractFromSource } from '../src/extraction';
import {
  initGrammars,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';
import type { ExtractionResult, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  // .cu/.cuh map to 'cpp' in grammars.ts — load the cpp grammar.
  await loadGrammarsForLanguages(['cpp']);
});

describe('findLaunchSites — pure pattern catcher', () => {
  it('catches a simple two-arg launch', () => {
    const src = `void host() { my_kernel<<<grid, block>>>(a, b); }`;
    const sites = findLaunchSites(src);
    expect(sites.map((s) => s.kernelName)).toEqual(['my_kernel']);
  });

  it('catches a template-instantiated launch', () => {
    const src = `void host() { my_kernel<half><<<grid, threads>>>(a); }`;
    const sites = findLaunchSites(src);
    expect(sites.map((s) => s.kernelName)).toEqual(['my_kernel']);
  });

  it('catches a multi-arg-template launch', () => {
    const src = `void host() { my_kernel<half, 128><<<g, b>>>(p); }`;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual(['my_kernel']);
  });

  it('catches a 4-arg launch (grid, block, smem, stream)', () => {
    const src = `void host() { my_kernel<<<g, b, 0, stream>>>(p); }`;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual(['my_kernel']);
  });

  it('catches a qualified-name launch (returns unqualified leaf)', () => {
    const src = `void host() { ns::Cls::do_it<<<g, b>>>(); }`;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual(['do_it']);
  });

  it('catches multiple launches in one file', () => {
    const src = `
      void host() {
        kernel_a<<<g, b>>>(x);
        if (cond) kernel_b<half><<<g, b>>>(y);
        kernel_c<<<g, b, 0, stream>>>(z);
      }
    `;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual([
      'kernel_a',
      'kernel_b',
      'kernel_c',
    ]);
  });

  it('reports the correct (line, column) of the kernel-name token', () => {
    // Line 1: void host() {
    // Line 2:   my_kernel<<<g,b>>>(x);
    const src = `void host() {\n  my_kernel<<<g, b>>>(x);\n}`;
    const [site] = findLaunchSites(src);
    expect(site).toBeDefined();
    expect(site!.kernelName).toBe('my_kernel');
    expect(site!.line).toBe(2);
    expect(site!.column).toBe(3);
  });

  it('ignores `std::cout << x` (stream insertion, only `<<`)', () => {
    const src = `void host() { std::cout << x << y; my_kernel<<<g, b>>>(p); }`;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual(['my_kernel']);
  });

  it('ignores `<<<` inside a line comment', () => {
    const src = `void host() { /* leftover from a test: foo<<<g,b>>>(x); */ }`;
    expect(findLaunchSites(src)).toEqual([]);
  });

  it('ignores `<<<` inside a string literal', () => {
    const src = `void host() { const char* s = "doc says foo<<<g,b>>>(x)"; }`;
    expect(findLaunchSites(src)).toEqual([]);
  });

  it('ignores `<<<` that is not followed by a call (no `(` after `>>>`)', () => {
    // Not a real CUDA shape, but our verifier should refuse it gracefully
    // rather than emit a false-positive edge.
    const src = `void host() { foo<<<g, b>>>; }`;
    expect(findLaunchSites(src)).toEqual([]);
  });

  it('handles a launch with no whitespace between name and `<<<`', () => {
    const src = `void host(){kernel_x<<<g,b>>>(p);}`;
    expect(findLaunchSites(src).map((s) => s.kernelName)).toEqual(['kernel_x']);
  });
});

describe('addCudaKernelLaunchReferences — attribution to enclosing function', () => {
  const makeNode = (
    name: string,
    startLine: number,
    endLine: number,
    filePath = 'src/k.cu'
  ): Node => ({
    id: `id::${name}`,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'cpp',
    startLine,
    endLine,
    startColumn: 1,
    endColumn: 1,
  });

  const emptyResult = (nodes: Node[]): ExtractionResult => ({
    nodes,
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 0,
  });

  it('attaches the launch to the smallest enclosing host function', () => {
    // Source: line 5 is inside both `outer` (3..10) and `inner` (4..6).
    // Smallest wins → `inner`.
    const src =
      `void unrelated() {}\n` + // 1
      `\n` + // 2
      `void outer() {\n` + // 3
      `  void inner() {\n` + // 4
      `    my_kernel<<<g, b>>>(x);\n` + // 5
      `  }\n` + // 6
      `}\n` + // 7
      `// end\n`;
    const nodes = [
      makeNode('outer', 3, 7),
      makeNode('inner', 4, 6),
      makeNode('unrelated', 1, 1),
    ];

    const result = addCudaKernelLaunchReferences(emptyResult(nodes), 'src/k.cu', src);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(refs.length).toBe(1);
    expect(refs[0]!.fromNodeId).toBe('id::inner');
    expect(refs[0]!.referenceName).toBe('my_kernel');
    expect(refs[0]!.line).toBe(5);
  });

  it('emits no ref when no enclosing function exists', () => {
    // Pathological: launch at file scope.
    const src = `my_kernel<<<g, b>>>(x);\n`;
    const result = addCudaKernelLaunchReferences(emptyResult([]), 'src/k.cu', src);
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('is a no-op when source contains no `<<<`', () => {
    const nodes = [makeNode('host', 1, 5)];
    const src = `void host() { add_residual(x, y); }`;
    const before = emptyResult(nodes);
    const after = addCudaKernelLaunchReferences(before, 'src/k.cu', src);
    expect(after).toBe(before); // same reference, no new allocation
  });
});

describe('extractFromSource end-to-end on `.cu`', () => {
  it('emits a calls UnresolvedReference for a host→kernel launch', () => {
    const cu = `
__global__ void my_kernel(float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = 1.0f;
}

void host_wrapper(float* out, int n) {
  dim3 grid((n + 255) / 256);
  my_kernel<<<grid, 256>>>(out, n);
}
`;
    const result = extractFromSource('src/k.cu', cu);
    const calls = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'calls' && r.referenceName === 'my_kernel'
    );
    // tree-sitter-cpp also resolves the call expression `my_kernel(...)`
    // inside the launch as a normal call when it sees the `(args)` tail
    // after the launch config — but the IMPORTANT thing is that the
    // post-processor's contribution is present AND is attributed to the
    // host function:
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const host = result.nodes.find((n) => n.name === 'host_wrapper');
    expect(host).toBeDefined();
    const fromHost = calls.find((c) => c.fromNodeId === host!.id);
    expect(fromHost).toBeDefined();
  });

  it('does not regress non-CUDA .cpp call extraction', () => {
    const cpp = `
void plain_call_target(int x) {}

void host_caller() {
  plain_call_target(42);
}
`;
    const result = extractFromSource('src/x.cpp', cpp);
    const calls = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'calls' && r.referenceName === 'plain_call_target'
    );
    expect(calls.length).toBe(1);
  });
});
