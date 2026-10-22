/**
 * Offset-preserving source fixes the Pascal grammar needs before it parses a
 * Delphi unit (the extractor's `preParse`). Each one blanks syntax the grammar
 * has no rule for with spaces, keeping every newline, so node positions and
 * text stay where they are.
 *
 * - An attribute on a routine parameter, before or after its modifier:
 *   `const [ref] AValue: Integer`, `[ref] const Source: TVarData`,
 *   `const [MVCFromBody] Person: TPerson`, `[MVCFromQueryString('q', '')] Q: string`.
 *   The grammar's parameter rule takes no attribute, so the parse fell apart
 *   at the `[` and every member declared after it in the class was lost.
 *   The extractor reads nothing from an attribute, and a signature still
 *   shows it: Pascal signatures read the source as written.
 * - The inline variable of a `for … in` loop (Delphi 10.3): `for var lItem in
 *   AList do`, `for var lHandle: THandle in lHandles do`. The grammar's for-in
 *   rule takes a plain variable, so the whole loop became an error and no
 *   call in its body was read. Blanking `var` and the type leaves the loop
 *   the grammar knows. The resolver still finds the type: it reads a
 *   receiver's declaration from the source as written.
 */

const MODIFIERS: ReadonlySet<string> = new Set(['const', 'var', 'out', 'constref']);
const ROUTINE_KEYWORDS: ReadonlySet<string> = new Set(['procedure', 'function', 'constructor', 'destructor', 'operator']);
/** An attribute group longer than this is not one (and keeps the scan linear). */
const MAX_ATTRIBUTE_LENGTH = 2000;
/** A for-in loop variable's type longer than this is not one. */
const MAX_LOOP_TYPE_LENGTH = 500;
/** Words that end a for-in variable's type without an `in`: not the for-in form. */
const NOT_A_FOR_IN: ReadonlySet<string> = new Set(['do', 'to', 'downto', 'begin', 'end']);
/** Whether a file can hold a `for var … in` loop at all (the scan below decides). */
const FOR_VAR = /\bfor\s+var\b/i;

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32, CH_AMP = 38, CH_QUOTE = 39;
const CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42, CH_DOT = 46, CH_SLASH = 47;
const CH_COLON = 58, CH_SEMI = 59, CH_LT = 60, CH_EQ = 61, CH_GT = 62;
const CH_LBRACKET = 91, CH_RBRACKET = 93, CH_LBRACE = 123;

/** Identifier characters, `&` (Delphi's keyword escape) and any non-ASCII letter. */
function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === CH_AMP || c >= 128;
}
function isIdentPart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 48 && c <= 57) || c >= 128;
}

function wordEnd(s: string, i: number): number {
  while (i < s.length && isIdentPart(s.charCodeAt(i))) i++;
  return i;
}

/**
 * The index after the comment or string that starts at `i`, or -1 when none
 * does. Pascal comments are `{…}` (compiler directives included), `(*…*)` and
 * `//…`; a string is `'…'` with `''` for a quote and ends at its line's end
 * when unterminated.
 */
function commentOrStringEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === CH_LBRACE) {
    const e = s.indexOf('}', i + 1);
    return e < 0 ? s.length : e + 1;
  }
  if (c === CH_LPAREN && s.charCodeAt(i + 1) === CH_STAR) {
    const e = s.indexOf('*)', i + 2);
    return e < 0 ? s.length : e + 2;
  }
  if (c === CH_SLASH && s.charCodeAt(i + 1) === CH_SLASH) {
    const e = s.indexOf('\n', i + 2);
    return e < 0 ? s.length : e;
  }
  if (c === CH_QUOTE) {
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === CH_QUOTE) {
        if (s.charCodeAt(j + 1) !== CH_QUOTE) return j + 1;
        j += 2;
        continue;
      }
      if (d === CH_LF) return j;
      j++;
    }
    return j;
  }
  return -1;
}

/** The index of the first character from `i` that is neither whitespace nor in a comment. */
function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
      i++;
    } else if (c === CH_LBRACE || (c === CH_LPAREN && s.charCodeAt(i + 1) === CH_STAR) || (c === CH_SLASH && s.charCodeAt(i + 1) === CH_SLASH)) {
      i = commentOrStringEnd(s, i);
    } else {
      break;
    }
  }
  return i;
}

