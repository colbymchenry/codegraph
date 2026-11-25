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

function skipSpace(src: string, k: number): number {
  while (k < src.length && isSpace(src.charCodeAt(k))) k++;
  return k;
}

function nameEnd(src: string, k: number): number {
  while (k < src.length && isNamePart(src.charCodeAt(k))) k++;
  return k;
}

function lineEnd(src: string, k: number): number {
  for (let c = src.charCodeAt(k); k < src.length && c !== 10 && c !== 13; c = src.charCodeAt(++k));
  return k;
}

/** The `/` closing the regex literal opened at `start`, or -1 when it doesn't close on its line. */
function regexEnd(src: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < src.length; k++) {
    const c = src.charCodeAt(k);
    if (c === 10 || c === 13) return -1;
    if (c === 92) {
      k++;
      if (src.charCodeAt(k) === 10 || src.charCodeAt(k) === 13) return -1;
    } else if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) return k;
  }
  return -1;
}

/** The quote closing the string opened at `start`, or -1 when the string doesn't close. */
function stringEnd(src: string, start: number): number {
  const quote = src.charCodeAt(start);
  for (let k = start + 1; k < src.length; k++) {
    const c = src.charCodeAt(k);
    if (c === quote) return k;
    if (c === 92) k += src.charCodeAt(k + 1) === 13 && src.charCodeAt(k + 2) === 10 ? 2 : 1;
    else if (c === 10 || c === 13) return -1;
  }
  return -1;
}

