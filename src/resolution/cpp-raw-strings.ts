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

/** Is this UTF-16 code unit a letter, digit, `_` or `$`? (NaN, past either end of a string, is not.) */
const isWordCode = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36;

const SLASH = 47;
const STAR = 42;
const QUOTE = 34;
const APOSTROPHE = 39;
const BACKSLASH = 92;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const CAPITAL_R = 82;

/** The `\r`s of `text` in [from, to), which a column doesn't count. */
function carriageReturnsIn(text: string, from: number, to: number): number {
  let count = 0;
  for (let k = from; k < to; k++) if (text.charCodeAt(k) === CARRIAGE_RETURN) count++;
  return count;
}

/** Where a string or character literal opened at `open` ends: past its closing quote, or at the end of the line. */
function literalEnd(text: string, open: number, quote: number): number {
  const n = text.length;
  let k = open + 1;
  for (; k < n; k++) {
    const c = text.charCodeAt(k);
    if (c === quote || c === NEWLINE) break;
    if (c === BACKSLASH) k++;
  }
  return Math.min(n, text.charCodeAt(k) === quote ? k + 1 : k);
}

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
    const n = text.length;
    const hasCarriageReturns = text.includes('\r');
    // The line holding offset `i`, reached only when something on it is marked.
    let line = 1;
    let lineStart = 0;
    const seek = (to: number): void => {
      for (let nl = text.indexOf('\n', lineStart); nl >= 0 && nl < to; nl = text.indexOf('\n', lineStart)) {
        line++;
        lineStart = nl + 1;
      }
    };
    // Mark [from, to) of the text, which may span lines, as raw string contents.
    const mark = (from: number, to: number): void => {
      seek(from);
      let l = line;
      let start = from - lineStart - (hasCarriageReturns ? carriageReturnsIn(text, lineStart, from) : 0);
      for (let k = from; ;) {
        const nl = text.indexOf('\n', k);
        const end = nl < 0 || nl >= to ? to : nl;
        const width = end - k - (hasCarriageReturns ? carriageReturnsIn(text, k, end) : 0);
        if (width > 0) (lines.get(l) ?? lines.set(l, []).get(l)!).push([start, start + width]);
        if (end === to) break;
        k = end + 1;
        l++;
        start = 0;
      }
    };
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === SLASH) {
        const next = text.charCodeAt(i + 1);
        if (next === SLASH) {
          const end = text.indexOf('\n', i);
          i = end < 0 ? n : end;
        } else if (next === STAR) {
          const end = text.indexOf('*/', i + 2);
          const to = end < 0 ? n : end + 2;
          mark(i, to);
          i = to;
        } else i++;
      } else if (c === QUOTE) {
        // `R"`, `u8R"`, `uR"`, `UR"`, `LR"`, not part of a longer name.
        const prefix = text.charCodeAt(i - 1) === CAPITAL_R ? /(?:u8|[uUL])?R$/.exec(text.slice(Math.max(0, i - 3), i)) : null;
        const open = prefix && !isWordCode(text.charCodeAt(i - prefix[0].length - 1)) ? text.indexOf('(', i + 1) : -1;
        const delimiter = open > i ? text.slice(i + 1, open) : null;
        if (delimiter !== null && delimiter.length <= 16 && /^[^\s()\\]*$/.test(delimiter)) {
          // From the opening quote through the closing one: `"cc( … )cc"`.
          const close = text.indexOf(`)${delimiter}"`, open + 1);
          const end = close < 0 ? n : close + delimiter.length + 2;
          mark(i, end);
          i = end;
        } else i = literalEnd(text, i, QUOTE); // An ordinary string, to its closing quote or the end of the line.
      } else if (c === APOSTROPHE && !isWordCode(text.charCodeAt(i - 1))) {
        // A character literal (`'"'`); after a digit it is a digit separator (`1'000`).
        i = literalEnd(text, i, APOSTROPHE);
      } else i++;
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
  const hasQuotes = text.includes('"') || text.includes('\'');
  if (!raw && !hasQuotes) return text;
  const blanks: Ranges = raw ? raw.slice() : [];
  if (hasQuotes) {
    const inRaw = (k: number): boolean => !!raw?.some(([start, end]) => k >= start && k < end);
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (c !== SLASH && c !== QUOTE && c !== APOSTROPHE) continue;
      if (inRaw(k)) continue;
      if (c === SLASH) {
        const next = text.charCodeAt(k + 1);
        if (next === SLASH) break;
        if (next !== STAR) continue;
        // A comment's quotes are no string's (cppCodeOf blanks the comment).
        const close = text.indexOf('*/', k + 2);
        if (close < 0) break;
        k = close + 1;
        continue;
      }
      if (c === APOSTROPHE && isWordCode(text.charCodeAt(k - 1))) continue;
      let end = k + 1;
      while (end < text.length && text.charCodeAt(end) !== c) end += text.charCodeAt(end) === BACKSLASH ? 2 : 1;
      blanks.push([k + 1, Math.min(end, text.length)]);
      k = end;
    }
  }
  return blankRanges(text, blanks);
}

/** `text` with spaces over each of `ranges`, which may overlap and may run past its end. */
function blankRanges(text: string, ranges: Ranges): string {
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(start, at);
    const to = Math.min(end, text.length);
    if (from >= to) continue;
    out += text.slice(at, from) + ' '.repeat(to - from);
    at = to;
  }
  return out + text.slice(at);
}
