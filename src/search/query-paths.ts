/**
 * File-path recognition for explore queries.
 *
 * Agents routinely name files by path in a `codegraph_explore` query —
 * "the scroll logic in src/routes/m/projects/[id]/runs/[runId]/+page.svelte" —
 * and until this module existed those spans were SHREDDED by the downstream
 * tokenizers instead of being read as file references:
 *
 *   - the named-symbol seeder splits on `[\s,()[\]]+`, so SvelteKit/Next
 *     bracketed segments (`[id]`, `[runId]`) and route groups (`(protected)`)
 *     exploded the path into fragments; the identifier-shaped survivors
 *     (`runId`, `scope`) then seeded as "symbols the agent named" and
 *     headlined the blast radius;
 *   - FTS saw the fragments (`page`, `chat`, `runs`) and admitted every
 *     sibling `+page.svelte` in the repo, which ate the output envelope and
 *     truncated the files the agent actually asked for.
 *
 * `extractQueryPaths` finds path-like spans — slashed paths, dotted basenames,
 * and extension-less kebab basenames (`background-image-table`, the spelling
 * import paths and prose actually use) — resolves them against the INDEXED
 * file list (resolution IS the detector — `and/or`, `gen_server:call/2`,
 * `non-blocking` and other path-shaped non-paths match nothing and are left
 * alone), and returns the matches as pinned files plus the query with those
 * spans removed.
 * Callers treat pinned files as first-class: guaranteed admission, top rank,
 * funded first. Pure string work — no DB, no fs — so it is trivially testable
 * and safe inside the query-pool workers. The one question string shape cannot
 * answer (is this dotless slashed span, `scripts/deploy`, a real file that is
 * merely unindexed, or is it prose like `and/or`?) is delegated to an OPTIONAL
 * `existsOnDisk` predicate the caller injects — the fs access stays at the call
 * site, which owns the project root, and this module stays pure.
 */

import { normalizePath } from '../utils';

export interface QueryPathExtraction {
  /** The query with resolved/clearly-path spans removed, whitespace-joined. */
  strippedQuery: string;
  /** Indexed file paths the query named, appearance-ordered, deduped. */
  pinnedFiles: string[];
  /**
   * Spans that are unambiguously path-shaped but resolved to nothing (stale
   * path, unindexed file) or to too many files (bare `+page.svelte`). Stripped
   * from the query — their fragments could only mint junk matches — and
   * surfaced to the agent so the miss is visible instead of silent.
   */
  unresolvedPathSpans: string[];
  /**
   * Line spans the query anchored to a pinned file, 1-based and inclusive:
   * `compiler.py:776`, `foo.ts:12-40`, `foo.ts#L88-L120`, or prose next to a
   * path (`compiler.py lines 900-1003`, `L900-L1003 of compiler.py`). An agent
   * writes these when it wants THOSE lines — typically the body a previous
   * response elided — so a pin that drops them answers a different question
   * (the file's most relevant clusters) than the one asked. Only a span whose
   * path resolved to exactly one file is kept: a line number means nothing
   * across two candidate files.
   */
  lineAnchors: QueryLineAnchor[];
  /**
   * Files a span matched but did NOT pin: the span named several files, some
   * of which define a symbol the query also names, and these define none.
   * Surfaced so a set-aside file is visible, not silently dropped.
   */
  setAsideMatches: QuerySetAsideMatch[];
}

export interface QuerySetAsideMatch {
  /** The span as the query wrote it, normalized (`editorOptions.ts`). */
  span: string;
  files: string[];
}

export interface QueryLineAnchor {
  file: string;
  start: number;
  end: number;
}

/**
 * Cheap pre-gate so callers only fetch the indexed file list when the query
 * could possibly contain a path: a slash, a dot-extension-shaped tail
 * (`chat-manager.ts`), or a hyphen-joined word (`background-image-table` —
 * kebab files are named WITHOUT their extension more often than with, so the
 * shape must open the gate on its own). Extensions cap at 8 chars, which
 * keeps `Class.method` spans (`app.isPackaged`) from qualifying; the kebab
 * alternative requires clean non-word boundaries, which keeps `--flags` and
 * snake_case-with-a-dash hybrids from firing it.
 */
