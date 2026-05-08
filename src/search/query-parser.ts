/**
 * Field-qualified search query parser.
 *
 * Splits a raw query like
 *
 *     kind:function name:auth path:src/api authenticate
 *
 * into structured filters (kind=function, name="auth", path prefix
 * "src/api") plus the free-text portion ("authenticate") that goes
 * to FTS. Free-text and filters compose: filters narrow the result
 * set, FTS scores within the narrowed set.
 *
 * Recognised fields (case-insensitive, value is the rest until
 * whitespace):
 *
 *   kind:    one of function|method|class|interface|struct|...
 *   lang:    one of typescript|python|go|...   (alias: language:)
 *   path:    case-insensitive substring of file_path
 *   name:    case-insensitive substring of the symbol's name
 *
 * Unknown field prefixes (e.g. `foo:bar`) are passed through to FTS
 * as plain text — that's how someone searching for `TODO:` gets a
 * result instead of a parse error.
 *
 * Quoting:
 *   kind:function path:"src/some path/with spaces" → handled by stripping
 *   the surrounding double quotes from the value (single token only,
 *   no nested escapes).
 */

import { NODE_KINDS, LANGUAGES } from '../types';
import type { NodeKind, Language } from '../types';

export interface ParsedQuery {
  /** Free-text portion to feed to FTS / LIKE. May be empty. */
  text: string;
  /** kind: filters (OR'd). Empty when none specified. */
  kinds: NodeKind[];
  /** lang:/language: filters (OR'd). Empty when none specified. */
  languages: Language[];
  /** path: filters (OR'd, case-insensitive substring of file_path). Empty when none. */
  pathFilters: string[];
  /** name: filters (OR'd, case-insensitive substring of node.name). */
  nameFilters: string[];
}

// Derived from the canonical `NODE_KINDS` / `LANGUAGES` arrays in
// types.ts so adding a new kind or language doesn't silently fall
// through to plain text here.
const KIND_VALUES: ReadonlySet<string> = new Set<NodeKind>(NODE_KINDS);
const LANGUAGE_VALUES: ReadonlySet<string> = new Set<Language>(LANGUAGES);

/**
 * Strip a surrounding pair of double quotes from `s`. Allows users to
 * keep whitespace in path filters: `path:"my dir/file"`.
 */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * Parse a raw query into structured filters + remaining text.
 * Always returns a value; never throws.
 */
export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    kinds: [],
    languages: [],
    pathFilters: [],
    nameFilters: [],
  };

  // Tokenise on whitespace, preserving quoted spans as part of the
  // current token. Quotes can appear at the start (`"…"`) OR mid-token
  // (`path:"…"`); in both cases everything from the opening `"` to the
  // matching `"` is included in the token, whitespace and all.
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    while (i < raw.length && !/\s/.test(raw[i]!)) {
      if (raw[i] === '"') {
        const end = raw.indexOf('"', i + 1);
        if (end === -1) {
          // Unterminated quote — swallow the rest of the input as
          // one token. Forgiving rather than throwing.
          i = raw.length;
          break;
        }
        i = end + 1;
        continue;
      }
      i++;
    }
    tokens.push(raw.slice(start, i));
  }

  const textParts: string[] = [];
  for (const tok of tokens) {
    const colon = tok.indexOf(':');
    if (colon <= 0 || colon === tok.length - 1) {
      textParts.push(tok);
      continue;
    }
    const key = tok.slice(0, colon).toLowerCase();
    const valueRaw = unquote(tok.slice(colon + 1));
    if (!valueRaw) {
      textParts.push(tok);
      continue;
    }
    switch (key) {
      case 'kind': {
        if (KIND_VALUES.has(valueRaw)) {
          out.kinds.push(valueRaw as NodeKind);
        } else {
          textParts.push(tok);
        }
        break;
      }
      case 'lang':
      case 'language': {
        const lower = valueRaw.toLowerCase();
        if (LANGUAGE_VALUES.has(lower)) {
          out.languages.push(lower as Language);
        } else {
          textParts.push(tok);
        }
        break;
      }
      case 'path':
        out.pathFilters.push(valueRaw);
        break;
      case 'name':
        out.nameFilters.push(valueRaw);
        break;
      default:
        textParts.push(tok);
    }
  }

  out.text = textParts.join(' ').trim();
  return out;
}

/**
 * Damerau-Levenshtein-ish bounded edit distance. Returns `maxDist + 1`
 * as soon as the distance is known to exceed `maxDist`; that early-exit
 * makes the fuzzy fallback cheap even over tens of thousands of names.
 *
 * Pure DP, O(min(len(a), len(b))) memory. Compares case-folded inputs;
 * callers should pass `lowercase(name)` strings.
 */
export function boundedEditDistance(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const insertion = cur[j - 1]! + 1;
      const deletion = prev[j]! + 1;
      const substitution = prev[j - 1]! + cost;
      cur[j] = Math.min(insertion, deletion, substitution);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[bl]!;
}
