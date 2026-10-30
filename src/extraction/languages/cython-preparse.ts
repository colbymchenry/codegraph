/**
 * Offset-preserving source fixes the Python grammar needs before it parses a
 * Cython file (`.pyx`/`.pxd`/`.pxi`) — the Python extractor's `preParse`,
 * keyed on those extensions (python.ts). Cython is a Python superset: the
 * grammar reads its Python half natively, and each Cython-only construct is
 * either rewritten in place into the Python construct with the same meaning,
 * or blanked with spaces (newlines kept) when no such construct exists, so
 * node positions and text stay where they are.
 *
 * A dedicated tree-sitter-cython grammar exists upstream but none is vendored
 * here (#1819); riding the Python grammar — the same one `.py` files use —
 * also means every Python resolution semantic (module resolution, name
 * matching, call resolution) applies to Cython unchanged.
 *
 * - `cimport numpy as np` / `from libc.math cimport sin, cos` → the `cimport`
 *   token is written over with `import ` (both 7 bytes). The statement
 *   becomes the `import`/`import from` statement the grammar knows, and the
 *   import node's module name — what resolution links — is unchanged. Left
 *   alone, `cimport numpy` parsed as an error around an `as`-pattern and no
 *   import survived.
 * - `cdef class` / `cpdef class` → `class` is written over the whole keyword
 *   region, padded to the same bytes, so `class` leads at the statement's own
 *   indent column (blanking `cdef ` in place would leave `class` five columns
 *   deep, past a nested body's indent). The grammar's error recovery kept the
 *   class_definition, but nested inside an ERROR node; leading the line keeps
 *   the tree clean (and the kernel fast path, which defers on any ERROR,
 *   available).
 * - A `cdef`/`cpdef` FUNCTION declaration with its body —
 *   `cpdef double add(self, double amount) nogil:` — becomes the `def` it
 *   is: the keyword is written over with `def ` (padded to the same byte
 *   length), the return type and Cython modifiers between it and the name
 *   are blanked, and the `nogil`/`gil`/`except …`/`noexcept` clause between
 *   the `)` and the `:` is blanked. The typed parameters stay as written —
 *   the grammar recovers them inside the parameter list (with ERROR
 *   children), and the function's signature reads the list's raw text, so
 *   `(self, double amount)` survives verbatim. Left alone, the declaration
 *   parsed as a CALL on `cpdef`, the body leaked to the enclosing scope, and
 *   the function never existed.
 * - A bodiless `cdef`/`cpdef` PROTOTYPE (a `.pxd` declaration file is made
 *   of these) — `cpdef double scale(self, double k)` with no `:` — is
 *   blanked whole. `def` needs a body; no offset-preserving rewrite can give
 *   it one, and left alone the prototype parsed as a spurious call to the
 *   function it declares. The `.pxd`'s declaration adds nothing the `.pyx`
 *   implementation doesn't carry.
 * - `cdef extern from "math.h":` and its indented C declarations are blanked
 *   whole (a C header's contents are not graph symbols, and the raw C
 *   signatures parse as calls).
 * - A `cdef`/`ctypedef struct|union|enum` declaration keeps its own line but
 *   its indented body of C fields / enumerators is blanked whole, like an
 *   extern block's. The declared name is what the graph wants — python.ts's
 *   `visitNode` hook reads it out of the grammar's recovery — while the body
 *   is C detail: left alone, a struct body minted a bogus variable, and an
 *   enum body (a valid-Python tuple) glued the ERROR into everything that
 *   followed, losing the rest of the file. An INLINE body
 *   (`ctypedef enum Color: RED, GREEN`) is left whole: its damage stays on
 *   its own line.
 * - `IF` / `ELIF` / `ELSE`, Cython's compile-time conditional, are written
 *   over with their lowercase Python spellings (same byte width, so columns
 *   hold). Left alone, `ELSE:` recovered as a variable named ELSE that
 *   swallowed its branch's body.
 * - A `ctypedef <C type> <alias>` line is LEFT ALONE: the grammar's recovery
 *   puts the declared name in a shape the extractor's `visitNode` hook reads
 *   (see python.ts) — blanking here would erase the alias. So is a `DEF
 *   NAME = …` compile-time constant (recovered as the variable it is), a
 *   bodiless-`:`-less `cdef` aggregate in the old colon-less style, and an
 *   initialized `cdef int x = f(3)` — whose recovery's bogus shape (an
 *   assignment to a variable named `cdef`) the visitNode hook drops.
 *
 * Lines inside a triple-quoted string are never rewritten — Cython docstrings
 * routinely show `cdef` examples, and the rewrites are line-based.
 */

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32;
const CH_HASH = 35, CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42;
const CH_COLON = 58, CH_LBRACKET = 91, CH_BACKSLASH = 92;
const CH_RBRACKET = 93, CH_LBRACE = 123, CH_RBRACE = 125;

