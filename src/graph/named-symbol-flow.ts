/**
 * The call path among a bag of named symbols — the one path finder.
 *
 * `codegraph_explore` leads its answer with a "Flow" section: the longest call
 * chain among the symbols an agent named, riding synthesized dynamic-dispatch
 * edges so a controller reaches its implementation through the interface. The
 * viewer's Flow strip (`/api/flow`, design spec §3.5) draws the same thing as
 * cards. They must never disagree, so the search lives here once and both
 * callers ride it: same token parsing, same overload disambiguation, same
 * bridge budget, same edges.
 *
 * What differs between the two callers is expressed as OPTIONS, not as a second
 * implementation:
 *
 * - **`mode: 'named'`** is exactly what explore does. Every resolved symbol is
 *   both a possible start and a possible end, at most ONE unnamed symbol may
 *   bridge two named ones ({@link DEFAULT_MAX_BRIDGE}), and the LONGEST chain
 *   wins. The bridge cap is what stops the search wandering a god-function's
 *   fan-out: the agent's own naming is the evidence that a hop is on-topic.
 * - **`mode: 'directed'`** is "how does X reach Y", which the agent has no way
 *   to ask and the viewer's search box does. Both ends are pinned, so the
 *   evidence the bridge cap was standing in for is already there and the search
 *   bridges freely — a two-token query under the named rules could never return
 *   more than three cards. The SHORTEST path wins, because with both ends fixed
 *   a longer route is a detour rather than a fuller answer.
 *
 * Overloads are handled differently for the same reason. A bare ambiguous name
 * in `named` mode is filtered by CO-NAMING (keep `list` only where the agent
 * also named its class); in `directed` mode every candidate for both endpoints
 * is tried and the pair that actually connects is the answer — which is a
 * better disambiguator than co-naming and the only one available when the
 * whole query is two words.
 */

import type CodeGraph from '../index';
import type { Node, Edge } from '../types';
import { isTestFile } from '../search/query-utils';

import { lastQualifierPart, matchesSymbol, HASKELL_FLOW_IDENTIFIER_SOURCE, HASKELL_FLOW_MODULE_SOURCE, QUALIFIED_OPERATOR_CONTAINER_SOURCE, isHaskellOperatorBody, qualifiedHaskellOperator, qualifiedHaskellOperatorMatches } from './symbol-lookup';

// Preserve the existing imports while sharing the matcher with the CLI and MCP.
export { RUST_PATH_PREFIXES, lastQualifierPart, matchesSymbol } from './symbol-lookup';

/** Split graph hierarchy separators only when they are outside operator parens. */
function qualifiedNameSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    if (depth !== 0) continue;
    const separatorLength = value.startsWith('::', index) ? 2 : char === '.' ? 1 : 0;
    if (separatorLength === 0) continue;
    if (index > start) segments.push(value.slice(start, index));
    index += separatorLength - 1;
    start = index + 1;
  }
  if (start < value.length) segments.push(value.slice(start));
  return segments.filter(Boolean);
}


/**
 * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
 * results across all matching symbols (e.g., multiple classes with an `execute` method).
 *
 * Exact matches only (#1473): a missing / mistyped name must NOT silently
 * resolve to the top fuzzy FTS hit under the caller's typed label. Closest
 * hits may appear in `note` as a did-you-mean hint when `nodes` is empty.
 */
