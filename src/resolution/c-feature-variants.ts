/**
 * Is a C function defined only for a build that turns on a flag nothing in
 * the project turns on? lua-cjson's fpconv.h defines `static inline void
 * fpconv_init()` under `#ifdef USE_INTERNAL_FPCONV` and otherwise declares it
 * `extern`, for fpconv.c to define. Nothing in redis's tree sets
 * USE_INTERNAL_FPCONV, so its build compiles fpconv.c's.
 *
 * The name matcher asks this only when choosing among definitions of one
 * name, where a call has to reach one of them: of a flag nothing sets, the
 * build to follow is the one that leaves it off. Whether a macro is visible
 * at a call (./cpp-macro-visibility) keeps such a flag unknown instead, since
 * there an unknown flag must not suppress anything.
 *
 * A branch is off only when flags decide its test: `#ifdef X`, `#ifndef X`,
 * `#if defined(X)`, `#if X`, `#if 0`, with `!`, `&&`, `||` and parentheses,
 * and the `#elif` and `#else` after them. A flag is set nowhere when the
 * definition's own file doesn't `#define` it, no build file in the
 * directories from the project root down to the definition or the call names
 * it (a Makefile's `-DX`, CMake's `option(X …)`, configure's `AC_DEFINE(X)`)
 * and no C or C++ file of their components does — a component being the
 * tree under the nearest directory with a build file, redis's `deps/lua/src`
 * for fpconv.h. A macro of the compiler or the platform — a reserved name
 * like `_WIN32` or `__linux__`, or `WIN32`, `linux`, `unix` — is unknown, and
 * so is any other test (`#if LEVEL > 1`).
 */
import type { Node } from '../types';
import type { ResolutionContext } from './types';
import { directiveLines } from './cpp-macro-visibility';
import { escapeRegExp } from '../utils';

/** Three-valued: true / false / undefined = the build may go either way. */
type Truth = boolean | undefined;
type Op = 'if' | 'ifdef' | 'ifndef' | 'elifdef' | 'elifndef' | 'elif' | 'else' | 'endif';
interface Directive { op: Op; expression: string; line: number }
interface FileDirectives { conditionals: Directive[]; defines: Set<string> }

interface Memo {
  files: Map<string, FileDirectives>;
  /** Directory → the text of the build files directly in it. */
  buildText: Map<string, string>;
  /** Directory → the nearest directory at or above it with a build file ('' for the project root). */
  components: Map<string, string>;
  /** The project's C and C++ files, once. */
  cFiles: string[] | null;
  /** `${flag}\0${component}` → whether a C or C++ file of the component `#define`s it. */
  defines: Map<string, boolean>;
  /** Flag → the build-file test for its name. */
  named: Map<string, RegExp>;
  answers: Map<string, boolean>;
}

const MEMO = new WeakMap<ResolutionContext, Memo>();

export function clearCFeatureVariantMemos(context: ResolutionContext): void {
  MEMO.delete(context);
}

function memoFor(context: ResolutionContext): Memo {
  let memo = MEMO.get(context);
  if (!memo) {
    memo = { files: new Map(), buildText: new Map(), components: new Map(), cFiles: null, defines: new Map(), named: new Map(), answers: new Map() };
    MEMO.set(context, memo);
  }
  return memo;
}

const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === true && b === true ? true : undefined);
const or = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === false && b === false ? false : undefined);
const not = (a: Truth): Truth => (a === undefined ? undefined : !a);

const C_FAMILY_FILE = /\.(c|h|cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+|inl|ipp|tcc|inc|m|mm)$/i;
const PLATFORM_FLAGS = new Set(['WIN32', 'WIN64', 'linux', 'unix']);
const BUILD_FILES = [
  'Makefile', 'makefile', 'GNUmakefile', 'Makefile.am', 'Makefile.in', 'CMakeLists.txt', 'meson.build',
  'meson_options.txt', 'configure.ac', 'configure.in', 'config.h.in', 'BUILD', 'BUILD.bazel', 'SConstruct', 'SConscript',
];

const dirOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf('/')));

/** `a/b/c.h` → `a/b`, `a`, `` (the project root). */
function ancestors(file: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirOf(file); ; dir = dirOf(dir)) {
    dirs.push(dir);
    if (dir === '') return dirs;
  }
}

/**
 * Is `fn`'s definition compiled only by a build that sets a flag nothing in
 * the project sets, for the call at `ref`? A branch around both the
 * definition and the call, in the call's own file, decides nothing.
 */