/** Whether a file is a Cython source, by extension (the preParse's gate). */
export const CYTHON_FILE = /\.(?:pyx|pxd|pxi)$/;

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
}
function isIdentPart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 48 && c <= 57) || c >= 128;
}
function isSpace(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_CR;
}

function wordEnd(s: string, i: number): number {
  while (i < s.length && isIdentPart(s.charCodeAt(i))) i++;
  return i;
}

/** The word starting at `i`, or '' when no word starts there. */
function wordAt(s: string, i: number): string {
  return isIdentStart(s.charCodeAt(i)) ? s.slice(i, wordEnd(s, i)) : '';
}

/**
 * The index after the comment or string that starts at `i`, or -1 when none
 * does. Python strings: `'…'`/`"…"` with `\` escapes (ends at line end when
 * unterminated) and `'''…'''`/`"""…"""`, which may span lines. A `#` comment
 * runs to its line's end.
 */
function commentOrStringEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === CH_HASH) {
    const e = s.indexOf('\n', i + 1);
    return e < 0 ? s.length : e;
  }
  if (c === 39 || c === 34) {
    const triple = s.substr(i, 3);
    if (triple === '"""' || triple === "'''") {
      const close = s.indexOf(triple, i + 3);
      return close < 0 ? s.length : close + 3;
    }
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === CH_BACKSLASH) { j += 2; continue; }
      if (d === c) return j + 1;
      if (d === CH_LF) return j; // unterminated: stops at its line's end
      j++;
    }
    return s.length;
  }
  return -1;
}

/**
 * Whether a `(`/`[`/`{` at `i` is closed before the source ends, tracking
 * nesting and skipping strings and comments; `close` receives the index just
 * after the matching closer, or -1 when the list never closes.
 */
function findCloser(s: string, open: number, close: { pos: number }): boolean {
  const opener = s.charCodeAt(open);
  const closer = opener === CH_LPAREN ? CH_RPAREN : opener === CH_LBRACKET ? CH_RBRACKET : CH_RBRACE;
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) { i = k; continue; }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
    else if (c === closer) {
      if (--depth === 0) {
        close.pos = i + 1;
        return true;
      }
    } else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) {
      return false; // closes a list we're not in — not a parameter list
    }
    i++;
  }
  return false;
}

/** The index of the first non-space, non-comment character from `i`, or -1 at the source's end. */
function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    if (isSpace(s.charCodeAt(i)) || s.charCodeAt(i) === CH_LF) i++;
    else if (commentOrStringEnd(s, i) > i) i = commentOrStringEnd(s, i);
    else return i;
  }
  return -1;
}

/** The start of the identifier that ends just before `i` (spaces allowed between), or -1. */
function wordStartBefore(s: string, i: number): number {
  while (i > 0 && isSpace(s.charCodeAt(i - 1))) i--;
  const end = i;
  while (i > 0 && isIdentPart(s.charCodeAt(i - 1))) i--;
  return i < end && isIdentStart(s.charCodeAt(i)) ? i : -1;
}

