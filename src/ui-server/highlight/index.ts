/**
 * Server-side syntax classification for the viewer's code block.
 *
 * The classes come off the engine's OWN tree-sitter parse (CG-57). Until then
 * the viewer ran a second highlighter — Shiki, plus 56 pruned TextMate grammars
 * shipped beside the binary — over source the engine had already parsed with a
 * real grammar. That is gone: one grammar set, one opinion about what a `.ts`
 * file is, nothing extra in the bundle, and roughly an order of magnitude off
 * the cost on the language that used to be worst (see below).
 *
 * Three properties are unchanged, because they are what make this safe to
 * depend on:
 *
 * * **It never fails a request.** A grammar that will not load, a parse that
 *   throws, a language nobody wrote a grammar for, a slice too big to be worth
 *   parsing — every one of them answers `engine: 'plain'` with a reason and the
 *   source still goes out. Highlighting is the part that degrades; nothing else
 *   does.
 * * **Identifiers survive whatever token boundaries the grammar chose.** Every
 *   code token is split into identifier runs before it goes on the wire, which
 *   is what lets the viewer wrap a call site as a link by *claiming a token*
 *   rather than re-tokenising the line on top of the classifier's answer.
 * * **The classification is a class name, not a colour.** The viewer paints
 *   from CSS custom properties, so one token stream serves light and dark and
 *   the design tokens live in exactly one place.
 *
 * ## Cost, measured
 *
 * On the dev Mac, 3 000 lines, cold (parse + classify + wire):
 *
 * | | TypeScript | Go | Python |
 * |---|---|---|---|
 * | Shiki (was) | ~700 ms | 43–57 ms | 35–47 ms |
 * | tree-sitter (now) | 24–41 ms | ~30 ms | 25–29 ms |
 *
 * Rust, Ruby, PHP, C# and Swift all land between 14 and 27 ms on the same
 * measurement. TypeScript's TextMate grammar was 5–7× every other one and the
 * cost was regex *execution*, not compilation — nothing about the old module
 * could have fixed it, and it is now the same order as everything else. The
 * slice cache still exists, because a re-render (a theme flip, a resize,
 * stepping back through the trail) should cost nothing at all, and because a
 * whole-file view pages the same file repeatedly.
 */

import { SYNTAX_TOKEN_CLASSES, tokenizeSource, type SyntaxTokenClass } from '../../extraction/syntax-tokens';
import type { Language } from '../../types';
import { grammarFor } from './languages';

export { COMPONENT_LANGUAGES, grammarFor, isHighlightable } from './languages';
export { SYNTAX_TOKEN_CLASSES as TOKEN_CLASSES } from '../../extraction/syntax-tokens';

/** One token on the wire: its class id, then its text. */
export type WireToken = [number, string];

export interface HighlightResult {
  /** `tree-sitter` when a grammar produced the classes; `plain` when nothing did. */
  engine: 'tree-sitter' | 'plain';
  /** The grammar the source was read with, or null. */
  grammar: string | null;
  /** Class names, indexed by the first element of every {@link WireToken}. */
  classes: readonly string[];
  /** One entry per source line, in order. */
  lines: WireToken[][];
  /** Why the answer is plain, when it is. Absent on the happy path. */
  reason?: string;
}

/**
 * Lines above this are not classified.
 *
 * Matches `MAX_SOURCE_LINES`, so anything the source endpoint will serve, this
 * will try to classify.
 */
export const MAX_HIGHLIGHT_LINES = 4000;

/**
 * Characters above this are not classified.
 *
 * The line cap alone does not bound the work: one minified bundle line can be
 * two megabytes, and a parser walks it character by character. This is the
 * guard that keeps a single request from wedging a single-threaded loopback
 * server, and it is generous — 600 kB is far more source than any screen
 * renders.
 */
export const MAX_HIGHLIGHT_CHARS = 600_000;

/** Classified slices kept in memory. Most are one symbol's body. */
export const SLICE_CACHE_LIMIT = 96;

/**
 * Total cached lines, which is the bound that actually matters.
 *
 * The entry count alone does not bound memory: 96 slices of a symbol body is a
 * megabyte, 96 whole 4 000-line files is two orders of magnitude more, and this
 * process is a reader someone leaves open all day. Twenty thousand lines is
 * roughly a working set of every symbol a session visits, or a handful of whole
 * files, and the eviction is the same recency order.
 */
export const SLICE_CACHE_LINES = 20_000;

