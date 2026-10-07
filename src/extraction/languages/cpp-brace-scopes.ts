/**
 * C++ scopes read from the source's braces, for a file whose parse tree has
 * errors.
 *
 * tree-sitter recovers from a construct it can't parse by inserting the token
 * it expected, and inside a class body that token is often a `}`: an unknown
 * macro in front of a member (`PROTOBUF_FUTURE_ADD_EARLY_NODISCARD
 * absl::string_view name() const`, `struct ALIGN_AS(64U) HandleImpl`) closes
 * the class there. Every `}` after it then closes the scope one level out, so
 * the rest of the class, and of each namespace around it, parses as
 * declarations of an outer scope: protobuf's `FieldDescriptor` indexed as
 * `FieldDescriptor` instead of `google::protobuf::FieldDescriptor`, rocksdb's
 * `struct Opts` outside the class it is declared in. Recovery also runs the
 * other way and keeps a scope open past its own `}`.
 *
 * The braces are rarely what the parser misread, so the walker takes each
 * declaration's namespaces and enclosing classes from them instead
 * (TreeSitterExtractor.visitInCppBraceScope; mirrored in the kernel,
 * ccpp/mod.rs). The scan skips comments, string and character literals (raw
 * strings and digit separators too) and preprocessor lines. Each branch of an
 * `#if` is read from the braces open at the `#if`, and the scan continues
 * after `#endif` with the first branch's — so `#if A` `struct X : B {`
 * `#else` `struct X {` `#endif` opens one scope, not two. A file whose braces
 * don't balance gets no scopes and keeps the tree's.
 */

/** Intervals that nest properly, added in order of their opening offset. */
export class NestedIntervals<T> {
  private readonly opens: number[] = [];
  private readonly closes: number[] = [];
  private readonly parents: number[] = [];
  private readonly values: T[] = [];

  /**
   * Adds the interval `(open, close)`. One that opens before the last one
   * added, or crosses one that holds it, is refused (false).
   */
  add(open: number, close: number, value: T): boolean {
    const count = this.opens.length;
    if (close <= open || (count > 0 && open <= this.opens[count - 1]!)) return false;
    const parent = this.innermost(open);
    if (parent >= 0 && close >= this.closes[parent]!) return false;
    this.opens.push(open);
    this.closes.push(close);
    this.parents.push(parent);
    this.values.push(value);
    return true;
  }

  /** The values of the intervals holding `offset` (open < offset < close), outermost first. */
  at(offset: number): T[] {
    const out: T[] = [];
    for (let k = this.innermost(offset); k >= 0; k = this.parents[k]!) out.push(this.values[k]!);
    return out.reverse();
  }

  /**
   * The innermost interval holding `offset`, or -1. It is the last interval
   * opening before `offset` or one of the intervals around that one.
   */
  private innermost(offset: number): number {
    let lo = 0;
    let hi = this.opens.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.opens[mid]! < offset) {
        k = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    while (k >= 0 && this.closes[k]! <= offset) k = this.parents[k]!;
    return k;
  }
}

export interface CppBraceScopes {
  /** The offset of the `}` that closes the `{` at `open`. */
  closeOf(open: number): number | undefined;
  /** The named namespaces whose braces hold `offset`, outermost first, as written (`a::b`). */
  namespacesAt(offset: number): string[];
  /** The 1-based line and the column of `offset`. */
  positionOf(offset: number): { line: number; column: number };
}

const NEWLINE = 10;
const isBlank = (c: number): boolean => c === 32 || c === 9 || c === 13 || c === 12 || c === 11;
const isWordStart = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c >= 128;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWordChar = (c: number): boolean => isWordStart(c) || isDigit(c);
const RAW_STRING_PREFIX = /^(?:u8|[uUL])?R$/;
// A raw string's delimiter: up to 16 printable ASCII characters but `"`, `(`, `)` and `\`.
const RAW_STRING_DELIMITER = /^[!#-'*-[\]-~]{0,16}$/;

/** The end of a `//` comment starting at `i`: its newline (a `\` before it continues the comment). */
function lineCommentEnd(source: string, i: number): number {
  for (;;) {
    const nl = source.indexOf('\n', i);
    if (nl < 0) return source.length;
    let k = nl - 1;
    if (source.charCodeAt(k) === 13) k--;
    if (source.charCodeAt(k) !== 92) return nl;
    i = nl + 1;
  }
}

/** Past whitespace and comments from `i`. */
function skipBlank(source: string, i: number): number {
  const n = source.length;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (isBlank(c) || c === NEWLINE) i++;
    else if (c === 47 && source.charCodeAt(i + 1) === 47) i = lineCommentEnd(source, i + 2);
    else if (c === 47 && source.charCodeAt(i + 1) === 42) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else break;
  }
  return i;
}

