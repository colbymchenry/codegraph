/**
 * An in-memory answer to the substring lookup `codegraph_explore` runs for
 * every word of its query (#2620):
 *
 *   SELECT … FROM nodes WHERE name LIKE '%word%' [AND name NOT LIKE 'word%']
 *     AND kind IN (…) ORDER BY length(name) LIMIT n
 *
 * A leading `%` can't use an index, so SQLite reads every node of those kinds
 * for each call: about 80 ms on a 560k-node index, four calls a word, and a
 * pasted log or document has hundreds of words. This index reads the names
 * once and answers each call with one string search.
 *
 * It returns exactly what SQLite would. LIKE folds case for ASCII letters only,
 * `_` matches any one character, and `length()` counts characters, not UTF-16
 * units, so all three are done that way here. SQLite leaves rows of equal
 * length in the order its plan read them: through `idx_nodes_kind` (kind,
 * file_path, start_line, id) on a large index, by rowid when it scans a small
 * one. The index keeps both orders, and the caller says which plan SQLite
 * chose. A pattern with a `%` is left to SQLite.
 */

/**
 * The kinds the index holds: the definitions and callables explore's
 * camel-case and compound steps ask about, and the variables and constants its
 * named-symbol seeding adds.
 */
export const NAME_SUBSTRING_KINDS: readonly string[] = [
  'class', 'component', 'constant', 'enum', 'function', 'interface', 'method',
  'protocol', 'struct', 'trait', 'type_alias', 'union', 'variable',
];

/** Separates the names in {@link NameSubstringIndex.hay}; no name may contain it. */
const SEPARATOR = '\u0000';

export interface NameSubstringIndex {
  /** Kind codes: `kinds[entryKind[e]]` is entry `e`'s kind. */
  readonly kinds: readonly string[];
  /** Every distinct ASCII-lowercased name, each followed by {@link SEPARATOR}. */
  readonly hay: string;
  /** Where each distinct name starts in `hay`, plus one past the end. */
  readonly starts: Int32Array;
  /** The entries of distinct name `i` are `nameEntries[nameEntryStart[i] … nameEntryStart[i+1])`, ascending. */
  readonly nameEntryStart: Int32Array;
  readonly nameEntries: Int32Array;
  /** Per entry, in index order. */
  readonly entryRowid: Float64Array;
  readonly entryKind: Uint8Array;
  readonly entryLength: Int32Array;
}

/** Lowercase ASCII letters only, as SQLite's LIKE compares them. */
function asciiLower(text: string): string {
  return /[A-Z]/.test(text) ? text.replace(/[A-Z]+/g, (run) => run.toLowerCase()) : text;
}

/** `length(text)` as SQLite counts it: characters, so a surrogate pair is one. */
function sqliteLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { length--; i++; }
    }
  }
  return length;
}

/**
 * Build the index from rows of {@link NAME_SUBSTRING_KINDS} read in
 * `idx_nodes_kind` order, which becomes the entries' order. Returns null when
 * a name holds the separator, so the caller keeps asking SQLite.
 */
export function buildNameSubstringIndex(
  rows: Iterable<{ rowid: number; kind: string; name: string }>,
): NameSubstringIndex | null {
  const kindCodes = new Map(NAME_SUBSTRING_KINDS.map((kind, i) => [kind, i]));
  const nameIds = new Map<string, number>();
  const names: string[] = [];
  const rowids: number[] = [];
  const kinds: number[] = [];
  const lengths: number[] = [];
  const nameOf: number[] = [];
  for (const row of rows) {
    const code = kindCodes.get(row.kind);
    if (code === undefined) continue;
    const lowered = asciiLower(row.name);
    if (lowered.includes(SEPARATOR)) return null;
    let id = nameIds.get(lowered);
    if (id === undefined) {
      id = names.length;
      nameIds.set(lowered, id);
      names.push(lowered);
    }
    rowids.push(row.rowid);
    kinds.push(code);
    lengths.push(sqliteLength(row.name));
    nameOf.push(id);
  }

  const starts = new Int32Array(names.length + 1);
  let offset = 0;
  for (let i = 0; i < names.length; i++) {
    starts[i] = offset;
    offset += names[i]!.length + SEPARATOR.length;
  }
  starts[names.length] = offset;

  // Group entries by name, keeping index order inside each group.
  const nameEntryStart = new Int32Array(names.length + 1);
  for (const id of nameOf) nameEntryStart[id + 1]!++;
  for (let i = 0; i < names.length; i++) nameEntryStart[i + 1]! += nameEntryStart[i]!;
  const fill = nameEntryStart.slice(0, names.length);
  const nameEntries = new Int32Array(nameOf.length);
  for (let entry = 0; entry < nameOf.length; entry++) nameEntries[fill[nameOf[entry]!]!++] = entry;

  return {
    kinds: NAME_SUBSTRING_KINDS,
    hay: names.join(SEPARATOR) + SEPARATOR,
    starts,
    nameEntryStart,
    nameEntries,
    entryRowid: Float64Array.from(rowids),
    entryKind: Uint8Array.from(kinds),
    entryLength: Int32Array.from(lengths),
  };
}

