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
 * Directive summaries are cached per file, but evaluated in translation-unit
 * order on every inclusion. Only #pragma once and actual guard state suppress
 * reinclusion; an active recursion stack breaks include cycles. Unknown build
 * flags remain possible, so only definite macro visibility suppresses a call.
 * Object-like definitions participate in conditions but never enter the cached
 * call-site timelines (vendor headers can contain tens of thousands of them).
 */
import * as path from 'path';
import { maskCppRawStrings } from '../extraction/languages/c-cpp';
import { CPP_DEFINE_SIGNATURE, type ResolutionContext, type UnresolvedRef } from './types';
import { resolveImportPath } from './import-resolver';

/** Three-valued: true / false / undefined = depends on an unknown build flag. */
type Truth = boolean | undefined;
type FileEvent =
  | { kind: 'define' | 'undef'; name: string; line: number; functionLike: boolean; value: string; wrapsItself: boolean }
  | { kind: 'include'; quote: string; spec: string; line: number }
  | { kind: 'branch'; op: string; expression: string; guard: boolean; line: number }
  | { kind: 'once'; line: number };
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

/** Cache syntax, never conditional truth: an included file can change its flags. */
function summarize(file: string, context: ResolutionContext, cache: Cache): FileEvent[] {
  const cached = cache.summaries.get(file);
  if (cached) return cached;
  const events: FileEvent[] = [];
  const lines = directiveLines(context.readFile(file) ?? '');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const branch = text.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/);
    if (branch) {
      events.push({ kind: 'branch', op: branch[1]!, expression: branch[2]!,
        guard: guardsItself(lines, i, branch[1]!, branch[2]!), line: i + 1 });
      continue;
    }
    const directive = text.match(/^\s*#\s*(define|undef)\s+(\w+)(\(?)/);
    if (directive) {
      events.push({ kind: directive[1] as 'define' | 'undef', name: directive[2]!, line: i + 1,
        functionLike: directive[3] === '(', value: text.slice(directive[0].length),
        wrapsItself: directive[3] === '(' && callsItself(lines, i, directive[2]!) });
      continue;
    }
    const include = text.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
    if (include) events.push({ kind: 'include', quote: include[1]!, spec: include[2]!, line: i + 1 });
    if (/^\s*#\s*pragma\s+once\b/.test(text)) events.push({ kind: 'once', line: i + 1 });
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
  for (const raw of maskCppRawStrings(source).source.split(/\r?\n/)) {
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
  const definitions = new Map<string, { defined: Truth; value: Truth; macro: Truth }>();
  const scanning = new Set<string>();
  const macroNames = new Set<string>();
  const once = new Map<string, Truth>();
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
  const scan = (file: string, inherited: Truth, includeLine?: number): void => {
    if (inherited === false || scanning.has(file) || once.get(file) === true) return;
    scanning.add(file);
    let active: Truth = inherited;
    const frames: Array<{ parent: Truth; taken: Truth }> = [];
    for (const ev of summarize(file, context, cache)) {
      const line = includeLine ?? ev.line;
      if (ev.kind === 'branch') {
        if (ev.op === 'if' || ev.op === 'ifdef' || ev.op === 'ifndef') {
          const known = definitions.get(ev.expression.trim())?.defined;
          let selected = ev.op === 'if' ? condition(ev.expression) : ev.op === 'ifndef' ? not(known) : known;
          if (selected === undefined && ev.guard) selected = true;
          frames.push({ parent: active, taken: selected });
          active = and(active, selected);
        } else if (ev.op === 'endif') {
          active = frames.pop()?.parent ?? inherited;
        } else {
          const frame = frames[frames.length - 1];
          if (frame) {
            const test = ev.op === 'else' ? true : condition(ev.expression);
            active = and(frame.parent, and(not(frame.taken), test));
            frame.taken = or(frame.taken, test);
          }
        }
        continue;
      }
      if (active === false) continue;
      if (ev.kind === 'once') {
        once.set(file, or(once.get(file) ?? false, active));
        continue;
      }
      if (ev.kind === 'include') {
        const target = resolveInclude(file, ev.quote, ev.spec, language, context, cache);
        if (target) scan(target, active, line);
        continue;
      }
      const prior = definitions.get(ev.name);
      const defining = ev.kind === 'define';
      const macro = defining && ev.functionLike && !ev.wrapsItself;
      const now = active === true ? macro : prior?.macro === macro ? macro : undefined;
      definitions.set(ev.name, {
        defined: defining ? or(prior?.defined ?? false, active) : and(prior?.defined ?? false, not(active)),
        value: defining && active === true ? condition(ev.value) : undefined,
        macro: now,
      });
      if (ev.functionLike) macroNames.add(ev.name);
      if (macroNames.has(ev.name)) {
        const events = timeline.get(ev.name) ?? [];
        events.push({ line, defined: now });
        timeline.set(ev.name, events);
      }
    }
    scanning.delete(file);
  };

  scan(rootFile, true);
  return timeline;
}
