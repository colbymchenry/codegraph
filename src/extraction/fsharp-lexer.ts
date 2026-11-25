/**
 * A minimal F# lexer: what of a text is code, as F#'s own lexer reads it.
 * Comments are `// …` and `(* … *)`, which nest; `(*)` is the multiplication
 * operator, not a comment. Strings (`"…"`, `@"…"`, `"""…"""`, `$"…"`) and
 * character literals hold no code.
 *
 * The names it yields are identifiers (``` ``a b`` ``` without its backticks),
 * operators written in parentheses (`(+++)`) and active patterns
 * (`(|Even|Odd|)`), each spelled without spaces, as a declaration names it.
 */

const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_']/u;
const OPERATOR_CHARS = /[!%&*+\-./<=>?@^|~:$]/;

/** The names an F# text's code holds, in order. */
export function fsharpNames(text: string): string[] {
  const names: string[] = [];
  lex(text, (name) => names.push(name));
  return names;
}

/** Whether an F# text has anything but comments and blank space. */
export function hasFsharpCode(text: string): boolean {
  let found = false;
  lex(text, () => { found = true; }, () => { found = true; });
  return found;
}

/** Walk `text`, calling `onName` for each name and `onOther` for any other code. */
function lex(text: string, onName: (name: string) => void, onOther: () => void = () => {}): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '(' && text[i + 1] === '*' && text[i + 2] !== ')') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === '"' || ((ch === '@' || ch === '$') && text[i + 1] === '"') || (ch === '$' && text[i + 1] === '@' && text[i + 2] === '"') || (ch === '@' && text[i + 1] === '$' && text[i + 2] === '"')) {
      i = skipString(text, i);
      onOther();
      continue;
    }
    if (ch === "'" && isCharLiteral(text, i)) {
      i = skipCharLiteral(text, i);
      onOther();
      continue;
    }
    if (ch === '`' && text[i + 1] === '`') {
      const end = text.indexOf('``', i + 2);
      if (end < 0) { i = n; continue; }
      onName(text.slice(i + 2, end));
      i = end + 2;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(text[j]!)) j++;
      onName(text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '(') {
      // `(+++)`, `( * )`, `(|Even|Odd|)`: an operator or an active pattern named in parentheses.
      const named = parenthesisedName(text, i);
      if (named) {
        onName(named.name);
        i = named.end;
        continue;
      }
    }
    onOther();
    i++;
  }
}

/** The end of the `(* … *)` comment that starts at `start`; comments nest, and strings inside them hold no `*)`. */
function skipBlockComment(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text[i] === '(' && text[i + 1] === '*' && text[i + 2] !== ')') { depth++; i += 2; continue; }
    if (text[i] === '*' && text[i + 1] === ')') {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    if (text[i] === '"') { i = skipString(text, i); continue; }
    i++;
  }
  return text.length;
}

/** The end of the string literal that starts at `start` (`"…"`, `@"…"`, `"""…"""`, `$"…"`, `$@"…"`). */
function skipString(text: string, start: number): number {
  let i = start;
  let verbatim = false;
  while (text[i] === '@' || text[i] === '$') { if (text[i] === '@') verbatim = true; i++; }
  if (text.startsWith('"""', i)) {
    const end = text.indexOf('"""', i + 3);
    return end < 0 ? text.length : end + 3;
  }
  i++;
  while (i < text.length) {
    if (!verbatim && text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') {
      if (verbatim && text[i + 1] === '"') { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Whether the `'` at `i` opens a character literal (`'a'`, `'\n'`), not a type parameter (`'T`) or a name's prime. */
function isCharLiteral(text: string, i: number): boolean {
  if (i > 0 && NAME_PART.test(text[i - 1]!)) return false;
  return text[i + 1] === '\\' ? /^'\\(?:[ntbrafv\\"'0]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-9]{3})'/.test(text.slice(i, i + 12)) : text[i + 2] === "'";
}

function skipCharLiteral(text: string, i: number): number {
  const end = text.indexOf("'", i + 2);
  return end < 0 ? text.length : end + 1;
}

/** The operator or active pattern named in the parentheses at `start`, spelled without spaces, and where it ends. */
function parenthesisedName(text: string, start: number): { name: string; end: number } | null {
  let j = start + 1;
  while (text[j] === ' ') j++;
  if (text[j] === '|') {
    // `(|Even|Odd|)`, `(|Int|_|)`.
    const close = text.indexOf('|)', j + 1);
    if (close < 0) return null;
    const inner = text.slice(j, close + 1).replace(/\s+/g, '');
    return /^\|(?:[\p{L}_][\p{L}\p{N}_']*\|)+(?:_\|)?$/u.test(inner) ? { name: `(${inner})`, end: close + 2 } : null;
  }
  let k = j;
  while (k < text.length && OPERATOR_CHARS.test(text[k]!)) k++;
  if (k === j) return null;
  let close = k;
  while (text[close] === ' ') close++;
  if (text[close] !== ')') return null;
  return { name: `(${text.slice(j, k)})`, end: close + 1 };
}