/** Class name → its index in {@link SYNTAX_TOKEN_CLASSES}, which is what the wire carries. */
const CLASS_ID = Object.fromEntries(
  SYNTAX_TOKEN_CLASSES.map((name, index) => [name, index])
) as Record<SyntaxTokenClass, number>;

/**
 * Classes that are never merged with their neighbour.
 *
 * Every identifier-shaped token has to stay claimable on its own — the overlay
 * wraps exactly one of them as a call-site link, and two merged into one token
 * would underline both or neither.
 */
const UNMERGEABLE: ReadonlySet<SyntaxTokenClass> = new Set<SyntaxTokenClass>([
  'ident',
  'type',
  'def',
]);

/* -------------------------------------------------------------- the cache -- */

const sliceCache = new Map<string, HighlightResult>();
let cachedLines = 0;

function cacheGet(key: string): HighlightResult | undefined {
  const hit = sliceCache.get(key);
  // Re-insert so the map's insertion order is a recency order and the first
  // key is always the coldest.
  if (hit) {
    sliceCache.delete(key);
    sliceCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: HighlightResult): void {
  sliceCache.set(key, value);
  cachedLines += value.lines.length;
  while (
    sliceCache.size > SLICE_CACHE_LIMIT ||
    (cachedLines > SLICE_CACHE_LINES && sliceCache.size > 1)
  ) {
    const oldest = sliceCache.keys().next();
    if (oldest.done) break;
    cachedLines -= sliceCache.get(oldest.value)?.lines.length ?? 0;
    sliceCache.delete(oldest.value);
  }
}

/** Drop everything cached. Tests use it; nothing in the server needs to. */
export function clearHighlightCache(): void {
  sliceCache.clear();
  cachedLines = 0;
}

/** What the slice cache is holding — for tests, and for anyone diagnosing it. */
export function highlightCacheStats(): { entries: number; lines: number } {
  return { entries: sliceCache.size, lines: cachedLines };
}

/* ------------------------------------------------------------- the entry -- */

export interface HighlightOptions {
  /** The engine's language for the file, e.g. `typescript`. */
  language?: string | null;
  /**
   * A key that changes whenever the text does — the file's content hash plus
   * the requested range. Omit it and the slice is classified every time.
   */
  cacheKey?: string;
}

/**
 * Classify `lines` for the viewer's code block.
 *
 * Never throws and never rejects: every failure path returns a plain result
 * carrying the reason, because the caller is serving source and the source is
 * the part that matters.
 */
export async function highlightLines(
  lines: readonly string[],
  options: HighlightOptions = {}
): Promise<HighlightResult> {
  const grammar = grammarFor(options.language);
  const key = options.cacheKey ? `${grammar ?? '-'} ${options.cacheKey}` : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const result = await highlightUncached(lines, options.language ?? null, grammar);
  if (key) cachePut(key, result);
  return result;
}

async function highlightUncached(
  lines: readonly string[],
  language: string | null,
  grammar: string | null
): Promise<HighlightResult> {
  if (!grammar) {
    return plain(lines, null, 'No syntax grammar covers this file type.');
  }
  if (lines.length > MAX_HIGHLIGHT_LINES) {
    return plain(lines, grammar, `Too many lines to highlight (over ${MAX_HIGHLIGHT_LINES}).`);
  }
  const text = lines.join('\n');
  if (text.length > MAX_HIGHLIGHT_CHARS) {
    return plain(lines, grammar, 'Too much text on too few lines to highlight (minified?).');
  }

  const tokenized = await tokenizeSource(text, language as Language);
  if (!tokenized || tokenized.spans.length === 0) {
    return plain(lines, grammar, `The ${grammar} grammar is not available in this build.`);
  }

  return {
    engine: 'tree-sitter',
    grammar: tokenized.grammars.join('+') || grammar,
    classes: SYNTAX_TOKEN_CLASSES,
    lines: toWireLines(lines, text, tokenized.spans),
  };
}

function plain(lines: readonly string[], grammar: string | null, reason?: string): HighlightResult {
  return {
    engine: 'plain',
    grammar,
    classes: SYNTAX_TOKEN_CLASSES,
    lines: lines.map(atomizePlain),
    ...(reason ? { reason } : {}),
  };
}

/* -------------------------------------------------------- spans to lines -- */

/**
 * Cut the classifier's spans into one token list per source line.
 *
 * The classifier answers over the whole slice, in string offsets, and leaves
 * the gaps between spans unclassified — those are whitespace and the layout
 * separators no grammar names. Here they become plain tokens, multi-line spans
 * (a block comment, a heredoc) are split at the newlines, and every line ends
 * up with a token list whose texts concatenate back to exactly that line.
 *
 * One entry per line, always: the code block indexes rows positionally, so a
 * short answer would render every line below it against the wrong source.
 */
function toWireLines(
  lines: readonly string[],
  text: string,
  spans: readonly { start: number; end: number; cls: SyntaxTokenClass }[]
): WireToken[][] {
  const pieces: { start: number; end: number; cls: SyntaxTokenClass }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    const start = Math.max(span.start, cursor);
    if (start > cursor) pieces.push({ start: cursor, end: start, cls: 'other' });
    pieces.push({ start, end: span.end, cls: span.cls });
    cursor = span.end;
  }
  if (cursor < text.length) pieces.push({ start: cursor, end: text.length, cls: 'other' });

  const out: WireToken[][] = [];
  let lineStart = 0;
  let first = 0;
  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    const row: WireToken[] = [];
    while (first < pieces.length && (pieces[first] as { end: number }).end <= lineStart) first += 1;
    for (let i = first; i < pieces.length; i++) {
      const piece = pieces[i] as { start: number; end: number; cls: SyntaxTokenClass };
      if (piece.start >= lineEnd) break;
      const from = Math.max(piece.start, lineStart);
      const to = Math.min(piece.end, lineEnd);
      if (to > from) pushPiece(row, text.slice(from, to), piece.cls);
    }
    out.push(row);
    lineStart = lineEnd + 1; // the '\n' the join put back
  }
  return out;
}

