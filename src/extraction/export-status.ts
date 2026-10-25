/**
 * Export status — the ONE implementation of "is this name exported from this
 * file" (#1721).
 *
 * Three places used to answer this question, none sharing code, and they
 * disagreed:
 *
 *   1. `isExported` (the AST predicate on the TS/JS language extractors) walks
 *      the parent chain for an `export_statement` ancestor. Exact for
 *      `export function f`, blind to everything else: `const x = …; export {
 *      x }` and every CommonJS form left it false.
 *   2. `isExportedLater` (a regex over the file source, in tree-sitter.ts and
 *      mirrored by hand in the Rust kernel) exists only because of that
 *      blindness. Its single call site was the store-extraction condition, so
 *      the fix it represents was scoped to Zustand stores.
 *   3. A third, per-file check in the resolver (`isSealedModule`), which needs
 *      "does this file export anything at all" and could use neither — the AST
 *      predicate answers no for a CommonJS module, and the regex answers a
 *      per-name question.
 *
 * The result was that a CommonJS module's exports were invisible to the graph
 * as exports, `export { x }` was visible only to store extraction, and the
 * resolver re-derived a coarser version of the same fact from the same file
 * text.
 *
 * This module is the single answer. It is deliberately SOURCE-based rather
 * than AST-based, because two of the three callers (the resolver's per-file
 * question, and the kernel's decoded tables, which carry no tree) have no
 * syntax tree to walk — and because the forms the AST walk misses are exactly
 * the ones a source scan reads cleanly. The AST walk is kept as a fast path
 * for the declaration forms it is exact on (see `declaredExported`).
 *
 * Everything here is offset-preserving and comment/string-aware: a `// export
 * { x }` in a comment or an `'export { x }'` in a string is not an export.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { blankStringContents, stripCommentsForRegex } from '../resolution/strip-comments';

/**
 * The export forms a source scan recognizes. Each is anchored at a line start
 * (indentation allowed) so a mention mid-expression does not match.
 */