const DEF_MODIFIERS: ReadonlySet<string> = new Set([
  'public', 'readonly', 'api', 'inline', 'nogil', 'staticmethod', 'final',
  'internal', 'noinline', 'cpdef', 'cdef', 'packed',
]);

/** Whether the code from `from` to `to` holds no `=` outside brackets — an initialized variable, not a declaration header. */
function holdsEquals(s: string, from: number, to: number): boolean {
  let depth = 0;
  let i = from;
  while (i < to) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) { i = k; continue; }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
    else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) depth--;
    else if (c === 61 && depth <= 0) {
      // `==`, `<=`, `>=`, `!=` are comparisons, not the assignment `=`.
      const prev = s.charCodeAt(i - 1);
      const next = s.charCodeAt(i + 1);
      if (prev !== 61 && prev !== 60 && prev !== 62 && prev !== 33 && next !== 61) return true;
    }
    i++;
  }
  return false;
}

/** The index of the line end at or after `i`. */
function lineEnd(s: string, i: number): number {
  const e = s.indexOf('\n', i);
  return e < 0 ? s.length : e;
}

/** Whether the word `cimport` appears in the statement text before any `(`, `=` or newline. */
function findCimportToken(s: string, from: number): number {
  let i = from;
  const end = lineEnd(s, from);
  while (i < end) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) { i = k; continue; }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === 61 || c === CH_COLON) return -1;
    if (isIdentStart(c) && wordAt(s, i) === 'cimport') return i;
    i++;
  }
  return -1;
}

/** One pending edit: blank `[from, to)` (word '' ) or write `word` over it, padded with spaces. */
interface Edit { from: number; to: number; word: string; }

/** `s` with every edit applied, each replaced by its word padded with spaces (a blank edit's word is ''). */
function applyEdits(s: string, edits: Edit[]): string {
  edits.sort((a, b) => a.from - b.from);
  let out = '';
  let last = 0;
  for (const e of edits) {
    if (e.to <= e.from || e.from < last) continue;
    const written = e.word.length <= e.to - e.from ? e.word : '';
    out += s.slice(last, e.from) + written + s.slice(e.from + written.length, e.to).replace(/[^\r\n]/g, ' ');
    last = e.to;
  }
  return out + s.slice(last);
}

/** A cheap gate: files with none of Cython's keywords pass through untouched. */
const MAY_BE_CYTHON = /\b(cdef|cpdef|cimport|ctypedef|IF|ELIF|ELSE)\b/;

/**
 * The triple-quoted string (`'''` / `"""`) still open at the END of `line`,
 * or null when none is — `open` being the one open on entry. Docstrings carry
 * Cython examples (`cdef int x`, `IF …:`) at line starts, and every rewrite
 * below is line-based; skipping the lines inside a multi-line string keeps a
 * docstring's prose out of the rewrites. Backslash escapes and single-line
 * `'…'`/`"…"` strings inside the line are honored.
 */
function tripleOpenAfter(line: string, open: string | null): string | null {
  let active = open;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '\\') { i += 2; continue; }
    if (active) {
      if (line.startsWith(active, i)) { active = null; i += 3; continue; }
      i++;
      continue;
    }
    if (c === '#' && active === null) return null; // comment: the rest is prose
    if (c === "'" || c === '"') {
      const triple = c + c + c;
      if (line.startsWith(triple, i)) { active = triple; i += 3; continue; }
      const close = line.indexOf(c, i + 1); // a one-line string
      i = close < 0 ? line.length : close + 1;
      continue;
    }
    i++;
  }
  return active;
}

/**
 * Whether `text` holds a `:` outside strings, brackets and comments — the
 * colon that closes an `if`-style header. A condition may carry its own
 * colons (a subscript slice, a dict literal, a lambda), all inside brackets.
 */