export function findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
  const qualifiedOperator = qualifiedHaskellOperator(symbol);
  if (qualifiedOperator) {
    const candidates = [
      ...cg.getNodesByName(qualifiedOperator.nodeName),
      ...cg.getNodesByName(qualifiedOperator.operatorBody),
    ];
    const exact = [...new Map(candidates.map((node) => [node.id, node])).values()]
      .filter((node) => {
        if (qualifiedHaskellOperatorMatches(node, qualifiedOperator)) return true;
        if (
          node.language === 'haskell'
          && node.kind === 'enum_member'
          && node.name === qualifiedOperator.nodeName
          && node.isExported === true
          && node.qualifiedName.startsWith(`${qualifiedOperator.moduleName}::`)
          && node.qualifiedName.endsWith(`::${qualifiedOperator.nodeName}`)
        ) return true;
        if (node.language !== 'haskell' || node.kind !== 'method') return false;
        if (!node.qualifiedName.startsWith(`${qualifiedOperator.moduleName}::`)
          || !node.qualifiedName.endsWith(`::${qualifiedOperator.nodeName}`)) return false;
        // Class selectors are exported through their class and are legitimately
        // addressable through the module. Instance implementations and local
        // helpers are not. Follow THIS method's containment edge rather than
        // matching owner text: a nullary class and its instance may share the
        // same qualified spelling.
        return cg.getIncomingEdges(node.id).some((edge) => {
          if (edge.kind !== 'contains') return false;
          const owner = cg.getNode(edge.source);
          return owner?.language === 'haskell' && owner.kind === 'trait';
        });
      });
    if (exact.length === 0) return { nodes: [], note: '' };
    const isGen = cg.generatedFilePredicate(exact.map((node) => node.filePath));
    const nodes = [...exact].sort(
      (left, right) => (isGen(left.filePath) ? 1 : 0) - (isGen(right.filePath) ? 1 : 0),
    );
    const note = nodes.length <= 1
      ? ''
      : `\n\n> **Note:** Aggregated results across ${nodes.length} symbols named "${symbol}": ${nodes.map((node) => `${node.kind} at ${node.filePath}:${node.startLine}`).join(', ')}`;
    return { nodes, note };
  }
  // Nix option paths: the declaration is stored as `options.<path>` and
  // config writes carry longer/quoted tails (`<path>."git/config".text`),
  // so a dotted option token (`xdg.configFile`, `launchd.user.agents`) has
  // no exact-name node and would degrade to bare-tail FTS soup — burying
  // the declaration hub the nix-option-path edges hang off. Resolve the
  // convention directly: declaration first, then the exact write, then a
  // capped prefix scan of write sites. Three index hits; non-nix graphs
  // fall straight through.
  if (/^[a-z][\w'-]*(?:\.[\w'-]+)+$/.test(symbol)) {
    const optionHits = [
      ...cg.getNodesByName(`options.${symbol}`),
      ...cg.getNodesByName(symbol),
      ...cg.getNodesByNamePrefix(`${symbol}.`, 12),
    ].filter((n) => n.language === 'nix');
    if (optionHits.length > 0) {
      const seen = new Set<string>();
      const nodes = optionHits.filter((n) => !seen.has(n.id) && !!seen.add(n.id)).slice(0, 10);
      return { nodes, note: '' };
    }
  }
  const unqualifiedOperator = /^\(([^()\s]+)\)$/.exec(symbol)?.[1]
    ?? (/^\$+$/.test(symbol) ? symbol : undefined);
  if (unqualifiedOperator && isHaskellOperatorBody(unqualifiedOperator)) {
    const exact = cg.getNodesByName(`(${unqualifiedOperator})`)
      .filter((node) => node.language === 'haskell');
    // A bare dollar-only spelling is also a valid JavaScript identifier.
    // Resolve both exact language-specific names, never a fuzzy operator match.
    if (symbol === unqualifiedOperator) {
      exact.push(...cg.getNodesByName(symbol).filter((node) => node.language !== 'haskell'));
    }
    const isGen = cg.generatedFilePredicate(exact.map((node) => node.filePath));
    const nodes = [...exact].sort(
      (left, right) => (isGen(left.filePath) ? 1 : 0) - (isGen(right.filePath) ? 1 : 0),
    );
    const note = nodes.length <= 1
      ? ''
      : `\n\n> **Note:** Aggregated results across ${nodes.length} symbols named "${symbol}": ${nodes.map((node) => `${node.kind} at ${node.filePath}:${node.startLine}`).join(', ')}`;
    // An operator token is shape-exact. Never degrade an absent `(⊗)` into an
    // FTS result for a nearby `(⊕)`.
    return { nodes, note };
  }

  const isQualified = /[.\/]|::/.test(symbol);
  let exactNodes: Node[];

  if (!isQualified) {
    // Direct index — every exact-name overload, case-sensitive. Avoids FTS
    // ranking a differently-cased sibling above the real node (#1473 Fetch).
    exactNodes = cg.getNodesByName(symbol);
  } else {
    let results = cg.searchNodes(symbol, { limit: 50 });
    // Mirror findSymbolMatches — FTS strips colons, so re-search by bare tail.
    if (results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }
    exactNodes = results
      .filter((r) => matchesSymbol(r.node, symbol))
      .map((r) => r.node);
  }

  if (exactNodes.length === 0) {
    const fuzzy = cg.searchNodes(symbol, { limit: 5 });
    const suggestions = [
      ...new Set(fuzzy.map((r) => r.node.name).filter((n) => n !== symbol)),
    ].slice(0, 3);
    const note =
      suggestions.length > 0
        ? `\n\n> **Note:** no symbol named "${symbol}". Did you mean: ${suggestions.join(', ')}?`
        : '';
    return { nodes: [], note };
  }

  if (exactNodes.length === 1) {
    return { nodes: exactNodes, note: '' };
  }

  // Same generated-file down-rank as findSymbol — keeps callers/callees
  // /impact aggregation aligned (a query against "Send" returns the
  // hand-written implementations before the protobuf scaffold).
  const isGen = cg.generatedFilePredicate(exactNodes.map((n) => n.filePath));
  const ranked = [...exactNodes].sort((a, b) => {
    const aGen = isGen(a.filePath) ? 1 : 0;
    const bGen = isGen(b.filePath) ? 1 : 0;
    return aGen - bGen;
  });

  const locations = ranked.map(
    (n) => `${n.kind} at ${n.filePath}:${n.startLine}`
  );
  const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: ranked, note };
}