export function isCFeatureVariant(fn: Node, ref: { filePath: string; line: number }, context: ResolutionContext): boolean {
  const memo = memoFor(context);
  const sameFile = fn.filePath === ref.filePath;
  const key = `v\0${fn.id}\0${sameFile ? ref.line : dirOf(ref.filePath)}`;
  const hit = memo.answers.get(key);
  if (hit !== undefined) return hit;
  const file = directivesOf(fn.filePath, context, memo);
  let groups = enclosingTests(file.conditionals, fn.startLine);
  if (sameFile) {
    const around = enclosingTests(file.conditionals, ref.line);
    let shared = 0;
    while (shared < groups.length && shared < around.length &&
      groups[shared]![0] === around[shared]![0] && groups[shared]!.length === around[shared]!.length) shared++;
    groups = groups.slice(shared);
  }
  const off = groups.length > 0 && isOff(groups, file, [fn.filePath, ref.filePath], context, memo);
  memo.answers.set(key, off);
  return off;
}

/** Is line `line` of `path` compiled only by a build that sets a flag nothing in the project sets? */
export function isOffByDefault(path: string, line: number, context: ResolutionContext): boolean {
  const memo = memoFor(context);
  const key = `o\0${path}\0${line}`;
  const hit = memo.answers.get(key);
  if (hit !== undefined) return hit;
  const file = directivesOf(path, context, memo);
  const groups = enclosingTests(file.conditionals, line);
  const off = groups.length > 0 && isOff(groups, file, [path], context, memo);
  memo.answers.set(key, off);
  return off;
}

/** Is a branch of `groups` off when no flag `scope`'s files see is set? */
function isOff(groups: Directive[][], file: FileDirectives, scope: string[], context: ResolutionContext, memo: Memo): boolean {
  const dirs = [...new Set(scope.flatMap(ancestors))];
  const flag = (name: string): Truth => {
    if (name.startsWith('_') || PLATFORM_FLAGS.has(name) || file.defines.has(name)) return undefined;
    let named = memo.named.get(name);
    // A word of its own, or a compiler flag's `-DX` / `/DX`.
    if (!named) memo.named.set(name, (named = new RegExp(`(?:^|[^\\w]|[-/]D)${escapeRegExp(name)}\\b`, 'm')));
    if (dirs.some((dir) => named!.test(buildTextOf(dir, context, memo)))) return undefined;
    const components = new Set(scope.map((f) => componentOf(dirOf(f), context, memo)));
    return [...components].some((component) => isDefinedIn(name, component, context, memo)) ? undefined : false;
  };
  return groups.some((tests) => branchTruth(tests, flag) === false);
}

/**
 * The branches around `line`, innermost last: for each, the tests of its
 * group's branches up to and including the one `line` is in (`#else` has no
 * test).
 */
function enclosingTests(conditionals: Directive[], line: number): Directive[][] {
  const groups: Directive[][] = [];
  for (const d of conditionals) {
    if (d.line >= line) break;
    if (d.op === 'if' || d.op === 'ifdef' || d.op === 'ifndef') groups.push([d]);
    else if (d.op === 'endif') groups.pop();
    else groups[groups.length - 1]?.push(d);
  }
  return groups;
}

/** Whether the last branch of `tests` is taken: no earlier test held, and its own does. */
function branchTruth(tests: Directive[], flag: (name: string) => Truth): Truth {
  let earlier: Truth = false;
  for (let i = 0; i < tests.length - 1; i++) {
    earlier = or(earlier, testTruth(tests[i]!, flag));
    if (earlier === true) return false;
  }
  return and(not(earlier), testTruth(tests[tests.length - 1]!, flag));
}

function testTruth(d: Directive, flag: (name: string) => Truth): Truth {
  const name = d.expression.trim().match(/^\w+$/)?.[0];
  switch (d.op) {
    case 'ifdef':
    case 'elifdef':
      return name ? flag(name) : undefined;
    case 'ifndef':
    case 'elifndef':
      return name ? not(flag(name)) : undefined;
    case 'else':
      return true;
    default:
      return evaluate(d.expression, flag);
  }
}

/**
 * A `#if` expression of `defined`, flags, integers, `!`, `&&`, `||` and
 * parentheses; anything else is unknown. A flag that is set nowhere reads as
 * `0`, as the preprocessor reads a name no `#define` gave a value.
 */