export function queryMightContainPaths(query: string): boolean {
  return /[/\\]/.test(query)
    || /\.[A-Za-z][A-Za-z0-9]{0,7}(?=[\s,;:)\]'"`]|$)/.test(query)
    || /(?:^|[^-\w])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?=[^-\w]|$)/.test(query);
}

/**
 * Longest span→suffix walk tried per span. 8 covers an absolute macOS path
 * (`/Users/<user>/dev/<repo>/…`) over a deeply nested repo-relative file;
 * deeper prefixes buy nothing.
 */
const MAX_SUFFIX_TRIES = 8;
/** Spans examined per query — a prose sentence is not 50 paths. */
const MAX_CANDIDATE_SPANS = 8;

/** `name.ext` shape with a plausible source extension (no slash required). */
const DOTTED_BASENAME = /^[^\s/\\]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Extension-less kebab basename (`background-image-table`). Hyphens are
 * illegal in identifiers, so consuming these tokens can never steal one from
 * the named-symbol seeder; ≥2 segments keeps single words out.
 */
const KEBAB_BASENAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;

/** A basename's last dot-extension, same shape DOTTED_BASENAME accepts. */
const LAST_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * A query token that names a symbol, in the shape explore's named-symbol
 * seeder reads: `clampedInt`, `SQLCompiler.as_sql`, `Engine::ServeHTTP`.
 */
const SYMBOL_TOKEN = /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/;
/** Symbol tokens consulted per query — the seeder's cap. */
const MAX_SYMBOL_TOKENS = 16;

/**
 * The seeder's NL-stopword test: camelCase, PascalCase, snake_case, `$` and
 * qualified tokens are unmistakably code. A bare lowercase word (`options`,
 * `render`) is also English, and a file defining one proves nothing about
 * which same-named file the agent meant.
 */
function isPreciseSymbolToken(t: string): boolean {
  return /[._$]|::/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z]/.test(t);
}

/**
 * The precise symbol tokens a query names, excluding the files it names
 * (`editorOptions.ts` is identifier-shaped too). Split on the same brackets
 * the seeder splits on, so `clampedInt()` still counts.
 */