/** Node kinds that can sit on a call chain. */
export const FLOW_CALLABLE_KINDS: ReadonlySet<string> = new Set([
  'method',
  'function',
  'component',
  'constructor',
  'route',
]);

/**
 * Edge kinds a flow may ride. `navigates` is a screen transition (Expo Router
 * `router.push('/x')` → the route node) — a hop in the user's flow exactly as
 * a call is a hop in the program's.
 */
export const FLOW_EDGE_KINDS: ReadonlySet<string> = new Set(['calls', 'navigates']);

/**
 * Node kinds that can be an endpoint of a SYNTHESIZED edge without being
 * callable. An RTK thunk is `const X = createAsyncThunk(...)`, so a thunk →
 * thunk hop is constant → constant and the callable-only set cannot hold it.
 */
const DYN_KINDS: ReadonlySet<string> = new Set(['constant', 'variable', 'field', 'property']);

/** Only a REAL file extension is stripped from a token — `Class.method` is kept. */
const FILE_EXT =
  /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl|hs)$/i;

/** Chain length ceiling, in NODES. Explore's Flow section has always used 7. */
export const DEFAULT_MAX_HOPS = 7;

/**
 * Longer ceiling for a directed question.
 *
 * "How does X reach Y" is asked about two symbols that a reader believes are
 * connected, and a real call path between a CLI entry point and a storage
 * primitive runs deeper than seven frames. Explore's ceiling stays where it is:
 * there, a longer chain is a bigger guess, because nothing pins the far end.
 */
export const DIRECTED_MAX_HOPS = 12;

/** At most one consecutive UNNAMED hop may bridge two named symbols. */
export const DEFAULT_MAX_BRIDGE = 1;

/** Seeds a `named` search starts from, and candidates an ambiguous token keeps. */
const MAX_SEEDS = 8;
const MAX_CANDIDATES_PER_TOKEN = 6;

/**
 * Candidates a DIRECTED endpoint keeps, and the seeds it therefore walks from.
 *
 * Higher than the `named` cap, and the reason is a real failure: `main` has ten
 * definitions in this repository — a Python asset script, a Rust build script,
 * four `scripts/*.mjs` one-offs, a Go fixture — and the CLI's own `main`, the
 * one anybody asking "how does main reach X" means, sorts SEVENTH. A cap of six
 * silently answered "these two symbols are not connected". Both endpoints are
 * pinned here, so an extra candidate costs one bounded walk that ends the
 * moment it reaches the destination, and the pair that connects is the answer.
 */
const MAX_CANDIDATES_DIRECTED = 12;
const MAX_TOKENS = 16;
const MAX_NAMED = 40;

export interface FlowStep {
  node: Node;
  /** The edge INTO this node from the previous step; null on the first. */
  edge: Edge | null;
}

export interface FlowChain {
  steps: FlowStep[];
  /** For each node on the chain, the line where it calls the NEXT one. */
  callSites: Map<string, number>;
}

export interface NamedSymbolFlowOptions {
  /** `named` = explore's rules; `directed` = a pinned from → to question. */
  mode?: 'named' | 'directed';
  /** Required in `directed` mode: the token the path must start at. */
  from?: string;
  /** Required in `directed` mode: the token the path must end at. */
  to?: string;
  maxHops?: number;
  /** Consecutive unnamed hops allowed. `Infinity` in directed mode. */
  maxBridge?: number;
  /** Distinct chains to return. Explore only ever looks at the first. */
  maxChains?: number;
}

