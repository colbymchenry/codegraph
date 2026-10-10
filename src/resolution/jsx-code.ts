/**
 * A JavaScript or JSX file's code, for a scan that reads JSX tags off it with a
 * pattern.
 *
 * Text that only mentions a tag renders nothing: a JSDoc example, markup
 * commented out (`{/* <Progress /> *\/}`), an error message ("You cannot
 * render a <Router> inside another <Router>"), an attribute's value. So
 * comments, and the contents of string, template and regex literals and of
 * JSX attribute strings, are blanked. Every character keeps its offset and
 * every line break its place, so a match in the result sits at the same line
 * and column as in the source.
 *
 * Inside an element, a quote, a slash or a backtick is text: `<p>Don't have an
 * account? <Link to="/signup">`, `<a>https://…</a>`. Read as code, that
 * apostrophe opens a string that blanks the `<Link`. So the lexer follows
 * elements the way JSX does: one opens where an expression can start, and its
 * text runs to a tag or a `{`. A `<` that opens a type parameter list in the
 * same place (`<T,>(x: T) =>`, `type Fn = <T>(x: T) => T`) reads as an element
 * only until it fails to: the lexer then reads it again as an operator.
 *
 * Null when the file does not read as one program that way: a string still
 * open at the end of its line, a comment, template or element still open at
 * the end of the file, braces that don't balance, a closing tag that names
 * another element, or a `</` or `/>` among code. A scan should then read the
 * source as it is.
 */

/**
 * What the lexer reads: code, a template's text, an element's opening tag (its
 * attributes), or its children (JSX text, tags and `{…}`).
 */
type Mode = 'code' | 'template' | 'tag' | 'children';

interface Frame {
  mode: Mode;
  /** Code: braces opened in this frame and not closed yet. */
  braces: number;
  /** Tag and Children: the element's name, which its closing tag repeats. */
  name: string;
}

/** Where an element opened among code: what to undo to read its `<` again. */
interface Root {
  at: number;
  depth: number;
  blanks: number;
}

/** Keywords an expression follows: a `<` after one opens an element, a `/` a regex. */
const BEFORE_EXPRESSION = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'default',
]);

/** How many elements may fail to read before the file is read as it is. */
const MAX_REREADS = 64;

const isSpace = (c: number): boolean =>
  c === 32 || c === 10 || c === 13 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff;
const isIdStart = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || (c > 127 && !isSpace(c));
const isIdPart = (c: number): boolean => isIdStart(c) || (c >= 48 && c <= 57);
/** A JSX name's characters: an identifier's, and the `-`, `.` and `:` between its parts. */
const isNamePart = (c: number): boolean => isIdPart(c) || c === 45 || c === 46 || c === 58;

