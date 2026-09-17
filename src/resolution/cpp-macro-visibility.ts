/**
 * Is a C/C++ call's name a function-like macro visible at the call site?
 *
 * `TRACE_POINT(1)` parses as a call_expression, so extraction records a
 * `calls` ref named `TRACE_POINT`. If the translation unit defines
 * `#define TRACE_POINT(value) ...` (in the file itself or through an
 * include), the "call" is a macro expansion — and binding it to a
 * same-spelled free function in an unrelated file fabricates a caller and a
 * callee that never existed (#1838). The resolver asks this before trying
 * any strategy and drops such a ref.
 *
 * This is a textual include walk, not a C preprocessor:
 *  - each file is summarized ONCE per resolution context into the events
 *    that matter — function-like `#define NAME(` (the object-like defines
 *    a vendor header carries by the ten thousand are skipped on syntax),
 *    `#undef`, and `#include`. `#if` / `#ifdef` / `#ifndef`
 *    / `#elif` / `#else` are evaluated with what the file itself defines
 *    (and literals), with the include-guard idiom (`#ifndef X_H` directly
 *    followed by `#define X_H`) read as the first inclusion; a condition the
 *    file can't decide (`#ifdef __GNUC__`, a build flag, a defaulted
 *    `#define ENABLE_X 0`) leaves its arm "possible";
 *  - a translation unit is the root file's events with its in-repo includes
 *    (next to the including file, through the configured include dirs, or a
 *    unique basename match) spliced in at the include line, each file at
 *    most once — include guards and `#pragma once` make a later inclusion a
 *    no-op in practice, and re-walking a shared header from every include
 *    site is exponential;
 *  - events are kept in source order, so a call ABOVE the definition, or
 *    after an `#undef`, is not a macro use;
 *  - only a DEFINITE definition suppresses the call. A macro that exists in
 *    one build configuration only (CMSIS's `__DSB()` is a macro under the
 *    ARM compilers and an inline function under GCC; a target's compat header
 *    redefines a HAL call) still lets the call bind to the function the other
 *    configuration compiles — dropping those cost a firmware tree hundreds of
 *    real edges, while the fabricated edge #1838 describes comes from an
 *    unconditional macro.
 * Summaries stay small even for vendor headers with tens of thousands of
 * object-like defines, which is what keeps a large firmware tree indexable.
 */
import * as path from 'path';
import { CPP_DEFINE_SIGNATURE, type ResolutionContext, type UnresolvedRef } from './types';
import { resolveImportPath } from './import-resolver';

/** Three-valued: true / false / undefined = depends on an unknown build flag. */
type Truth = boolean | undefined;
type FileEvent =
  | { kind: 'define' | 'undef'; name: string; line: number; active: Truth }
  | { kind: 'include'; quote: string; spec: string; line: number; active: Truth };
type Event = { line: number; defined: Truth };
type Cache = {
  summaries: Map<string, FileEvent[]>;
  includes: Map<string, string | null>;
  /** Indexed files by basename, for `#include "dir/name.h"` that no include root explains. */
  byBasename: Map<string, string[]> | null;
  /** Per root file: macro name → define/undef events in root-file line order. */
  roots: Map<string, Map<string, Event[]>>;
};

const memo = new WeakMap<ResolutionContext, Cache>();
const ROOT_TIMELINE_CAP = 32;

const and = (a: Truth, b: Truth): Truth =>
  a === false || b === false ? false : a === true && b === true ? true : undefined;
const or = (a: Truth, b: Truth): Truth =>
  a === true || b === true ? true : a === false && b === false ? false : undefined;
const not = (a: Truth): Truth => (a === undefined ? undefined : !a);

export function clearCppMacroVisibility(context: ResolutionContext): void {
  memo.delete(context);
}

const isDefine = (n: { kind: string; signature?: string }): boolean =>
  n.kind === 'constant' && CPP_DEFINE_SIGNATURE.test(n.signature ?? '');

/**
 * Is this C/C++ `calls` ref a macro expansion rather than a call? True when
 * the index knows the name as a function-like macro (extraction mints a
 * `constant` per `preproc_function_def`) and either nothing but macros bears
 * the name — there is no function to call, and a case-insensitive fuzzy
 * match (`SWAP` → `swap`) must not invent one — or the macro is definitely
 * visible at the call site.
 */
