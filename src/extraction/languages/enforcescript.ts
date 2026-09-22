import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import { csharpExtractor } from './csharp';

/**
 * Enforce Script (DayZ modding language, `.c`) reuses the vendored C# grammar
 * — there's no dedicated tree-sitter grammar for it, and its OOP syntax is
 * close enough to C# that a handful of textual rewrites ahead of parsing
 * (below) let the C# grammar parse it cleanly. All rewrites preserve line
 * count (never touch newlines) and, except where noted, preserve exact byte
 * offsets too, so node positions stay accurate.
 */

/** Modded classes: `modded` is rewritten to this real C# modifier keyword
 * (same length, so offsets don't shift) so the class still parses as a class
 * — `sealed` doesn't exist in Enforce Script, so no real code collides with it. */
const MODDED_SENTINEL = 'sealed';

/** Marks an unresolved reference as the modded→original namesake link so the
 * dedicated framework resolver (not general name-matching, which would risk
 * a self-loop or an arbitrary pick among same-named files) is the only thing
 * that ever claims it. Exported so the resolver can match on the exact prefix. */
export const MODDED_LINK_PREFIX = '__enforcescript_modded__:';

/**
 * Blank C-style conditional-compilation directives. Enforce Script uses
 * `#ifdef`/`#ifndef` (real C#'s preprocessor only has `#if`/`#elif`/`#else`/
 * `#endif` — no `-def`/`-ndef` forms), which otherwise doesn't parse as a
 * directive at all and corrupts the rest of the file's top-level structure.
 * Blanking (not converting to `#if`) matches the existing C# extractor's
 * policy of indexing every symbol regardless of build flags.
 */
function blankPreprocessorDirectives(source: string): string {
  if (source.indexOf('#') === -1) return source;
  const re = /^([ \t]*)#[ \t]*(ifdef|ifndef|if|elif|else|endif|define|undef)\b[^\n]*/gm;
  return source.replace(re, (m, indent: string) => indent + ' '.repeat(m.length - indent.length));
}

/**
 * `modded class Foo` / `modded class Foo: Bar` / `modded class Foo extends
 * Bar`. The compiler silently ignores any inheritance clause on a modded
 * class — `Foo` stays a descendant of its own original, never `Bar`
 * (modded-classes.md #2) — so keeping the clause would create a false
 * `extends` edge. Rewritten to a bare `sealed class Foo` (no bases at all);
 * `extractModifiers`/`synthesizeMembers` below use the sentinel to flag the
 * node and link it to its namesake instead.
 */
function markModdedAndStripInheritance(source: string): string {
  source = source.replace(/\bmodded\b(?=\s+class\b)/g, MODDED_SENTINEL);
  const re = new RegExp(`\\b${MODDED_SENTINEL}\\s+class\\s+\\w+\\s*(:\\s*\\w+|extends\\s+\\w+)`, 'g');
  return source.replace(re, (m, clause: string) => m.slice(0, m.length - clause.length) + clause.replace(/[^\n]/g, ' '));
}

/**
 * `class Foo extends Bar` — Java-style inheritance real C# doesn't parse at
 * all (an ERROR node that detaches the base but leaves the body intact).
 * Rewritten to colon form, which the grammar already handles natively.
 */
function convertExtendsToColon(source: string): string {
  return source.replace(/\bclass(\s+\w+)\s+extends\b/g, (_m, nameGroup: string) => `class${nameGroup} :` + ' '.repeat('extends'.length - 1));
}

/**
 * Keyword modifiers with no C# equivalent that otherwise cause the grammar to
 * misparse `<modifier> <Type> <name>` as `type: modifier, name: Type` with
 * the real name orphaned in an ERROR sibling (the documented `proto Man
 * GetPlayer()` bug, and the same shape for event/notnull/inout/autoptr).
 * `proto(\s+native)?` is blanked as one unit — `native` alone after `proto`
 * is blanked would still misparse the same way. `ref` and `auto` are
 * deliberately NOT included: `ref` is already a valid C# modifier and `auto`
 * parses fine structurally as an (unknown) type-position identifier.
 */
function blankUnknownModifiers(source: string): string {
  return source.replace(/\bproto(\s+native)?\b|\bevent\b|\bnotnull\b|\binout\b|\bautoptr\b/g, (m) => ' '.repeat(m.length));
}

/**
 * `void ~ClassName()` — Enforce Script destructors declare an explicit `void`
 * return type (memory-refs.md #9); real C# destructors have none (a distinct
 * `destructor_declaration` grammar rule). The leftover `void` collides with
 * that rule, and on real files the resulting ERROR cascades and corrupts the
 * parse of everything after it (confirmed against a 9.7k-line vanilla file).
 */
function blankVoidBeforeDestructor(source: string): string {
  return source.replace(/\bvoid\b(?=\s+~\s*\w+\s*\()/g, (m) => ' '.repeat(m.length));
}

/**
 * `foreach (Type v: coll)` / `foreach (Type k, Type v: map)`
 * (language-rules.md #5) — C#'s foreach uses `in`, not `:`. Same cascading-
 * failure shape as the destructor case: foreach appears constantly in real
 * code, so one unhandled instance corrupts the rest of the file. NOT byte-
 * offset preserving (the standard style has no space before the colon, so
 * there's no room for ` in `) — shifts columns for the rest of that one line
 * only; no newlines are touched, so every other line stays exact.
 */
function convertForeachColonToIn(source: string): string {
  return source.replace(/\bforeach(\s*)\(([^)]*)\)/g, (m, ws: string, inner: string) => {
    const colonIdx = inner.indexOf(':');
    if (colonIdx === -1) return m;
    const before = inner.slice(0, colonIdx).replace(/\s+$/, '');
    const after = inner.slice(colonIdx + 1).replace(/^\s+/, '');
    return `foreach${ws}(${before} in ${after})`;
  });
}

