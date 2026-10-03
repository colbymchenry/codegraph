/**
 * GET /api/search 在数据库中先应用过滤并限制候选数量，再合并有界全文搜索结果。
 * 按名称匹配等级排序，保留符号分组；候选池耗尽时明确标记总数不完整。
 */

import type { CodeGraph } from '../../index';
import type { Node, NodeKind } from '../../types';
import { parseQuery, type ParsedQuery } from '../../search/query-parser';
import { intParam, optionalTextParam } from './respond';
import { toNodeRef, wireList, type WireNodeRef } from './wire';

/** How a result's text matched the query. Also the primary sort key. */
export type MatchKind = 'exact' | 'prefix' | 'substring' | 'qualified' | 'file' | 'related';

const MATCH_RANK: Record<MatchKind, number> = {
  exact: 0,
  prefix: 1,
  substring: 2,
  qualified: 3,
  file: 4,
  // Matched by FTS through a signature, docstring or fuzzy neighbour — real,
  // but never what someone typing a name is looking for first.
  related: 5,
};

/** Candidates pulled from each source before ranking trims to `limit`. */
const CANDIDATE_POOL = 400;

export interface WireSearchResult extends WireNodeRef {
  matchKind: MatchKind;
}

/**
 * Tie-break inside a match tier: the kinds someone navigates to, before the
 * kinds that merely mention a name.
 */
function kindRank(kind: NodeKind): number {
  switch (kind) {
    case 'function':
    case 'method':
    case 'class':
    case 'component':
    case 'interface':
    case 'struct':
    case 'trait':
    case 'protocol':
    case 'enum':
    case 'union':
    case 'type_alias':
    case 'route':
      return 0;
    case 'constant':
    case 'property':
    case 'field':
    case 'variable':
    case 'enum_member':
      return 1;
    case 'file':
    case 'module':
    case 'namespace':
      return 2;
    default:
      // import / export / parameter — a mention, not a definition.
      return 3;
  }
}

function classify(node: Node, needle: string): MatchKind | null {
  const name = node.name.toLowerCase();
  if (name === needle) return 'exact';
  if (name.startsWith(needle)) return 'prefix';
  if (name.includes(needle)) return 'substring';
  if (node.qualifiedName.toLowerCase().includes(needle)) return 'qualified';
  if (node.filePath.toLowerCase().replace(/\\/g, '/').includes(needle)) return 'file';
  return null;
}

