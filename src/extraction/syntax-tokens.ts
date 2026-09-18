/**
 * Syntax classification from the engine's own tree-sitter parse (CG-57).
 *
 * The viewer used to run a second highlighter (Shiki + 56 pruned TextMate
 * grammars) over source the engine had already parsed with a real grammar. This
 * takes the classification off the tree instead, which removes the second
 * dependency, the second grammar set, and — the part that actually mattered —
 * the second opinion: a `.ts` file is now read by exactly the grammar that
 * decided what its symbols are.
 *
 * ## What comes out
 *
 * A flat, ordered, non-overlapping list of {@link SyntaxSpan}s over the source
 * string. Gaps between spans are whitespace and are the caller's to fill. The
 * classes are deliberately few, because the design's code colouring is
 * near-monochrome: comments recede, strings and numbers recede one step less,
 * keywords carry weight rather than hue, and the only colour in the body is a
 * call site the graph resolved.
 *
 * ## How a node becomes a class
 *
 * The rules are language-agnostic on purpose — the engine indexes 40-odd
 * languages and a per-grammar scope table would be 40 tables to keep true:
 *
 * * a node whose type mentions `comment` is a comment, whole, undescended;
 * * inside a string node every leaf is string, *except* below an interpolation,
 *   where the code starts again (so `${user.name()}` still links);
 * * a numeric literal node is a number;
 * * an **anonymous** leaf is a keyword when its text is a bare word and
 *   punctuation otherwise — this is what makes `func`, `fn`, `def`, `END-IF`
 *   and `Sub` all land as keywords without naming any of them;
 * * a **named** leaf whose text is identifier-shaped is an identifier, unless
 *   the grammar called it a type name, or the extractor's own definition tables
 *   say it is the name of a definition.
 *
 * The last of those is the one place per-language knowledge is used, and it is
 * reused rather than restated: {@link EXTRACTORS} already names every node type
 * that declares something in each language, plus the field its name hangs on.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Language } from '../types';
import { EXTRACTORS } from './languages';
import { getParser, loadGrammarsForLanguages } from './grammars';
import type { LanguageExtractor } from './tree-sitter-types';

/* ------------------------------------------------------------- the classes -- */

/**
 * Every class a token can carry, in wire order.
 *
 * `other` is punctuation and whitespace both. The design spec lists them apart
 * (`punct` vs the gaps) but they paint identically — plain ink — and splitting
 * them would roughly double the token count on a dense line to express a
 * difference nothing draws.
 */
export const SYNTAX_TOKEN_CLASSES = [
  'other',
  'ident',
  'comment',
  'string',
  'keyword',
  'number',
  'type',
  'def',
] as const;

export type SyntaxTokenClass = (typeof SYNTAX_TOKEN_CLASSES)[number];

/** A classified run of the source, by JS string index. Half-open. */
export interface SyntaxSpan {
  start: number;
  end: number;
  cls: SyntaxTokenClass;
}

/* ---------------------------------------------------------- node-type tests -- */

/**
 * Anything a grammar calls a comment.
 *
 * Substring rather than equality because the spelling is per-grammar:
 * `comment`, `line_comment`, `block_comment`, `doc_comment`, `html_comment`,
 * `comment_directive`, `preproc_comment`.
 */
function isCommentType(type: string): boolean {
  return type.includes('comment');
}

/**
 * A node whose leaves are string content unless an interpolation interrupts.
 *
 * `string` covers the bulk (`string_literal`, `interpreted_string_literal`,
 * `raw_string_literal`, `encapsed_string`, `string_content`); the rest are the
 * spellings that avoid the word — Rust/Go/C character literals, shell and PHP
 * heredocs, and regular expressions, which recede for the same reason a string
 * does.
 */
function isStringType(type: string): boolean {
  return (
    type.includes('string') ||
    type.includes('heredoc') ||
    type.includes('regex') ||
    type === 'char_literal' ||
    type === 'character' ||
    type === 'character_literal' ||
    type === 'rune_literal' ||
    type === 'quoted_attribute_value'
  );
}

