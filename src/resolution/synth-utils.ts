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

/** The last few long texts lineAt was asked about, each with its resolver; the most recent last. */
const LINE_AT_TEXTS: Array<{ text: string; at: (idx: number) => number }> = [];
/** How many it keeps: a scan reads one text, or one and what it was stripped from. */
const LINE_AT_KEEP = 4;
/** Below this length counting a text's lines outright is as quick as looking them up. */
const LINE_AT_SHORT = 2048;

/**
 * The 1-based line of `idx` in `text`: `text.slice(0, idx).split('\n').length`,
 * which is what every caller wrote and what this returns, without reading
 * the text up to `idx` again for each match. That idiom made a file's scan
 * take its matches times its length: a megabyte of `require` lines took a
 * minute, a generated file of some thousand routes or handlers the same. The
 * newline index of the text asked about is kept while it is the one being
 * scanned (makeLineAt).
 */
export function lineAt(text: string, idx: number): number {
  // A short text, or an index the idiom reads from the end: as written.
  if (text.length < LINE_AT_SHORT || !(idx >= 0)) return text.slice(0, idx).split('\n').length;
  let known = LINE_AT_TEXTS.length - 1;
  while (known >= 0 && LINE_AT_TEXTS[known]!.text !== text) known--;
  let entry: { text: string; at: (idx: number) => number };
  if (known >= 0) {
    entry = LINE_AT_TEXTS[known]!;
    if (known !== LINE_AT_TEXTS.length - 1) {
      LINE_AT_TEXTS.splice(known, 1);
      LINE_AT_TEXTS.push(entry);
    }
  } else {
    entry = { text, at: makeLineAt(text, 1) };
    if (LINE_AT_TEXTS.length >= LINE_AT_KEEP) LINE_AT_TEXTS.shift();
    LINE_AT_TEXTS.push(entry);
  }
  return entry.at(idx);
}

/** The last few long texts linesOf split, each with its lines; the most recent last. */
const LINES_OF_TEXTS: Array<{ text: string; lines: readonly string[] }> = [];

/**
 * `text.split('\n')`, kept for the text while it is the one being read: its
 * lines, for reading, never for changing. A check that split its file for
 * each reference it was asked about took seven seconds over a file of 1.9 MB.
 */
export function linesOf(text: string): readonly string[] {
  if (text.length < LINE_AT_SHORT) return text.split('\n');
  for (let known = LINES_OF_TEXTS.length - 1; known >= 0; known--) {
    if (LINES_OF_TEXTS[known]!.text === text) return LINES_OF_TEXTS[known]!.lines;
  }
  const lines = text.split('\n');
  if (LINES_OF_TEXTS.length >= LINE_AT_KEEP) LINES_OF_TEXTS.shift();
  LINES_OF_TEXTS.push({ text, lines });
  return lines;
}

/** Let go of the texts lineAt and linesOf keep, once the scans that read them are over. */
export function releaseLineAtTexts(): void {
  LINE_AT_TEXTS.length = 0;
  LINES_OF_TEXTS.length = 0;
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