/**
 * `<Type> Name(params) { body };` — a method/function body immediately
 * followed by a stray `;`. Enforce Script's compiler tolerates it — it's
 * scattered across 21+ base-game files (`gameplayeffectwidgets_base.c`,
 * `human.c`, `entityai.c`, `dayzplayerimplement.c`, …), never a mod-only
 * quirk — but a body-ful `method_declaration` can NEVER be followed by `;`
 * in the C# grammar (only a body-LESS interface-style signature can), so the
 * stray `;` derails the WHOLE class into one top-level ERROR node the
 * instant it appears (confirmed against gameplayeffectwidgets_base.c: the
 * class and all 15 of its methods vanished from the tree).
 *
 * Blanks any stray `;` directly following a `{ … }` block whose OWN `{` was
 * itself preceded by `)` — the shape shared by a method/constructor body AND
 * an `if`/`for`/`while`/`foreach`/`switch`/`catch`/`using`/`lock` body. The
 * control-flow case is deliberately not excluded: `if (x) { … };` already
 * parses as two ordinary statements (the block, then an empty statement), so
 * blanking that harmless `;` changes nothing structurally — it only matters
 * for the method-declaration case, and getting that case right without
 * false positives needs full member-vs-statement classification this stays
 * simple by not needing. (Enforce Script has no C#-style `new Foo() {
 * init };` object-initializer syntax — confirmed empirically against the
 * whole DayZ base-game script tree — so that real C# false-positive shape
 * never occurs here.)
 *
 * Brace-balanced and string/char/comment-aware so a `}` or `;` inside a
 * literal is never mistaken for a real token. Byte-offset preserving (only
 * the stray `;` itself is blanked to a space).
 */
function blankStrayBlockSemicolons(source: string): string {
  if (source.indexOf('{') === -1) return source;
  const n = source.length;
  const out: string[] = Array.from(source);
  const parenPrecededStack: boolean[] = [];
  let lastSignificant = '';
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      lastSignificant = quote;
      continue;
    }
    if (c === '{') {
      parenPrecededStack.push(lastSignificant === ')');
      lastSignificant = '{';
      i++;
      continue;
    }
    if (c === '}') {
      const precededByParen = parenPrecededStack.pop() ?? false;
      lastSignificant = '}';
      i++;
      if (precededByParen) {
        let j = i;
        while (j < n && /\s/.test(source[j] as string)) j++;
        if (source[j] === ';') out[j] = ' ';
      }
      continue;
    }
    if (!/\s/.test(c as string)) lastSignificant = c as string;
    i++;
  }
  return out.join('');
}

function preprocessEnforceScript(source: string): string {
  source = blankPreprocessorDirectives(source);
  source = markModdedAndStripInheritance(source);
  source = convertExtendsToColon(source);
  source = blankUnknownModifiers(source);
  source = blankVoidBeforeDestructor(source);
  source = convertForeachColonToIn(source);
  source = blankStrayBlockSemicolons(source);
  return source;
}

/** A class_declaration carries the `modded` sentinel modifier iff the source declared it `modded`. */
function hasModdedSentinel(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'modifier' && child.text === MODDED_SENTINEL) return true;
  }
  return false;
}

export const enforcescriptExtractor: LanguageExtractor = {
  ...csharpExtractor,
  preParse: preprocessEnforceScript,
  // `void ~ClassName()` parses as a first-class `destructor_declaration` once
  // blankVoidBeforeDestructor removes the leading `void` — same name/params/
  // body field shape as method_declaration, so no extra hooks are needed.
  methodTypes: [...csharpExtractor.methodTypes, 'destructor_declaration'],
  // File-scope free functions (`void wpnPrint(string s) { … }` outside any
  // class) — a routine EnforceScript pattern real C# has no equivalent for
  // (every C# function lives in a class); the grammar parses one exactly like
  // a C# 9 top-level-statement local function (`compilation_unit >
  // global_statement > local_function_statement`). csharpExtractor leaves
  // `functionTypes` empty since real C# has no file-scope functions to catch
  // this way. Only ever dispatched for genuinely top-level instances — one
  // nested inside another function's body is walked via visitFunctionBody,
  // which never reaches this dispatch, so no local-helper explosion.
  functionTypes: ['local_function_statement'],
  extractModifiers: (node) => (hasModdedSentinel(node) ? ['modded'] : undefined),
  // `modded class Foo` has no bases (the inheritance clause was stripped
  // pre-parse), so no false `extends` edge is ever created. This links it to
  // its namesake instead — the sentinel-prefixed reference name ensures only
  // the dedicated framework resolver (frameworks/enforcescript-modded.ts)
  // ever resolves it, never general name-matching (which has no self-
  // exclusion and would risk a self-loop when this is the only same-named
  // symbol in the project).
  synthesizeMembers: (classNode, ctx: ExtractorContext) => {
    if (!hasModdedSentinel(classNode)) return;
    const nameNode = classNode.childForFieldName('name');
    const classId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (!nameNode || !classId) return;
    ctx.addUnresolvedReference({
      fromNodeId: classId,
      referenceName: MODDED_LINK_PREFIX + getNodeText(nameNode, ctx.source),
      referenceKind: 'references',
      line: classNode.startPosition.row + 1,
      column: classNode.startPosition.column,
      filePath: ctx.filePath,
      language: 'enforcescript',
    });
  },
};