/**
 * Where code resumes inside a string.
 *
 * A template literal's `${…}` and an f-string's `{…}` hold real expressions,
 * and the graph records call sites inside them. Swallowing the whole literal as
 * one string token would drop those links — the overlay refuses to claim a
 * token classed `string`, deliberately, so that a word inside a message never
 * gets underlined.
 */
function isInterpolationType(type: string): boolean {
  return (
    type.includes('interpolation') ||
    type.includes('substitution') ||
    type === 'template_substitution' ||
    type === 'string_interpolation' ||
    type === 'format_expression'
  );
}

/** A numeric literal, plus the language constants a theme groups with them. */
function isNumberType(type: string): boolean {
  return (
    type === 'number' ||
    type === 'integer' ||
    type === 'float' ||
    type === 'number_literal' ||
    type === 'integer_literal' ||
    type === 'float_literal' ||
    type === 'decimal_integer_literal' ||
    type === 'decimal_floating_point_literal' ||
    type === 'hex_integer_literal' ||
    type === 'real_literal' ||
    type === 'numeric_literal' ||
    type === 'int_literal' ||
    type === 'imaginary_literal'
  );
}

/** A named type reference — `type_identifier` and the equivalents. */
function isTypeNameType(type: string): boolean {
  return type.includes('type_identifier') || type === 'type_name' || type === 'class_type';
}

/**
 * Built-in type words — `string`, `int`, `u32`, `void`.
 *
 * These are emitted WHOLE and undescended, and they carry the same `type` class
 * a user-defined type name gets. Both halves of that matter, because the
 * grammars disagree with each other about what a built-in type even is:
 * tree-sitter-go calls `string` a `type_identifier` (so it would be a type),
 * tree-sitter-typescript wraps it in a `predefined_type` whose child is an
 * anonymous token spelled `string` (so it would be a keyword). Reading the
 * wrapper rather than its children is what stops the same word from painting
 * two different ways in two languages on the same screen.
 */
const BUILTIN_TYPE_TYPES: ReadonlySet<string> = new Set([
  'primitive_type',
  'predefined_type',
  'builtin_type',
  'sized_type_specifier',
]);

/** Literal constants a theme groups with numbers (`constant.language`). */
const CONSTANT_TYPES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'nil',
  'none',
  'undefined',
  'null_literal',
  'nil_literal',
  'boolean_literal',
  'true_literal',
  'false_literal',
]);

/**
 * Identifier-shaped text, in the loosest sense every indexed language agrees on.
 *
 * The high range is there because `\w` is ASCII-only in JavaScript and a symbol
 * name can be Chinese, Japanese or Cyrillic; a call site in those repositories
 * has to be linkable too. Hyphens are in because COBOL and Erlang spell words
 * with them (`END-IF`, `is_record`).
 */
const IDENT_SHAPE = /^[A-Za-z_$À-￿][\w$À-￿-]*$/;

/** A bare word — what separates a keyword from punctuation among anonymous nodes. */
const WORD_SHAPE = /^[A-Za-z_][A-Za-z_0-9-]*$/;

/* ------------------------------------------------------- definition names -- */

/**
 * Every node type that declares something, per language, from the extractors.
 *
 * This is the single piece of per-language knowledge the classifier uses, and
 * it is borrowed rather than restated: the same lists drive extraction, so a
 * language that learns a new declaration form gets its name bolded here for
 * free — and cannot drift, because there is only one list.
 */
function definitionTypesFor(extractor: LanguageExtractor): ReadonlySet<string> {
  return new Set([
    ...extractor.functionTypes,
    ...extractor.classTypes,
    ...extractor.methodTypes,
    ...extractor.interfaceTypes,
    ...extractor.structTypes,
    ...extractor.enumTypes,
    ...extractor.typeAliasTypes,
    ...(extractor.unionTypes ?? []),
    ...(extractor.extraClassNodeTypes ?? []),
  ]);
}

/* ------------------------------------------------------------- the walker -- */

