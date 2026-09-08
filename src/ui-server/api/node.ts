/**
 * `GET /api/node/<id>` — everything the Symbol view draws, in one round-trip.
 *
 * The Symbol view is three panes and a strip: callers on the left, the verbatim
 * body in the middle with a port per call site, callees on the right anchored
 * to those lines, and a blast-radius summary underneath. Splitting that across
 * five endpoints would mean five waterfalls before the screen settles, and the
 * screen is the product. So this endpoint answers all of it.
 *
 * Two properties it has to hold, and the reasons they are not obvious:
 *
 * **No N+1, anywhere.** The engine's own busiest symbol has 545 incoming edges.
 * Resolving those one `getNode` at a time is 545 queries and blows the budget on
 * its own; so every edge list is resolved with one batched `getNodesByIds`, and
 * fan-in for the rail pills comes from one batched `getFanIn`.
 *
 * **Capped lists that still tell the truth.** 545 callers cannot all be rows,
 * but the payload must never suggest there are fewer. Every list carries the
 * true `total` beside the `shown` slice, and the ordering is chosen so the
 * slice is the useful end: same file first, then production code, then tests.
 */

import type { CodeGraph } from '../../index';
import type { Edge, Node, NodeKind } from '../../types';
import { isTestFile } from '../../search/query-utils';
import { buildHierarchy, type WireOverride } from './hierarchy';
import { notFound } from './respond';
import { findIndexedFile, hasDriftedOnDisk } from './source';
import { annotateWhen } from './when';
import {
  BLAST_DEPTH,
  CALLER_EDGE_KINDS,
  CONTAINER_KINDS,
  HUB_THRESHOLD,
  MAX_INCOMING_GROUPS,
  MAX_OUTGOING_GROUPS,
  MAX_OUTLINE_NODES,
  MAX_OUTSIDE_INDEX_SAMPLES,
  MAX_TEST_FILES,
  TEST_CALLER_BUDGET,
  TEST_CALLER_HOPS,
  TYPE_KINDS,
  firstLine,
  groupRelations,
  toNodeDetail,
  toNodeRef,
  toPosixPath,
  wireList,
  type WireNodeRef,
} from './wire';

/** A member row in the focal symbol's outline, with its place in the tree. */
export interface WireMember extends WireNodeRef {
  /** The container this member belongs to — the focal node, or one of its children. */
  parentId: string;
  /** 1 = direct member, 2 = a member of a member (a class's method inside a file). */
  depth: number;
  /**
   * Edges in and out of this member — the outline's `← in  → out` columns.
   *
   * A container's own fan-out is usually zero (a class calls nothing; its
   * methods do), so without these an outline of a 700-line class says nothing
   * about which member is load-bearing and which is a getter. Edge counts, not
   * distinct counterparts: the column is a weight, and it sits beside a
   * signature rather than beside a caller list it could contradict.
   */
  fanIn: number;
  fanOut: number;
  /**
   * This member redeclares one an ancestor type declares — a name match inside
   * a chain the graph already links, not an `overrides` edge (nothing emits
   * one). Absent for every member that declares something new.
   */
  overrides?: WireOverride;
}

