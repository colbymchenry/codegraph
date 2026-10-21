/**
 * C and C++ string literals as text, not code, for the scans that read
 * declarations off source lines (receiver inference in name-matcher.ts).
 *
 * A raw string literal — `R"cc( … )cc"`, which protobuf's generators use for
 * the code they emit — can span many lines and hold anything, declarations
 * included: upb's generator writes `upb_MiniTableField field = $field_init$;`
 * inside one, and reading back from a later `field.ctype()` on the function's
 * own `upb::FieldDefPtr field` parameter found that line first. Its lines are
 * found by reading the file once, as the compiler does: comments, ordinary
 * string and character literals, and raw strings with their delimiters.
 * An ordinary string can't span lines, so its contents are blanked on the
 * line being read. Block comments are found in the same pass and blanked
 * too: a line inside one is no code whatever it starts with, and a line
 * outside one is code even when it starts with `*` (`*out = value;`).
 */
import type { ResolutionContext } from './types';

/** Column ranges, `[start, end)`, a raw string literal or a block comment takes on a line (its quotes, delimiters and comment markers included). */
type Ranges = Array<[number, number]>;

const RAW_STRING_LINES = new WeakMap<ResolutionContext, Map<string, Map<number, Ranges>>>();

/** Drop the per-file raw-string memo (see ReferenceResolver.clearCaches). */
export function clearCppRawStringMemos(context: ResolutionContext): void {
  RAW_STRING_LINES.delete(context);
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * The 1-based lines of a C or C++ file that raw string literals or block
 * comments cover, each with the columns they take. Empty for a file with none.
 */
export function cppNonCodeLines(file: string, context: ResolutionContext): Map<number, Ranges> {
  let memo = RAW_STRING_LINES.get(context);
  if (!memo) RAW_STRING_LINES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const lines = new Map<number, Ranges>();
  const text = context.readFile(file);
  if (text && (text.includes('R"') || text.includes('/*'))) {
    let line = 1;
    let column = 0;
    const n = text.length;
    let i = 0;
    // Mark [from, to) of the text, which may span lines, as raw string contents.
    const mark = (from: number, fromLine: number, fromColumn: number, to: number): void => {
      let l = fromLine;
      let start = fromColumn;
      let c = fromColumn;
      for (let k = from; k < to; k++) {
        if (text[k] === '\n') {
          if (c > start) (lines.get(l) ?? lines.set(l, []).get(l)!).push([start, c]);
          l++;
          start = 0;
          c = 0;
        } else if (text[k] !== '\r') c++;
      }
      if (c > start) (lines.get(l) ?? lines.set(l, []).get(l)!).push([start, c]);
    };
    // Advance over [i, to), keeping line and column.
    const advance = (to: number): void => {
      for (; i < to; i++) {
        if (text[i] === '\n') {
          line++;
          column = 0;
        } else if (text[i] !== '\r') column++;
      }
    };
    while (i < n) {
      const c = text[i]!;
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        advance(end < 0 ? n : end);
      } else if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        const to = end < 0 ? n : end + 2;
        mark(i, line, column, to);
        advance(to);
      } else if (c === '"') {
        // `R"`, `u8R"`, `uR"`, `UR"`, `LR"`, not part of a longer name.
        const prefix = /(?:u8|[uUL])?R$/.exec(text.slice(Math.max(0, i - 3), i));
        const open = prefix && !isWordChar(text[i - prefix[0].length - 1]) ? text.indexOf('(', i + 1) : -1;
        const delimiter = open > i ? text.slice(i + 1, open) : null;
        if (delimiter !== null && delimiter.length <= 16 && /^[^\s()\\]*$/.test(delimiter)) {
          // From the opening quote through the closing one: `"cc( … )cc"`.
          const close = text.indexOf(`)${delimiter}"`, open + 1);
          const end = close < 0 ? n : close + delimiter.length + 2;
          mark(i, line, column, end);
          advance(end);
        } else {
          // An ordinary string: to its closing quote, or the end of the line.
          let k = i + 1;
          while (k < n && text[k] !== '"' && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
          advance(Math.min(n, text[k] === '"' ? k + 1 : k));
        }
      } else if (c === '\'' && !isWordChar(text[i - 1])) {
        // A character literal (`'"'`); after a digit it is a digit separator (`1'000`).
        let k = i + 1;
        while (k < n && text[k] !== '\'' && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
        advance(Math.min(n, text[k] === '\'' ? k + 1 : k));
      } else advance(i + 1);
    }
  }
  memo.set(file, lines);
  return lines;
}

/**
 * Line `line` (1-based) of a C or C++ file with the contents of its string
 * and character literals blanked, raw strings included, columns kept.
 */
export function cppLiteralsBlanked(text: string, line: number, rawLines: Map<number, Ranges>): string {
  const raw = rawLines.get(line);
  const out = text.split('');
  if (raw) for (const [start, end] of raw) for (let k = start; k < end && k < out.length; k++) out[k] = ' ';
  if (!text.includes('"') && !text.includes('\'')) return out.join('');
  const inRaw = (k: number): boolean => !!raw?.some(([start, end]) => k >= start && k < end);
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (inRaw(k)) continue;
    if (c === '/' && text[k + 1] === '/') break;
    if (c === '/' && text[k + 1] === '*') {
      // A comment's quotes are no string's (cppCodeOf blanks the comment).
      const close = text.indexOf('*/', k + 2);
      if (close < 0) break;
      k = close + 1;
      continue;
    }
    if (c !== '"' && !(c === '\'' && !isWordChar(text[k - 1]))) continue;
    let end = k + 1;
    while (end < text.length && text[end] !== c) end += text[end] === '\\' ? 2 : 1;
    for (let b = k + 1; b < Math.min(end, text.length); b++) out[b] = ' ';
    k = end;
  }
  return out.join('');
}
