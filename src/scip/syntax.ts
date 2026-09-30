/**
 * Reading the source text around a SCIP occurrence: is this reference a call,
 * a `new`, or a struct literal? SCIP records where a symbol is mentioned, not
 * how, so these few text rules are what turn references into call sites.
 * Language-specific literal rules live with their adapter (`indexers/*.ts`).
 */

import { POSITION_ENCODING_UTF8, ScipOccurrence } from './reader';

/** Given the text after and before a type reference: does the brace that follows build that type? */
export type LiteralShape = (tail: string, head: string) => boolean;

export type CallShape = 'call' | 'new' | 'literal';

/** Strips one balanced `open…close` group (type arguments) from the start of `t`; null when it never closes. */
export function skipGroup(t: string, open: string, close: string): string | null {
  if (!t.startsWith(open)) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close && --depth === 0) return t.slice(i + 1).trimStart();
  }
  return null;
}

/** Text after the callee name opens an argument list: `(`, `?.(`, or TS type arguments `<…>(`. */
export function looksLikeCall(tail: string): boolean {
  let t = tail.trimStart();
  if (t.startsWith('?.')) t = t.slice(2).trimStart();
  return skipGroup(t, '<', '>')?.startsWith('(') ?? false;
}

/** Maps a SCIP column to a JS string offset in `line`. */
function toStringOffset(line: string, col: number, encoding: number): number {
  if (encoding !== POSITION_ENCODING_UTF8 || /^[\x00-\x7f]*$/.test(line)) return col;
  return Buffer.from(line, 'utf8').subarray(0, col).toString('utf8').length;
}

/**
 * How the source text around an occurrence reads: `'call'` when an argument
 * list follows it, `'new'` when only a `new` keyword precedes it (`new Foo`),
 * `'literal'` when the language's `literal` rule accepts it (Go/Rust
 * `Type{…}`), null otherwise (a callback passed by name, a type annotation, …).
 */
export function callShape(
  o: ScipOccurrence, encoding: number, lines: string[], literal?: LiteralShape
): CallShape | null {
  const { startLine, startCol, endLine, endCol } = o.range;
  const endText = lines[endLine];
  if (endText === undefined) return null;
  const tail = endText.slice(toStringOffset(endText, endCol, encoding));
  if (looksLikeCall(tail)) return 'call';
  const startText = lines[startLine] ?? '';
  const head = startText.slice(0, toStringOffset(startText, startCol, encoding));
  if (/\bnew\s+$/.test(head)) return 'new';
  return literal?.(tail, head) ? 'literal' : null;
}
