/**
 * Small helpers the dynamic-edge synthesizers share: a per-match line
 * resolver over one source string, and "the function this line is in".
 */

import type { Node } from '../types';
import { nodesAroundLineIn } from './nodes-around';

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
  // Among the nodes that can hold the line, not all of the file's: every pass asks this for every site it finds.
  for (const n of nodesAroundLineIn(nodesInFile, line)) {
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
  for (const n of nodesAroundLineIn(nodesInFile, line)) {
    if (n.kind !== 'constant' && n.kind !== 'variable') continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n;
    }
  }
  return best;
}

/**
 * Where each of `names` first occurs in `text` as a run of characters: what
 * `text.indexOf(name)` gives for each of them (-1 for none), found for all
 * of them in one pass over the text.
 *
 * Searching for some thousand names one at a time reads the text from its
 * start once for each, and a name declared late is found late: a props
 * interface of fifty-six thousand props, each looked for from the
 * interface's first line, took twenty seconds at 1.2 MB. Here the names are
 * laid out as a trie with, for each of its states, the longest end of its
 * string that the trie also spells (Aho–Corasick); the text is read through
 * it once, each state keeps where the text first reached it, and a name's
 * first occurrence is the earliest any state ending in the name was reached.
 */
export function firstIndexOfEach(text: string, names: Iterable<string>): Map<string, number> {
  const found = new Map<string, number>();
  // The trie. State 0 is its root; an edge is looked up by the state it leaves and its character.
  const EDGE = 0x10000;
  const edges = new Map<number, number>();
  const parent: number[] = [0];
  const via: number[] = [0];
  const depth: number[] = [0];
  const ends = new Map<string, number>();
  for (const name of names) {
    if (ends.has(name) || found.has(name)) continue;
    if (name.length === 0) {
      found.set(name, 0);
      continue;
    }
    let state = 0;
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      const key = state * EDGE + code;
      let to = edges.get(key);
      if (to === undefined) {
        to = parent.length;
        edges.set(key, to);
        parent.push(state);
        via.push(code);
        depth.push(depth[state]! + 1);
      }
      state = to;
    }
    ends.set(name, state);
  }
  const states = parent.length;
  if (states === 1) return found;

  // The states, shallowest first.
  let deepest = 0;
  for (let s = 0; s < states; s++) if (depth[s]! > deepest) deepest = depth[s]!;
  const startOf = new Int32Array(deepest + 2);
  for (let s = 0; s < states; s++) startOf[depth[s]! + 1]!++;
  for (let d = 1; d < startOf.length; d++) startOf[d]! += startOf[d - 1]!;
  const order = new Int32Array(states);
  for (let s = 0; s < states; s++) order[startOf[depth[s]!]!++] = s;

  // For each state, the longest proper end of its string that the trie also
  // spells: where the reading goes on from when the next character has no
  // edge. Found through the parent's, so the shallower states come first.
  const fallback = new Int32Array(states);
  for (let at = 0; at < states; at++) {
    const state = order[at]!;
    if (depth[state]! <= 1) continue;
    const code = via[state]!;
    let from = fallback[parent[state]!]!;
    for (;;) {
      const to = edges.get(from * EDGE + code);
      if (to !== undefined) {
        fallback[state] = to;
        break;
      }
      if (from === 0) break;
      from = fallback[from]!;
    }
  }

  // Where the text first reaches each state: the index of the character that brought it there.
  const NEVER = -1;
  const reached = new Int32Array(states).fill(NEVER);
  let state = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (;;) {
      const to = edges.get(state * EDGE + code);
      if (to !== undefined) {
        state = to;
        break;
      }
      if (state === 0) break;
      state = fallback[state]!;
    }
    if (state !== 0 && reached[state] === NEVER) reached[state] = i;
  }
  // A state reached is its fallback reached too, at the same character: deepest first.
  for (let at = states - 1; at > 0; at--) {
    const from = order[at]!;
    const to = fallback[from]!;
    if (to === 0 || reached[from] === NEVER) continue;
    if (reached[to] === NEVER || reached[from]! < reached[to]!) reached[to] = reached[from]!;
  }
  for (const [name, end] of ends) found.set(name, reached[end] === NEVER ? -1 : reached[end]! - name.length + 1);
  return found;
}
