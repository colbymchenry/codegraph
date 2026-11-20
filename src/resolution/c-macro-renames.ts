/**
 * What an object-like macro renames a C or C++ name to, in the files it
 * reaches: hiredis's sdscompat.h has `#define sds hisds`, so a `sds` member in
 * redis-cli.c, which includes it, is a `hisds`, whatever a namesake in
 * src/sds.h says. The preprocessor sees this and the parser doesn't.
 *
 * A macro with no parameters gets no node, so only the source says what one
 * does. Headers are read once per resolver, in one pass over their `define`s,
 * into an index by macro name: a name no header renames costs one lookup,
 * however many files write it. So are the source files something includes
 * (`#include "impl.c"`), which reach their includers as a header does. A
 * vendor's register maps can run to hundreds of megabytes, so the pass stops at
 * a budget, past which a name is left as written. Any other source file reaches
 * itself alone, so it is read when a name in it is asked about, for its own
 * answers: the index is fixed once built, and no answer depends on which files
 * have asked. A rename counts where the translation unit from the asking file
 * has certainly defined it by that line (isCppMacroDefinedAt): a macro under a
 * flag no file sets, or written further down, renames nothing. Two renames of
 * one name that disagree (`#ifdef` arms) say nothing either.
 */
import type { ResolutionContext, UnresolvedRef } from './types';
import { cppIncludedSources, cppIncluders } from './cpp-includers';
import { directiveLines, isCppMacroDefinedAt } from './cpp-macro-visibility';

interface Memo {
  /** Macro name → the headers and included source files with a `#define` of it to one name. */
  byName: Map<string, string[]>;
  /** A source file asked about → the names it renames itself. */
  own: Map<string, ReadonlySet<string>>;
  /** `file\0name` → what the name is renamed to there (null: nothing). */
  answers: Map<string, string | null>;
}

const MEMO = new WeakMap<ResolutionContext, Memo>();

export function clearCMacroRenames(context: ResolutionContext): void {
  MEMO.delete(context);
}

const HEADER_FILE = /\.(?:h|hh|hpp|hxx)$/i;
/** Characters of the index one resolver reads for renames: redis has 2 MB of headers, rocksdb 9 MB, betaflight 109 MB. */
const HEADER_SCAN_BUDGET = 16_000_000;
/** `#define sds hisds`, with a comment after it or none. */
const RENAME_LINE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)[ \t]*(?:\/[/*].*)?\r?$/;

/** Add the renames `source` writes to the index, by a search for `define`: most of a file is no directive. */
function index(file: string, source: string, byName: Map<string, string[]>): void {
  for (let at = source.indexOf('define'); at >= 0; at = source.indexOf('define', at + 6)) {
    const next = source.charCodeAt(at + 6);
    if (next !== 32 && next !== 9) continue; // `defined(X)`
    const end = source.indexOf('\n', at);
    const line = source.slice(source.lastIndexOf('\n', at) + 1, end < 0 ? source.length : end);
    const m = RENAME_LINE.exec(line);
    if (!m) continue;
    const files = byName.get(m[1]!);
    if (!files) byName.set(m[1]!, [file]);
    else if (files[files.length - 1] !== file) files.push(file);
  }
}

function memoFor(context: ResolutionContext): Memo {
  let memo = MEMO.get(context);
  if (memo) return memo;
  const byName = new Map<string, string[]>();
  let budget = HEADER_SCAN_BUDGET;
  const read = (file: string): void => {
    const source = context.readFile(file);
    if (!source) return;
    index(file, source, byName);
    budget -= source.length;
  };
  for (const file of context.getAllFiles()) {
    if (budget <= 0) break;
    if (HEADER_FILE.test(file)) read(file);
  }
  for (const file of cppIncludedSources(context)) {
    if (budget <= 0) break;
    if (!HEADER_FILE.test(file)) read(file);
  }
  MEMO.set(context, (memo = { byName, own: new Map(), answers: new Map() }));
  return memo;
}

const NO_NAMES: ReadonlySet<string> = new Set();
const NO_FILES: readonly string[] = [];

/** What the source file `file` renames itself. */
function ownRenames(file: string, memo: Memo, context: ResolutionContext): ReadonlySet<string> {
  let own = memo.own.get(file);
  if (!own) {
    const names = new Map<string, string[]>();
    index(file, context.readFile(file) ?? '', names);
    own = names.size > 0 ? new Set(names.keys()) : NO_NAMES;
    memo.own.set(file, own);
  }
  return own;
}

/** The one name `name` is renamed to at `line` of `file`, by the file or by what it includes. */
export function cMacroRename(
  name: string,
  file: string,
  line: number,
  language: UnresolvedRef['language'],
  context: ResolutionContext
): string | null {
  const memo = memoFor(context);
  const indexed = memo.byName.get(name) ?? NO_FILES;
  const own = !HEADER_FILE.test(file) && ownRenames(file, memo, context).has(name);
  if (!own && indexed.length === 0) return null;
  const key = `${file}\0${name}`;
  let renamed = memo.answers.get(key);
  if (renamed === undefined) {
    const renames = new Set<string>();
    for (const candidate of own && !indexed.includes(file) ? [file, ...indexed] : indexed) {
      if (candidate !== file && !cppIncluders(candidate, context).has(file)) continue;
      for (const directive of directiveLines(context.readFile(candidate) ?? '')) {
        const m = RENAME_LINE.exec(directive);
        if (m?.[1] === name) renames.add(m[2]!);
      }
    }
    renamed = renames.size === 1 ? [...renames][0]! : null;
    memo.answers.set(key, renamed);
  }
  return renamed !== null && isCppMacroDefinedAt(name, file, line, language, context) ? renamed : null;
}
