/**
 * Conditions, as a reader says them.
 *
 * A `when` arrives from the graph as code joined by our own operators: the
 * guards along a chain joined with ` && `, a negated one wrapped as `!(…)`,
 * and — on a link with several call sites — the sites' conditions joined
 * with ` || `. The code inside one guard stays code (`isUploadInProgress ||
 * elapsed < 5000` is what the source says); the joins are ours, and ours read
 * as words — WHEN, AND, OR, NOT — set in capitals and a little bolder.
 *
 * A link with several sites is several scenarios, not one long condition:
 * four early returns that each go home are four rows, and the clauses every
 * row shares — the same first guard on all four — are said once above them.
 */

/**
 * The top-level terms of `text` around `sep`, respecting brackets and
 * strings. `splitTop('a && (b || c)', ' && ')` → `['a', '(b || c)']`.
 */
export function splitTop(text: string, sep: ' && ' | ' || '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(start, i).trim());
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((c) => c.length > 0);
}

/**
 * The top-level `&&` terms of a condition, in the order they were tested —
 * the outermost guard first, the one decided at the call last. A condition
 * joined by a top-level `||` (several scenarios merged) has no single
 * innermost term and comes back whole.
 */
export function clauses(when: string): string[] {
  if (splitTop(when, ' || ').length > 1) return [when.trim()];
  return splitTop(when, ' && ');
}

/**
 * One word of a condition: a keyword we add (WHEN, AND, OR, NOT — set in
 * capitals and a little bolder, so the joins read at a glance and the code
 * between them reads as code), or a run of the code itself.
 */
export type WordToken = { kw: true; text: 'WHEN' | 'AND' | 'OR' | 'NOT' } | { kw: false; text: string };

const KW = (text: 'WHEN' | 'AND' | 'OR' | 'NOT'): WordToken => ({ kw: true, text });
const CODE = (text: string): WordToken => ({ kw: false, text });

/** `!(a || b)` → NOT `(a || b)`; `!busy` → NOT `busy`; code otherwise untouched. */
export function clauseTokens(clause: string): WordToken[] {
  const text = clause.trim();
  if (text.startsWith('!(') && closesAtEnd(text, 1)) return [KW('NOT'), CODE(text.slice(1))];
  if (/^![A-Za-z_$][\w$.?]*$/.test(text)) return [KW('NOT'), CODE(text.slice(1))];
  return [CODE(text)];
}

/** {@link clauseTokens} as one string — for a pill, which has no markup. */
export function clauseWords(clause: string): string {
  return joinTokens(clauseTokens(clause));
}

/** Tokens joined by a keyword: `a AND b AND c`. */
function joinWith(groups: readonly WordToken[][], kw: 'AND' | 'OR'): WordToken[] {
  const out: WordToken[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(KW(kw));
    out.push(...g);
  });
  return out;
}

export function joinTokens(tokens: readonly WordToken[]): string {
  return tokens.map((t) => t.text).join(' ');
}

/** Whether the bracket opened at `open` closes on the last character. */
function closesAtEnd(text: string, open: number): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

/** The same clause tested twice along a chain (two early returns with one condition) is said once. */
function distinct(list: readonly string[]): string[] {
  return list.filter((c, i) => list.indexOf(c) === i);
}

/** A whole `when` as tokens: scenarios joined by OR, each its guards joined by AND. Empty when unconditional. */
export function whenTokens(when: string): WordToken[] {
  if (!when) return [];
  return joinWith(
    splitTop(when, ' || ').map((scenario) => joinWith(distinct(splitTop(scenario, ' && ')).map(clauseTokens), 'AND')),
    'OR'
  );
}

/** {@link whenTokens} led by WHEN, or `always` when there is nothing to say. */
export function conditionTokens(when: string): WordToken[] {
  const tokens = whenTokens(when);
  return tokens.length === 0 ? [CODE('always')] : [KW('WHEN'), ...tokens];
}

/** A whole `when` as one string — for a pill, a tooltip title, a test. */
export function whenWords(when: string): string {
  return joinTokens(whenTokens(when));
}

/** The clauses every scenario shares, led by WHEN. */
export function commonTokens(common: readonly string[]): WordToken[] {
  return common.length === 0 ? [] : [KW('WHEN'), ...joinWith(common.map(clauseTokens), 'AND')];
}

export interface ScenarioRows<T> {
  /** The clauses every site shares, in chain order — said once. */
  common: string[];
  /** One row per site with what remains after the shared clauses; `rest` empty = always, given the shared ones. */
  rows: Array<{ site: T; rest: string[] }>;
}

/**
 * A link's sites as scenarios. One site: its whole condition is `common` and
 * the one row has nothing left to say. Several: the longest common prefix of
 * their clause lists is `common`, and each row keeps its own tail.
 */
export function scenarios<T extends { when: string }>(sites: readonly T[]): ScenarioRows<T> {
  const lists = sites.map((site) => ({ site, all: site.when ? distinct(clauses(site.when)) : [] }));
  if (lists.length === 0) return { common: [], rows: [] };
  let common = lists[0]!.all.slice();
  for (const { all } of lists.slice(1)) {
    let i = 0;
    while (i < common.length && i < all.length && common[i] === all[i]) i++;
    common = common.slice(0, i);
  }
  return {
    common,
    rows: lists.map(({ site, all }) => ({ site, rest: all.slice(common.length) })),
  };
}

/** The words a scenario row prints under a shared prefix: `AND x AND y` (`WHEN x` with no prefix), or `always`. */
export function restTokens(rest: readonly string[], hasCommon: boolean): WordToken[] {
  if (rest.length === 0) return [CODE('always')];
  return [KW(hasCommon ? 'AND' : 'WHEN'), ...joinWith(rest.map(clauseTokens), 'AND')];
}

export function restWords(rest: readonly string[], hasCommon: boolean): string {
  return joinTokens(restTokens(rest, hasCommon));
}