interface WalkContext {
  source: string;
  out: SyntaxSpan[];
  defTypes: ReadonlySet<string>;
  nameField: string;
  /** Start indices of nodes that are a definition's own name. */
  defStarts: Set<number>;
  offset: number;
}

/**
 * Classify one parsed tree into spans.
 *
 * Exported for tests and for anything that already holds a tree; the usual
 * entry point is {@link tokenizeSource}, which parses first.
 */
export function classifyTree(
  root: SyntaxNode,
  source: string,
  language: Language,
  offset = 0
): SyntaxSpan[] {
  const extractor = EXTRACTORS[language];
  const ctx: WalkContext = {
    source,
    out: [],
    defTypes: extractor ? definitionTypesFor(extractor) : new Set<string>(),
    nameField: extractor?.nameField ?? 'name',
    defStarts: new Set<number>(),
    offset,
  };
  visit(root, ctx, false);
  return ctx.out;
}

function visit(node: SyntaxNode, ctx: WalkContext, inString: boolean): void {
  const type = node.type;

  if (node.isNamed && isCommentType(type)) {
    emit(ctx, node.startIndex, node.endIndex, 'comment');
    return;
  }

  if (node.isNamed && BUILTIN_TYPE_TYPES.has(type)) {
    emit(ctx, node.startIndex, node.endIndex, 'type');
    return;
  }

  // Record the definition's own name BEFORE descending — the name node is a
  // descendant, so the mark has to be in place by the time the walk reaches it.
  if (ctx.defTypes.has(type)) {
    const name = node.childForFieldName(ctx.nameField);
    if (name) ctx.defStarts.add(name.startIndex);
  }

  const childCount = node.childCount;
  if (childCount === 0) {
    emit(ctx, node.startIndex, node.endIndex, leafClass(node, ctx, inString));
    return;
  }

  const nested = isInterpolationType(type) ? false : inString || isStringType(type);

  for (let i = 0; i < childCount; i++) {
    const child = node.child(i);
    if (child) visit(child, ctx, nested);
  }
}

function leafClass(node: SyntaxNode, ctx: WalkContext, inString: boolean): SyntaxTokenClass {
  const type = node.type;

  // An ANONYMOUS node's `type` is its own literal text, so none of the
  // type-name tests below may be applied to one: `key: string` in TypeScript or
  // PHP is a token whose type is the word `string`, and reading that as a
  // string literal greys out half of every signature. Anonymous means keyword
  // or punctuation, decided on shape alone — which is also what makes `func`,
  // `fn`, `def`, `Sub` and `END-IF` all land right without naming any of them.
  if (!node.isNamed) {
    if (inString) return 'string';
    if (CONSTANT_TYPES.has(type)) return 'number';
    return WORD_SHAPE.test(type) ? 'keyword' : 'other';
  }

  if (inString || isStringType(type)) return 'string';
  if (isNumberType(type) || CONSTANT_TYPES.has(type)) return 'number';

  const text = ctx.source.slice(node.startIndex, node.endIndex);
  // Ahead of the type tests: a class name is a `type_identifier` in half these
  // grammars and a plain `identifier` in the other half, and the design bolds
  // the thing being DECLARED either way.
  if (ctx.defStarts.has(node.startIndex) && IDENT_SHAPE.test(text)) return 'def';
  if (isTypeNameType(type)) return 'type';
  return IDENT_SHAPE.test(text) ? 'ident' : 'other';
}

/**
 * Append a span, skipping empties and merging a run of the same class.
 *
 * Zero-width nodes are real: every grammar with a layout-sensitive scanner
 * (Python's `_newline`, Erlang's, Swift's) emits them, and a zero-width span
 * would put an empty token on the wire for nothing.
 */
function emit(ctx: WalkContext, start: number, end: number, cls: SyntaxTokenClass): void {
  if (end <= start) return;
  const last = ctx.out[ctx.out.length - 1];
  const from = start + ctx.offset;
  if (last && last.cls === cls && last.end === from) {
    last.end = end + ctx.offset;
    return;
  }
  ctx.out.push({ start: from, end: end + ctx.offset, cls });
}