export async function buildNode(cg: CodeGraph, projectRoot: string, nodeId: string): Promise<unknown> {
  const node = cg.getNode(nodeId);
  if (!node) {
    throw notFound(
      'No symbol with that id is in this index.',
      'Symbol ids change whenever the file is re-indexed — search for the symbol by ' +
        'name instead of reusing an id from an older session.'
    );
  }

  const incomingAll = cg.getIncomingEdges(nodeId);
  const outgoingAll = cg.getOutgoingEdges(nodeId);

  // `contains` is structure, not dependency: upward it is the parent (already in
  // `ancestors`), downward it is the members outline. Leaving it in the rails
  // would put a symbol's own class in its caller list.
  const incoming = incomingAll.filter((e) => e.kind !== 'contains');
  const outgoingRest: Edge[] = [];
  const containsOut: Edge[] = [];
  for (const edge of outgoingAll) {
    if (edge.kind === 'contains') containsOut.push(edge);
    else outgoingRest.push(edge);
  }

  const ancestors = cg.getAncestors(nodeId);

  // ---------------------------------------------------------------------------
  // One batched resolve for every endpoint this payload names.
  // ---------------------------------------------------------------------------
  const endpointIds = new Set<string>();
  for (const edge of incoming) endpointIds.add(edge.source);
  for (const edge of outgoingRest) endpointIds.add(edge.target);
  for (const edge of containsOut) endpointIds.add(edge.target);
  const endpoints = cg.getNodesByIds([...endpointIds]);

  // A `references` edge into a type is "uses type X", not "calls X" — the
  // header shows those as chips rather than as callee rows. Split at the EDGE
  // level so a class that is both instantiated and named as a type appears in
  // both places, which is what the source actually says.
  const calleeEdges: Edge[] = [];
  const typeRefs: Edge[] = [];
  for (const edge of outgoingRest) {
    const target = endpoints.get(edge.target);
    if (edge.kind === 'references' && target && TYPE_KINDS.has(target.kind)) typeRefs.push(edge);
    else calleeEdges.push(edge);
  }

  // ---------------------------------------------------------------------------
  // Rails
  // ---------------------------------------------------------------------------
  const focalFile = toPosixPath(node.filePath);

  const incomingGroups = groupRelations(incoming, (e) => e.source, endpoints);
  incomingGroups.sort((a, b) => {
    // The symbol's own file first ("same file" in the left rail), then
    // production code, then tests — so a cap trims the least useful end.
    const aSame = a.node.file === focalFile ? 0 : 1;
    const bSame = b.node.file === focalFile ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    if (a.node.test !== b.node.test) return a.node.test ? 1 : -1;
    return a.node.file.localeCompare(b.node.file) || firstLine(a) - firstLine(b);
  });

  const outgoingGroups = groupRelations(calleeEdges, (e) => e.target, endpoints);
  // The right rail is line-anchored: rows sit beside the line that calls them.
  outgoingGroups.sort((a, b) => firstLine(a) - firstLine(b) || a.node.name.localeCompare(b.node.name));

  const typeGroups = groupRelations(typeRefs, (e) => e.target, endpoints);
  typeGroups.sort((a, b) => firstLine(a) - firstLine(b) || a.node.name.localeCompare(b.node.name));

  const shownIncoming = incomingGroups.slice(0, MAX_INCOMING_GROUPS);
  const shownOutgoing = outgoingGroups.slice(0, MAX_OUTGOING_GROUPS);

  // Branch conditions per call site: the right rail's sites are all in this
  // file; the left rail's are in each caller's own file.
  await annotateWhen(cg, projectRoot, [
    { file: focalFile, edges: shownOutgoing.flatMap((r) => r.edges) },
    ...shownIncoming.map((r) => ({ file: r.node.file, edges: r.edges })),
  ]);

  // Fan-in for the rail pills ("hub · N"), for the rows actually returned —
  // one query, not one per row.
  const fanInOf = cg.getFanIn([
    ...shownIncoming.map((r) => r.node.id),
    ...shownOutgoing.map((r) => r.node.id),
    ...typeGroups.map((r) => r.node.id),
  ]);
  for (const relation of [...shownIncoming, ...shownOutgoing, ...typeGroups]) {
    const count = fanInOf.get(relation.node.id) ?? 0;
    relation.fanIn = count;
    relation.hub = count >= HUB_THRESHOLD;
  }

  // ---------------------------------------------------------------------------
  // Members outline
  // ---------------------------------------------------------------------------
  // The type hierarchy, and the override marks it puts on the outline. Gated
  // to types inside `buildHierarchy`, so a function costs one kind test.
  const hierarchy = buildHierarchy(cg, node);
  const members = buildMembers(cg, node, containsOut, endpoints, hierarchy?.overrides);

  // ---------------------------------------------------------------------------
  // Counts, tests, what leaves the index, blast radius
  // ---------------------------------------------------------------------------
  const directCallers: Node[] = [];
  const seenCaller = new Set<string>();
  for (const edge of incoming) {
    if (!CALLER_EDGE_KINDS.has(edge.kind) || seenCaller.has(edge.source)) continue;
    seenCaller.add(edge.source);
    const source = endpoints.get(edge.source);
    if (source) directCallers.push(source);
  }

  const drift = driftFor(cg, projectRoot, node.filePath);

  return {
    node: toNodeDetail(node),
    /** Outermost first: file, then module/class, then the symbol's own parent. */
    ancestors: [...ancestors].reverse().map(toNodeRef),
    members: wireList(members.items, members.total),
    /**
     * Ancestors, subtypes and the dispatch fan — `null` for anything that is
     * not a type, and for a type with no hierarchy at all.
     */
    hierarchy: hierarchy?.wire ?? null,
    incoming: wireList(shownIncoming, incomingGroups.length),
    outgoing: wireList(shownOutgoing, outgoingGroups.length),
    /** `references` edges into a type — the header's "uses types …" chips. */
    typesUsed: typeGroups,
    counts: {
      // Every count below is the length of a list this payload also returns, so
      // a badge and the rail beneath it can never disagree.
      /** Distinct symbols that reach this one — `incoming.total`. Drives `hub`. */
      callers: incomingGroups.length,
      /** Distinct symbols this one calls — `outgoing.total`. Types are counted separately. */
      callees: outgoingGroups.length,
      /** Distinct types this symbol names — `typesUsed.length`. */
      typesUsed: typeGroups.length,
      /** EDGE counts, which run higher: one caller can call from many lines. */
      fanIn: incoming.length,
      fanOut: outgoingRest.length,
      members: members.total,
      hub: incomingGroups.length >= HUB_THRESHOLD,
    },
    tests: summarizeTestCallers(cg, directCallers),
    outsideIndex: summarizeOutsideIndex(cg, nodeId),
    blast: summarizeBlast(cg, node, incomingGroups.length),
    /** The symbol's file changed on disk since the index — line ranges may be shifted. */
    drift,
  };
}