function querySymbolTokens(tokens: readonly string[], indexedBasenames: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const raw of tokens) {
    for (const part of raw.split(/[,()[\]{}]+/)) {
      const t = part.replace(/^['"`<]+/, '').replace(/['"`>.,;:!?]+$/, '');
      if (t.length < 3 || !SYMBOL_TOKEN.test(t) || !isPreciseSymbolToken(t)) continue;
      if (indexedBasenames.has(t.toLowerCase())) continue;
      out.add(t);
      if (out.size >= MAX_SYMBOL_TOKENS) return [...out];
    }
  }
  return [...out];
}

/**
 * Lowercased basename stems of the hyphen-named indexed files, stem → paths.
 * A stem drops only the LAST extension (`a-b.module.scss` → `a-b.module`), so
 * a bare kebab token can't accidentally pin a same-named stylesheet or
 * `.d.ts` sibling of the source file it names; an extension-less basename
 * (`pre-commit`) is its own stem. Hyphen-free basenames are skipped — a
 * KEBAB_BASENAME token can never equal one, and the filter keeps the map
 * near-empty in repos that don't name files this way.
 */
function buildBasenameStems(indexedPaths: readonly string[]): Map<string, string[]> {
  const stems = new Map<string, string[]>();
  for (const p of indexedPaths) {
    const normalized = normalizePath(p);
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (!basename.includes('-')) continue;
    const stem = basename.replace(LAST_EXTENSION, '').toLowerCase();
    if (!stem) continue;
    const existing = stems.get(stem);
    if (existing) existing.push(p);
    else stems.set(stem, [p]);
  }
  return stems;
}

/**
 * Line references that ride along in agent-written paths: `foo.ts:123`,
 * `foo.ts:12-40`, `foo.ts#L88`, `foo.ts#L88-L120`.
 */
const LINE_REF_SUFFIX = /(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;

/**
 * A standalone line-number token: `900`, `900-1003`, `900–1003`, `900..1003`,
 * `L900`, `L900-L1003`. The `L` form is unambiguous on its own; a bare number
 * only counts after a `line`/`lines` word or directly after a path.
 */
const LINE_NUMBER_TOKEN = /^(L?)(\d+)(?:(?:-|–|\.\.)L?(\d+))?$/;
const LINE_WORD = /^lines?$/i;
/** `lines 900 to 1003` — the connective between two bare numbers. */
const RANGE_CONNECTIVE = /^(?:to|through|thru)$/i;
/** Nothing real is this long; a larger number is a port, an id, a year typo. */
const MAX_LINE_NUMBER = 1_000_000;

function lineSpan(a: string | undefined, b: string | undefined): { start: number; end: number } | null {
  const start = Number(a);
  const end = b === undefined ? start : Number(b);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) return null;
  if (start > MAX_LINE_NUMBER || end > MAX_LINE_NUMBER) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Prose punctuation a line-number token can carry: "lines 900-1003," / "(L88)". */
function stripLineTokenPunctuation(token: string): string {
  return token.replace(/^[('"`[]+/, '').replace(/[)'"`\].,;:!?]+$/, '');
}

/**
 * Strip prose punctuation wrapped around a token without eating punctuation
 * that is PART of the path: quotes/backticks always strip; a trailing `)`/`]`
 * strips only when the token has no matching opener (so `(protected)` and
 * `[id]` segments survive, while "…(see src/foo.ts)" loses its parenthesis);
 * a leading `(`/`[` mirrors that. Trailing sentence punctuation strips last,
 * so "src/foo.ts." resolves. A trailing line reference is split off and
 * returned separately — the file is what resolves, the lines are what the
 * agent wants from it.
 */
function stripWrapping(token: string): { path: string; lines: { start: number; end: number } | null } {
  let s = token;
  for (;;) {
    const first = s[0];
    if (!first) break;
    if ('\'"`<'.includes(first)) { s = s.slice(1); continue; }
    if (first === '(' && !s.includes(')')) { s = s.slice(1); continue; }
    if (first === '[' && !s.includes(']')) { s = s.slice(1); continue; }
    if (first === '{' && !s.includes('}')) { s = s.slice(1); continue; }
    break;
  }
  for (;;) {
    const last = s[s.length - 1];
    if (!last) break;
    if ('\'"`>.,;!?'.includes(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && !s.includes('(')) { s = s.slice(0, -1); continue; }
    if (last === ']' && !s.includes('[')) { s = s.slice(0, -1); continue; }
    if (last === '}' && !s.includes('{')) { s = s.slice(0, -1); continue; }
    break;
  }
  const ref = LINE_REF_SUFFIX.exec(s);
  if (!ref) return { path: s, lines: null };
  return {
    path: s.slice(0, ref.index),
    lines: ref[1] !== undefined ? lineSpan(ref[1], ref[2]) : lineSpan(ref[3], ref[4]),
  };
}

/** Normalize a span into the repo-relative shape the files table stores. */
function normalizeSpan(span: string): string {
  return normalizePath(span)
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/** Path-shaped beyond doubt: ≥2 segments and a dot-extension on the last. */
function isClearlyPathShaped(normalized: string): boolean {
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return false;
  return DOTTED_BASENAME.test(normalized.slice(slash + 1));
}

/**
 * Resolve one normalized span against the indexed paths: exact match first,
 * then segment-aligned suffix matches, dropping leading segments one at a
 * time (so an absolute path, or one prefixed with the repo directory name,
 * still lands on the indexed repo-relative file). Suffixes only get shorter —
 * and therefore only match MORE — so the walk stops at the first suffix that
 * matches anything: within budget it resolves, over budget it is ambiguous.
 */
function resolveSpan(
  normalizedLower: string,
  lowerToOriginal: ReadonlyMap<string, string>,
  maxMatches: number,
): { matches: string[]; ambiguous: boolean } {
  const exact = lowerToOriginal.get(normalizedLower);
  if (exact) return { matches: [exact], ambiguous: false };

  const segments = normalizedLower.split('/').filter(Boolean);
  const tries = Math.min(segments.length, MAX_SUFFIX_TRIES);
  for (let drop = 0; drop < tries; drop++) {
    const suffix = segments.slice(drop).join('/');
    if (!suffix) break;
    const withSlash = '/' + suffix;
    const matches: string[] = [];
    for (const [lower, original] of lowerToOriginal) {
      if (lower === suffix || lower.endsWith(withSlash)) {
        matches.push(original);
        if (matches.length > maxMatches) return { matches: [], ambiguous: true };
      }
    }
    if (matches.length > 0) return { matches, ambiguous: false };
  }
  return { matches: [], ambiguous: false };
}

export function extractQueryPaths(
  query: string,
  indexedPaths: readonly string[],
  opts: {
    maxPins?: number;
    maxMatchesPerSpan?: number;
    /**
     * Does this repo-relative span name a real FILE in the project? Optional,
     * injected by the caller (see the module docstring): it is the only way to
     * tell a dotless path the index simply doesn't hold (`scripts/deploy`)
     * from slashed prose (`and/or`), and it must stay out of this module.
     * Must not throw — the caller absorbs fs errors and returns false.
     */
    existsOnDisk?: (relPath: string) => boolean;
    /**
     * Which indexed files define a symbol spelled like this query token
     * (`clampedInt`, `SQLCompiler.as_sql`)? Optional, injected by the caller
     * for the same reason as `existsOnDisk`: the answer lives in the index,
     * and this module stays DB-free. Consulted only when a span matches
     * several files (a basename two directories share): the matches that
     * define a symbol the query also names are pinned, the rest set aside.
     * Must not throw — the caller absorbs lookup errors and returns nothing.
     */
    symbolFiles?: (symbol: string) => Iterable<string>;
  } = {},
): QueryPathExtraction {
  const maxPins = Math.max(1, opts.maxPins ?? 8);
  const maxMatchesPerSpan = Math.max(1, opts.maxMatchesPerSpan ?? 3);

  const passthrough: QueryPathExtraction = {
    strippedQuery: query,
    pinnedFiles: [],
    unresolvedPathSpans: [],
    lineAnchors: [],
    setAsideMatches: [],
  };
  if (!query.trim() || indexedPaths.length === 0) return passthrough;

  // Lowercase view of the index, built once per call. Last writer wins on a
  // case-colliding pair, which is the existing file-view behavior too.
  const lowerToOriginal = new Map<string, string>();
  for (const p of indexedPaths) lowerToOriginal.set(p.toLowerCase(), p);

  const tokens = query.split(/\s+/).filter(Boolean);
  const consumed = new Set<number>();
  const pinned: string[] = [];
  const pinnedSeen = new Set<string>();
  const unresolved: string[] = [];
  const anchors: QueryLineAnchor[] = [];
  const setAside: QuerySetAsideMatch[] = [];
  /** Token index → the ONE file it pinned, for binding prose line ranges. */
  const singleFileAt = new Map<number, string>();
  let candidatesExamined = 0;

  // A bare basename two directories share (`editorOptions.ts` is both vscode's
  // editor option registry and a workbench helper) used to pin EVERY match,
  // and the matches split the pinned reservation — so a query that also named
  // three functions in one of them got half the room for them it would have
  // got without the path. When the query names symbols, the file it means is
  // the one defining them: keep the matches that define at least one, set the
  // rest aside. When no match defines one, or every match does, the symbols
  // pick nothing out and the span resolves exactly as before.
  //
  // The same test lets a basename shared by more files than the ambiguity
  // budget (django's 40 `models.py`) resolve after all — to the one defining
  // the named class — so a span is collected past the budget only while
  // narrowing is possible, and still reports as ambiguous if it doesn't
  // narrow into the budget.
  let symbolTokens: string[] | null = null;
  const definersOf = new Map<string, ReadonlySet<string>>();
  const narrowBySymbols = (matches: readonly string[]): string[] | null => {
    if (!opts.symbolFiles || matches.length < 2) return null;
    if (symbolTokens === null) {
      const basenames = new Set<string>();
      for (const p of indexedPaths) {
        basenames.add(p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase());
      }
      symbolTokens = querySymbolTokens(tokens, basenames);
    }
    const candidates = new Set(matches);
    const definers = new Set<string>();
    for (const t of symbolTokens) {
      let files = definersOf.get(t);
      if (!files) {
        files = new Set(opts.symbolFiles(t));
        definersOf.set(t, files);
      }
      for (const f of files) if (candidates.has(f)) definers.add(f);
    }
    if (definers.size === 0 || definers.size === candidates.size) return null;
    return matches.filter((m) => definers.has(m));
  };
  /** Narrow a span's matches, recording what was set aside; null = over budget. */
  const pinnableMatches = (span: string, matches: string[]): string[] | null => {
    const narrowed = matches.length > 1 ? narrowBySymbols(matches) : null;
    if (narrowed && narrowed.length <= maxMatchesPerSpan) {
      setAside.push({ span, files: matches.filter((m) => !narrowed.includes(m)) });
      return narrowed;
    }
    return matches.length > maxMatchesPerSpan ? null : matches;
  };
  const collectLimit = opts.symbolFiles ? Number.POSITIVE_INFINITY : maxMatchesPerSpan;

  for (let i = 0; i < tokens.length; i++) {
    if (pinned.length >= maxPins) break;
    if (candidatesExamined >= MAX_CANDIDATE_SPANS) break;
    const { path: stripped, lines } = stripWrapping(tokens[i]!);
    if (stripped.length < 4) continue;
    const hasSlash = /[/\\]/.test(stripped);
    if (!hasSlash && !DOTTED_BASENAME.test(stripped)) continue;

    const normalized = normalizeSpan(stripped);
    if (!normalized) continue;
    candidatesExamined++;

    const resolved = resolveSpan(normalized.toLowerCase(), lowerToOriginal, collectLimit);
    const pinnable = resolved.matches.length > 0 ? pinnableMatches(normalized, resolved.matches) : null;
    const matches = pinnable ?? [];
    const ambiguous = resolved.ambiguous || (resolved.matches.length > 0 && pinnable === null);
    if (matches.length > 0) {
      consumed.add(i);
      for (const m of matches) {
        if (pinnedSeen.has(m) || pinned.length >= maxPins) continue;
        pinnedSeen.add(m);
        pinned.push(m);
      }
      if (matches.length === 1 && pinnedSeen.has(matches[0]!)) {
        singleFileAt.set(i, matches[0]!);
        if (lines) anchors.push({ file: matches[0]!, ...lines });
      }
    } else if (
      ambiguous
      || isClearlyPathShaped(normalized)
      || (normalized.includes('/') && opts.existsOnDisk?.(normalized) === true)
    ) {
      // A real path that didn't resolve to a usable set. Keeping it in the
      // query is strictly worse — its fragments are what minted the junk
      // matches this module exists to stop — so strip it and say so.
      // The third arm covers the DOTLESS slashed span (`scripts/deploy`,
      // `bin/build`): shape alone cannot tell it from `and/or` or
      // `input/output`, so the file's existence on disk decides. Loosening the
      // SHAPE test instead would strip that prose out of every query and mint a
      // false "no indexed file matches `and/or`" caveat.
      consumed.add(i);
      if (unresolved.length < 4) unresolved.push(normalized);
    }
    // Anything else (`and/or`, `call/2`, `foo.Bar`) is not a path reference:
    // leave the token for the normal matching pipeline.
  }

  // Second pass — extension-less kebab basenames. `background-image-table`
  // opens no door above (no slash, no dotted tail), the hyphens disqualify it
  // from the named-symbol seeder downstream, and FTS shreds it into the most
  // common words in a kebab-cased repo (`background`, `image`, `table`) —
  // which admit look-alike SIBLINGS that crowd out the named file. Resolution
  // stays the detector: a token pins only when its whole lowercased form is
  // the stem of an indexed basename. Two deliberate asymmetries vs the first
  // pass: prose that resolves to nothing (`non-blocking`, `cross-call`) is
  // LEFT IN the query — unlike a slashed span it may be legitimate wording,
  // so it keeps feeding FTS and is not reported as an unresolved path — and a
  // stem hotter than maxMatchesPerSpan is likewise left alone (pinning half a
  // monorepo off one hot name trades precision the wrong way; a directory
  // segment, which the first pass handles, disambiguates). Runs after the
  // slashed/dotted pass so explicit paths win the shared maxPins budget, and
  // examines every remaining token: lookups are O(1) map hits, so the
  // scan-cost rationale behind MAX_CANDIDATE_SPANS doesn't apply.
  let basenameStems: Map<string, string[]> | null = null;
  for (let i = 0; i < tokens.length && pinned.length < maxPins; i++) {
    if (consumed.has(i)) continue;
    const { path: stripped, lines } = stripWrapping(tokens[i]!);
    if (stripped.length < 4 || !KEBAB_BASENAME.test(stripped)) continue;
    basenameStems ??= buildBasenameStems(indexedPaths);
    const stemMatches = basenameStems.get(stripped.toLowerCase());
    const matches = stemMatches ? pinnableMatches(stripped, stemMatches) : null;
    if (!matches) continue;
    consumed.add(i);
    for (const m of matches) {
      if (pinnedSeen.has(m) || pinned.length >= maxPins) continue;
      pinnedSeen.add(m);
      pinned.push(m);
    }
    if (matches.length === 1 && pinnedSeen.has(matches[0]!)) {
      singleFileAt.set(i, matches[0]!);
      if (lines) anchors.push({ file: matches[0]!, ...lines });
    }
  }

  // Third pass — prose line ranges (`lines 900-1003`, `line 42`, `L88-L120`,
  // `lines 900 to 1003`) bound to the NEAREST single-file path token. These
  // are what an agent writes when a previous response elided a body and it
  // asks for the rest; left in the query, the numbers match nothing and
  // `lines` feeds FTS a word every file contains. A range with no path to
  // bind to says nothing about which file, so it is left alone.
  if (singleFileAt.size > 0) {
    const pathIdx = [...singleFileAt.keys()];
    const nearestFile = (i: number): string => {
      let best = pathIdx[0]!;
      for (const p of pathIdx) if (Math.abs(p - i) < Math.abs(best - i)) best = p;
      return singleFileAt.get(best)!;
    };
    for (let i = 0; i < tokens.length; i++) {
      if (consumed.has(i)) continue;
      const tok = stripLineTokenPunctuation(tokens[i]!);
      const afterWord = i > 0 && !consumed.has(i - 1) && LINE_WORD.test(stripLineTokenPunctuation(tokens[i - 1]!));
      const afterPath = singleFileAt.has(i - 1);
      const m = LINE_NUMBER_TOKEN.exec(tok);
      if (!m) continue;
      // A bare number is a line number only in a line context; `L900` is one
      // on its own.
      if (!m[1] && !afterWord && !afterPath) continue;
      let span = lineSpan(m[2], m[3]);
      const used = [i];
      // `lines 900 to 1003`
      if (span && m[3] === undefined && i + 2 < tokens.length
          && RANGE_CONNECTIVE.test(stripLineTokenPunctuation(tokens[i + 1]!))) {
        const tail = LINE_NUMBER_TOKEN.exec(stripLineTokenPunctuation(tokens[i + 2]!));
        if (tail && tail[3] === undefined) {
          span = lineSpan(m[2], tail[2]);
          used.push(i + 1, i + 2);
        }
      }
      if (!span) continue;
      anchors.push({ file: nearestFile(i), ...span });
      for (const u of used) consumed.add(u);
      if (afterWord) consumed.add(i - 1);
    }
  }

  if (consumed.size === 0) return passthrough;
  const seenAnchor = new Set<string>();
  return {
    strippedQuery: tokens.filter((_, i) => !consumed.has(i)).join(' '),
    pinnedFiles: pinned,
    unresolvedPathSpans: unresolved,
    lineAnchors: anchors.filter((a) => {
      const key = `${a.file}:${a.start}-${a.end}`;
      if (seenAnchor.has(key)) return false;
      seenAnchor.add(key);
      return true;
    }),
    // A file another span pinned outright (the agent also wrote its full path)
    // was not set aside after all.
    setAsideMatches: setAside
      .map((s) => ({ span: s.span, files: s.files.filter((f) => !pinnedSeen.has(f)) }))
      .filter((s) => s.files.length > 0),
  };
}