/**
 * The index after the `]` closing the attribute group whose `[` is at `i`,
 * or -1 when the group doesn't close the way an attribute does: nested
 * brackets and parentheses balance, strings and comments are skipped, and an
 * attribute's arguments hold no `;`.
 */
function attributeEnd(s: string, i: number): number {
  const limit = Math.min(s.length, i + MAX_ATTRIBUTE_LENGTH);
  let depth = 0;
  let j = i;
  while (j < limit) {
    const k = commentOrStringEnd(s, j);
    if (k >= 0) {
      j = k;
      continue;
    }
    const c = s.charCodeAt(j);
    if (c === CH_LBRACKET || c === CH_LPAREN) {
      depth++;
    } else if (c === CH_RBRACKET || c === CH_RPAREN) {
      depth--;
      if (depth === 0) return c === CH_RBRACKET ? j + 1 : -1;
    } else if (c === CH_SEMI) {
      return -1;
    }
    j++;
  }
  return -1;
}

/**
 * The index after a routine's name — `Name`, `TFoo.Bar`, `TFoo<T>.Bar<U>`,
 * `Get<T: class, constructor>` — read from `i`, or `i` itself (trivia
 * skipped) when no name starts there (`procedure(…) of object`).
 */
function routineNameEnd(s: string, i: number): number {
  for (;;) {
    i = skipTrivia(s, i);
    if (!isIdentStart(s.charCodeAt(i))) return i;
    i = wordEnd(s, i + 1);
    let j = skipTrivia(s, i);
    if (s.charCodeAt(j) === CH_LT) {
      let depth = 0;
      for (; j < s.length; j++) {
        const c = s.charCodeAt(j);
        if (c === CH_LT) {
          depth++;
        } else if (c === CH_GT) {
          if (--depth === 0) {
            j++;
            break;
          }
        } else if (c === CH_SEMI || c === CH_LPAREN || c === CH_RPAREN || c === CH_LF) {
          return i; // not a generic parameter list
        }
      }
      i = j;
      j = skipTrivia(s, i);
    }
    if (s.charCodeAt(j) !== CH_DOT) return i;
    i = j + 1;
  }
}

/**
 * Walk the parameter list whose `(` is at `open`, pushing the `[from, to)`
 * range of each attribute group a parameter starts with — before or after its
 * modifier — onto `ranges`. Returns the index after the list's `)`.
 */
function scanParameterList(s: string, open: number, ranges: number[]): number {
  let depth = 0;
  let i = open;
  let atParameterStart = false;
  while (i < s.length) {
    if (atParameterStart) {
      atParameterStart = false;
      for (;;) {
        i = skipTrivia(s, i);
        const c = s.charCodeAt(i);
        if (c === CH_LBRACKET) {
          const end = attributeEnd(s, i);
          if (end < 0) break;
          ranges.push(i, end);
          i = end;
        } else if (isIdentStart(c)) {
          const e = wordEnd(s, i + 1);
          if (!MODIFIERS.has(s.slice(i, e).toLowerCase())) break;
          i = e;
        } else {
          break;
        }
      }
      continue;
    }
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      if (++depth === 1) atParameterStart = true;
    } else if (c === CH_RPAREN || c === CH_RBRACKET) {
      if (--depth <= 0) return i + 1;
    } else if (c === CH_SEMI && depth === 1) {
      atParameterStart = true;
    }
    i++;
  }
  return i;
}

/** The word starting at `i`, lowercased, or '' when no word starts there. */
function lowerWordAt(s: string, i: number): string {
  return isIdentStart(s.charCodeAt(i)) ? s.slice(i, wordEnd(s, i + 1)).toLowerCase() : '';
}

/**
 * After a `for` keyword ending at `forEnd`, recognize `var Name in` or
 * `var Name: Type in` and push the `var` range and the `: Type` range onto
 * `ranges`. The type runs to the `in` at nesting depth 0, so generic types
 * (`TPair<string, TList<Integer>>`) and dotted names are whole. Any other
 * shape (`for var i := 0 to …`, which the grammar parses, or no `in`) adds
 * nothing. Returns the index to resume scanning from.
 */