/** The end of the identifier at `i`, or -1 when none starts there. */
function wordEnd(source: string, i: number): number {
  if (!isWordStart(source.charCodeAt(i))) return -1;
  let j = i + 1;
  while (j < source.length && isWordChar(source.charCodeAt(j))) j++;
  return j;
}

/** Past the `(…)` group at `i` (strings inside skipped), or -1. */
function parenGroupEnd(source: string, i: number): number {
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const c = source.charCodeAt(j);
    if (c === 34 || c === 39) j = quotedEnd(source, j) - 1;
    else if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return j + 1;
  }
  return -1;
}

/** Past the string or character literal whose quote is at `i` (it stops at a newline). */
function quotedEnd(source: string, i: number): number {
  const quote = source.charCodeAt(i);
  let j = i + 1;
  while (j < source.length) {
    const c = source.charCodeAt(j);
    if (c === 92) j += source.charCodeAt(j + 1) === 13 && source.charCodeAt(j + 2) === NEWLINE ? 3 : 2;
    else if (c === quote) return j + 1;
    else if (c === NEWLINE) return j;
    else j++;
  }
  return source.length;
}

/**
 * After the `namespace` keyword ending at `from`: the name as written and the
 * offset of the `{` that opens the body. Null for anything else, such as
 * `using namespace std;` or `namespace fs = std::filesystem;`. Takes C++17
 * attributes (`namespace [[deprecated]] old {`), nested and inline names
 * (`namespace a::inline b {`), and an attribute macro after the name
 * (`namespace std _GLIBCXX_VISIBILITY(default) {`).
 */
function namespaceHead(source: string, from: number): { name: string; brace: number } | null {
  let i = skipBlank(source, from);
  while (source.startsWith('[[', i)) {
    const end = source.indexOf(']]', i + 2);
    if (end < 0) return null;
    i = skipBlank(source, end + 2);
  }
  let nameStart = -1;
  let nameEnd = -1;
  for (let end = wordEnd(source, i); end >= 0; end = wordEnd(source, i)) {
    if (nameStart < 0) nameStart = i;
    nameEnd = end;
    i = skipBlank(source, end);
    if (!source.startsWith('::', i)) break;
    i = skipBlank(source, i + 2);
    const inline = wordEnd(source, i);
    if (inline >= 0 && source.slice(i, inline) === 'inline') i = skipBlank(source, inline);
  }
  for (let end = wordEnd(source, i); end >= 0 && nameStart >= 0; end = wordEnd(source, i)) {
    const paren = skipBlank(source, end);
    const after = source.charCodeAt(paren) === 40 ? parenGroupEnd(source, paren) : -1;
    if (after < 0) return null;
    i = skipBlank(source, after);
  }
  if (source.charCodeAt(i) !== 123) return null;
  return { name: nameStart < 0 ? '' : source.slice(nameStart, nameEnd), brace: i };
}

/**
 * Scan `source` (a C++ file as the parser saw it, after preParse) for its
 * braces and namespaces. Null when the braces don't balance.
 */