/** `export const x`, `export function f`, `export { x }`, `export default x`, `export * from`. */
export const ESM_EXPORT = /^[ \t]*export[\s{*]/m;

/** `declare global` contributes names to every file, exported or not. */
export const DECLARE_GLOBAL = /^[ \t]*declare\s+global\b/m;

/**
 * Anything the file could offer another file: an ESM export statement OR a
 * `declare global` block. The two are one question at the call sites that ask
 * "does this file contribute names at all" (the resolver's sealed-module and
 * classic-script checks), so they share one pattern rather than each spelling
 * the alternation out.
 */
export const ESM_EXPORT_OR_DECLARE_GLOBAL = /^[ \t]*export[\s{*]|^[ \t]*declare\s+global\b/m;

/**
 * A CommonJS export in either the dot or the bracket form: `module.exports`,
 * `exports.x`, `exports["x"]`, `exports['x']`.
 */
export const CJS_EXPORT = /\bmodule\.exports\b|\bexports\s*[.[]/;

/** A line-initial `import` statement — the marker that a JS/TS file is a module. */
export const IMPORT_STATEMENT = /^[ \t]*import[\s{*'"]/m;

/** A `require(…)` call — the other way a file joins the module system. */
export const REQUIRE_CALL = /(?:^|[^\w$.])require\s*\(/;

/** A JS/TS-family language: the only family these export forms describe. */
export function isJsTsFamily(language: string): boolean {
  return (
    language === 'typescript' ||
    language === 'javascript' ||
    language === 'tsx' ||
    language === 'jsx' ||
    language === 'arkts'
  );
}

/**
 * The source with comments blanked and string contents blanked, so a regex
 * over it cannot match text that only *looks* like an export. Offsets are
 * preserved (both helpers replace with spaces), so a match index still maps to
 * the original line.
 *
 * Template interpolations are blanked too. A CommonJS assignment genuinely can
 * execute inside one, which is why the per-file "exports nothing" verdict
 * consults the RAW source for the CommonJS forms as well (see
 * `fileExportsAnything`) — the conservative direction there is to call a file
 * exported, never to seal it.
 */
export function maskedJsSource(source: string, language: string): string {
  return blankStringContents(stripCommentsForRegex(source, jsCommentLang(language)));
}

/** The comment syntax to strip with — JS-family languages all use C-style. */
function jsCommentLang(language: string): 'typescript' {
  // stripCommentsForRegex keys its C-style branch on 'typescript'; every
  // JS-family language shares that syntax, so one key covers them.
  void language;
  return 'typescript';
}

/**
 * The source with comments blanked but string literals left INTACT — what the
 * CommonJS name scan reads. The bracket form puts the exported name inside a
 * string (`exports["x"] = …`), so blanking string contents (as
 * `maskedJsSource` does) would erase the very name being looked for. Comment
 * text is not code, so it is blanked: a commented-out CommonJS assignment is
 * not an export.
 */
export function commentStrippedJsSource(source: string, language: string): string {
  return stripCommentsForRegex(source, jsCommentLang(language));
}

/**
 * One-entry memos for the masked and comment-stripped forms of a source. The
 * extractor asks the per-name questions once per declaration node, always with
 * the same source string, so caching the last one turns a per-node O(file)
 * mask into a per-file one.
 */
let lastMasked: { source: string; language: string; text: string } | null = null;
let lastStripped: { source: string; language: string; text: string } | null = null;

/** `maskedJsSource`, memoized for the source the caller is walking. */
function maskedFor(source: string, language: string): string {
  if (lastMasked && lastMasked.source === source && lastMasked.language === language) return lastMasked.text;
  lastMasked = { source, language, text: maskedJsSource(source, language) };
  return lastMasked.text;
}

/** `commentStrippedJsSource`, memoized the same way. */
function strippedFor(source: string, language: string): string {
  if (lastStripped && lastStripped.source === source && lastStripped.language === language) return lastStripped.text;
  lastStripped = { source, language, text: commentStrippedJsSource(source, language) };
  return lastStripped.text;
}

/**
 * Whether the file source contains ANY export, in any form — the per-file
 * question the resolver asks (#1720's "does this file export anything at
 * all"). Covers the ESM statement forms, the CommonJS forms, and
 * `declare global` (which contributes names whether or not the module exports
 * anything of its own).
 *
 * Checks the RAW source for the CommonJS forms as well as the masked source,
 * because a `module.exports` assignment can execute inside a template
 * interpolation that the masker blanks. Erring toward "exports something" is
 * the safe direction: a file wrongly called exported keeps its cross-file
 * candidates, a file wrongly called sealed loses real edges.
 */
export function fileExportsAnything(source: string, language: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (CJS_EXPORT.test(source)) return true;
  const code = maskedJsSource(source, language);
  return ESM_EXPORT.test(code) || DECLARE_GLOBAL.test(code);
}

/**
 * Whether a JS/TS file is a module that exports NOTHING — an `import` or
 * `require(…)` present, no export of any form. No reference from another file
 * can reach a binding in such a file, so every one of its symbols is a false
 * candidate for a cross-file name match.
 *
 * Deliberately narrow on three axes, because each is a class this would
 * otherwise resolve wrongly in the opposite direction:
 *
 * - **A classic script is exempt.** Requiring an `import`/`require` means a
 *   non-module `.js` file — concatenated globals, a browser `<script>` — keeps
 *   its cross-file matches, where a top-level binding genuinely is reachable.
 * - **CommonJS is exempt.** `module.exports` and `exports.x` count as exports,
 *   so a CJS file is never sealed.
 * - **Other languages are exempt.** Go, Python, Java and the rest have no
 *   equivalent boundary, and several extractors hardcode `isExported`.
 */
export function isSealedModuleSource(source: string, language: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (fileExportsAnything(source, language)) return false;
  const code = maskedJsSource(source, language);
  return IMPORT_STATEMENT.test(code) || REQUIRE_CALL.test(code);
}

/**
 * Whether the file is an ES module (as opposed to a classic script or a
 * CommonJS file) — `import`/`export` syntax present, no CommonJS export and no
 * `declare global`.
 */
export function isEsModuleSource(source: string, language: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (CJS_EXPORT.test(source)) return false;
  const code = maskedJsSource(source, language);
  if (DECLARE_GLOBAL.test(code)) return false;
  return IMPORT_STATEMENT.test(code) || ESM_EXPORT.test(code);
}

/** An identifier a later `export { … }` / `export default` statement can name. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The names a declaration node binds — one for `function f` / `class C`, one
 * per declarator for `const a = 1, b = 2`. The AST predicate is asked once per
 * declaration node, so a name-based fallback has to consider every name that
 * node introduces.
 */
export function declarationNames(
  node: SyntaxNode,
  source: string,
  nameField: string
): string[] {
  const names: string[] = [];
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const declarator = node.namedChild(i);
      if (declarator?.type !== 'variable_declarator') continue;
      const nameNode = declarator.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        names.push(source.substring(nameNode.startIndex, nameNode.endIndex));
      }
    }
    return names;
  }
  const nameNode = node.childForFieldName(nameField);
  if (nameNode) {
    const text = source.substring(nameNode.startIndex, nameNode.endIndex);
    if (IDENTIFIER.test(text)) names.push(text);
  }
  return names;
}

/**
 * Whether a declaration node is exported by a form the AST walk cannot see —
 * a later `export { … }` / `export default`, or a CommonJS assignment. The AST
 * walk stays the exact fast path for the declaration forms; this is the
 * fallback that closes the blind spots.
 */
export function declarationExportedBySource(
  node: SyntaxNode,
  source: string,
  language: string,
  nameField: string
): boolean {
  if (!isJsTsFamily(language)) return false;
  const names = declarationNames(node, source, nameField);
  if (names.length === 0) return false;
  // Comments and strings are blanked before the scan: a `// export { x }` in a
  // comment or an `'export { x }'` in a string is not an export, and reading
  // the raw source here marked a declaration exported that no file could
  // reach — which then un-sealed its module and let a bare name match across
  // files (#1719). The CommonJS bracket form keeps its string
  // (`exports["x"]`), so that scan reads the comment-stripped source instead.
  const masked = maskedFor(source, language);
  const stripped = strippedFor(source, language);
  for (const name of names) {
    if (isExportedLaterInSource(masked, language, name)) return true;
    if (isCommonJsExportedName(stripped, name)) return true;
  }
  return false;
}

/**
 * Whether a name is exported by a CommonJS assignment anywhere in the file:
 * `exports.NAME = …`, `module.exports.NAME = …`, `exports["NAME"] = …`, or a
 * `module.exports = { NAME }` object literal.
 */
export function isCommonJsExportedName(source: string, name: string): boolean {
  if (!IDENTIFIER.test(name)) return false;
  const n = escapeName(name);
  const assignment = new RegExp(
    `\\b(?:module\\.exports|exports)\\s*[.[]\\s*['\"]?${n}['\"]?\\s*\\]?\\s*=`
  );
  if (assignment.test(source)) return true;
  for (const m of source.matchAll(/\bmodule\.exports\s*=\s*(\{[\s\S]*?\})\s*;?/g)) {
    const names = commonJsObjectExportNames(m[1]!);
    if (names?.includes(name)) return true;
  }
  return false;
}

/** Escape a name for literal use in a RegExp. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `name` is exported by a LATER statement than its declaration:
 * `export default NAME`, `export { NAME }`, `export { NAME as default }`.
 *
 * The declaration's own `isExported` (an `export_statement` ancestor) cannot
 * see these, so a store written as `const useStore = create(…)` + `export
 * default useStore` read as unexported and its actions were never extracted.
 *
 * Anchored per line. The name must be a specifier the clause exports AS ITSELF
 * or AS THE DEFAULT: `export { A as B }` exports `B`, and `A` is only the local
 * source of it, so a caller asking after `A` must not be told yes. That is the
 * ambient-module case, where a body's own export clause narrows what the body
 * exports — `declare module 'x' { interface Unlisted {}; export { Unlisted as
 * Renamed } }` exports `Renamed`, not `Unlisted`. `A as default` does count:
 * the binding is the module's default, which is the module itself.
 */
export function isExportedLaterInSource(source: string, language: string, name: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (!IDENTIFIER.test(name)) return false;
  const n = escapeName(name);
  if (new RegExp(`^[ \\t]*export\\s+default\\s+${n}\\s*;?[ \\t]*$`, 'm').test(source)) return true;
  for (const clause of source.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const raw of clause[1]!.split(',')) {
      const specifier = raw.trim().replace(/^type\s+/, '');
      if (!specifier) continue;
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
      if (as) {
        if (as[2] === name || (as[2] === 'default' && as[1] === name)) return true;
        continue;
      }
      if (specifier === name) return true;
    }
  }
  return false;
}

/**
 * Whether `name` is a NAMED export of the file — one an `import { name }`
 * reaches — as opposed to only the module's DEFAULT (`export default name`,
 * `export { name as default }`).
 *
 * The two are different questions and the resolver must not conflate them. A
 * declaration flagged exported because of a later `export default name` is the
 * module's default, not a named export: `import { Widget } from './x'` where
 * `x.ts` writes `class Widget {}` + `export default Widget` names nothing, and
 * a full index leaves the import unresolved (a name match may still take it).
 * Feeding the default into the named-export index made the import resolve to
 * the default's declaration, so a sync that dropped the default kept the edge
 * where a full index had none (#2744's sync case).
 *
 * Only the forms the AST walk cannot see are read here: the declaration forms
 * (`export function f`) are already exact on the node's own flag, and a caller
 * asking this question has that flag in hand.
 */
export function isNamedExportInSource(source: string, language: string, name: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (!IDENTIFIER.test(name)) return false;
  const masked = maskedFor(source, language);
  for (const clause of masked.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const raw of clause[1]!.split(',')) {
      const specifier = raw.trim().replace(/^type\s+/, '');
      // `export { a as b }` exports `b`; `a` is only the local source of it.
      if (specifier === name) return true;
    }
  }
  return isCommonJsExportedName(strippedFor(source, language), name);
}

/**
 * Whether `name` is exported ONLY as the module's default — `export default
 * name` / `export { name as default }` — and by no named form.
 *
 * This is the guard the resolver's named-export index needs. A declaration the
 * shared scan flags exported because of a later `export default name` is the
 * module's DEFAULT, not a named export: `import { Widget } from './x'` where
 * `x.ts` writes `class Widget {}` + `export default Widget` names nothing. The
 * declaration forms and the named clause are checked first, so a file that also
 * writes `export { Widget }` (or `export function Widget`) is not default-only
 * and keeps its named export.
 *
 * `export default function f` / `export default class C` are NOT default-only
 * by this test: the AST walk already flags them on main, so the resolver's
 * index has always carried them, and narrowing that is a separate question.
 */
export function isDefaultOnlyExportInSource(source: string, language: string, name: string): boolean {
  if (!isJsTsFamily(language)) return false;
  if (!IDENTIFIER.test(name)) return false;
  const n = escapeName(name);
  const masked = maskedFor(source, language);
  const declared = new RegExp(
    `^[ \\t]*export\\s+(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum|namespace|abstract\\s+class)\\s+${n}\\b`,
    'm'
  ).test(masked);
  if (declared || isNamedExportInSource(source, language, name)) return false;
  if (new RegExp(`^[ \\t]*export\\s+default\\s+${n}\\s*;?[ \\t]*$`, 'm').test(masked)) return true;
  return new RegExp(
    `^[ \\t]*export\\s+(?:type\\s+)?\\{[^}]*\\b${n}\\s+as\\s+default\\b[^}]*\\}`,
    'm'
  ).test(masked);
}

/**
 * The property a CommonJS export assignment binds a value to —
 * `exports.NAME = …` or `module.exports.NAME = …` — or null for any other
 * assignment. The name is read from the assignment's LEFT side, so it works
 * whether or not the value is a function.
 *
 * `exports["NAME"]` / `exports['NAME']` are read too: the bracket form is the
 * same export, and only the dot form was recognized before.
 */
export function commonJsExportNameFromAssignment(left: string): string | null {
  const text = left.trim();
  const dot = /^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)$/.exec(text);
  if (dot) return dot[1]!;
  const bracket = /^(?:module\.exports|exports)\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]$/.exec(text);
  if (bracket) return bracket[2]!;
  return null;
}

