/**
 * Which of a class's same-named methods overrides an overload of a type it
 * implements or extends (#2663). Java, Kotlin, C# and Scala make an override
 * repeat the parameter list of the method it overrides, so of
 * `ExampleServiceImpl`'s two `putTairValue`s, `putTairValue(String)` is the
 * one a call to `ExampleService.putTairValue(String)` runs, never
 * `putTairValue(List<String>, double)`. The override pass
 * (interfaceOverrideEdges) asks this module once a name is overloaded on
 * either side; a name declared once on each side pairs as it always has.
 *
 * Parameter lists come from the stored signatures (`Object (String tairKey)`
 * in Java, `(tairKey: String): Any?` in Kotlin, `(id: Long): Any` in Scala).
 * C# methods store none, so theirs is read from the declaration, as the
 * resolver's own overload choice reads it (name-matcher's overloadSetOf).
 */
import type { Node } from '../types';
import type { ResolutionContext } from './types';
import { typeParametersInScope } from './type-parameters';
import { escapeRegExp } from '../utils';

/** The languages whose overrides repeat the parameter list of the method they override. */
export const PARAMETER_OVERRIDE_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin', 'csharp', 'scala']);

/** How far a C# declaration is read for its parameter list: attributes, then a parameter a line. */
const CSHARP_HEAD_LINES = 40;

/** C#'s keyword for each BCL type it aliases: `String key` and `string key` are one parameter type. */
const CSHARP_KEYWORD_TYPES: Readonly<Record<string, string>> = {
  String: 'string', Object: 'object', Boolean: 'bool', Byte: 'byte', SByte: 'sbyte', Char: 'char',
  Decimal: 'decimal', Double: 'double', Single: 'float', Int16: 'short', UInt16: 'ushort', Int32: 'int',
  UInt32: 'uint', Int64: 'long', UInt64: 'ulong', IntPtr: 'nint', UIntPtr: 'nuint',
};

/** How two parameter types compare: alike, possibly alike, or told apart. */
type Fit = 'same' | 'maybe' | 'differs';

/**
 * A filter for one run of the override pass: `(base, methods)` keeps the
 * methods that can override `base`, from same-named methods of a class
 * implementing or extending its type, in their order:
 *
 * - those with as many parameters as `base`, never one with another count;
 * - of those, the ones whose parameter types are `base`'s, when there are any;
 * - else the ones whose types can't be told apart from `base`'s: a type
 *   parameter of `base`, its class or a class around it stands for any type
 *   in its place (`save(T entity)` implemented as `save(String entity)`), a
 *   type with its type arguments dropped or nullable may be the same type (a
 *   raw `List` for `List<String>`), and the types of a method in another
 *   language (a Kotlin class implementing a Java interface) aren't compared
 *   at all.
 *
 * Every method, as before, when `base`'s parameters can't be read or its
 * language isn't one of {@link PARAMETER_OVERRIDE_LANGUAGES}; a method whose
 * own parameters can't be read is kept with those that might match.
 */
export function overrideFilter(context: ResolutionContext): (base: Node, methods: readonly Node[]) => Node[] {
  const types = new Map<string, readonly string[] | null>();
  const typesOf = (m: Node): readonly string[] | null => {
    let found = types.get(m.id);
    if (found === undefined) {
      found = parameterTypes(m, context);
      types.set(m.id, found);
    }
    return found;
  };
  // Asked of a base method only: an override's own type parameter facing a
  // concrete type of the base is no override in these languages (`<A> A
  // appendTo(A, …)` does not override `appendTo(StringBuilder, …)`), and the
  // overrides of one base sit in many files that would each be read.
  const scopes = new Map<string, ReadonlySet<string>>();
  const scopeOf = (m: Node): ReadonlySet<string> => {
    let found = scopes.get(m.id);
    if (!found) {
      found = typeParametersInScope(m, context);
      scopes.set(m.id, found);
    }
    return found;
  };
  return (base, methods) => {
    const want = PARAMETER_OVERRIDE_LANGUAGES.has(base.language) ? typesOf(base) : null;
    if (!want) return [...methods];
    const same: Node[] = [];
    const maybe: Node[] = [];
    for (const m of methods) {
      const have = PARAMETER_OVERRIDE_LANGUAGES.has(m.language) ? typesOf(m) : null;
      if (!have) {
        maybe.push(m);
        continue;
      }
      if (have.length !== want.length) continue;
      if (m.language !== base.language) {
        maybe.push(m);
        continue;
      }
      let fit: Fit = 'same';
      for (let i = 0; i < want.length && fit !== 'differs'; i++) {
        const f = compareTypes(want[i]!, () => scopeOf(base), have[i]!, base.language);
        if (f !== 'same') fit = f;
      }
      if (fit === 'same') same.push(m);
      else if (fit === 'maybe') maybe.push(m);
    }
    return same.length > 0 ? same : maybe;
  };
}