export function scanCppBraceScopes(source: string): CppBraceScopes | null {
  const n = source.length;
  const closes = new Map<number, number>();
  let open: number[] = [];
  // Per `#if` group: the braces open at the `#if`, and those open after its
  // first branch (null until a second branch starts).
  const branches: Array<{ atIf: number[]; afterFirst: number[] | null }> = [];
  const namespaceAt = new Map<number, string>(); // `{` offset → name, for named namespaces
  let pendingNamespace: { name: string; brace: number } | null = null;
  let balanced = true;
  let lineStart = true;
  let wordStart = -1; // the last identifier or number read
  let wordEndAt = -1;
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0; // past a byte-order mark, so line 1 can be a directive
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === NEWLINE) {
      lineStart = true;
      i++;
      continue;
    }
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 47) {
      i = lineCommentEnd(source, i + 2);
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 42) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === 35 && lineStart) {
      // A directive runs to the end of its line, through `\` continuations
      // and comments. Only `"` strings are skipped in it: an apostrophe in
      // `#error Don't …` is no character literal.
      let j = i + 1;
      while (j < n && isBlank(source.charCodeAt(j))) j++;
      const nameEnd = wordEnd(source, j);
      const directive = nameEnd < 0 ? '' : source.slice(j, nameEnd);
      while (j < n) {
        const d = source.charCodeAt(j);
        if (d === NEWLINE) {
          let k = j - 1;
          if (source.charCodeAt(k) === 13) k--;
          if (source.charCodeAt(k) !== 92) break;
          j++;
        } else if (d === 47 && source.charCodeAt(j + 1) === 47) {
          j = lineCommentEnd(source, j + 2);
        } else if (d === 47 && source.charCodeAt(j + 1) === 42) {
          const end = source.indexOf('*/', j + 2);
          j = end < 0 ? n : end + 2;
        } else if (d === 34) {
          j = quotedEnd(source, j);
        } else {
          j++;
        }
      }
      if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
        branches.push({ atIf: open.slice(), afterFirst: null });
      } else if (
        (directive === 'else' || directive === 'elif' || directive === 'elifdef' || directive === 'elifndef') &&
        branches.length > 0
      ) {
        const group = branches[branches.length - 1]!;
        if (group.afterFirst === null) group.afterFirst = open;
        open = group.atIf.slice();
      } else if (directive === 'endif' && branches.length > 0) {
        const group = branches.pop()!;
        if (group.afterFirst !== null) open = group.afterFirst;
      }
      i = j;
      continue;
    }
    lineStart = false;
    if (c === 34) {
      // A raw string (`R"x(…)x"`) can hold any brace and quote; its prefix is
      // the word that ends right at the quote.
      if (wordEndAt === i && i - wordStart <= 3 && RAW_STRING_PREFIX.test(source.slice(wordStart, i))) {
        const paren = source.indexOf('(', i + 1);
        const delimiter = paren < 0 ? '' : source.slice(i + 1, paren);
        if (paren >= 0 && RAW_STRING_DELIMITER.test(delimiter)) {
          const end = source.indexOf(`)${delimiter}"`, paren + 1);
          i = end < 0 ? n : end + delimiter.length + 2;
          continue;
        }
      }
      i = quotedEnd(source, i);
      continue;
    }
    if (c === 39) {
      i = quotedEnd(source, i);
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(source.charCodeAt(i + 1)))) {
      // A number, digit separators (`1'000'000`) and exponent signs included.
      let j = i + 1;
      while (j < n) {
        const d = source.charCodeAt(j);
        if (isWordChar(d) || d === 46) j++;
        else if (d === 39 && isWordChar(source.charCodeAt(j + 1))) j += 2;
        else if ((d === 43 || d === 45) && /[eEpP]/.test(source[j - 1]!)) j++;
        else break;
      }
      wordStart = i;
      wordEndAt = j;
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      const end = wordEnd(source, i);
      wordStart = i;
      wordEndAt = end;
      if (end - i === 9 && source.startsWith('namespace', i)) {
        const head = namespaceHead(source, end);
        if (head) pendingNamespace = head;
      }
      i = end;
      continue;
    }
    if (c === 123) {
      open.push(i);
      if (pendingNamespace && pendingNamespace.brace === i) {
        if (pendingNamespace.name) namespaceAt.set(i, pendingNamespace.name);
        pendingNamespace = null;
      }
    } else if (c === 125) {
      const from = open.pop();
      if (from === undefined) balanced = false;
      else if (!closes.has(from)) closes.set(from, i);
    }
    i++;
  }
  if (!balanced || open.length > 0) return null;

  const namespaces = new NestedIntervals<string>();
  for (const [brace, name] of [...namespaceAt].sort((a, b) => a[0] - b[0])) {
    const close = closes.get(brace);
    if (close !== undefined) namespaces.add(brace, close, name);
  }
  let lineStarts: number[] | null = null;
  return {
    closeOf: (at) => closes.get(at),
    namespacesAt: (offset) => namespaces.at(offset),
    positionOf: (offset) => {
      if (!lineStarts) {
        lineStarts = [0];
        for (let k = source.indexOf('\n'); k >= 0; k = source.indexOf('\n', k + 1)) lineStarts.push(k + 1);
      }
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - lineStarts[lo]! };
    },
  };
}
