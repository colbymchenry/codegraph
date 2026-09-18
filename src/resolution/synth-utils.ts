/**
 * Small helpers the dynamic-edge synthesizers share: a per-match line
 * resolver over one source string, and "the function this line is in".
 */

import type { Node } from '../types';

/** The kinds a call site can be attributed to. */
export const FN_KINDS: ReadonlySet<string> = new Set(['method', 'function', 'component']);

/**
 * Per-match line resolver over `src`, 1-based at `baseLine`. The inline
 * `src.slice(0, idx).split('\n').length` idiom is O(source-length) PER MATCH,
 * which goes quadratic on a match-dense source (a generated function full of
 * `.push(` calls re-scanned tens of thousands of times was most of the #1235
 * indexing wedge). Builds the newline index once — lazily, since most sources
 * never produce a match — then answers each call with a binary search.
 */
export function makeLineAt(src: string, baseLine: number): (idx: number) => number {
  let nl: number[] | null = null;
  return (idx: number) => {
    if (!nl) {
      nl = [];
      for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) nl.push(i);
    }
    // Count newlines strictly before idx.
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid]! < idx) lo = mid + 1;
      else hi = mid;
    }
    return baseLine + lo;
  };
}

/** Innermost function/method node whose line range contains `line`. */
export function enclosingFn(nodesInFile: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n; // prefer the tightest (latest-starting) encloser
    }
  }
  return best;
}

/**
 * The smallest `constant` / `variable` node whose lines contain `line` — the
 * value a top-level registration is written inside (`const worker = new
 * Worker('q', async (job) => …)`): what a caller imports and a walk can start
 * from when no function encloses the site.
 */
export function enclosingValue(nodesInFile: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (n.kind !== 'constant' && n.kind !== 'variable') continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n;
    }
  }
  return best;
}