/**
 * The names a `module.exports = { … }` object literal exports, in shorthand
 * (`{ x }`), keyed (`{ x: impl }`) and string-keyed (`{ 'x': impl }`) form.
 * Returns null when the right-hand side is not an object literal.
 *
 * A `module.exports = { … }` is how a CommonJS module hands out its whole
 * surface; without this every name in it stayed invisible as an export.
 */
export function commonJsObjectExportNames(right: string): string[] | null {
  const text = right.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const body = text.slice(1, -1);
  const names: string[] = [];
  for (const rawEntry of splitTopLevel(body)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    // `...spread` contributes names this scan cannot know — skip it rather
    // than guess one.
    if (entry.startsWith('...')) continue;
    const colon = topLevelColon(entry);
    if (colon === -1) {
      // Shorthand `{ x }` — the name is the binding.
      const name = entry.replace(/^\.\.\./, '').trim();
      if (IDENTIFIER.test(name)) names.push(name);
      continue;
    }
    const key = entry.slice(0, colon).trim();
    const quoted = /^(['"])([A-Za-z_$][\w$]*)\1$/.exec(key);
    if (quoted) names.push(quoted[2]!);
    else if (IDENTIFIER.test(key)) names.push(key);
  }
  return names;
}

/** Split an object-literal body on top-level commas (not inside braces/brackets/parens/strings). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The index of the top-level `:` in an object-literal entry, or -1. */
function topLevelColon(entry: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Every name the file exports, by any form. Used where a caller needs the set
 * rather than a per-name verdict (the resolver's export-list check).
 *
 * `export { a, b as c }` contributes BOTH names: `a` is the local binding and
 * `c` is the exported one, and a caller asking "is this name exported" may be
 * asking about either. Re-exports (`export { x } from './y'`) contribute the
 * exported name only — the local one belongs to the other file.
 */
export function exportedNamesInSource(source: string, language: string): Set<string> {
  const names = new Set<string>();
  if (!isJsTsFamily(language)) return names;
  const code = maskedJsSource(source, language);

  // `export { a, b as c }` and `export { a } from './x'`.
  for (const m of code.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    const clause = m[1]!;
    const reExport = /^\s*from\b/m.test(code.slice(m.index! + m[0].length).split('\n')[0] ?? '');
    for (const item of clause.split(',')) {
      const entry = item.trim().replace(/^type\s+/, '');
      if (!entry) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry);
      if (asMatch) {
        if (!reExport) names.add(asMatch[1]!);
        names.add(asMatch[2]!);
      } else if (IDENTIFIER.test(entry)) {
        names.add(entry);
      }
    }
  }

  // `export default NAME` / `export default function NAME` / `export = NAME`.
  for (const m of code.matchAll(
    /^[ \t]*export\s+(?:default\s+(?:function\s+|class\s+)?|=)\s*([A-Za-z_$][\w$]*)/gm
  )) {
    names.add(m[1]!);
  }

  // `export const x`, `export function f`, `export class C` — the declaration
  // forms, so a caller asking by name gets a hit without walking a tree.
  for (const m of code.matchAll(
    /^[ \t]*export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum|namespace|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    names.add(m[1]!);
  }

  // CommonJS: `exports.x = …`, `module.exports.x = …`, and the object literal
  // `module.exports = { x, y: impl }`.
  for (const m of source.matchAll(/\b(?:module\.exports|exports)\s*[.[]\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*\]?\s*=/g)) {
    names.add(m[2]!);
  }
  for (const m of source.matchAll(/\bmodule\.exports\s*=\s*(\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s*;?/g)) {
    const rhs = m[1]!;
    const objNames = commonJsObjectExportNames(rhs);
    if (objNames) for (const n of objNames) names.add(n);
    else if (IDENTIFIER.test(rhs)) names.add(rhs);
  }

  return names;
}