// =============================================================================
// Members
// =============================================================================

/**
 * The focal symbol's members, in source order, one level of nesting deep.
 *
 * A file's outline is file → class → method, so direct children alone would
 * show a class and nothing inside it. The grandchildren come from ONE batched
 * `getOutgoingEdgesFrom` over the container children, never a query per child.
 */
function buildMembers(
  cg: CodeGraph,
  focal: Node,
  containsOut: readonly Edge[],
  endpoints: Map<string, Node>,
  overrides?: Map<string, WireOverride>
): { items: WireMember[]; total: number } {
  const direct: Array<{ node: Node; parentId: string; depth: number }> = [];
  for (const edge of containsOut) {
    const child = endpoints.get(edge.target);
    if (child) direct.push({ node: child, parentId: focal.id, depth: 1 });
  }

  const containerIds = direct
    .filter((entry) => CONTAINER_KINDS.has(entry.node.kind))
    .map((entry) => entry.node.id);

  const nested: Array<{ node: Node; parentId: string; depth: number }> = [];
  if (containerIds.length > 0) {
    const grandEdges = cg.getOutgoingEdgesFrom(containerIds, ['contains']);
    const grandNodes = cg.getNodesByIds(grandEdges.map((e) => e.target));
    for (const edge of grandEdges) {
      const child = grandNodes.get(edge.target);
      if (child) nested.push({ node: child, parentId: edge.source, depth: 2 });
    }
  }

  const all = [...direct, ...nested].sort(
    (a, b) => a.node.startLine - b.node.startLine || a.node.name.localeCompare(b.node.name)
  );
  const shown = all.slice(0, MAX_OUTLINE_NODES);

  // Two queries for the whole outline, not two per row: a file with 400
  // symbols would otherwise be 800 lookups behind one screen.
  const memberIds = shown.map((entry) => entry.node.id);
  const fanIn = cg.getFanIn(memberIds);
  const fanOut = cg.getFanOut(memberIds);

  return {
    items: shown.map((entry) => {
      const member: WireMember = {
        ...toNodeRef(entry.node),
        parentId: entry.parentId,
        depth: entry.depth,
        fanIn: fanIn.get(entry.node.id) ?? 0,
        fanOut: fanOut.get(entry.node.id) ?? 0,
      };
      const override = overrides?.get(entry.node.id);
      if (override) member.overrides = override;
      return member;
    }),
    total: all.length,
  };
}

// =============================================================================
// Test coverage
// =============================================================================

export interface WireTestSummary {
  /** A test file reaches this symbol within {@link TEST_CALLER_HOPS} caller hops. */
  reached: boolean;
  /** How many hops away the nearest test was. 1 = a test calls it directly. */
  hops: number | null;
  fileCount: number;
  files: string[];
  /**
   * The search finished rather than running out of budget. `false` weakens the
   * claim from "no test reaches this within 3 hops" to "no test calls this
   * directly", which is all that was actually checked.
   */
  exhaustive: boolean;
  hopsSearched: number;
}

/**
 * Which tests reach this symbol — the same question, and the same method,
 * behind `codegraph_explore`'s "tests:" line.
 *
 * Direct test callers first; failing that, walk up to two more caller hops,
 * because a helper called only by production code is still tested through
 * whatever calls it. The budget bounds a god-symbol, and running out of it is
 * reported rather than papered over: claiming "no test reaches this" after an
 * incomplete search would be exactly the kind of confident wrong answer the
 * viewer exists to avoid.
 */