export function isVisibleCppMacro(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'c' && ref.language !== 'cpp') return false;
  if (ref.referenceKind !== 'calls' || !/^\w+$/.test(ref.referenceName)) return false;
  // The name cache is the index's truth, invalidated with the resolver's other
  // caches; a per-context name set would go stale between indexing batches.
  const sameName = context.getNodesByName(ref.referenceName);
  if (!sameName.some(isDefine)) return false;
  if (!sameName.some((n) => !isDefine(n))) return true;
  const cache = cacheFor(context);

  const rootKey = `${ref.language}\0${ref.filePath}`;
  let timeline = cache.roots.get(rootKey);
  if (!timeline) {
    timeline = walkTranslationUnit(ref.filePath, ref.language, context, cache);
    if (cache.roots.size >= ROOT_TIMELINE_CAP) cache.roots.delete(cache.roots.keys().next().value!);
    cache.roots.set(rootKey, timeline);
  }
  const before = (timeline.get(ref.referenceName) ?? []).filter((e) => e.line <= ref.line);
  return before.length > 0 && before[before.length - 1]!.defined === true;
}

function cacheFor(context: ResolutionContext): Cache {
  let cache = memo.get(context);
  if (!cache) {
    cache = { summaries: new Map(), includes: new Map(), byBasename: null, roots: new Map() };
    memo.set(context, cache);
  }
  return cache;
}

/**
 * One pass over a file: its conditional structure evaluated with what the
 * file itself defines, reduced to function-like define / undef events (with
 * the truth of the arm they sit in) and includes.
 */
function summarize(file: string, context: ResolutionContext, cache: Cache): FileEvent[] {
  const cached = cache.summaries.get(file);
  if (cached) return cached;
  const events: FileEvent[] = [];
  const lines = directiveLines(context.readFile(file) ?? '');
  const definitions = new Map<string, { defined: Truth; value: Truth }>();
  const frames: Array<{ parent: Truth; taken: Truth }> = [];
  let active: Truth = true;

  const condition = (expression: string): Truth => {
    const text = expression.trim();
    if (/^(?:0x[\da-f]+|\d+)[uUlL]*$/i.test(text)) return Number(text.replace(/[uUlL]+$/, '')) !== 0;
    const def = text.match(/^(!)?\s*defined\s*(?:\(\s*(\w+)\s*\)|(\w+))$/);
    if (def) {
      const known = definitions.get(def[2] ?? def[3]!)?.defined;
      return def[1] ? not(known) : known;
    }
    return /^\w+$/.test(text) ? definitions.get(text)?.value : undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (!/^\s*#/.test(text)) continue;
    const branch = text.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/);
    if (branch) {
      const op = branch[1];
      if (op === 'if' || op === 'ifdef' || op === 'ifndef') {
        const test = op === 'if' ? condition(branch[2]!) : definitions.get(branch[2]!.trim())?.defined;
        let selected = op === 'ifndef' ? not(test) : test;
        if (selected === undefined && guardsItself(lines, i, op, branch[2]!)) selected = true;
        frames.push({ parent: active, taken: selected });
        active = and(active, selected);
      } else if (op === 'endif') {
        active = frames.pop()?.parent ?? true;
      } else {
        const frame = frames[frames.length - 1];
        if (frame) {
          const test = op === 'else' ? true : condition(branch[2]!);
          active = and(frame.parent, and(not(frame.taken), test));
          frame.taken = or(frame.taken, test);
        }
      }
      continue;
    }
    if (active === false) continue;

    const directive = text.match(/^\s*#\s*(define|undef)\s+(\w+)(\(?)/);
    if (directive) {
      const name = directive[2]!;
      const defining = directive[1] === 'define';
      const functionLike = directive[3] === '(';
      // A wrapper macro whose body calls the same-named function —
      // `#define vec_splice(v, s, n) (vec_splice(unpack(v), s, n), …)` — is
      // how that function gets called; it hides nothing.
      const wrapsItself = functionLike && callsItself(lines, i, name);
      // An absent entry is false; an existing unknown must stay unknown.
      const prior = definitions.get(name)?.defined ?? false;
      definitions.set(name, {
        defined: defining ? or(prior, active) : and(prior, not(active)),
        value: defining && active === true ? condition(text.slice(directive[0].length)) : undefined,
      });
      if (!defining || (functionLike && !wrapsItself)) {
        events.push({ kind: defining ? 'define' : 'undef', name, line: i + 1, active });
      }
      continue;
    }
    const include = text.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
    if (include) events.push({ kind: 'include', quote: include[1]!, spec: include[2]!, line: i + 1, active });
  }
  cache.summaries.set(file, events);
  return events;
}

/**
 * The file's lines with comments removed — only as far as the preprocessor
 * needs: a line inside a block comment is blank, a directive line loses its
 * trailing `//` / `/* … *\/`, and every other line is kept verbatim (its
 * content is never read, only whether a block comment opens on it). The
 * generic comment stripper is a regex pass over the whole file and this walk
 * touches every header of a translation unit, vendor trees included.
 */
function directiveLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split(/\r?\n/)) {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) {
        out.push('');
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    const directive = /^\s*#/.test(text);
    let kept = '';
    let quote = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        kept = text.slice(0, i);
        break;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) {
          inBlock = true;
          kept = text.slice(0, i);
          break;
        }
        text = text.slice(0, i) + ' ' + text.slice(end + 2);
        i--;
        continue;
      }
    }
    out.push(directive ? kept || text : raw);
  }
  return out;
}

