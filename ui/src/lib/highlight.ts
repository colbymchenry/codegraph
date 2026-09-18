/**
 * Turning the server's classified source into tokens the code block can draw.
 *
 * The classification itself happens on the server (`src/ui-server/highlight/`),
 * off the engine's own tree-sitter parse — the same grammar that decided what
 * the file's symbols are. What arrives is deliberately small:
 * one array per line, each entry a `[classId, text]` pair, with the class names
 * carried alongside so the payload is self-describing. This module does two
 * things to it and nothing else — resolve the class ids to names, and compute
 * each token's column, which is what the graph's call-site overlay matches
 * against.
 *
 * ## Why the classes are names and not colours
 *
 * A theme that sent colours would have to send two of them, or force a refetch
 * every time `prefers-color-scheme` flipped. Class names let one token stream
 * serve light and dark and keep the design tokens in `app.css`, which is the
 * only place they should live. Design spec §2.2 — comments recede furthest,
 * strings and numbers one step in, keywords stay ink and gain weight, and the
 * only colour in the body is a call site the graph resolved.
 *
 * Nothing here re-tokenises. The overlay claims tokens the highlighter already
 * produced (`assignRefs` in `symbol-model.ts`), which is what makes the accent
 * underline land on the callee's own name whatever boundaries a grammar chose.
 */

export type TokenClass =
  | 'other'
  | 'ident'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  /** A named type reference. Plain ink today — the class is here so a consumer
   *  of this payload can style it without a second round of server work. */
  | 'type'
  /** The name a definition declares, from the extractor's own tables. */
  | 'def';

export interface Token {
  cls: TokenClass;
  text: string;
  /** Column of the token's first character, 0-based — how a ref finds it. */
  col: number;
}

/** `[classId, text]`, indexed into the payload's `classes` table. */
export type WireToken = [number, string];

export interface WireHighlight {
  engine: 'tree-sitter' | 'plain';
  grammar: string | null;
  classes: string[];
  lines: WireToken[][];
  /** Why the answer is unhighlighted, when it is. */
  reason?: string;
}

const CLASS_NAMES: ReadonlySet<string> = new Set<TokenClass>([
  'other',
  'ident',
  'comment',
  'string',
  'keyword',
  'number',
  'type',
  'def',
]);

/**
 * Decode one line's tokens, filling in columns.
 *
 * Columns are derived rather than sent: they are the running sum of the token
 * texts, so putting them on the wire would be duplicating a fact the payload
 * already determines — and a wire column that disagreed with the text would be
 * a silent mis-underline rather than a visible error.
 */
export function decodeLine(wire: readonly WireToken[], classes: readonly string[]): Token[] {
  const out: Token[] = [];
  let col = 0;
  for (const [id, text] of wire) {
    const name = classes[id];
    out.push({ cls: CLASS_NAMES.has(name as string) ? (name as TokenClass) : 'other', text, col });
    col += text.length;
  }
  return out;
}

/**
 * Split a line into identifier runs with no syntax classification at all.
 *
 * The fallback for the moment before a payload arrives, and for a payload that
 * carries no `highlight` block (an index served by an older build). It keeps
 * the call-site overlay working — the links come from the graph, never from the
 * grammar — so a line rendered this way loses only its colouring.
 */
export function plainLine(text: string): Token[] {
  const out: Token[] = [];
  const ident = /[A-Za-z_$À-￿][\w$À-￿]*/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = ident.exec(text)) !== null) {
    if (match.index > at) out.push({ cls: 'other', text: text.slice(at, match.index), col: at });
    out.push({ cls: 'ident', text: match[0], col: match.index });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ cls: 'other', text: text.slice(at), col: at });
  return out;
}

/**
 * The tokens for a slice, by 1-based file line.
 *
 * `from` is the slice's first line, so the map is keyed the way every other
 * part of the Symbol view counts: real file lines, never offsets into a window.
 */
export function tokensByLine(
  lines: readonly string[],
  from: number,
  highlight: WireHighlight | undefined
): Map<number, Token[]> {
  const byLine = new Map<number, Token[]>();
  for (let i = 0; i < lines.length; i++) {
    const wire = highlight?.lines[i];
    byLine.set(
      from + i,
      wire ? decodeLine(wire, highlight.classes) : plainLine(lines[i] as string)
    );
  }
  return byLine;
}

/**
 * The CSS class for a token, or null where the default ink is right.
 *
 * `type` deliberately returns null: the design's code colouring is
 * near-monochrome and a type name is not one of the four things it moves off
 * plain ink. It stays a distinct class on the wire because the classification
 * is free once the tree has been walked, and re-deriving it in a consumer would
 * not be.
 */
export function tokenClass(cls: TokenClass): string | null {
  switch (cls) {
    case 'comment':
      return 't-c';
    case 'string':
      return 't-s';
    case 'keyword':
      return 't-k';
    case 'number':
      return 't-n';
    case 'def':
      return 't-def';
    default:
      return null;
  }
}