/** The distinct name whose span in `hay` holds `offset`. */
function nameAt(starts: Int32Array, offset: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * A matcher for a LIKE pattern without `%`: where the next match at or after
 * `from` starts, and whether one starts exactly at `at`. Without `_` this is a
 * plain string search; each `_` matches any one character but the separator.
 */
function patternMatcher(needle: string): { next(hay: string, from: number): number; startsAt(hay: string, at: number): boolean } {
  if (!needle.includes('_')) {
    return {
      next: (hay, from) => hay.indexOf(needle, from),
      startsAt: (hay, at) => hay.startsWith(needle, at),
    };
  }
  // `u`, so a wildcard takes a whole character, as SQLite's `_` does.
  const source = needle
    .split('_')
    .map((part) => part.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&'))
    .join('[^\\u0000]');
  const anywhere = new RegExp(source, 'gu');
  const anchored = new RegExp(source, 'uy');
  return {
    next(hay, from) {
      anywhere.lastIndex = from;
      const match = anywhere.exec(hay);
      return match ? match.index : -1;
    },
    startsAt(hay, at) {
      anchored.lastIndex = at;
      return anchored.test(hay);
    },
  };
}

/**
 * The order SQLite's plan reads candidate rows in, which its ORDER BY keeps
 * for rows of equal length: the kind index's, or the table's by rowid.
 */
export type ScanOrder = 'index' | 'rowid';

/**
 * The rowids SQLite's substring lookup returns, in its order, or null when the
 * index can't answer exactly (a `%` in the pattern, an empty pattern, or a
 * kind it doesn't hold). `order` is the order the plan reads rows in.
 */
export function searchNameSubstring(
  index: NameSubstringIndex,
  substring: string,
  kinds: readonly string[],
  excludePrefix: boolean,
  limit: number,
  order: ScanOrder,
): number[] | null {
  const needle = asciiLower(substring);
  if (needle.length === 0 || needle.includes('%') || needle.includes(SEPARATOR)) return null;
  const wanted = new Uint8Array(index.kinds.length);
  for (const kind of kinds) {
    const code = index.kinds.indexOf(kind);
    if (code < 0) return null;
    wanted[code] = 1;
  }

  const { hay, starts, nameEntryStart, nameEntries, entryKind, entryLength } = index;
  const matcher = patternMatcher(needle);
  const hits: number[] = [];
  for (let at = matcher.next(hay, 0); at >= 0; ) {
    const name = nameAt(starts, at);
    if (!(excludePrefix && matcher.startsAt(hay, starts[name]!))) {
      for (let k = nameEntryStart[name]!; k < nameEntryStart[name + 1]!; k++) {
        const entry = nameEntries[k]!;
        if (wanted[entryKind[entry]!]) hits.push(entry);
      }
    }
    at = matcher.next(hay, starts[name + 1]!);
  }
  // Entry numbers follow the kind index, rowids the table: either breaks
  // length ties the way SQLite's plan does.
  const rowid = index.entryRowid;
  hits.sort(order === 'index'
    ? (a, b) => (entryLength[a]! - entryLength[b]!) || (a - b)
    : (a, b) => (entryLength[a]! - entryLength[b]!) || (rowid[a]! - rowid[b]!));
  // A negative LIMIT is no limit in SQLite.
  if (limit >= 0 && hits.length > limit) hits.length = limit;
  return hits.map((entry) => index.entryRowid[entry]!);
}