/** Does the body of the `#define NAME(` at `index` (continuation lines included) call `NAME`? */
function callsItself(lines: string[], index: number, name: string): boolean {
  let text = lines[index]!;
  for (let j = index; /\\\s*$/.test(lines[j]!) && j + 1 < lines.length; j++) text += ' ' + lines[j + 1]!;
  const body = text.slice(text.indexOf('(') + 1);
  return new RegExp(`(?:\\b${name}\\s*\\(|\\(\\s*${name}\\s*\\)\\s*\\()`).test(body);
}

/**
 * The include-guard idiom: `#ifndef X_H` (or `#if !defined(X_H)`) whose next
 * directive is `#define X_H`. Nothing in the file defines the guard before
 * the test, so this is the first inclusion and the guarded body is active.
 * The same shape around a fallback function-like macro (`#ifndef MIN` /
 * `#define MIN(a, b) …`) is read the same way. A default VALUE
 * (`#ifndef ENABLE_X` / `#define ENABLE_X 0`) is not: that is the flag a
 * build overrides on the command line, so it stays unknown.
 */
function guardsItself(lines: string[], index: number, op: string, expression: string): boolean {
  const name =
    op === 'ifndef'
      ? expression.trim()
      : expression.match(/^\s*!\s*defined\s*(?:\(\s*(\w+)\s*\)|(\w+))\s*$/)?.slice(1).find(Boolean);
  if (!name || !/^\w+$/.test(name)) return false;
  for (let j = index + 1; j < lines.length; j++) {
    const text = lines[j]!;
    if (!/^\s*#/.test(text)) continue;
    return new RegExp(`^\\s*#\\s*define\\s+${name}(?:\\s*$|\\()`).test(text);
  }
  return false;
}

function resolveInclude(
  file: string,
  quote: string,
  spec: string,
  language: UnresolvedRef['language'],
  context: ResolutionContext,
  cache: Cache
): string | null {
  const key = `${language}\0${file}\0${quote}${spec}`;
  const cached = cache.includes.get(key);
  if (cached !== undefined) return cached;
  const local = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.replace(/\\/g, '/')));
  let target =
    quote === '"' && !local.startsWith('../') && !path.posix.isAbsolute(local) && context.fileExists(local)
      ? local
      : resolveImportPath(spec, file, language, context);
  if (!target) {
    if (!cache.byBasename) {
      cache.byBasename = new Map();
      for (const f of context.getAllFiles()) {
        const base = f.slice(f.lastIndexOf('/') + 1);
        const list = cache.byBasename.get(base);
        if (list) list.push(f);
        else cache.byBasename.set(base, [f]);
      }
    }
    const normalized = spec.replace(/\\/g, '/');
    const matches = (cache.byBasename.get(normalized.slice(normalized.lastIndexOf('/') + 1)) ?? []).filter(
      (f) => f === normalized || f.endsWith('/' + normalized)
    );
    if (matches.length === 1) target = matches[0]!;
  }
  cache.includes.set(key, target);
  return target;
}

function walkTranslationUnit(
  rootFile: string,
  language: UnresolvedRef['language'],
  context: ResolutionContext,
  cache: Cache
): Map<string, Event[]> {
  const timeline = new Map<string, Event[]>();
  const defined = new Map<string, Truth>();
  // A file is walked once — twice when a later include reaches it
  // unconditionally after a first, conditional one (a diamond).
  const scanned = new Map<string, Truth>();

  const scan = (file: string, inherited: Truth, includeLine?: number): void => {
    if (scanned.has(file) && (scanned.get(file) === true || inherited !== true)) return;
    scanned.set(file, inherited);
    for (const ev of summarize(file, context, cache)) {
      const line = includeLine ?? ev.line;
      // An include under `#ifdef __GNUC__` brings its definitions in as
      // "possible", exactly like a define under that guard.
      const active = and(inherited, ev.active);
      if (ev.kind === 'include') {
        const target = resolveInclude(file, ev.quote, ev.spec, language, context, cache);
        if (target) scan(target, active, line);
        continue;
      }
      const prior = defined.get(ev.name) ?? false;
      const now = ev.kind === 'define' ? or(prior, active) : and(prior, not(active));
      defined.set(ev.name, now);
      const events = timeline.get(ev.name) ?? [];
      events.push({ line, defined: now });
      timeline.set(ev.name, events);
    }
  };

  scan(rootFile, true);
  return timeline;
}