export interface NamedSymbolFlow {
  /** The query's symbol tokens, in the order they were written. */
  tokens: string[];
  /** Every CALLABLE the tokens resolved to, by node id. */
  named: Map<string, Node>;
  /** Non-callable endpoints of synthesized edges (RTK thunks and friends). */
  dynNamed: Map<string, Node>;
  /** token → the node ids it resolved to. */
  tokenNodes: Map<string, string[]>;
  /** token → its whole same-name callable family, before the container filter. */
  tokenFamily: Map<string, Node[]>;
  /** Ids whose token was a (near-)unique callable name — at most 3 defs. */
  uniqueNamedNodeIds: Set<string>;
  /** Ids resolved from a shape-precise token (camelCase, dotted, PascalCase…). */
  preciseNamedIds: Set<string>;
  /** Chains found, best first. Empty when nothing connects. */
  chains: FlowChain[];
}

const EMPTY_FLOW = (): NamedSymbolFlow => ({
  tokens: [],
  named: new Map(),
  dynNamed: new Map(),
  tokenNodes: new Map(),
  tokenFamily: new Map(),
  uniqueNamedNodeIds: new Set(),
  preciseNamedIds: new Set(),
  chains: [],
});

/**
 * Production code before test and fixture code, otherwise the order the index
 * ranked them in.
 *
 * Only used for a directed question, where the candidates are the two ends of
 * "how does X reach Y" and a fixture's `main` is never what was meant. In
 * `named` mode the agent's own co-naming does this job and re-ranking would
 * change what `codegraph_explore` answers.
 */
function rankForDirected(nodes: readonly Node[]): Node[] {
  return [...nodes].sort(
    (a, b) => (isTestFile(a.filePath) ? 1 : 0) - (isTestFile(b.filePath) ? 1 : 0)
  );
}

/**
 * A token is shape-precise when it looks like a symbol reference rather than an
 * English word that happened to exact-match a callable.
 */