/** `src` with the ranges (start and end pairs, in order) turned to spaces, line breaks kept. */
function blankRanges(src: string, blanks: number[]): string {
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

export function jsxCode(src: string): string | null {
  return new JsxLexer(src).read();
}

/**
 * The lexer's state for one file. Its steps are methods, not closures made
 * per file: a closure made anew for each file is another call target to the
 * optimizer, which threw `jsxCode`'s code away and compiled it again for
 * file after file, at 40 to 90 ms a time (excalidraw's index did it 15 times).
 */
class JsxLexer {
  private readonly n: number;
  /** Ranges to blank, as start and end pairs, in source order. */
  private readonly blanks: number[] = [];
  private readonly stack: Frame[] = [{ mode: 'code', braces: 0, name: '' }];
  /** The elements opened among code that are still open, innermost last. */
  private readonly roots: Root[] = [];
  /** `<`s that failed to read as an element. */
  private readonly operators = new Set<number>();
  private i = 0;
  /** Whether the last token ends an expression: a `<` then compares, a `/` divides. */
  private exprEnd = false;
  /** Whether the last token is a `.`, so a keyword is a property's name. */
  private afterDot = false;
  private rereads = 0;

  constructor(private readonly src: string) {
    this.n = src.length;
  }

  read(): string | null {
    const budget = 4 * this.n + 65536;
    let steps = 0;
    for (;;) {
      while (this.i < this.n) {
        if (++steps > budget) return null;
        const top = this.stack[this.stack.length - 1]!;
        const c = this.src.charCodeAt(this.i);
        const ok =
          top.mode === 'code' ? this.code(top, c)
          : top.mode === 'template' ? this.template(c)
          : top.mode === 'tag' ? this.tag(top, c)
          : this.children(top, c);
        if (!ok) return null;
      }
      if (this.stack.length === 1 && this.stack[0]!.braces === 0) break;
      if (!this.reread()) return null;
    }
    return blankRanges(this.src, this.blanks);
  }

  private blank(from: number, to: number): void {
    if (to > from) this.blanks.push(from, Math.min(to, this.n));
  }

  private codeFrame(): void {
    this.stack.push({ mode: 'code', braces: 0, name: '' });
    this.exprEnd = false;
    this.afterDot = false;
  }

  /**
   * Undo back to the innermost element still open among code and read its
   * `<` again as an operator. False when there is none, or too many have
   * failed: the file is then read as it is.
   */
  private reread(): boolean {
    const root = this.roots.pop();
    if (!root || ++this.rereads > MAX_REREADS) return false;
    this.stack.length = root.depth;
    this.blanks.length = root.blanks;
    for (const k of this.operators) if (k > root.at) this.operators.delete(k);
    this.operators.add(root.at);
    this.i = root.at;
    this.exprEnd = false;
    this.afterDot = false;
    return true;
  }

  /** Open the element whose `<` is at `lt`. False when it cannot be one. */
  private openElement(lt: number): boolean {
    const src = this.src;
    if (src.charCodeAt(lt + 1) === 62) {
      this.stack.push({ mode: 'children', braces: 0, name: '' });
      this.i = lt + 2;
      return true;
    }
    let k = nameEnd(src, lt + 1);
    const name = src.slice(lt + 1, k);
    // `<Entry extends BaseEntity>(…) =>`: a generic arrow function's type parameters.
    const next = skipSpace(src, k);
    if (next > k && src.startsWith('extends', next) && isSpace(src.charCodeAt(next + 7))) return false;
    if (src.charCodeAt(k) === 60) {
      // `<Select<Option> …>`: the element's type arguments.
      let depth = 0;
      const limit = Math.min(this.n, k + 1000);
      for (; k < limit; k++) {
        const c = src.charCodeAt(k);
        if (c === 60) depth++;
        else if (c === 62 && --depth === 0) break;
      }
      if (depth !== 0) return false;
      k++;
    }
    this.stack.push({ mode: 'tag', braces: 0, name });
    this.i = k;
    return true;
  }

  /** Close the innermost element. Closing an element opened among code ends an expression. */
  private closeElement(): void {
    this.stack.pop();
    if (this.stack[this.stack.length - 1]!.mode === 'code') {
      this.roots.pop();
      this.exprEnd = true;
      this.afterDot = false;
    }
  }

  /** One step among code. False when the file is given up. */
  private code(top: Frame, c: number): boolean {
    const src = this.src;
    const i = this.i;
    if (isSpace(c)) {
      this.i = i + 1;
      return true;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        const end = lineEnd(src, i);
        this.blank(i, end);
        this.i = end;
        return true;
      }
      if (d === 42) {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return this.reread();
        this.blank(i, end + 2);
        this.i = end + 2;
        return true;
      }
      if (this.exprEnd) {
        // `/>` among code: an element read as code.
        if (d === 62) return this.reread();
        this.i = i + 1;
        this.exprEnd = false;
        this.afterDot = false;
        return true;
      }
      const end = regexEnd(src, i);
      if (end === -1) {
        this.i = i + 1;
        return true;
      }
      this.blank(i + 1, end);
      let k = end + 1;
      while (k < this.n && isIdPart(src.charCodeAt(k))) k++;
      this.i = k;
      this.exprEnd = true;
      this.afterDot = false;
      return true;
    }
    if (c === 34 || c === 39) {
      const end = stringEnd(src, i);
      if (end === -1) return this.reread();
      this.blank(i + 1, end);
      this.i = end + 1;
      this.exprEnd = true;
      this.afterDot = false;
      return true;
    }
    if (c === 96) {
      this.stack.push({ mode: 'template', braces: 0, name: '' });
      this.i = i + 1;
      return true;
    }
    if (c === 60) {
      const d = src.charCodeAt(i + 1);
      if (!this.exprEnd && (d === 62 || isIdStart(d)) && !this.operators.has(i)) {
        this.roots.push({ at: i, depth: this.stack.length, blanks: this.blanks.length });
        return this.openElement(i) || this.reread();
      }
      // `</` among code: a closing tag read as code.
      if (d === 47) return this.reread();
      this.i = i + (d === 60 || d === 61 ? 2 : 1);
      this.exprEnd = false;
      this.afterDot = false;
      return true;
    }
    if (c === 123) {
      top.braces++;
      this.i = i + 1;
      this.exprEnd = false;
      this.afterDot = false;
      return true;
    }
    if (c === 125) {
      if (top.braces > 0) {
        top.braces--;
        this.i = i + 1;
        this.exprEnd = false;
        this.afterDot = false;
        return true;
      }
      if (this.stack.length === 1) return this.reread();
      // The end of a JSX `{…}` or of a template's `${…}`.
      this.stack.pop();
      this.i = i + 1;
      return true;
    }
    if (isIdStart(c)) {
      let end = i + 1;
      while (end < this.n && isIdPart(src.charCodeAt(end))) end++;
      this.exprEnd = this.afterDot || !BEFORE_EXPRESSION.has(src.slice(i, end));
      this.afterDot = false;
      this.i = end;
      return true;
    }
    const d = src.charCodeAt(i + 1);
    if ((c >= 48 && c <= 57) || (c === 46 && d >= 48 && d <= 57)) {
      let end = i + 1;
      for (let e = src.charCodeAt(end); end < this.n && (isIdPart(e) || e === 46); e = src.charCodeAt(++end));
      this.i = end;
      this.exprEnd = true;
      this.afterDot = false;
      return true;
    }
    if (c === 46) {
      if (d === 46 && src.charCodeAt(i + 2) === 46) {
        this.i = i + 3;
        this.exprEnd = false;
        this.afterDot = false;
      } else {
        this.i = i + 1;
        this.exprEnd = false;
        this.afterDot = true;
      }
      return true;
    }
    if (c === 41 || c === 93) {
      this.i = i + 1;
      this.exprEnd = true;
      this.afterDot = false;
      return true;
    }
    // `++` and `--` leave the expression where it was, and so does TypeScript's `x!`.
    if ((c === 43 || c === 45) && d === c) {
      this.i = i + 2;
      return true;
    }
    if (c === 33 && this.exprEnd && d !== 61) {
      this.i = i + 1;
      return true;
    }
    if (c === 35 && i === 0 && d === 33) {
      this.i = lineEnd(src, 0);
      return true;
    }
    this.i = i + 1;
    this.exprEnd = false;
    this.afterDot = false;
    return true;
  }

  /** One step in a template's text. */
  private template(c: number): boolean {
    const src = this.src;
    const i = this.i;
    if (c === 96) {
      this.stack.pop();
      this.i = i + 1;
      this.exprEnd = true;
      this.afterDot = false;
      return true;
    }
    if (c === 92) {
      this.blank(i, i + 2);
      this.i = i + 2;
      return true;
    }
    if (c === 36 && src.charCodeAt(i + 1) === 123) {
      this.codeFrame();
      this.i = i + 2;
      return true;
    }
    let end = i + 1;
    for (let e = src.charCodeAt(end); end < this.n && e !== 96 && e !== 92 && e !== 36; e = src.charCodeAt(++end));
    this.blank(i, end);
    this.i = end;
    return true;
  }

  /** One step in an element's opening tag. False when the file is given up. */
  private tag(top: Frame, c: number): boolean {
    const src = this.src;
    const i = this.i;
    if (isSpace(c)) {
      this.i = i + 1;
      return true;
    }
    if (c === 62) {
      top.mode = 'children';
      this.i = i + 1;
      return true;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 62) {
        this.i = i + 2;
        this.closeElement();
        return true;
      }
      if (d === 47) {
        const end = lineEnd(src, i);
        this.blank(i, end);
        this.i = end;
        return true;
      }
      if (d === 42) {
        const end = src.indexOf('*/', i + 2);
        if (end !== -1) {
          this.blank(i, end + 2);
          this.i = end + 2;
          return true;
        }
      }
      return this.reread();
    }
    if (c === 123) {
      this.codeFrame();
      this.i = i + 1;
      return true;
    }
    if (isIdStart(c)) {
      const end = nameEnd(src, i + 1);
      const eq = skipSpace(src, end);
      if (src.charCodeAt(eq) !== 61) {
        this.i = end;
        return true;
      }
      const value = skipSpace(src, eq + 1);
      const q = src.charCodeAt(value);
      if (q === 34 || q === 39) {
        // JSX strings have no escapes and may span lines.
        const close = src.indexOf(q === 34 ? '"' : "'", value + 1);
        if (close === -1) return this.reread();
        this.blank(value + 1, close);
        this.i = close + 1;
        return true;
      }
      if (q === 123) {
        this.codeFrame();
        this.i = value + 1;
        return true;
      }
      const next = src.charCodeAt(value + 1);
      if (q === 60 && (next === 62 || isIdStart(next)) && this.openElement(value)) return true;
    }
    return this.reread();
  }

  /** One step among an element's children. False when the file is given up. */
  private children(top: Frame, c: number): boolean {
    const src = this.src;
    const i = this.i;
    if (c === 123) {
      this.codeFrame();
      this.i = i + 1;
      return true;
    }
    if (c === 60) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        const start = skipSpace(src, i + 2);
        const end = nameEnd(src, start);
        const gt = skipSpace(src, end);
        if (src.charCodeAt(gt) !== 62 || src.slice(start, end) !== top.name) return this.reread();
        this.i = gt + 1;
        this.closeElement();
        return true;
      }
      if ((d === 62 || isIdStart(d)) && this.openElement(i)) return true;
      return this.reread();
    }
    // JSX text can't hold a `>` or a `}`: code read as text.
    if (c === 62 || c === 125) return this.reread();
    let end = i + 1;
    for (let e = src.charCodeAt(end); end < this.n && e !== 123 && e !== 60 && e !== 62 && e !== 125; e = src.charCodeAt(++end));
    this.i = end;
    return true;
  }
}
