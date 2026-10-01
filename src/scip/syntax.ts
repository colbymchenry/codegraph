/**
 * Reading the source text around a SCIP occurrence: is this reference a call,
 * a `new`, or a struct literal? SCIP records where a symbol is mentioned, not
 * how, so these few text rules are what turn references into call sites.
 * Language-specific literal rules live with their adapter (`indexers/*.ts`).
 */

import { DescriptorKind, POSITION_ENCODING_UTF8, ScipOccurrence } from './reader';

/** Given the text after and before a type reference: does the brace that follows build that type? */
export type LiteralShape = (tail: string, head: string) => boolean;

export type CallShape = 'call' | 'new' | 'literal';

/**
 * Where a trait implementation's header names the trait and the implementing
 * type (string offsets in the line), or null when the line is no such header.
 * For indexers that emit no implementation relationships (rust-analyzer): the
 * header's own references stand in for them.
 */
export type ImplHeader = (line: string) => { traitFrom: number; selfFrom: number } | null;

/**
 * What a site is about: a call, an instantiation, (`inherits`) a type's
 * `implements`/`extends` edge — one key kind for both, since codegraph and the
 * compiler may label the same base differently (`class A implements B` with B a class)
 * — or a `references` edge (a type annotation, a value read, a function passed by name).
 */
export type SiteKind = 'calls' | 'instantiates' | 'inherits' | 'references';

/** Symbol kinds a call can target: types (instantiated), methods and values (called). */
export function isCallTarget(kind: DescriptorKind | undefined): boolean {
  return kind === 'type' || kind === 'method' || kind === 'term';
}

/**
 * The call-site rule. Compaction (which references an index keeps) and the
 * merge (which it judges) both ask it, so the two can't drift apart — a
 * reference compaction dropped is one the merge never sees. A type read as
 * `X(…)`, `new X` or `X{…}` is an instantiation; a method or value followed by
 * an argument list is a call. `shape` reads source text, so it is only asked
 * for kinds that can be call targets.
 */
export function siteKind(kind: DescriptorKind | undefined, shape: () => CallShape | null): 'calls' | 'instantiates' | null {
  if (kind === 'type') return shape() ? 'instantiates' : null;
  if (kind === 'method' || kind === 'term') return shape() === 'call' ? 'calls' : null;
  return null;
}

/**
 * A trait implementation header's two types among `refs`, the type references on
 * its line (any order): the trait is the first after the impl's generics and before
 * `for`, the implementing type the first after `for`. Null when either is missing.
 */
export function implTypes<T extends ScipOccurrence>(
  header: ImplHeader, line: string, encoding: number, refs: readonly T[]
): { trait: T; self: T } | null {
  const h = header(line);
  if (!h) return null;
  const at = (o: T) => toStringOffset(line, o.range.startCol, encoding);
  const sorted = [...refs].sort((a, b) => a.range.startCol - b.range.startCol);
  const trait = sorted.find(o => at(o) >= h.traitFrom && at(o) < h.selfFrom);
  const self = sorted.find(o => at(o) >= h.selfFrom);
  return trait && self ? { trait, self } : null;
}

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
export function toStringOffset(line: string, col: number, encoding: number): number {
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