/**
 * How parameter type `a` of a base method compares with `b`, the override's
 * type in the same place. `aScope` gives the type parameters the base can
 * name, asked for only when nothing cheaper decides: reading them reads the
 * base's source.
 */
function compareTypes(a: string, aScope: () => ReadonlySet<string>, b: string, language: string): Fit {
  if (a === b) return 'same';
  if (looseType(a, language) === looseType(b, language)) return 'maybe';
  return fitsWithTypeParameters(a, aScope(), b) ? 'maybe' : 'differs';
}

/** Past this length a type is not matched against a pattern: each type parameter in it is a `.+`. */
const MAX_PATTERN_TYPE_LENGTH = 200;

/**
 * Whether `type` is `pattern` with each type parameter it names filled in:
 * `List<String>` is `List<T>`, and `String` is `T`. A type too long to match
 * cheaply might be, and so fits.
 */
function fitsWithTypeParameters(pattern: string, typeParameters: ReadonlySet<string>, type: string): boolean {
  if (typeParameters.size === 0) return false;
  if (pattern.length > MAX_PATTERN_TYPE_LENGTH || type.length > MAX_PATTERN_TYPE_LENGTH) {
    return [...typeParameters].some((name) => new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(pattern));
  }
  let named = false;
  const source = pattern
    .split(/([A-Za-z_$][\w$]*)/)
    .map((part, i) => {
      if (i % 2 === 1 && typeParameters.has(part)) {
        named = true;
        return '.+';
      }
      return escapeRegExp(part);
    })
    .join('');
  return named && new RegExp(`^${source}$`).test(type);
}

/** A type without its type arguments and nullable marks: `List<String>?` is `List`. */
function looseType(type: string, language: string): string {
  const args = language === 'scala' ? /\[[^[\]]*\]/g : /<[^<>]*>/g;
  let t = type;
  for (let previous = ''; previous !== t; ) {
    previous = t;
    t = t.replace(args, '');
  }
  return t.replace(/\?/g, '');
}

/** The parameter types `method` declares, each normalized (normalizeType); null when they can't be read. */
function parameterTypes(method: Node, context: ResolutionContext): readonly string[] | null {
  const list = parameterList(method, context);
  if (list === null) return null;
  const types: string[] = [];
  for (const param of splitParameters(list)) {
    const type = parameterType(param, method.language);
    if (type === RECEIVER) continue;
    if (type === null) return null;
    types.push(normalizeType(type, method.language));
  }
  return types;
}

/** The text of `method`'s parameter list, without its parentheses; null when it can't be found. */
function parameterList(method: Node, context: ResolutionContext): string | null {
  if (method.language === 'csharp') return csharpParameterList(method, context);
  const sig = method.signature?.trim();
  if (!sig) return null;
  if (method.language === 'java') {
    // The return type, then the list: `Object (List<String> tairKey, double count)`.
    const groups = parenGroups(sig);
    const last = groups[groups.length - 1];
    return last && last[1] === sig.length - 1 ? sig.slice(last[0] + 1, last[1]) : null;
  }
  // Kotlin and Scala: the list, then the return type: `(keys: List<String>): Any?`.
  // A Scala `def size: Int` takes no parameter list at all.
  if (method.language === 'scala' && sig.startsWith(':')) return '';
  const first = parenGroups(sig)[0];
  return first && first[0] === 0 ? sig.slice(1, first[1]) : null;
}