/* --------------------------------------------------------------- regions -- */

/**
 * A stretch of a file written in a different language from the file itself.
 *
 * Single-file components are the only case: a `.svelte`, `.vue` or `.astro`
 * file has no tree-sitter grammar of its own here, but its `<script>` block —
 * where every symbol the engine indexed in that file lives — is ordinary
 * TypeScript or JavaScript. The extractors already delegate exactly this way,
 * so the viewer reads a component's code with the same grammar the graph was
 * built from. The surrounding markup stays unclassified, which under a
 * near-monochrome theme costs the recession on tag names and attribute strings
 * and nothing else.
 */
export interface SyntaxRegion {
  start: number;
  end: number;
  language: Language;
}

const SCRIPT_BLOCK = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const TS_LANG_ATTR = /lang\s*=\s*["'](ts|typescript)["']/i;
/** Astro's frontmatter: a `---` fence at the very top of the file. */
const ASTRO_FRONTMATTER = /^(---\r?\n)([\s\S]*?)\r?\n---/;

/**
 * The sub-language regions of a file, or null when the file is one language.
 *
 * Null and an empty array mean different things: null is "parse the whole file
 * as `language`", empty is "this file has a grammar for none of it".
 */
export function syntaxRegionsFor(source: string, language: Language): SyntaxRegion[] | null {
  if (language !== 'svelte' && language !== 'vue' && language !== 'astro') return null;

  const regions: SyntaxRegion[] = [];
  if (language === 'astro') {
    const front = ASTRO_FRONTMATTER.exec(source);
    if (front && front[2]) {
      const start = (front[1] as string).length;
      regions.push({ start, end: start + (front[2] as string).length, language: 'typescript' });
    }
  }

  SCRIPT_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK.exec(source)) !== null) {
    const body = match[2] ?? '';
    if (body.trim() === '') continue;
    const start = match.index + match[0].length - body.length - '</script>'.length;
    regions.push({
      start,
      end: start + body.length,
      language: TS_LANG_ATTR.test(match[1] ?? '') ? 'typescript' : 'javascript',
    });
  }
  return regions;
}

/* --------------------------------------------------------------- the API -- */

export interface TokenizeResult {
  spans: SyntaxSpan[];
  /** The grammar(s) that produced them, for the payload's `grammar` field. */
  grammars: string[];
}

/**
 * Parse `source` and classify it.
 *
 * Returns null when nothing in the file has a grammar — a plain answer, which
 * every caller here already knows how to serve. Never throws: a grammar that
 * fails to load or a parse that comes back empty is the same outcome as not
 * having one.
 */
export async function tokenizeSource(
  source: string,
  language: Language
): Promise<TokenizeResult | null> {
  const regions = syntaxRegionsFor(source, language);
  if (regions === null) {
    const spans = await tokenizeRegion(source, language, 0);
    return spans ? { spans, grammars: [language] } : null;
  }
  if (regions.length === 0) return null;

  const spans: SyntaxSpan[] = [];
  const grammars = new Set<string>();
  for (const region of regions) {
    const part = await tokenizeRegion(
      source.slice(region.start, region.end),
      region.language,
      region.start
    );
    if (!part) continue;
    grammars.add(region.language);
    spans.push(...part);
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a.start - b.start);
  return { spans, grammars: [...grammars] };
}

async function tokenizeRegion(
  source: string,
  language: Language,
  offset: number
): Promise<SyntaxSpan[] | null> {
  try {
    await loadGrammarsForLanguages([language]);
    const parser = getParser(language);
    if (!parser) return null;
    const tree = parser.parse(source);
    if (!tree?.rootNode) return null;
    try {
      return classifyTree(tree.rootNode, source, language, offset);
    } finally {
      tree.delete();
    }
  } catch {
    // A grammar that will not load, or a parse that threw: the caller serves
    // the source unclassified, which is the whole point of the plain path.
    return null;
  }
}