function summarizeTestCallers(cg: CodeGraph, directCallers: readonly Node[]): WireTestSummary {
  const directFiles = [
    ...new Set(directCallers.map((n) => toPosixPath(n.filePath)).filter(isTestFile)),
  ];
  if (directFiles.length > 0) {
    return {
      reached: true,
      hops: 1,
      fileCount: directFiles.length,
      files: directFiles.slice(0, MAX_TEST_FILES),
      exhaustive: true,
      hopsSearched: 1,
    };
  }

  let budget = TEST_CALLER_BUDGET;
  const visited = new Set(directCallers.map((n) => n.id));
  let frontier: Node[] = [...directCallers];
  let hopsSearched = 1;

  for (let hop = 2; hop <= TEST_CALLER_HOPS && frontier.length > 0 && budget > 0; hop++) {
    hopsSearched = hop;
    const next: Node[] = [];
    const found = new Set<string>();
    for (const current of frontier) {
      if (budget-- <= 0) break;
      let callers: Array<{ node: Node }>;
      try {
        callers = cg.getCallers(current.id) as Array<{ node: Node }>;
      } catch {
        continue;
      }
      for (const caller of callers) {
        const source = caller?.node;
        if (!source || visited.has(source.id)) continue;
        visited.add(source.id);
        const file = toPosixPath(source.filePath);
        if (isTestFile(file)) found.add(file);
        else next.push(source);
      }
    }
    if (found.size > 0) {
      const files = [...found];
      return {
        reached: true,
        hops: hop,
        fileCount: files.length,
        files: files.slice(0, MAX_TEST_FILES),
        exhaustive: true,
        hopsSearched: hop,
      };
    }
    frontier = next;
  }

  return {
    reached: false,
    hops: null,
    fileCount: 0,
    files: [],
    exhaustive: budget > 0,
    hopsSearched,
  };
}

// =============================================================================
// References that leave the index
// =============================================================================

/**
 * Calls and type mentions from this symbol that never resolved to a node — a
 * third-party package, a runtime builtin, a construct extraction doesn't model.
 *
 * Without this the callee rail would silently be shorter than the body's call
 * sites, which reads as "nothing else happens here". Saying "+N calls into
 * symbols outside the index" is the honest version of the same screen.
 */
function summarizeOutsideIndex(
  cg: CodeGraph,
  nodeId: string
): {
  total: number;
  byKind: Record<string, number>;
  samples: Array<{ name: string; kind: string; line: number; col: number }>;
} {
  let refs;
  try {
    refs = cg.getUnresolvedReferencesFrom(nodeId);
  } catch {
    return { total: 0, byKind: {}, samples: [] };
  }

  const byKind: Record<string, number> = {};
  for (const ref of refs) byKind[ref.referenceKind] = (byKind[ref.referenceKind] ?? 0) + 1;

  const samples = [...refs]
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .slice(0, MAX_OUTSIDE_INDEX_SAMPLES)
    .map((ref) => ({
      name: ref.referenceName,
      kind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
    }));

  return { total: refs.length, byKind, samples };
}

// =============================================================================
// Blast radius
// =============================================================================

export interface WireBlastSummary {
  /** Distinct symbols that depend on this one directly. */
  direct: number;
  /** Distinct symbols reached within {@link BLAST_DEPTH} dependency hops. */
  withinHops: number;
  hops: number;
  files: number;
  testFiles: number;
  routes: number;
  /** Up to 40 of the dependent files, most-affected first, for the "what would need re-checking" fold. */
  topFiles: Array<{ file: string; symbols: number; test: boolean }>;
}

/**
 * What would need re-checking if this symbol changed.
 *
 * `getImpactRadius` at depth 3 is the engine's own answer to that question —
 * incoming dependencies only, `contains` excluded upward so a leaf symbol does
 * not explode into its whole class, container members expanded downward so
 * callers of a class's methods count against the class.
 */
function summarizeBlast(cg: CodeGraph, node: Node, direct: number): WireBlastSummary | null {
  let subgraph;
  try {
    subgraph = cg.getImpactRadius(node.id, BLAST_DEPTH);
  } catch {
    return null;
  }

  const perFile = new Map<string, number>();
  let routes = 0;
  for (const [id, dependent] of subgraph.nodes) {
    if (id === node.id) continue;
    const file = toPosixPath(dependent.filePath);
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    if (dependent.kind === ('route' as NodeKind)) routes++;
  }

  const testFiles = [...perFile.keys()].filter(isTestFile).length;
  const topFiles = [...perFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([file, symbols]) => ({ file, symbols, test: isTestFile(file) }));

  return {
    direct,
    withinHops: Math.max(0, subgraph.nodes.size - 1),
    hops: BLAST_DEPTH,
    files: perFile.size,
    testFiles,
    routes,
    topFiles,
  };
}

// =============================================================================
// Drift
// =============================================================================

function driftFor(cg: CodeGraph, projectRoot: string, filePath: string): boolean {
  const found = findIndexedFile(cg, filePath);
  if (!found) return false;
  return hasDriftedOnDisk(projectRoot, found.storedPath, found.record);
}