function hasHeaderColon(text: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const k = commentOrStringEnd(text, i);
    if (k >= 0) { i = k; continue; }
    const c = text.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
    else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) depth--;
    else if (c === CH_COLON && depth <= 0) return true;
    i++;
  }
  return false;
}

/**
 * Rewrite the Cython constructs the Python grammar can't read (see the file
 * comment). Returns the source unchanged when there is nothing to rewrite.
 */
export function preParseCython(source: string): string {
  if (!MAY_BE_CYTHON.test(source)) return source;
  const edits: Edit[] = [];
  const n = source.length;
  // The indent of the block whose lines are being blanked (a `cdef extern`
  // block, or the body of a `cdef`/`ctypedef struct/enum/union`), or -1
  // outside one.
  let blockIndent = -1;
  // The triple-quoted string open at the line being read, or null.
  let triple: string | null = null;
  let i = 0;
  while (i < n) {
    const lineStart = i;
    const end = lineEnd(source, i);
    const line = source.slice(lineStart, end);
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (triple !== null) {
      // The line starts inside a multi-line string (a docstring's prose): no
      // rewrites, whatever it holds.
      triple = tripleOpenAfter(line, triple);
      i = end + 1;
      continue;
    }
    triple = tripleOpenAfter(line, triple);

    if (blockIndent >= 0) {
      // Inside a blanked block: blank every code line until the dedent.
      // Blank and comment lines belong to the block but hold nothing to blank.
      const isCode = trimmed !== '' && !trimmed.startsWith('#');
      if (!isCode) {
        i = end + 1;
        continue;
      }
      if (indent > blockIndent) {
        edits.push({ from: lineStart, to: end, word: '' });
        i = end + 1;
        continue;
      }
      blockIndent = -1; // dedent: this line is outside the block
    }

    if (trimmed === '' || trimmed.startsWith('#')) {
      i = end + 1;
      continue;
    }

    const first = wordAt(source, lineStart + indent);
    if (first === 'cimport') {
      edits.push({ from: lineStart + indent, to: lineStart + indent + 7, word: 'import ' });
    } else if (first === 'from') {
      const at = findCimportToken(source, lineStart + indent + 4);
      if (at >= 0) edits.push({ from: at, to: at + 7, word: 'import ' });
    } else if (first === 'cdef' || first === 'cpdef') {
      if (rewriteCdef(source, lineStart + indent, lineStart + indent + first.length, end, edits) === 'block') {
        blockIndent = indent;
      }
    } else if (first === 'ctypedef') {
      // A C aggregate (`ctypedef enum Color:`) opens a blanked block; a plain
      // alias (`ctypedef unsigned long long u64`) is left for the grammar's
      // recovery and the extractor's visitNode hook.
      const at = skipTrivia(source, lineStart + indent + first.length);
      if (at >= 0 && rewriteAggregate(source, at, end, edits) === 'block') {
        blockIndent = indent;
      }
    } else if (first === 'IF' || first === 'ELIF' || first === 'ELSE') {
      // Cython's compile-time conditional, spelled exactly as its Python
      // counterpart but capitalized: rewrite in place (same byte width) so the
      // grammar reads `if`/`elif`/`else` and BOTH branches parse — left alone,
      // `ELSE:` recovered as a variable named ELSE that swallowed its branch's
      // body. IF/ELIF need a header colon on the line; ELSE is only `ELSE:`.
      const rest = trimmed.slice(first.length);
      const headerOk =
        first === 'ELSE' ? /^\s*:(?:\s|#|$)/.test(rest) : hasHeaderColon(rest);
      if (headerOk) {
        edits.push({
          from: lineStart + indent,
          to: lineStart + indent + first.length,
          word: first.toLowerCase(),
        });
      }
    }

    i = end + 1;
  }
  if (edits.length === 0) return source;
  return applyEdits(source, edits);
}

/**
 * Rewrite one `cdef`/`cpdef` statement starting at `kwStart` (keyword ends at
 * `kwEnd`) on a line ending at `end`. Returns 'block' when the statement opens
 * a block whose indented lines the caller blanks until the dedent (a
 * `cdef extern` block, or a `struct`/`union`/`enum` body). Recognizes, by what
 * follows the modifiers:
 *   - `extern …` → blank the block: this line plus every following line with
 *     greater indent.
 *   - `class …` → `class` written over the whole `cdef class` region, padded,
 *     so it leads at the statement's indent column.
 *   - `struct|union|enum …` → a C aggregate: this line stays (the extractor's
 *     visitNode hook reads its recovery), a colon-ended header's indented body
 *     is blanked whole.
 *   - a function header — `NAME(` where the pre-name region holds no `=`
 *     (an initialized variable is left to the grammar: python.ts's visitNode
 *     hook drops the bogus shape its recovery mints) — rewritten as a `def`,
 *     or blanked whole when it has no `:` body (a `.pxd` prototype).
 *   - anything else (a field or module-level variable declaration) is left
 *     alone: with an initializer the recovery's bogus assignment is dropped
 *     by the visitNode hook, and without one nothing is a node either way.
 */
function rewriteCdef(s: string, kwStart: number, kwEnd: number, end: number, edits: Edit[]): 'block' | undefined {
  let i = skipTrivia(s, kwEnd);
  if (i < 0) return;

  // `cdef extern from "x.h":` — blank this line and its indented members.
  if (wordAt(s, i) === 'extern') {
    edits.push({ from: kwStart, to: end, word: '' });
    return 'block';
  }

  // `cdef class Foo(Base):` — the keyword AND the `class` word are written
  // over with `class` (padded to the same span), so `class` leads at the
  // statement's own indent column: blanking `cdef ` in place would leave
  // `class` five columns deep, past a nested body's indent.
  if (wordAt(s, i) === 'class') {
    const classEnd = wordEnd(s, i);
    edits.push({ from: kwStart, to: classEnd, word: 'class'.padEnd(classEnd - kwStart, ' ') });
    return;
  }

  // Skip Cython's declaration modifiers: `cdef public api double f()…`.
  while (i >= 0 && DEF_MODIFIERS.has(wordAt(s, i))) {
    i = skipTrivia(s, wordEnd(s, i));
  }
  if (i < 0) return;

  // A C aggregate: `cdef struct Point:` (also `cdef packed struct …`,
  // `union`, `enum`) — handled by rewriteAggregate.
  const aggregateStart = i;
  if (['struct', 'union', 'enum'].includes(wordAt(s, i))) {
    return rewriteAggregate(s, aggregateStart, end, edits);
  }

  // The first `(` at bracket depth 0 opens the parameter list; the name is
  // the identifier just before it. No `(` on the statement's first line
  // (before any `=`/`:`) — not a function header.
  let open = -1;
  let scan = i;
  let depth = 0;
  while (scan < end) {
    const k = commentOrStringEnd(s, scan);
    if (k >= 0) { scan = k; continue; }
    const c = s.charCodeAt(scan);
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      if (depth === 0 && c === CH_LPAREN) { open = scan; break; }
      depth++;
    } else if (c === CH_RPAREN || c === CH_RBRACKET) depth--;
    else if (c === 61 && depth === 0) return; // initialized variable: leave
    else if (c === CH_COLON && depth === 0) return; // e.g. `cdef struct P:` — leave
    scan++;
  }
  if (open < 0) return;
  const nameStart = wordStartBefore(s, open);
  if (nameStart < 0 || nameStart < kwEnd) return; // `(` but no name: leave
  if (holdsEquals(s, kwEnd, nameStart)) return; // `cdef int x = f(3)`: leave

  const close: { pos: number } = { pos: -1 };
  if (!findCloser(s, open, close)) return;

  // After the `)`: the `:` that opens the body may sit behind the `nogil` /
  // `except …` clause. It must be on the `)`'s own line — a line end (or a
  // trailing `#` comment) first means the declaration has no body: a `.pxd`
  // prototype, blanked whole below.
  let t = close.pos;
  let colon = -1;
  const stop = lineEnd(s, close.pos);
  while (t < stop) {
    const c = s.charCodeAt(t);
    if (c === CH_HASH) break; // trailing comment: no `:` after it on this line
    if (isSpace(c)) { t++; continue; }
    if (c === CH_COLON) { colon = t; break; }
    if (c === CH_STAR || c === 63 || c === 45) { t++; continue; } // `except *` / `except? -1`
    if (isIdentStart(c) || (c >= 48 && c <= 57)) { t = wordEnd(s, t); continue; } // nogil/gil/except/noexcept/literal
    break; // anything else: no `:` on this line
  }

  if (colon < 0) {
    // A prototype: blank from the keyword through the end of the `)` line.
    edits.push({ from: kwStart, to: lineEnd(s, close.pos), word: '' });
    return;
  }

  // A function: `cdef`/`cpdef` → `def ` padded to the keyword's length, the
  // modifiers + return type between the keyword and the name, and the clause
  // between `)` and `:` all blanked.
  edits.push({ from: kwStart, to: kwEnd, word: 'def '.padEnd(kwEnd - kwStart, ' ') });
  if (nameStart > kwEnd) edits.push({ from: kwEnd, to: nameStart, word: '' });
  if (colon > close.pos) edits.push({ from: close.pos, to: colon, word: '' });
  return;
}