export function buildSearch(cg: CodeGraph, query: URLSearchParams): unknown {
  const raw = optionalTextParam(query, 'q');
  const limit = intParam(query, 'limit', { min: 1, max: 200, default: 60 });

  // An empty search box is the palette's resting state, not a mistake — it
  // answers with nothing rather than with an error the viewer has to special-
  // case. A MISSING `q` is still a 400: that is a caller bug.
  if (raw.trim() === '') return emptySearch(raw);

  // The filter grammar (`kind:function auth`) belongs to `searchNodes`; the
  // name lookups only ever want the free-text part of what was typed.
  const parsed = parseQuery(raw);
  const text = parsed.text.trim();
  const needle = text.toLowerCase();

  const candidates = new Map<string, Node>();
  const remember = (node: Node): void => {
    if (!candidates.has(node.id)) candidates.set(node.id, node);
  };

  const direct = cg.getUiSearchCandidates(parsed, CANDIDATE_POOL);
  for (const node of direct) remember(node);
  const related = cg.searchNodes(raw, { limit: CANDIDATE_POOL });
  for (const result of related) remember(result.node);
  const candidateLimited = direct.length >= CANDIDATE_POOL || related.length >= CANDIDATE_POOL;

  const scored: Array<{ node: Node; match: MatchKind }> = [];
  for (const node of candidates.values()) {
    // 合并后再次核对过滤条件，保持直接候选与全文搜索的匹配语义一致。
    if (!matchesFilters(node, parsed)) continue;
    // An empty text portion means the query was pure filters (`kind:route`);
    // everything `searchNodes` returned already satisfies them, so there is no
    // name match to grade and every row is equally "related".
    const match = needle.length === 0 ? 'related' : classify(node, needle) ?? 'related';
    scored.push({ node, match });
  }

  scored.sort((a, b) => {
    const byMatch = MATCH_RANK[a.match] - MATCH_RANK[b.match];
    if (byMatch !== 0) return byMatch;
    const byKind = kindRank(a.node.kind) - kindRank(b.node.kind);
    if (byKind !== 0) return byKind;
    // Production code before tests and fixtures: both are real answers, but one
    // of them is the one someone searching for a symbol usually means.
    const aTest = isTestPath(a.node.filePath);
    const bTest = isTestPath(b.node.filePath);
    if (aTest !== bTest) return aTest ? 1 : -1;
    // Shorter names are closer to what was typed (`get` before `getOrCreate`).
    const byLength = a.node.name.length - b.node.name.length;
    if (byLength !== 0) return byLength;
    return (
      a.node.filePath.localeCompare(b.node.filePath) || a.node.startLine - b.node.startLine
    );
  });

  const top = scored.slice(0, limit);
  // One bounded lookup for the whole page of results, so a generated stub
  // reads as one at a glance instead of after a click.
  const isGenerated = cg.generatedFilePredicate(top.map(({ node }) => node.filePath));
  const results: WireSearchResult[] = top.map(({ node, match }) => {
    const result: WireSearchResult = { ...toNodeRef(node), matchKind: match };
    if (isGenerated(node.filePath)) result.generated = true;
    return result;
  });

  // Groups keep the ranked order: a group appears where its best result did, so
  // flattening the groups reproduces the flat ranking for keyboard navigation.
  const groups: Array<{ kind: NodeKind; count: number; items: WireSearchResult[] }> = [];
  const byKind = new Map<NodeKind, WireSearchResult[]>();
  for (const result of results) {
    const bucket = byKind.get(result.kind);
    if (bucket) {
      bucket.push(result);
    } else {
      const created = [result];
      byKind.set(result.kind, created);
      groups.push({ kind: result.kind, count: 0, items: created });
    }
  }
  for (const group of groups) group.count = group.items.length;

  return {
    query: raw,
    text,
    filters: {
      kinds: parsed.kinds,
      languages: parsed.languages,
      paths: parsed.pathFilters,
      names: parsed.nameFilters,
    },
    results: wireList(results, scored.length),
    candidateLimited,
    totalExact: !candidateLimited,
    groups,
  };
}

/**
 * Deliberately a plain path check rather than the engine's `isTestFile`: this
 * is a ranking nudge inside one tier, and `isTestFile` also treats `examples/`,
 * `benchmarks/` and `fixtures/` as tests — pushing a legitimately-searched
 * example below an unrelated production symbol.
 */
function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    /(^|\/)(tests?|specs?|__tests__)\//.test(lower) ||
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lower)
  );
}

/**
 * The hard gate the `kind:` / `lang:` / `path:` / `name:` grammar asks for.
 *
 * Deliberately the same predicates `searchNodes` uses internally — kinds and
 * languages exact, paths and names case-insensitive substrings, each list OR'd
 * within itself and AND'd across lists — so a filtered search means the same
 * thing whichever lookup a result came from.
 */
function matchesFilters(node: Node, parsed: ParsedQuery): boolean {
  if (parsed.kinds.length > 0 && !parsed.kinds.includes(node.kind)) return false;
  if (parsed.languages.length > 0 && !parsed.languages.includes(node.language)) return false;
  if (parsed.pathFilters.length > 0) {
    const file = node.filePath.toLowerCase();
    if (!parsed.pathFilters.some((p) => file.includes(p.toLowerCase()))) return false;
  }
  if (parsed.nameFilters.length > 0) {
    const name = node.name.toLowerCase();
    if (!parsed.nameFilters.some((n) => name.includes(n.toLowerCase()))) return false;
  }
  return true;
}

/** The resting state of the palette: the shape of a real answer, with nothing in it. */
function emptySearch(raw: string): unknown {
  return {
    query: raw,
    text: '',
    filters: { kinds: [], languages: [], paths: [], names: [] },
    results: wireList<WireSearchResult>([], 0),
    groups: [],
  };
}
