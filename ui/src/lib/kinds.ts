/**
 * Kind glyphs — design spec §2.3.
 *
 * A 16x16 hollow square with a mono letter. Container/type kinds get a
 * --press fill so a class reads as a box and a function as an outline.
 */

/** NodeKind values the engine emits (src/types.ts). */
export const KIND_LETTER: Record<string, string> = {
  function: 'ƒ',
  method: 'm',
  class: 'C',
  interface: 'I',
  struct: 'S',
  type_alias: 'T',
  enum: 'E',
  enum_member: 'e',
  constant: 'k',
  variable: 'v',
  property: 'p',
  field: 'p',
  file: '≡',
  route: 'R',
  component: '⟨⟩',
  namespace: 'N',
  module: 'M',
  trait: 'Tr',
  union: 'U',
  protocol: 'P',
  // Beyond the spec's list, but the engine emits them and a rail row must
  // never render a blank box. Two lowercase letters, like `Tr`.
  parameter: 'pm',
  import: 'im',
  export: 'ex',
};

/** Kinds drawn with a --press fill (they contain other symbols, or are types). */
export const FILLED_KINDS = new Set(['class', 'interface', 'struct', 'type_alias', 'trait', 'protocol', 'union', 'enum']);

/** Empty string for an unknown kind — the glyph is then a plain hollow box. */
export function kindLetter(kind: string | null | undefined): string {
  if (!kind) return '';
  return KIND_LETTER[kind] ?? kind.slice(0, 1).toUpperCase();
}

/** Human wording for the kind, as shown next to a symbol's name. */
export function kindWord(kind: string | null | undefined): string {
  if (!kind) return 'symbol';
  return kind.replace(/_/g, ' ');
}