function scanForInVariable(s: string, forEnd: number, ranges: number[]): number {
  const varStart = skipTrivia(s, forEnd);
  if (lowerWordAt(s, varStart) !== 'var') return forEnd;
  const varEnd = varStart + 3;
  const nameStart = skipTrivia(s, varEnd);
  if (!isIdentStart(s.charCodeAt(nameStart))) return forEnd;
  let i = skipTrivia(s, wordEnd(s, nameStart + 1));
  let typeStart = -1;
  if (s.charCodeAt(i) === CH_COLON && s.charCodeAt(i + 1) !== CH_EQ) {
    typeStart = i;
    const limit = Math.min(s.length, i + MAX_LOOP_TYPE_LENGTH);
    let depth = 0;
    i++;
    for (;;) {
      if (i >= limit) return forEnd;
      const k = commentOrStringEnd(s, i);
      if (k >= 0) {
        i = k;
        continue;
      }
      const c = s.charCodeAt(i);
      if (c === CH_LT || c === CH_LPAREN || c === CH_LBRACKET) {
        depth++;
      } else if (c === CH_GT || c === CH_RPAREN || c === CH_RBRACKET) {
        if (--depth < 0) return forEnd;
      } else if (c === CH_SEMI || c === CH_EQ) {
        return forEnd; // `for var i: Integer := 0 to …`, or no loop at all
      } else if (isIdentStart(c)) {
        const word = lowerWordAt(s, i);
        if (depth === 0 && word === 'in') break;
        if (NOT_A_FOR_IN.has(word)) return forEnd;
        i = wordEnd(s, i + 1);
        continue;
      }
      i++;
    }
  }
  if (lowerWordAt(s, i) !== 'in') return forEnd;
  ranges.push(varStart, varEnd);
  if (typeStart >= 0) ranges.push(typeStart, i);
  return i;
}

/** `s` with every `[from, to)` range in `ranges` blanked to spaces, newlines kept. */
function blankRanges(s: string, ranges: number[]): string {
  if (ranges.length === 0) return s;
  let out = '';
  let last = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    const from = ranges[r]!;
    const to = ranges[r + 1]!;
    out += s.slice(last, from) + s.slice(from, to).replace(/[^\r\n]/g, ' ');
    last = to;
  }
  return out + s.slice(last);
}

/** Whether the word before index `i`, past whitespace, is `class`. */
function followsClass(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (s.charCodeAt(j) === CH_SPACE || s.charCodeAt(j) === CH_TAB || s.charCodeAt(j) === CH_LF || s.charCodeAt(j) === CH_CR)) j--;
  return j >= 4 && s.slice(j - 4, j + 1).toLowerCase() === 'class' && (j < 5 || !isIdentPart(s.charCodeAt(j - 5)));
}

/**
 * Blank what the Pascal grammar can't parse (see the file comment). Returns
 * the source unchanged when there is nothing to blank.
 */
export function preParsePascal(source: string): string {
  if (source.indexOf('[') < 0 && !FOR_VAR.test(source)) return source;
  const ranges: number[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const k = commentOrStringEnd(source, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    const c = source.charCodeAt(i);
    if (isIdentStart(c)) {
      const e = wordEnd(source, i + 1);
      const len = e - i;
      const word = len >= 8 && len <= 11 ? source.slice(i, e).toLowerCase() : '';
      // `operator` is no reserved word in Delphi (a call `Operator([1, 2])` is
      // code), so it starts a header only after `class`.
      if (ROUTINE_KEYWORDS.has(word) && (word !== 'operator' || followsClass(source, i))) {
        const open = skipTrivia(source, routineNameEnd(source, e));
        if (source.charCodeAt(open) === CH_LPAREN) {
          i = scanParameterList(source, open, ranges);
          continue;
        }
      } else if (len === 3 && source.slice(i, e).toLowerCase() === 'for') {
        i = scanForInVariable(source, e, ranges);
        continue;
      }
      i = e;
    } else if (c >= 48 && c <= 57) {
      i = wordEnd(source, i + 1); // a number
    } else {
      i++;
    }
  }
  return blankRanges(source, ranges);
}
