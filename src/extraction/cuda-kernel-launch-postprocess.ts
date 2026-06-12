/**
 * CUDA kernel launch post-processor.
 *
 * tree-sitter-cpp handles most of CUDA correctly (it parses `__global__` /
 * `__device__` functions, function bodies, and calls to `__device__` helpers
 * just like normal C++ calls). The one piece it does NOT understand is the
 * CUDA-specific kernel-launch operator
 *
 *     kernel_name<TemplateArgs><<<grid, block, smem, stream>>>(args);
 *
 * Without that, `codegraph callers <kernel>` returns the in-device callers
 * (other __device__ functions in the same kernel) but misses every host site
 * that *launches* the kernel — a fundamental edge in any CUDA codebase.
 *
 * This post-processor runs after the tree-sitter pass on `.cu` / `.cuh`
 * sources. It scans the source for `<<<...>>>` launch sites, identifies the
 * enclosing host function from the nodes already extracted, and emits one
 * `UnresolvedReference { referenceKind: 'calls' }` per launch. The existing
 * cross-file resolver then wires those refs into proper 'calls' edges, so
 * `codegraph_callers`, `codegraph_impact`, and `codegraph_trace` see the
 * host→kernel boundary transparently.
 */

import { ExtractionResult, Node, UnresolvedReference, Language } from '../types';

interface LaunchSite {
  kernelName: string;
  /** 1-indexed line of the kernel-name token */
  line: number;
  /** 1-indexed column of the kernel-name token */
  column: number;
}

/**
 * Find the smallest function/method node in the same file whose line range
 * contains `line`. That's the host launching the kernel.
 *
 * Falls back to undefined when no enclosing function exists (e.g. a launch
 * appears at file scope — unusual but legal inside a static initializer
 * macro, in which case we just drop the edge rather than misattribute it).
 */
function findEnclosingFunction(
  nodes: ReadonlyArray<Node>,
  line: number,
  filePath: string
): Node | undefined {
  let best: Node | undefined;
  for (const node of nodes) {
    if (node.filePath !== filePath) continue;
    if (node.kind !== 'function' && node.kind !== 'method') continue;
    if (node.startLine > line || node.endLine < line) continue;
    if (!best || node.endLine - node.startLine < best.endLine - best.startLine) {
      best = node;
    }
  }
  return best;
}

/**
 * Replace the contents of C/C++ comments and string/char literals with
 * whitespace so the launch-operator scanner doesn't trip on `<<<` that may
 * appear inside a doc-comment or string. Newlines are preserved so line
 * numbers stay in lockstep with the original source.
 *
 * The escape-handling here is intentionally minimal: it covers `\\` and
 * `\"` correctly and is robust enough for real CUDA source. A pathological
 * literal containing `<<<` is the only case where being slightly off would
 * matter, and that does not occur in any real `.cu` file we know of.
 */
function maskCommentsAndStrings(source: string): string {
  const n = source.length;
  const out: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    const c2 = i + 1 < n ? source[i + 1] : '';
    if (c === '/' && c2 === '/') {
      // line comment — keep newline, blank everything else
      while (i < n && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(source[i] === '*' && i + 1 < n && source[i + 1] === '/')) {
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
      }
    } else if (c === '"' || c === "'") {
      const quote = c;
      out[i] = ' ';
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out[i] = source[i] === '\n' ? '\n' : ' ';
          i++;
          if (i < n) {
            out[i] = source[i] === '\n' ? '\n' : ' ';
            i++;
          }
          continue;
        }
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        i++;
      }
    } else {
      out[i] = c === '\n' ? '\n' : c;
      i++;
    }
  }
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = source[k]!;
  return out.join('');
}

/**
 * Walk left from the position of the `<` in `<<<` to identify the kernel
 * being launched.
 *
 * Handles three lexical shapes:
 *   1. `kernel_name<<<grid,block>>>(args)`
 *   2. `kernel_name<TypeA,TypeB><<<grid,block>>>(args)` — template-instantiated
 *   3. `ns::Cls::method<<<grid,block>>>(args)` — qualified name (we still
 *      emit the unqualified leaf because that's how callers query)
 *
 * Returns null when the scan can't lock onto a plausible identifier — that
 * just means we skip emitting an edge for this site rather than guess.
 */