function isPreciseToken(token: string): boolean {
  return qualifiedHaskellOperator(token) !== null
    || (() => {
      const operator = /^\(([^()\s]+)\)$/.exec(token)?.[1];
      return !!operator && isHaskellOperatorBody(operator);
    })()
    || /[._$'#]|::|\//.test(token)
    || /[\p{Ll}][\p{Lu}\p{Lt}]/u.test(token)
    || /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(token);
}

/** The symbol-shaped tokens of a query, deduped and capped. */
export function flowTokens(query: string): string[] {
  const found: Array<{ index: number; token: string }> = [];
  const covered: Array<{ start: number; end: number }> = [];
  const overlapsQualifiedOperator = (start: number, end: number): boolean =>
    covered.some((range) => start < range.end && end > range.start);
  const addQualifiedOperators = (pattern: RegExp): void => {
    for (const match of query.matchAll(pattern)) {
      const parsed = qualifiedHaskellOperator(match[0]);
      if (!parsed) continue;
      const start = match.index!;
      const end = start + match[0].length;
      // Do not reinterpret a capitalized suffix inside another language's
      // identifier/path as a standalone Haskell module (`notOps.<+>`).
      if (start > 0 && /[\p{L}\p{N}_'$.:/]/u.test(query[start - 1]!)) continue;
      if (overlapsQualifiedOperator(start, end)) continue;
      covered.push({ start, end });
      found.push({ index: start, token: parsed.canonical });
    }
  };

  // Parse qualified operators before ordinary dotted identifiers. Otherwise
  // `Ops.<+>` degrades to the unrelated token `Ops`, losing the qualifier and
  // allowing a fuzzy fallback to another module's operator.
  addQualifiedOperators(new RegExp(
    `(?:${QUALIFIED_OPERATOR_CONTAINER_SOURCE})::\\([^()\\s]+\\)`,
    'gu',
  ));
  addQualifiedOperators(new RegExp(
    `(?:${QUALIFIED_OPERATOR_CONTAINER_SOURCE})::[^()\\s,\\[\\]\\x60]+`,
    'gu',
  ));
  addQualifiedOperators(new RegExp(
    `\\((?:${HASKELL_FLOW_MODULE_SOURCE})\\.[^()\\s\`]+\\)`,
    'gu',
  ));
  addQualifiedOperators(new RegExp(
    `(?:${HASKELL_FLOW_MODULE_SOURCE})\\.[^()\\s,\\[\\]\`]+`,
    'gu',
  ));

  const identifier = new RegExp(
    `${HASKELL_FLOW_IDENTIFIER_SOURCE}(?:(?:::|\\.)${HASKELL_FLOW_IDENTIFIER_SOURCE})*`,
    'gu',
  );
  for (const match of query.matchAll(identifier)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (overlapsQualifiedOperator(start, end)) continue;
    // The old tokenizer validated each whitespace-delimited token as a WHOLE.
    // Keep that contract for compound words and paths: `higher-order` does not
    // name `higher` plus `order`, and `/packages/auth/controllers` must not
    // consume the bounded symbol-token budget one directory segment at a time.
    // Haskell operators are collected separately above/below, so rejecting an
    // identifier fragment beside Unicode dash punctuation, `/`, or `\` cannot
    // hide an operator. `\p{Pd}` matters for agent prose, which commonly uses
    // typographic hyphen/en/em dashes rather than ASCII `-`.
    if (/[\p{Pd}/\\]/u.test(query[start - 1] ?? '') || /[\p{Pd}/\\]/u.test(query[end] ?? '')) {
      continue;
    }
    // A Template Haskell quote (`'name`) is syntax, not part of the queried
    // identifier. Likewise reject the valid prefix of an invalid qualified
    // spelling (`Module.'name`) instead of turning `Module` into a seed.
    if (query[start - 1] === "'" || (query[end] === '.' && query[end + 1] === "'")) continue;
    const token = normalizeToken(match[0]);
    // Haskell identifiers may contain primes (`hover'`, `Module'.run'`).
    // Keep the opening character strict in EVERY qualified segment so a quote
    // itself can never begin a token or a segment.
    // Keep the noise floor for short ASCII prose words, but do not discard a
    // valid one- or two-codepoint Unicode identifier (`λ`, `函数`). Exact node
    // lookup plus precise-token ranking still prevents a fuzzy fallback.
    if ((token.length >= 3 || /[^\x00-\x7f]/u.test(token)) && new RegExp(
      `^${HASKELL_FLOW_IDENTIFIER_SOURCE}(?:(?:::|\\.)${HASKELL_FLOW_IDENTIFIER_SOURCE})*$`,
      'u',
    ).test(token)) {
      found.push({ index: start, token });
    }
  }

  // Haskell operator definitions are stored in their canonical parenthesized
  // form. Preserve an explicitly parenthesized operator, and canonicalize a
  // whitespace-delimited infix spelling (`<+>`) to that same node name. The
  // exact-name lookup below means prose punctuation that has no indexed symbol
  // cannot become a flow endpoint.
  const parenthesizedOperator = /\(([^()\s]+)\)/gu;
  for (const match of query.matchAll(parenthesizedOperator)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (overlapsQualifiedOperator(start, end) || !isHaskellOperatorBody(match[1]!)) continue;
    found.push({ index: start, token: `(${match[1]})` });
  }
  const bareOperator = /(?:^|[\s,\[`])([^\s,\[\]()`]+)(?=$|[\s,\]`])/gu;
  for (const match of query.matchAll(bareOperator)) {
    const start = match.index! + match[0].indexOf(match[1]!);
    const end = start + match[1]!.length;
    if (overlapsQualifiedOperator(start, end) || !isHaskellOperatorBody(match[1]!)) continue;
    found.push({ index: start, token: normalizeToken(match[1]!) });
  }

  found.sort((left, right) => left.index - right.index);
  return [...new Set(found.map(({ token }) => token))].slice(0, MAX_TOKENS);
}

/**
 * Resolve a query's tokens to nodes, with the overload rules described in the
 * module header. No graph traversal happens here.
 */
export function resolveNamedTokens(
  cg: CodeGraph,
  query: string,
  opts: NamedSymbolFlowOptions = {}
): NamedSymbolFlow {
  const directed = opts.mode === 'directed';
  const out = EMPTY_FLOW();
  const tokens = flowTokens(query);
  out.tokens = tokens;
  if (tokens.length < 2) return out;

  // Pool of name SEGMENTS (Class + method from every token), used to keep an
  // ambiguous simple name only where its CONTAINER class is itself named.
  const segPool = new Set<string>();
  for (const t of tokens) {
    for (const segment of qualifiedNameSegments(t.toLowerCase())) segPool.add(segment);
  }

  // Match the edge kinds getCallers/getCallees historically considered here,
  // but inspect raw edges so endpoint admission needs two indexed edge reads and
  // no opposite-node hydration instead of four traversals plus node lookups.
  const traversableEdgeKinds = new Set(['calls', 'references', 'imports', 'instantiates', 'navigates']);
  const hasHeuristicEdge = (id: string): boolean => {
    const incident = [...cg.getOutgoingEdges(id), ...cg.getIncomingEdges(id)];
    return incident.some((edge) =>
      edge.provenance === 'heuristic'
      && traversableEdgeKinds.has(edge.kind)
      && edge.source !== edge.target);
  };

  for (const t of tokens) {
    const hits = findAllSymbols(cg, t).nodes;
    const operatorToken = /^\(([^()\s]+)\)$/.exec(lastQualifierPart(t))?.[1];
    const cands = hits.filter((n) =>
      FLOW_CALLABLE_KINDS.has(n.kind)
      || (n.language === 'haskell'
        && n.kind === 'enum_member'
        && !!operatorToken
        && isHaskellOperatorBody(operatorToken))
    );
    out.tokenFamily.set(t, cands);
    // A qualified Haskell operator is already module-filtered by an exact-name
    // path. Keep all class selectors even when there are >3; only the generic
    // overload path needs co-naming to constrain ambiguity.
    const moduleQualifiedOperator = qualifiedHaskellOperator(t) !== null;
    const specific = cands.length <= 3;
    // In directed mode every candidate is kept and the search decides: the pair
    // of overloads that actually connects IS the disambiguation, and co-naming
    // has nothing to work with when the whole query is two words.
    const pick =
      specific || moduleQualifiedOperator || directed
        ? cands
        : cands.filter((n) => {
            const segs = qualifiedNameSegments((n.qualifiedName || '').toLowerCase());
            const container = segs.length >= 2 ? segs[segs.length - 2] : '';
            return !!container && segPool.has(container);
          });
    const kept = directed
      ? rankForDirected(pick).slice(0, MAX_CANDIDATES_DIRECTED)
      : pick.slice(0, MAX_CANDIDATES_PER_TOKEN);
    out.tokenNodes.set(
      t,
      kept.map((n) => n.id)
    );
    const precise = isPreciseToken(t);
    for (const n of kept) {
      out.named.set(n.id, n);
      if (specific) out.uniqueNamedNodeIds.add(n.id);
      if (precise) out.preciseNamedIds.add(n.id);
    }
    // Same token, non-callable synthesized endpoints. Capped per token so one
    // token's many endpoints cannot fill the pool before later tokens get a slot,
    // and gated on an actual heuristic edge so plain constants never qualify.
    if (out.dynNamed.size < 12) {
      let tokenDyn = 0;
      for (const n of hits) {
        if (FLOW_CALLABLE_KINDS.has(n.kind) || !DYN_KINDS.has(n.kind) || out.dynNamed.has(n.id)) {
          continue;
        }
        if (hasHeuristicEdge(n.id)) {
          out.dynNamed.set(n.id, n);
          if (precise) out.preciseNamedIds.add(n.id);
          tokenDyn++;
        }
        if (out.dynNamed.size >= 12 || tokenDyn >= 4) break;
      }
    }
    if (out.named.size > MAX_NAMED) break;
  }
  return out;
}

/** Where each node on a chain calls the next one. */
function callSitesOf(steps: readonly FlowStep[]): Map<string, number> {
  const sites = new Map<string, number>();
  for (let i = 0; i < steps.length - 1; i++) {
    const line = steps[i + 1]?.edge?.line;
    const id = steps[i]?.node.id;
    if (id && line && line > 0 && !sites.has(id)) sites.set(id, line);
  }
  return sites;
}

/**
 * Nodes one side of a search may visit before it gives up.
 *
 * The `named` cap is explore's own, unchanged: with at most one unnamed bridge
 * between named symbols the frontier cannot run away, so 1 500 is generous.
 * A directed search bridges freely and needs far more room — but it spends it
 * from two ends at once, so a side that blows past this has genuinely fanned
 * out rather than merely gone deep.
 */
const NAMED_VISIT_CAP = 1500;
const DIRECTED_VISIT_CAP = 12_000;

/**
 * Breadth-first over `calls` edges — synthesized ones included, which is what
 * carries a flow across a callback, a re-render or a JSX child.
 *
 * This is the `named` walk: every named symbol is a possible destination, and
 * at most `maxBridge` unnamed symbols may sit between two of them. That cap is
 * what bounds the frontier, so {@link NAMED_VISIT_CAP} is generous.
 *
 * Returns the parent map, so a caller can reconstruct any reached node's path.
 */
function walkCalls(
  cg: CodeGraph,
  seed: Node,
  named: ReadonlySet<string>,
  maxHops: number,
  maxBridge: number
): { parent: Map<string, { prev: string | null; edge: Edge | null; node: Node }>; reached: string[] } {
  const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
  parent.set(seed.id, { prev: null, edge: null, node: seed });
  const queue: Array<{ id: string; depth: number; streak: number }> = [
    { id: seed.id, depth: 0, streak: 0 },
  ];
  const reached: string[] = [];
  for (let head = 0; head < queue.length && parent.size < NAMED_VISIT_CAP; head++) {
    const { id, depth, streak } = queue[head]!;
    if (id !== seed.id && named.has(id)) reached.push(id);
    if (depth >= maxHops - 1) continue;
    for (const c of cg.getCallees(id)) {
      if (!FLOW_EDGE_KINDS.has(c.edge.kind) || parent.has(c.node.id)) continue;
      // A route node is a connector, not a symbol the reader would have named:
      // crossing one costs no bridge budget.
      const newStreak = named.has(c.node.id) ? 0 : c.node.kind === 'route' ? streak : streak + 1;
      if (newStreak > maxBridge) continue;
      parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
      queue.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
    }
  }
  return { parent, reached };
}


/**
 * A short call path from `seed` to any of `sinks`, searched from BOTH ends.
 *
 * A directed question bridges freely — nothing in the middle is "named" to keep
 * the frontier small — so a one-way walk from an entry point balloons: `main`
 * on this repository touches hundreds of symbols within four hops of a
 * twelve-hop budget. Coming in from both ends halves the depth each side has to
 * cover, and the destination end is nearly always the cheap one: a leaf has a
 * handful of callers where an entry point has an enormous fan-out.
 *
 * Measured against the one-way walk on twelve pairs from this repository's own
 * index: **identical paths, 3–6× faster** (`main -> resolveOne` 40 ms → 11 ms,
 * `main -> scanDynamicDispatch` 33 ms → 7 ms). The one-way search never
 * actually exhausted its visit cap here, so the reachability headroom below is
 * insurance for a graph much larger than this one, not a fix for a bug that was
 * observed.
 *
 * It alternates a level at a time, always expanding the SMALLER frontier, and
 * stops the moment the two sides share a node. Alternating levels this way can
 * return a path one hop longer than the true shortest — which is why nothing in
 * the payload claims to be shortest, only to be a path the graph records.
 */
function walkBidirectional(
  cg: CodeGraph,
  seed: Node,
  sinks: ReadonlySet<string>,
  maxHops: number
): FlowStep[] | null {
  if (sinks.has(seed.id)) return null;

  const forward = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
  /** id → the edge OUT of it towards the destination; null AT the destination. */
  const backward = new Map<string, { next: string; edge: Edge } | null>();
  const backNodes = new Map<string, Node>();

  forward.set(seed.id, { prev: null, edge: null, node: seed });
  let frontF: Node[] = [seed];
  let frontB: Node[] = [];
  for (const id of sinks) {
    const node = cg.getNode(id);
    if (!node) continue;
    backward.set(id, null);
    backNodes.set(id, node);
    frontB.push(node);
  }
  if (frontB.length === 0) return null;

  const meetAt = (): string | null => {
    // The forward side is the one that is walked in full, so scanning it is the
    // cheaper direction of the check.
    for (const id of forward.keys()) if (backward.has(id)) return id;
    return null;
  };

  const maxEdges = Math.max(1, maxHops - 1);
  for (let laid = 0; laid < maxEdges; laid++) {
    if (frontF.length <= frontB.length) {
      if (forward.size > DIRECTED_VISIT_CAP) break;
      const next: Node[] = [];
      for (const node of frontF) {
        for (const c of cg.getCallees(node.id)) {
          if (!FLOW_EDGE_KINDS.has(c.edge.kind) || forward.has(c.node.id)) continue;
          forward.set(c.node.id, { prev: node.id, edge: c.edge, node: c.node });
          next.push(c.node);
        }
      }
      if (next.length === 0) break;
      frontF = next;
    } else {
      if (backward.size > DIRECTED_VISIT_CAP) break;
      const next: Node[] = [];
      for (const node of frontB) {
        for (const c of cg.getCallers(node.id)) {
          if (!FLOW_EDGE_KINDS.has(c.edge.kind) || backward.has(c.node.id)) continue;
          backward.set(c.node.id, { next: node.id, edge: c.edge });
          backNodes.set(c.node.id, c.node);
          next.push(c.node);
        }
      }
      if (next.length === 0) break;
      frontB = next;
    }

    const meet = meetAt();
    if (meet === null) continue;

    // Forward half: seed → meet, walking the forward parents back.
    const steps: FlowStep[] = [];
    let cur: string | null = meet;
    while (cur) {
      const at = forward.get(cur);
      if (!at) break;
      steps.push({ node: at.node, edge: at.edge });
      cur = at.prev;
    }
    steps.reverse();
    // Backward half: meet → sink. An entry holds the edge OUT of its node, so
    // it is the edge INTO the step after it, which is the shape a step wants.
    let link = backward.get(meet);
    while (link) {
      const node = backNodes.get(link.next);
      if (!node) break;
      steps.push({ node, edge: link.edge });
      link = backward.get(link.next);
    }

    const last = steps[steps.length - 1];
    if (steps.length < 2 || !last || !sinks.has(last.node.id)) return null;
    return steps.length <= maxHops ? steps : null;
  }
  return null;
}

function chainTo(
  parent: Map<string, { prev: string | null; edge: Edge | null; node: Node }>,
  target: string
): FlowStep[] {
  const steps: FlowStep[] = [];
  let cur: string | null = target;
  while (cur) {
    const at = parent.get(cur);
    if (!at) break;
    steps.push({ node: at.node, edge: at.edge });
    cur = at.prev;
  }
  steps.reverse();
  return steps;
}

/**
 * The call path among a query's named symbols. See the module header for what
 * the two modes mean and why they differ.
 */
export function resolveNamedSymbolFlow(
  cg: CodeGraph,
  query: string,
  opts: NamedSymbolFlowOptions = {}
): NamedSymbolFlow {
  try {
    const directed = opts.mode === 'directed';
    const flow = resolveNamedTokens(cg, query, opts);
    if (flow.named.size < 2) return flow;

    const maxHops = opts.maxHops ?? (directed ? DIRECTED_MAX_HOPS : DEFAULT_MAX_HOPS);
    const maxBridge = opts.maxBridge ?? (directed ? Number.POSITIVE_INFINITY : DEFAULT_MAX_BRIDGE);
    const maxChains = Math.max(1, opts.maxChains ?? 1);
    const namedIds = new Set(flow.named.keys());

    const found: FlowStep[][] = [];
    if (directed) {
      const fromIds = flow.tokenNodes.get(normalizeToken(opts.from ?? '')) ?? [];
      const toIds = flow.tokenNodes.get(normalizeToken(opts.to ?? '')) ?? [];
      if (fromIds.length === 0 || toIds.length === 0) return flow;
      const sinks = new Set(toIds);
      // Every candidate start is searched: each is a bounded two-ended walk that
      // ends the moment the frontiers meet, and the start that actually connects
      // IS the answer to which overload was meant.
      for (const id of fromIds) {
        const seed = flow.named.get(id);
        if (!seed) continue;
        const steps = walkBidirectional(cg, seed, sinks, maxHops);
        if (steps) found.push(steps);
      }
    } else {
      for (const seed of [...flow.named.values()].slice(0, MAX_SEEDS)) {
        const { parent, reached } = walkCalls(cg, seed, namedIds, maxHops, maxBridge);
        // Explore's rule: the DEEPEST named sink this seed can reach.
        let deepest: FlowStep[] | null = null;
        for (const id of reached) {
          const steps = chainTo(parent, id);
          if (!deepest || steps.length > deepest.length) deepest = steps;
        }
        if (deepest) found.push(deepest);
      }
    }

    if (found.length === 0) return flow;
    found.sort((a, b) => (directed ? a.length - b.length : b.length - a.length));

    // Identical chains, and chains that are just a shorter run along one
    // already kept, are the same answer twice: `a → b → c` and `b → c` differ
    // only in where the seed happened to be. Alternatives are for genuinely
    // different routes — a second overload, a different intermediate.
    const kept: string[] = [];
    for (const steps of found) {
      const key = steps.map((s) => s.node.id).join('>');
      if (kept.some((other) => other === key || other.includes(key))) continue;
      kept.push(key);
      flow.chains.push({ steps, callSites: callSitesOf(steps) });
      if (flow.chains.length >= maxChains) break;
    }
    return flow;
  } catch {
    return EMPTY_FLOW();
  }
}

/** The token spelling {@link flowTokens} would have produced for one word. */
export function normalizeToken(token: string): string {
  const trimmed = token.replace(FILE_EXT, '').trim();
  // flowTokens accepts Haskell's backtick call spelling; directed endpoints
  // pass through this function separately and must reach the same canonical
  // token map entry as the query text.
  const normalized = /^`([^`]+)`$/.exec(trimmed)?.[1] ?? trimmed;
  const qualifiedOperator = qualifiedHaskellOperator(normalized);
  if (qualifiedOperator) return qualifiedOperator.canonical;
  const parenthesized = /^\((.*)\)$/.exec(normalized)?.[1];
  if (parenthesized && isHaskellOperatorBody(parenthesized)) return `(${parenthesized})`;
  if (/^\$+$/.test(normalized)) return normalized;
  if (isHaskellOperatorBody(normalized)) return `(${normalized})`;
  return normalized;
}
