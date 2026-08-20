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
 * `extractQueryPaths` finds path-like spans, resolves them against the
 * INDEXED file list (resolution IS the detector — `and/or`, `gen_server:call/2`
 * and other slash-bearing non-paths match nothing and are left alone), and
 * returns the matches as pinned files plus the query with those spans removed.
 * Callers treat pinned files as first-class: guaranteed admission, top rank,
 * funded first. Pure string work — no DB, no fs — so it is trivially testable
 * and safe inside the query-pool workers.
 */

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
}

/**
 * Cheap pre-gate so callers only fetch the indexed file list when the query
 * could possibly contain a path: a slash, or a dot-extension-shaped tail
 * (`chat-manager.ts`). Extensions cap at 8 chars, which keeps `Class.method`
 * spans (`app.isPackaged`) from qualifying.
 */
export function queryMightContainPaths(query: string): boolean {
  return /[/\\]/.test(query) || /\.[A-Za-z][A-Za-z0-9]{0,7}(?=[\s,;:)\]'"`]|$)/.test(query);
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
 * Strip prose punctuation wrapped around a token without eating punctuation
 * that is PART of the path: quotes/backticks always strip; a trailing `)`/`]`
 * strips only when the token has no matching opener (so `(protected)` and
 * `[id]` segments survive, while "…(see src/foo.ts)" loses its parenthesis);
 * a leading `(`/`[` mirrors that. Trailing sentence punctuation strips last,
 * so "src/foo.ts." resolves.
 */
function stripWrapping(token: string): string {
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
  // Line references ride along in agent-written paths: `foo.ts:123`,
  // `foo.ts:12-40`, `foo.ts#L88`. The file is what gets pinned.
  s = s.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  return s;
}

/** Normalize a span into the repo-relative shape the files table stores. */
function normalizeSpan(span: string): string {
  return span
    .replace(/\\/g, '/')
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
  opts: { maxPins?: number; maxMatchesPerSpan?: number } = {},
): QueryPathExtraction {
  const maxPins = Math.max(1, opts.maxPins ?? 8);
  const maxMatchesPerSpan = Math.max(1, opts.maxMatchesPerSpan ?? 3);

  const passthrough: QueryPathExtraction = {
    strippedQuery: query,
    pinnedFiles: [],
    unresolvedPathSpans: [],
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
  let candidatesExamined = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (pinned.length >= maxPins) break;
    if (candidatesExamined >= MAX_CANDIDATE_SPANS) break;
    const stripped = stripWrapping(tokens[i]!);
    if (stripped.length < 4) continue;
    const hasSlash = /[/\\]/.test(stripped);
    if (!hasSlash && !DOTTED_BASENAME.test(stripped)) continue;

    const normalized = normalizeSpan(stripped);
    if (!normalized) continue;
    candidatesExamined++;

    const { matches, ambiguous } = resolveSpan(
      normalized.toLowerCase(), lowerToOriginal, maxMatchesPerSpan,
    );
    if (matches.length > 0) {
      consumed.add(i);
      for (const m of matches) {
        if (pinnedSeen.has(m) || pinned.length >= maxPins) continue;
        pinnedSeen.add(m);
        pinned.push(m);
      }
    } else if (ambiguous || isClearlyPathShaped(normalized)) {
      // A real path that didn't resolve to a usable set. Keeping it in the
      // query is strictly worse — its fragments are what minted the junk
      // matches this module exists to stop — so strip it and say so.
      consumed.add(i);
      if (unresolved.length < 4) unresolved.push(normalized);
    }
    // Anything else (`and/or`, `call/2`, `foo.Bar`) is not a path reference:
    // leave the token for the normal matching pipeline.
  }

  if (consumed.size === 0) return passthrough;
  return {
    strippedQuery: tokens.filter((_, i) => !consumed.has(i)).join(' '),
    pinnedFiles: pinned,
    unresolvedPathSpans: unresolved,
  };
}