function parseKernelNameBefore(
  source: string,
  launchOpenIdx: number
): { name: string; offset: number } | null {
  let i = launchOpenIdx - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  // Optional `<TemplateArgs>` — match balanced template depth.
  if (i >= 0 && source[i] === '>') {
    let depth = 1;
    i--;
    while (i >= 0 && depth > 0) {
      if (source[i] === '>') depth++;
      else if (source[i] === '<') depth--;
      else if (source[i] === ';' || source[i] === '{' || source[i] === '}') return null;
      i--;
    }
    if (depth !== 0) return null;
    while (i >= 0 && /\s/.test(source[i]!)) i--;
  }
  // Identifier (the unqualified kernel name).
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(source[i]!)) i--;
  const start = i + 1;
  if (start >= end) return null;
  if (!/[A-Za-z_]/.test(source[start]!)) return null;
  return { name: source.slice(start, end), offset: start };
}

/**
 * Build a sorted array of newline offsets so we can convert byte offsets to
 * (line, column) in O(log n).
 */
function buildLineIndex(source: string): number[] {
  // Sentinel at -1 so `line 1` starts at offset 0 (column = offset - (-1) = offset+1).
  const offsets: number[] = [-1];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i);
  }
  return offsets;
}

function lineColFromIndex(
  newlineOffsets: number[],
  offset: number
): { line: number; column: number } {
  let lo = 0;
  let hi = newlineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (newlineOffsets[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - newlineOffsets[lo]! };
}

/**
 * Scan a masked source string for `<<<...>>>` launch sites and resolve each
 * to a kernel-name + (line, column) site.
 */
export function findLaunchSites(source: string): LaunchSite[] {
  const masked = maskCommentsAndStrings(source);
  const newlineOffsets = buildLineIndex(source);
  const sites: LaunchSite[] = [];
  let scanFrom = 0;
  while (true) {
    const launchOpen = masked.indexOf('<<<', scanFrom);
    if (launchOpen < 0) break;
    const launchClose = masked.indexOf('>>>', launchOpen + 3);
    if (launchClose < 0) {
      scanFrom = launchOpen + 3;
      continue;
    }
    // Forward-verify a call argument list `(...)` follows the launch config.
    let afterClose = launchClose + 3;
    while (afterClose < masked.length && /\s/.test(masked[afterClose]!)) afterClose++;
    if (afterClose >= masked.length || masked[afterClose] !== '(') {
      scanFrom = launchClose + 3;
      continue;
    }
    const parsed = parseKernelNameBefore(masked, launchOpen);
    if (parsed) {
      const { line, column } = lineColFromIndex(newlineOffsets, parsed.offset);
      sites.push({ kernelName: parsed.name, line, column });
    }
    scanFrom = launchClose + 3;
  }
  return sites;
}

/**
 * Public entry point. Appends one UnresolvedReference per CUDA kernel launch
 * to `result.unresolvedReferences`. Returns a new ExtractionResult so callers
 * can chain.
 *
 * No-op when the source contains no `<<<` — the cheap fast path that lets us
 * call this on every .cu/.cuh without measurable overhead.
 */
export function addCudaKernelLaunchReferences(
  result: ExtractionResult,
  filePath: string,
  source: string
): ExtractionResult {
  // Fast guard: only scan when at least one `<<<` is present at all.
  if (source.indexOf('<<<') < 0) return result;

  const sites = findLaunchSites(source);
  if (sites.length === 0) return result;

  const extraRefs: UnresolvedReference[] = [];
  for (const site of sites) {
    const host = findEnclosingFunction(result.nodes, site.line, filePath);
    if (!host) continue;
    extraRefs.push({
      fromNodeId: host.id,
      referenceName: site.kernelName,
      referenceKind: 'calls',
      line: site.line,
      column: site.column,
      filePath,
      language: host.language as Language,
    });
  }

  if (extraRefs.length === 0) return result;
  return {
    ...result,
    unresolvedReferences: [...result.unresolvedReferences, ...extraRefs],
  };
}
