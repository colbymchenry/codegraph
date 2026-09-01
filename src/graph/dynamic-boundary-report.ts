/**
 * Where the graph stops — the boundary report, as data.
 *
 * When a flow does not connect, the honest answer is not "no path": it is the
 * dispatch site where the static path ends. `src/mcp/dynamic-boundaries.ts`
 * finds those sites in a body with deterministic regex; this module is the
 * graph-aware layer on top of it — it reads the bodies off disk, shortlists the
 * candidate runtime targets for a statically-visible dispatch key, and collects
 * the continuations out of the stopping symbol that the search did not follow.
 *
 * It exists for the same reason `named-symbol-flow.ts` does. `codegraph_explore`
 * announces boundaries in prose ("**Dynamic boundaries** … candidates for key
 * `save`: …") and the viewer's Flow strip draws the same verdict as an end cap
 * (design spec §3.5). Two derivations of "where does this stop" would eventually
 * disagree, and a reader who had both on screen would have no way to tell which
 * one was lying. So the *verdict* lives here once, and each caller renders it:
 * `ToolHandler.buildDynamicBoundaries` turns it into markdown, `/api/flow` turns
 * it into `WireFlowBoundary`.
 *
 * Everything here is query-time and read-only. The graph is never mutated, no
 * edge is ever guessed, and a fully connected flow never reaches this module —
 * silence beats a wrong edge (#687).
 */

import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { scanDynamicDispatch, type BoundaryMatch } from '../mcp/dynamic-boundaries';
import { validatePathWithinRoot } from '../utils';
import { existsSync, readFileSync } from 'fs';

/** Below this resolution confidence an edge is a name-only guess, not a call. */
export const UNCERTAIN_BELOW = 0.6;

/** Dispatch sites reported across one scan. Matches explore's bullet budget. */
export const MAX_BOUNDARY_SITES = 4;

/** Bodies read off disk per scan, however many symbols were handed in. */
const MAX_SCAN = 8;

/** Total body characters read per scan — a god-function tail must not stall a request. */
const MAX_TOTAL_CHARS = 200_000;

/** Candidate runtime targets shortlisted for one dispatch key. */
const MAX_CANDIDATES = 4;

/** FTS rows inspected while shortlisting; also the "too generic" threshold. */
const CANDIDATE_SEARCH_LIMIT = 12;

/** Kinds that can be the runtime target of a dispatch. */
const CALLABLE_KINDS = new Set(['method', 'function', 'component', 'constructor', 'class']);

/**
 * A conventional handler method on a typed-bus target class — MediatR's
 * `Handle`, a consumer's `Consume`, PHP's `__invoke`.
 */
const HANDLER_METHODS = /^(handle|handleAsync|execute|executeAsync|consume|consumeAsync|run|__invoke)$/i;

// =============================================================================
// Shapes
// =============================================================================

/** One plausible runtime target of a keyed dispatch. */
export interface BoundaryCandidate {
  node: Node;
  /**
   * How the candidate should be named. Usually `qualifiedName`, but a typed-bus
   * key resolves to a CLASS whose real target is its handler method, so the
   * display names that method (`CreateTodoCommandHandler.Handle`) and `node` is
   * the method too — a row the reader clicks must open what it claims.
   */
  display: string;
  /** The reader already named this symbol: "you were right, here's the wiring". */
  named: boolean;
}

/** A dispatch site: the detector's verdict plus what the graph knows about it. */
export interface BoundarySite extends BoundaryMatch {
  /** Runtime targets for {@link BoundaryMatch.key}. Empty when the key is a runtime value. */
  candidates: BoundaryCandidate[];
  /**
   * Why there is no shortlist, when a key was visible but nothing could be
   * narrowed down: "key `id` is too generic to shortlist (12+ matches)".
   */
  candidateNote: string | null;
}

/** Every dispatch site found in one symbol's body. */
export interface NodeBoundary {
  node: Node;
  sites: BoundarySite[];
}

/** One call out of the stopping symbol, and how sure the resolver was of it. */
export interface BoundaryContinuation {
  node: Node;
  line: number | null;
  confidence: number | null;
}

/**
 * The calls recorded out of a symbol, split by whether the resolver believed
 * them. `uncertain` is the part a flow search deliberately does not follow.
 */
export interface BoundaryContinuations {
  resolved: BoundaryContinuation[];
  uncertain: BoundaryContinuation[];
}

