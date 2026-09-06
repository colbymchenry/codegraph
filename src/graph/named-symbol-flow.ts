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

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Last `::` / `.` / `/`-separated segment of a qualified symbol. An Erlang
 * arity tail (`mod::fn/3`, `fn/3`) is stripped first — the useful last segment
 * is the function name, never the digits (#1610).
 */
export function lastQualifierPart(symbol: string): string {
  const noArity = symbol.replace(/\/\d{1,3}$/, '') || symbol;
  const parts = noArity.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Check if a node matches a symbol query.
 *
 * Accepts simple names (`run`) and three flavors of qualifier:
 *   - dotted     `Session.request`         (TS/JS/Python)
 *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
 *   - slash      `configurator/stage_apply` (path-ish)
 *
 * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
 * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
 * the canonical `crate::module::symbol` form resolves.
 *
 * Resolution order, last part must always equal `node.name`:
 *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
 *      where the extractor builds the qualified name from the AST stack)
 *   2. File-path containment (handles file-derived modules in Rust/
 *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  // Erlang arity spelling (`fn/3`, `mod:fn/3` → normalized `mod.fn/3`): when
  // the node's qualifiedName carries an arity (`mod::fn/3`, #1610), the
  // written arity must match it exactly; the remaining comparison then runs
  // on the arity-less spelling. A node with no arity in its qualifiedName
  // keeps the original symbol (a `/` there means a path-ish name instead).
  const aritySpelling = /^(.+)\/(\d{1,3})$/.exec(symbol);
  if (aritySpelling) {
    const nodeArity = /\/(\d{1,3})$/.exec(node.qualifiedName ?? '')?.[1];
    if (nodeArity !== undefined) {
      if (nodeArity !== aritySpelling[2]) return false;
      symbol = aritySpelling[1]!;
    }
  }
  // Simple name match
  if (node.name === symbol) return true;
  // File basename match (e.g., "product-card" matches "product-card.liquid")
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  // Qualified-name lookups: split on any supported separator. `\w` keeps
  // identifier chars (incl. `_`) intact; everything else is treated as
  // a separator we tolerate.
  if (!/[.\/]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Stage 1: qualified-name suffix match. The extractor joins the
  // semantic hierarchy with `::`, so `Session.request` and
  // `Session::request` both become `Session::request` here.
  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;
  // A CDS namespace is ONE dotted qualifiedName segment
  // (`sap.capire.bookshop::Books`), so the fully qualified name a model writes
  // (`sap.capire.bookshop.Books`) splits into four parts whose `::` join is
  // `sap::capire::bookshop::Books` and misses. Re-join everything before the
  // last part with dots and try that spelling too.
  if (parts.length >= 3) {
    const dottedContainer = `${parts.slice(0, -1).join('.')}::${lastPart}`;
    if (node.qualifiedName.includes(dottedContainer)) return true;
  }

  // Stage 2: file-path containment. Rust modules and Python packages
  // are not in `qualifiedName` — they're encoded in the file path. So
  // `stage_apply::run` matches a `run` in any file whose path
  // contains a `stage_apply` segment (with or without an extension).
  //
  // Filter out Rust path prefixes that have no file-system equivalent.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

/**
 * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
 * results across all matching symbols (e.g., multiple classes with an `execute` method).
 */
export function findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
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
  let results = cg.searchNodes(symbol, { limit: 50 });

  // Mirror the fallback in `findSymbol` for qualified queries — FTS
  // strips colons, so a module-qualified lookup needs a second pass
  // by the bare last part.
  if (results.length === 0 && /[.\/]|::/.test(symbol)) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }

  if (results.length === 0) {
    return { nodes: [], note: '' };
  }

  const exactMatches = results.filter(r => matchesSymbol(r.node, symbol));

  if (exactMatches.length <= 1) {
    const node = exactMatches[0]?.node ?? results[0]!.node;
    return { nodes: [node], note: '' };
  }

  // Same generated-file down-rank as findSymbol — keeps callers/callees
  // /impact aggregation aligned (a query against "Send" returns the
  // hand-written implementations before the protobuf scaffold).
  const isGen = cg.generatedFilePredicate(exactMatches.map((r) => r.node.filePath));
  const ranked = [...exactMatches].sort((a, b) => {
    const aGen = isGen(a.node.filePath) ? 1 : 0;
    const bGen = isGen(b.node.filePath) ? 1 : 0;
    return aGen - bGen;
  });

  const locations = ranked.map(r =>
    `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
  );
  const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: ranked.map(r => r.node), note };
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
  /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;

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
  return /[._$]|::|\//.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z]/.test(token);
}

/** The symbol-shaped tokens of a query, deduped and capped. */
export function flowTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/[\s,()[\]]+/)
        .map((t) => t.replace(FILE_EXT, '').trim())
        .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
    ),
  ].slice(0, MAX_TOKENS);
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
  for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);

  const hasHeuristicEdge = (id: string): boolean =>
    [...cg.getCallers(id), ...cg.getCallees(id)].some(({ edge }) => edge.provenance === 'heuristic');

  for (const t of tokens) {
    const hits = findAllSymbols(cg, t).nodes;
    const cands = hits.filter((n) => FLOW_CALLABLE_KINDS.has(n.kind));
    out.tokenFamily.set(t, cands);
    // A qualified or otherwise-specific name (<=3 hits) keeps all of them.
    const specific = cands.length <= 3;
    // In directed mode every candidate is kept and the search decides: the pair
    // of overloads that actually connects IS the disambiguation, and co-naming
    // has nothing to work with when the whole query is two words.
    const pick =
      specific || directed
        ? cands
        : cands.filter((n) => {
            const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
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
  return token.replace(FILE_EXT, '').trim();
}