/* ---------------------------------------------------------- atomisation -- */

/**
 * An identifier, in the loosest sense every indexed language agrees on.
 *
 * The high range is there because `\w` is ASCII-only in JavaScript and a symbol
 * name can be Chinese, Japanese or Cyrillic; a call site in those repositories
 * has to be linkable too.
 */
const IDENT = /[A-Za-z_$À-￿][\w$À-￿]*/g;

/**
 * Add one classified run to a line, splitting it into identifier atoms.
 *
 * This is the step that makes the graph's call-site links independent of how a
 * grammar chose to chunk a line: the viewer has to be able to wrap exactly
 * `withLock` in `this.mutex.withLock`, and giving it identifier-sized atoms up
 * front means the overlay only ever *claims* a token, never re-cuts one.
 *
 * Comments and strings are left whole on purpose: no edge points inside one,
 * and a doc comment split into forty atoms is forty times the wire bytes for
 * nothing.
 */
function pushPiece(row: WireToken[], text: string, cls: SyntaxTokenClass): void {
  if (cls === 'comment' || cls === 'string') {
    push(row, cls, text);
    return;
  }
  splitIdentifiers(row, text, cls);
}

function atomizePlain(line: string): WireToken[] {
  const out: WireToken[] = [];
  splitIdentifiers(out, line, 'other');
  return out;
}

/**
 * Emit `text` as alternating non-identifier and identifier runs.
 *
 * An identifier inside a run the grammar called a keyword keeps the keyword
 * class — `func` should still carry its weight — while the overlay's matcher
 * looks at a token's *text*, not its class, so a language whose grammar calls a
 * declared type name something unexpected still links.
 */
function splitIdentifiers(out: WireToken[], text: string, cls: SyntaxTokenClass): void {
  if (text === '') return;
  IDENT.lastIndex = 0;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENT.exec(text)) !== null) {
    if (match.index > at) push(out, gapClass(cls), text.slice(at, match.index));
    push(out, cls === 'other' ? 'ident' : cls, match[0]);
    at = match.index + match[0].length;
  }
  if (at < text.length) push(out, gapClass(cls), text.slice(at));
}

/** The class for the non-identifier remainder of a run. */
function gapClass(cls: SyntaxTokenClass): SyntaxTokenClass {
  return UNMERGEABLE.has(cls) ? 'other' : cls;
}

/** Append, merging into the previous token when it carries the same class. */
function push(out: WireToken[], cls: SyntaxTokenClass, text: string): void {
  if (text === '') return;
  const id = CLASS_ID[cls];
  const last = out[out.length - 1];
  if (last && last[0] === id && !UNMERGEABLE.has(cls)) {
    last[1] += text;
    return;
  }
  out.push([id, text]);
}