/**
 * A C aggregate declaration: `cdef [packed] struct|union|enum Name:` (the
 * `ctypedef` spellings arrive here through their own branch). The declaration
 * line STAYS — the grammar's recovery puts the declared name in the shape
 * python.ts's visitNode hook reads — while its indented body of C fields /
 * enumerators is blanked whole, like an extern block's. Left alone, a struct
 * body minted a bogus variable, and an enum body (a valid-Python tuple) glued
 * the ERROR into everything that followed, losing the rest of the file.
 *
 * Blanking the body is not enough on its own: the `:`-ended header recovers
 * as an assignment that hunts for a value, and swallows the NEXT statement
 * into the bargain. The header's trailing `:` goes too, so the declared name
 * escapes as the bare identifier the hook reads. An INLINE body
 * (`ctypedef enum Color: RED, GREEN`) is left whole: its damage stays on its
 * own line.
 */
function rewriteAggregate(s: string, from: number, end: number, edits: Edit[]): 'block' | undefined {
  let i = from;
  while (i >= 0 && wordAt(s, i) === 'packed') i = skipTrivia(s, wordEnd(s, i));
  if (i < 0) return;
  const aggregate = wordAt(s, i);
  if (aggregate !== 'struct' && aggregate !== 'enum' && aggregate !== 'union') return;
  const colon = lineEndingColon(s, i, end);
  if (colon < 0) return;
  edits.push({ from: colon, to: colon + 1, word: ' ' });
  return 'block';
}

/**
 * The `:` that ends the line's header at `from` — only spaces and a trailing
 * comment may follow it — or -1. An inline body
 * (`ctypedef enum Color: RED, GREEN`) has none: its colon carries members.
 */
function lineEndingColon(s: string, from: number, end: number): number {
  let depth = 0;
  let i = from;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CH_HASH) return -1; // comment before the colon: no header here
    const k = commentOrStringEnd(s, i);
    if (k >= 0) { i = k; continue; } // a string in the header text
    if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
    else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) depth--;
    else if (c === CH_COLON && depth <= 0) {
      for (let t = i + 1; t < end; t++) {
        const c2 = s.charCodeAt(t);
        if (isSpace(c2)) continue;
        if (c2 === CH_HASH) return i;
        return -1;
      }
      return i;
    }
    i++;
  }
  return -1;
}