export function jsxCode(src: string): string | null {
  const n = src.length;
  /** Ranges to blank, as start and end pairs, in source order. */
  const blanks: number[] = [];
  const stack: Frame[] = [{ mode: 'code', braces: 0, name: '' }];
  /** The elements opened among code that are still open, innermost last. */
  const roots: Root[] = [];
  /** `<`s that failed to read as an element. */
  const operators = new Set<number>();
  let i = 0;
  /** Whether the last token ends an expression: a `<` then compares, a `/` divides. */
  let exprEnd = false;
  /** Whether the last token is a `.`, so a keyword is a property's name. */
  let afterDot = false;
  let rereads = 0;
  let steps = 0;
  const budget = 4 * n + 65536;

  const at = (k: number): number => src.charCodeAt(k);
  const skipSpace = (k: number): number => {
    while (k < n && isSpace(at(k))) k++;
    return k;
  };
  const nameEnd = (k: number): number => {
    while (k < n && isNamePart(at(k))) k++;
    return k;
  };
  const lineEnd = (k: number): number => {
    while (k < n && at(k) !== 10 && at(k) !== 13) k++;
    return k;
  };
  const blank = (from: number, to: number): void => {
    if (to > from) blanks.push(from, Math.min(to, n));
  };
  const codeFrame = (): void => {
    stack.push({ mode: 'code', braces: 0, name: '' });
    exprEnd = false;
    afterDot = false;
  };

  /**
   * Undo back to the innermost element still open among code and read its
   * `<` again as an operator. False when there is none, or too many have
   * failed: the file is then read as it is.
   */
  const reread = (): boolean => {
    const root = roots.pop();
    if (!root || ++rereads > MAX_REREADS) return false;
    stack.length = root.depth;
    blanks.length = root.blanks;
    for (const k of operators) if (k > root.at) operators.delete(k);
    operators.add(root.at);
    i = root.at;
    exprEnd = false;
    afterDot = false;
    return true;
  };

  /** Open the element whose `<` is at `lt`. False when it cannot be one. */
  const openElement = (lt: number): boolean => {
    if (at(lt + 1) === 62) {
      stack.push({ mode: 'children', braces: 0, name: '' });
      i = lt + 2;
      return true;
    }
    let k = nameEnd(lt + 1);
    const name = src.slice(lt + 1, k);
    // `<Entry extends BaseEntity>(…) =>`: a generic arrow function's type parameters.
    const next = skipSpace(k);
    if (next > k && src.startsWith('extends', next) && isSpace(at(next + 7))) return false;
    if (at(k) === 60) {
      // `<Select<Option> …>`: the element's type arguments.
      let depth = 0;
      const limit = Math.min(n, k + 1000);
      for (; k < limit; k++) {
        const c = at(k);
        if (c === 60) depth++;
        else if (c === 62 && --depth === 0) break;
      }
      if (depth !== 0) return false;
      k++;
    }
    stack.push({ mode: 'tag', braces: 0, name });
    i = k;
    return true;
  };

  /** Close the innermost element. Closing an element opened among code ends an expression. */
  const closeElement = (): void => {
    stack.pop();
    if (stack[stack.length - 1]!.mode === 'code') {
      roots.pop();
      exprEnd = true;
      afterDot = false;
    }
  };

  /** The `/` closing the regex literal opened at `start`, or -1 when it doesn't close on its line. */
  const regexEnd = (start: number): number => {
    let inClass = false;
    for (let k = start + 1; k < n; k++) {
      const c = at(k);
      if (c === 10 || c === 13) return -1;
      if (c === 92) {
        k++;
        if (at(k) === 10 || at(k) === 13) return -1;
      } else if (c === 91) inClass = true;
      else if (c === 93) inClass = false;
      else if (c === 47 && !inClass) return k;
    }
    return -1;
  };

  /** The quote closing the string opened at `start`, or -1 when the string doesn't close. */
  const stringEnd = (start: number): number => {
    const quote = at(start);
    for (let k = start + 1; k < n; k++) {
      const c = at(k);
      if (c === quote) return k;
      if (c === 92) k += at(k + 1) === 13 && at(k + 2) === 10 ? 2 : 1;
      else if (c === 10 || c === 13) return -1;
    }
    return -1;
  };

  for (;;) {
    while (i < n) {
      if (++steps > budget) return null;
      const top = stack[stack.length - 1]!;
      const c = at(i);

      if (top.mode === 'code') {
        if (isSpace(c)) {
          i++;
          continue;
        }
        if (c === 47) {
          const d = at(i + 1);
          if (d === 47) {
            const end = lineEnd(i);
            blank(i, end);
            i = end;
            continue;
          }
          if (d === 42) {
            const end = src.indexOf('*/', i + 2);
            if (end === -1) {
              if (!reread()) return null;
              continue;
            }
            blank(i, end + 2);
            i = end + 2;
            continue;
          }
          if (exprEnd) {
            // `/>` among code: an element read as code.
            if (d === 62) {
              if (!reread()) return null;
              continue;
            }
            i++;
            exprEnd = false;
            afterDot = false;
            continue;
          }
          const end = regexEnd(i);
          if (end === -1) {
            i++;
            continue;
          }
          blank(i + 1, end);
          i = end + 1;
          while (i < n && isIdPart(at(i))) i++;
          exprEnd = true;
          afterDot = false;
          continue;
        }
        if (c === 34 || c === 39) {
          const end = stringEnd(i);
          if (end === -1) {
            if (!reread()) return null;
            continue;
          }
          blank(i + 1, end);
          i = end + 1;
          exprEnd = true;
          afterDot = false;
          continue;
        }
        if (c === 96) {
          stack.push({ mode: 'template', braces: 0, name: '' });
          i++;
          continue;
        }
        if (c === 60) {
          const d = at(i + 1);
          if (!exprEnd && (d === 62 || isIdStart(d)) && !operators.has(i)) {
            roots.push({ at: i, depth: stack.length, blanks: blanks.length });
            if (!openElement(i) && !reread()) return null;
            continue;
          }
          // `</` among code: a closing tag read as code.
          if (d === 47) {
            if (!reread()) return null;
            continue;
          }
          i += d === 60 || d === 61 ? 2 : 1;
          exprEnd = false;
          afterDot = false;
          continue;
        }
        if (c === 123) {
          top.braces++;
          i++;
          exprEnd = false;
          afterDot = false;
          continue;
        }
        if (c === 125) {
          if (top.braces > 0) {
            top.braces--;
            i++;
            exprEnd = false;
            afterDot = false;
            continue;
          }
          if (stack.length === 1) {
            if (!reread()) return null;
            continue;
          }
          // The end of a JSX `{…}` or of a template's `${…}`.
          stack.pop();
          i++;
          continue;
        }
        if (isIdStart(c)) {
          let end = i + 1;
          while (end < n && isIdPart(at(end))) end++;
          exprEnd = afterDot || !BEFORE_EXPRESSION.has(src.slice(i, end));
          afterDot = false;
          i = end;
          continue;
        }
        if ((c >= 48 && c <= 57) || (c === 46 && at(i + 1) >= 48 && at(i + 1) <= 57)) {
          let end = i + 1;
          while (end < n && (isIdPart(at(end)) || at(end) === 46)) end++;
          i = end;
          exprEnd = true;
          afterDot = false;
          continue;
        }
        if (c === 46) {
          if (at(i + 1) === 46 && at(i + 2) === 46) {
            i += 3;
            exprEnd = false;
            afterDot = false;
          } else {
            i++;
            exprEnd = false;
            afterDot = true;
          }
          continue;
        }
        if (c === 41 || c === 93) {
          i++;
          exprEnd = true;
          afterDot = false;
          continue;
        }
        // `++` and `--` leave the expression where it was, and so does TypeScript's `x!`.
        if ((c === 43 || c === 45) && at(i + 1) === c) {
          i += 2;
          continue;
        }
        if (c === 33 && exprEnd && at(i + 1) !== 61) {
          i++;
          continue;
        }
        if (c === 35 && i === 0 && at(1) === 33) {
          i = lineEnd(0);
          continue;
        }
        i++;
        exprEnd = false;
        afterDot = false;
        continue;
      }

      if (top.mode === 'template') {
        if (c === 96) {
          stack.pop();
          i++;
          exprEnd = true;
          afterDot = false;
          continue;
        }
        if (c === 92) {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        if (c === 36 && at(i + 1) === 123) {
          codeFrame();
          i += 2;
          continue;
        }
        let end = i + 1;
        while (end < n) {
          const e = at(end);
          if (e === 96 || e === 92 || e === 36) break;
          end++;
        }
        blank(i, end);
        i = end;
        continue;
      }

      if (top.mode === 'tag') {
        if (isSpace(c)) {
          i++;
          continue;
        }
        if (c === 62) {
          top.mode = 'children';
          i++;
          continue;
        }
        if (c === 47) {
          const d = at(i + 1);
          if (d === 62) {
            i += 2;
            closeElement();
            continue;
          }
          if (d === 47) {
            const end = lineEnd(i);
            blank(i, end);
            i = end;
            continue;
          }
          if (d === 42) {
            const end = src.indexOf('*/', i + 2);
            if (end !== -1) {
              blank(i, end + 2);
              i = end + 2;
              continue;
            }
          }
          if (!reread()) return null;
          continue;
        }
        if (c === 123) {
          codeFrame();
          i++;
          continue;
        }
        if (isIdStart(c)) {
          const end = nameEnd(i + 1);
          const eq = skipSpace(end);
          if (at(eq) !== 61) {
            i = end;
            continue;
          }
          const value = skipSpace(eq + 1);
          const q = at(value);
          if (q === 34 || q === 39) {
            // JSX strings have no escapes and may span lines.
            const close = src.indexOf(q === 34 ? '"' : "'", value + 1);
            if (close === -1) {
              if (!reread()) return null;
              continue;
            }
            blank(value + 1, close);
            i = close + 1;
            continue;
          }
          if (q === 123) {
            codeFrame();
            i = value + 1;
            continue;
          }
          if (q === 60 && (at(value + 1) === 62 || isIdStart(at(value + 1))) && openElement(value)) continue;
        }
        if (!reread()) return null;
        continue;
      }

      // Children.
      if (c === 123) {
        codeFrame();
        i++;
        continue;
      }
      if (c === 60) {
        const d = at(i + 1);
        if (d === 47) {
          const start = skipSpace(i + 2);
          const end = nameEnd(start);
          const gt = skipSpace(end);
          if (at(gt) !== 62 || src.slice(start, end) !== top.name) {
            if (!reread()) return null;
            continue;
          }
          i = gt + 1;
          closeElement();
          continue;
        }
        if ((d === 62 || isIdStart(d)) && openElement(i)) continue;
        if (!reread()) return null;
        continue;
      }
      // JSX text can't hold a `>` or a `}`: code read as text.
      if (c === 62 || c === 125) {
        if (!reread()) return null;
        continue;
      }
      let end = i + 1;
      while (end < n) {
        const e = at(end);
        if (e === 123 || e === 60 || e === 62 || e === 125) break;
        end++;
      }
      i = end;
    }
    if (stack.length === 1 && stack[0]!.braces === 0) break;
    if (!reread()) return null;
  }

  if (blanks.length === 0) return src;
  const parts: string[] = [];
  let from = 0;
  for (let b = 0; b < blanks.length; b += 2) {
    const start = blanks[b]!;
    const end = blanks[b + 1]!;
    if (start < from) continue;
    parts.push(src.slice(from, start));
    const text = src.slice(start, end);
    parts.push(/[\r\n]/.test(text) ? text.replace(/[^\r\n]/g, ' ') : ' '.repeat(end - start));
    from = end;
  }
  parts.push(src.slice(from));
  return parts.join('');
}