/**
 * The parameter list of a C# method, read from its declaration: past its
 * attribute sections (`[Obsolete("Put(int) instead")]`), the `( … )` after
 * its name — and type parameters, `Save<T>(…)` — with comments and string
 * literals blanked. An explicit interface implementation, `object
 * IStore.Put(string key)`, is named `Put` like any other.
 */
function csharpParameterList(method: Node, context: ResolutionContext): string | null {
  const lines = context.getFileLines?.(method.filePath) ?? context.readFile(method.filePath)?.split(/\r?\n/) ?? null;
  if (!lines || method.startLine < 1 || method.startLine > lines.length) return null;
  const end = Math.min(lines.length, Math.max(method.endLine, method.startLine), method.startLine - 1 + CSHARP_HEAD_LINES);
  const first = lines[method.startLine - 1]!;
  const head = blankCsharpTrivia(
    [first.slice(Math.min(method.startColumn, first.length)), ...lines.slice(method.startLine, end)].join('\n')
  );
  let at = 0;
  for (;;) {
    while (at < head.length && /\s/.test(head[at]!)) at++;
    if (head[at] !== '[') break;
    const close = closingBracket(head, at);
    if (close < 0) return null;
    at = close + 1;
  }
  const name = new RegExp(`(?<![\\w@])@?${escapeRegExp(method.name)}\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g');
  name.lastIndex = at;
  const found = name.exec(head);
  if (!found) return null;
  const open = found.index + found[0].length - 1;
  const close = closingBracket(head, open);
  return close < 0 ? null : head.slice(open + 1, close);
}

/** C# source with its comments and the contents of its string and character literals blanked, newlines kept. */
function blankCsharpTrivia(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const close = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      const stop = close < 0 ? text.length : text[i + 1] === '/' ? close : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // `@"…"` and `$@"…"` escape a quote by doubling it; the rest by a backslash.
      const verbatim = c === '"' && (text[i - 1] === '@' || (text[i - 2] === '@' && text[i - 1] === '$'));
      let j = i + 1;
      while (j < text.length) {
        if (verbatim ? text[j] === '"' && text[j + 1] === '"' : text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c || (!verbatim && text[j] === '\n')) break;
        j++;
      }
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + (text[j] ?? '');
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/** A parameter that is no parameter: Java's receiver, `void m(Foo this, int x)`. */
const RECEIVER = Symbol('receiver');

/** The type text a parameter declares, as written; null when it can't be read. */
function parameterType(param: string, language: string): string | null | typeof RECEIVER {
  if (language === 'csharp') return csharpParameterType(param);
  const bare = stripAnnotations(param).trim();
  if (language === 'java') {
    // `final List<String> lines`, `String... parts`, a C-style `int data[]`.
    const m = /^([\s\S]*?)([A-Za-z_$][\w$]*)((?:\s*\[\s*\])*)$/.exec(bare.replace(/\bfinal\b/g, ' ').trim());
    if (!m || !m[1]!.trim()) return null;
    if (m[2] === 'this') return RECEIVER;
    return m[1]! + m[3]!.replace(/\s+/g, '');
  }
  // Kotlin and Scala: `vararg keys: String`, `count: Double = 1.0`, `f: => Unit`.
  const colon = topLevelIndex(bare, (i) => bare[i] === ':');
  if (colon < 0) return null;
  let type = bare.slice(colon + 1);
  const assign = topLevelIndex(type, (i) => type[i] === '=' && type[i + 1] !== '>');
  if (assign >= 0) type = type.slice(0, assign);
  if (!type.trim()) return null;
  return /\bvararg\b/.test(bare.slice(0, colon)) ? `vararg ${type}` : type;
}

/**
 * A C# parameter's type: past its attributes and the modifiers that are no
 * part of it (`this`, `params`, `scoped`), keeping `ref`, `out` and `in`,
 * which are, and before its name and default value.
 */
function csharpParameterType(param: string): string | null {
  let p = param.trim();
  while (p.startsWith('[')) {
    const close = closingBracket(p, 0);
    if (close < 0) return null;
    p = p.slice(close + 1).trim();
  }
  const assign = topLevelIndex(p, (i) => p[i] === '=' && !/[=!<>]/.test(p[i - 1] ?? '') && !/[=>]/.test(p[i + 1] ?? ''));
  if (assign >= 0) p = p.slice(0, assign).trim();
  const m = /^([\s\S]*?\S)\s+@?[A-Za-z_]\w*$/.exec(p);
  if (!m) return null;
  let type = m[1]!.trim();
  const kept: string[] = [];
  for (let mod = /^(this|params|scoped|ref|out|in|readonly)\s+/.exec(type); mod; mod = /^(this|params|scoped|ref|out|in|readonly)\s+/.exec(type)) {
    if (mod[1] !== 'this' && mod[1] !== 'params' && mod[1] !== 'scoped') kept.push(mod[1]!);
    type = type.slice(mod[0].length);
  }
  return type ? [...kept, type].join(' ') : null;
}

/**
 * A parameter type as the languages compare it: qualifiers dropped
 * (`java.util.List<java.lang.String>` is `List<String>`), Java's varargs an
 * array, C#'s BCL names its keywords (`String` is `string`), and whitespace
 * kept only between two words (`out T`, `vararg String`).
 */
function normalizeType(type: string, language: string): string {
  let t = type.replace(/\s+/g, ' ').trim();
  if (language === 'java') t = t.replace(/\.\.\./g, '[]');
  t = t.replace(/\b[A-Za-z_]\w*\s*::\s*/g, '');
  t = t.replace(/\b(?:[A-Za-z_$][\w$]*\s*\.\s*)+(?=[A-Za-z_$])/g, '');
  if (language === 'csharp') t = t.replace(/\b[A-Z][A-Za-z0-9]*\b/g, (w) => CSHARP_KEYWORD_TYPES[w] ?? w);
  return t.replace(/ (?![\w$])|(?<![\w$]) /g, '');
}

/** Java, Kotlin and Scala annotations taken out of a parameter: `@Named("id")`, `@param:JsonProperty("x")`. */
function stripAnnotations(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const name = text[i] === '@' ? /^@\s*[A-Za-z_$][\w$]*(?:\s*:\s*[A-Za-z_$][\w$]*)?(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(text.slice(i)) : null;
    if (!name) {
      out += text[i];
      continue;
    }
    let next = i + name[0].length;
    let open = next;
    while (open < text.length && /\s/.test(text[open]!)) open++;
    if (text[open] === '(') {
      const close = closingBracket(text, open);
      next = close < 0 ? text.length : close + 1;
    }
    out += ' ';
    i = next - 1;
  }
  return out;
}

/** The parameters of a list, at its top-level commas. */
function splitParameters(list: string): string[] {
  const params: string[] = [];
  let start = 0;
  for (;;) {
    const comma = topLevelIndex(list.slice(start), (i, text) => text[i] === ',');
    const param = (comma < 0 ? list.slice(start) : list.slice(start, start + comma)).trim();
    if (param) params.push(param);
    if (comma < 0) return params;
    start += comma + 1;
  }
}

/**
 * The first index in `text` outside brackets and string literals where `at`
 * holds, or -1. A `<` opens type arguments when written right after a name
 * (`List<`), and the `>` of `->` and `=>` closes none.
 */
function topLevelIndex(text: string, at: (i: number, text: string) => boolean): number {
  let depth = 0;
  let angles = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = closingQuote(text, i);
      continue;
    }
    if (depth === 0 && angles === 0 && at(i, text)) return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '<' && /[\w$?\]>]/.test(text[i - 1] ?? '') && text[i + 1] !== '<' && text[i + 1] !== '=') angles++;
    else if (c === '>' && angles > 0 && text[i - 1] !== '-' && text[i - 1] !== '=') angles--;
  }
  return -1;
}

/** The top-level `( … )` groups of `text`, as [open, close] index pairs; string literals skipped. */
function parenGroups(text: string): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") i = closingQuote(text, i);
    else if (c === '(') {
      const close = closingBracket(text, i);
      if (close < 0) return groups;
      groups.push([i, close]);
      i = close;
    }
  }
  return groups;
}

/** The index of the bracket closing the one at `open` — `(`, `[` or `{` — or -1; string literals skipped. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") i = closingQuote(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
  }
  return -1;
}

/** The index of the quote closing the string or character literal opening at `open`, or the text's end. */
function closingQuote(text: string, open: number): number {
  const quote = text[open]!;
  let j = open + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return Math.min(j, text.length - 1);
}