export interface BoundaryScanOptions {
  /** Dispatch sites returned in total. Default {@link MAX_BOUNDARY_SITES}. */
  maxSites?: number;
  /** Symbols the reader named — candidates matching one are marked and sort first. */
  named?: ReadonlyMap<string, Node>;
}

// =============================================================================
// The scan
// =============================================================================

/**
 * Scan the given symbols' bodies for dynamic-dispatch sites, in order.
 *
 * `scanList` is a priority order, not a set: the caller puts the place the flow
 * actually stopped first (the chain's dead end), then the symbols that were
 * asked for and never reached. Scanning stops at the first of three budgets —
 * sites found, bodies read, characters read — so a question about a god
 * function costs the same as any other.
 *
 * Returns one entry per symbol that yielded at least one site; a symbol with a
 * clean body is simply absent, because "nothing dynamic here" is not a finding.
 */
export function findDynamicBoundaries(
  cg: CodeGraph,
  scanList: readonly Node[],
  opts: BoundaryScanOptions = {}
): NodeBoundary[] {
  const maxSites = opts.maxSites ?? MAX_BOUNDARY_SITES;
  const named = opts.named ?? new Map<string, Node>();
  let projectRoot: string;
  try {
    projectRoot = cg.getProjectRoot();
  } catch {
    return [];
  }

  const out: NodeBoundary[] = [];
  const seenNode = new Set<string>();
  const seenSite = new Set<string>();
  let sites = 0;
  let scanned = 0;
  let charsScanned = 0;

  for (const node of scanList) {
    if (sites >= maxSites || scanned >= MAX_SCAN || charsScanned > MAX_TOTAL_CHARS) break;
    if (seenNode.has(node.id) || !node.startLine || !node.endLine) continue;
    seenNode.add(node.id);
    const absPath = validatePathWithinRoot(projectRoot, node.filePath);
    if (!absPath || !existsSync(absPath)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const body = content.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
    scanned++;
    charsScanned += body.length;

    const found: BoundarySite[] = [];
    for (const match of scanDynamicDispatch(body, node.language || '', node.startLine)) {
      if (sites >= maxSites) break;
      const siteKey = `${node.filePath}:${match.line}:${match.form}`;
      if (seenSite.has(siteKey)) continue;
      seenSite.add(siteKey);
      const shortlist = match.key
        ? shortlistBoundaryCandidates(cg, match.key, !!match.keyIsType, named, node.id)
        : { candidates: [], note: null };
      found.push({ ...match, candidates: shortlist.candidates, candidateNote: shortlist.note });
      sites++;
    }
    if (found.length > 0) out.push({ node, sites: found });
  }
  return out;
}

// =============================================================================
// Candidates
// =============================================================================

const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Shortlist the runtime targets a dispatch key could reach.
 *
 * Exact conventional names first (`save` → `onSave` / `handleSave`;
 * `CreateCmd` → `CreateCmdHandler`), then FTS, with a normalized-containment
 * post-filter — FTS camel-splitting is fuzzier than a candidate list should be,
 * and a shortlist that is mostly wrong is worse than none. Symbols the caller
 * already named sort first and are marked.
 *
 * A key too short or too common to narrow down returns no candidates and a
 * `note` saying so, rather than four arbitrary rows.
 */
export function shortlistBoundaryCandidates(
  cg: CodeGraph,
  key: string,
  keyIsType: boolean,
  named: ReadonlyMap<string, Node>,
  selfId: string
): { candidates: BoundaryCandidate[]; note: string | null } {
  const keyNorm = normalizeName(key);
  if (keyNorm.length < 3) return { candidates: [], note: null };

  const cands = new Map<string, Node>();
  const consider = (n: Node | undefined | null): void => {
    if (!n || n.id === selfId || !CALLABLE_KINDS.has(n.kind) || cands.has(n.id)) return;
    const nameNorm = normalizeName(n.name || '');
    if (nameNorm.length < 3) return;
    if (!nameNorm.includes(keyNorm) && !keyNorm.includes(nameNorm)) return;
    cands.set(n.id, n);
  };

  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  const probes = keyIsType
    ? [`${key}Handler`, key]
    : [key, `on${cap}`, `handle${cap}`, `${key}Handler`, `handle_${key}`];
  for (const probe of probes) {
    try {
      for (const n of cg.getNodesByName(probe)) consider(n);
    } catch {
      /* an exact probe that misses is the normal case */
    }
  }

  let raw = 0;
  try {
    const results = cg.searchNodes(key, { limit: CANDIDATE_SEARCH_LIMIT });
    raw = results.length;
    for (const r of results) consider(r.node);
  } catch {
    /* FTS syntax edge — the exact probes already ran */
  }

  if (cands.size === 0) {
    const generic = raw >= CANDIDATE_SEARCH_LIMIT && key.length < 5;
    return {
      candidates: [],
      note: generic ? `key \`${key}\` is too generic to shortlist (${raw}+ matches)` : null,
    };
  }

  // A constructor candidate duplicates its class: extractors emit constructors
  // as METHOD nodes named like the class (C#/Java `Foo::Foo`) — keep the class.
  const all = [...cands.values()];
  const classKey = new Set(
    all.filter((n) => n.kind === 'class').map((n) => `${n.name}|${n.filePath}`)
  );
  // The flow's named set holds callables only, so a class whose METHOD the
  // reader named still counts as named — transfer the mark by name.
  const namedNames = new Set([...named.values()].map((n) => n.name));
  const isNamed = (n: Node): boolean => named.has(n.id) || namedNames.has(n.name);

  const candidates = all
    .filter((n) => !(n.kind !== 'class' && classKey.has(`${n.name}|${n.filePath}`)))
    .sort((a, b) => (isNamed(b) ? 1 : 0) - (isNamed(a) ? 1 : 0))
    .slice(0, MAX_CANDIDATES)
    .map((n): BoundaryCandidate => {
      // Typed-bus convention: the runtime target is the candidate class's
      // Handle/Execute/Consume method — name the exact node, not just the class.
      if (keyIsType && n.kind === 'class') {
        const method = handlerMethodOf(cg, n);
        if (method) {
          return { node: method, display: `${n.name}.${method.name}`, named: isNamed(n) };
        }
      }
      return { node: n, display: n.qualifiedName || n.name, named: isNamed(n) };
    });

  return { candidates, note: null };
}

function handlerMethodOf(cg: CodeGraph, cls: Node): Node | null {
  try {
    return (
      cg
        .getOutgoingEdges(cls.id)
        .filter((e) => e.kind === 'contains')
        .map((e) => {
          try {
            return cg.getNode(e.target);
          } catch {
            return null;
          }
        })
        .find((c): c is Node => !!c && c.kind === 'method' && HANDLER_METHODS.test(c.name)) ?? null
    );
  } catch {
    return null; // a class whose members do not resolve — show the class itself
  }
}

// =============================================================================
// Continuations
// =============================================================================

const CONTINUATION_KINDS = new Set(['calls', 'instantiates', 'navigates']);

/**
 * The calls recorded out of a symbol, minus the ones already on the path.
 *
 * This is the other half of an honest end cap. A flow that stops somewhere has
 * two kinds of unexplored exit: calls the resolver was sure of and the path
 * simply did not need, and name-only matches under {@link UNCERTAIN_BELOW} that
 * the search deliberately refused to follow. Listing the second kind is the
 * point — an unfollowed guess that stays invisible reads as "there is nothing
 * here", which is the one thing it does not mean.
 *
 * Deduped by target, keeping the first line each was recorded at.
 */
export function continuationsFrom(
  cg: CodeGraph,
  node: Node,
  exclude: ReadonlySet<string> = new Set()
): BoundaryContinuations {
  const resolved = new Map<string, BoundaryContinuation>();
  const uncertain = new Map<string, BoundaryContinuation>();
  let edges: Edge[];
  try {
    edges = cg.getOutgoingEdges(node.id);
  } catch {
    return { resolved: [], uncertain: [] };
  }
  for (const edge of edges) {
    if (!CONTINUATION_KINDS.has(edge.kind)) continue;
    if (edge.target === node.id || exclude.has(edge.target)) continue;
    const meta = (edge.metadata ?? {}) as Record<string, unknown>;
    const confidence = typeof meta.confidence === 'number' ? meta.confidence : null;
    const bucket = confidence !== null && confidence < UNCERTAIN_BELOW ? uncertain : resolved;
    if (bucket.has(edge.target)) continue;
    let target: Node | null;
    try {
      target = cg.getNode(edge.target);
    } catch {
      continue;
    }
    if (!target) continue;
    bucket.set(edge.target, {
      node: target,
      line: typeof edge.line === 'number' ? edge.line : null,
      confidence,
    });
  }
  const byLine = (a: BoundaryContinuation, b: BoundaryContinuation): number =>
    (a.line ?? 0) - (b.line ?? 0);
  return {
    resolved: [...resolved.values()].sort(byLine),
    uncertain: [...uncertain.values()].sort(byLine),
  };
}