function evaluate(expression: string, flag: (name: string) => Truth): Truth {
  const tokens = expression.match(/0x[\da-f]+\w*|\d\w*|[A-Za-z_]\w*|&&|\|\||\S/gi) ?? [];
  // Check the shape first, so an unsupported test reads no flag.
  let i = 0;
  const shape = (): boolean => {
    const term = (): boolean => {
      const t = tokens[i++];
      if (t === '!') return term();
      if (t === '(') return shape() && tokens[i++] === ')';
      if (t === 'defined') {
        const paren = tokens[i] === '(';
        if (paren) i++;
        return /^[A-Za-z_]\w*$/.test(tokens[i++] ?? '') && (!paren || tokens[i++] === ')');
      }
      return t !== undefined && (/^(0x[\da-f]+|\d+)[ul]*$/i.test(t) || /^[A-Za-z_]\w*$/.test(t));
    };
    if (!term()) return false;
    while (tokens[i] === '&&' || tokens[i] === '||') {
      i++;
      if (!term()) return false;
    }
    return true;
  };
  if (tokens.length === 0 || !shape() || i !== tokens.length) return undefined;

  i = 0;
  const disjunction = (): Truth => {
    let value = conjunction();
    while (tokens[i] === '||') {
      i++;
      value = or(value, conjunction());
    }
    return value;
  };
  const conjunction = (): Truth => {
    let value = term();
    while (tokens[i] === '&&') {
      i++;
      value = and(value, term());
    }
    return value;
  };
  const term = (): Truth => {
    const t = tokens[i++]!;
    if (t === '!') return not(term());
    if (t === '(') {
      const value = disjunction();
      i++;
      return value;
    }
    if (t === 'defined') {
      if (tokens[i] === '(') {
        const value = flag(tokens[i + 1]!);
        i += 3;
        return value;
      }
      return flag(tokens[i++]!);
    }
    if (/^\d|^0x/i.test(t)) return Number.parseInt(t.replace(/[ul]+$/i, ''), /^0x/i.test(t) ? 16 : 10) !== 0;
    return flag(t) === false ? false : undefined;
  };
  return disjunction();
}

function directivesOf(file: string, context: ResolutionContext, memo: Memo): FileDirectives {
  const hit = memo.files.get(file);
  if (hit) return hit;
  const lines = directiveLines(context.readFile(file) ?? '');
  const conditionals: Directive[] = [];
  const defines = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const define = lines[i]!.match(/^\s*#\s*define\s+(\w+)/);
    if (define) {
      defines.add(define[1]!);
      continue;
    }
    const m = lines[i]!.match(/^\s*#\s*(ifdef|ifndef|if|elifdef|elifndef|elif|else|endif)\b(.*)$/);
    if (!m) continue;
    // A test continued with a backslash goes on over the next lines.
    let expression = m[2]!;
    for (let j = i; /\\\s*$/.test(lines[j]!) && j + 1 < lines.length; j++) {
      expression = expression.replace(/\\\s*$/, ' ') + lines[j + 1]!;
    }
    conditionals.push({ op: m[1] as Op, expression, line: i + 1 });
  }
  const directives = { conditionals, defines };
  memo.files.set(file, directives);
  return directives;
}

function buildTextOf(dir: string, context: ResolutionContext, memo: Memo): string {
  const hit = memo.buildText.get(dir);
  if (hit !== undefined) return hit;
  const text = BUILD_FILES.map((name) => context.readFile(dir ? `${dir}/${name}` : name) ?? '').join('\n');
  memo.buildText.set(dir, text);
  return text;
}

/** The nearest directory at or above `dir` with a build file, else the project root. */
function componentOf(dir: string, context: ResolutionContext, memo: Memo): string {
  const hit = memo.components.get(dir);
  if (hit !== undefined) return hit;
  const component = dir === '' || buildTextOf(dir, context, memo).trim() ? dir : componentOf(dirOf(dir), context, memo);
  memo.components.set(dir, component);
  return component;
}

/** Does a C or C++ file under `component` `#define` `name`? Read only from files whose bytes hold the name. */
function isDefinedIn(name: string, component: string, context: ResolutionContext, memo: Memo): boolean {
  const key = `${name}\0${component}`;
  const hit = memo.defines.get(key);
  if (hit !== undefined) return hit;
  memo.cFiles ??= context.getAllFiles().filter((file) => C_FAMILY_FILE.test(file));
  const prefix = component ? `${component}/` : '';
  const define = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${escapeRegExp(name)}\\b`, 'm');
  const defined = memo.cFiles.some((file) =>
    file.startsWith(prefix) &&
    (context.fileContains ? context.fileContains(file, name) : true) &&
    define.test(context.readFile(file) ?? ''));
  memo.defines.set(key, defined);
  return defined;
}
