/**
 * The type hierarchy — one derivation of "what is above this type, what is
 * below it, and what a call through it can land on".
 *
 * Three surfaces ask that question. The viewer draws it as a tree above the
 * members outline (design spec §3.10). `codegraph_explore` announces it as an
 * interface-dispatch boundary ("`execute` → runtime dispatch to **611** types
 * implementing `INodeType`"). `codegraph_node` shows the same relations as
 * chips. Three derivations would eventually disagree about the ONE number that
 * matters — how many implementations a call can reach — and a reader holding
 * two of them has no way to tell which is lying. So the walk lives here once,
 * and each caller renders it: `src/ui-server/api/node.ts` turns it into
 * `WireHierarchy`, `ToolHandler.buildPolymorphicBoundaries` into prose.
 *
 * Everything here is query-time and read-only. No edge is invented: the tree is
 * exactly the `extends`/`implements` edges the graph holds, and the one thing
 * that is *derived* — which members override an ancestor's — is derived by name
 * within a chain the graph already links, and is labelled as a match rather
 * than as an `overrides` edge (nothing in the engine emits one).
 *
 * ## Why the fan is the interesting direction
 *
 * Ancestors are a fact about the code you are reading: `class X extends Y` is
 * written on line 1. Descendants are a fact you cannot get from the file at
 * all — the implementations of an interface live anywhere in the repo, and they
 * are precisely what a call through that interface dispatches to. Go makes this
 * sharpest: `System` and `Fixed` satisfy `Clock` without either file naming the
 * other, and the `implements` edge that links them is synthesized by the
 * resolver (`synthesizedBy: 'go-implements'`). So the fan carries its own
 * provenance and the caller draws a synthesized hop differently — the same
 * honesty rule the Flow strip's dashed connectors follow.
 */

import type CodeGraph from '../index';
import type { Edge, EdgeKind, Node, NodeKind } from '../types';

/** The two edge kinds that make a type hierarchy. Nothing else is a subtype. */
export const HIERARCHY_EDGE_KINDS: readonly EdgeKind[] = ['extends', 'implements'];

/**
 * Kinds that can sit in a type hierarchy.
 *
 * `type_alias` is in deliberately — TypeScript's `interface A extends B` and
 * Rust's associated types both land here, and an alias with subtypes is a real
 * hierarchy however it was spelled. `enum` is in for Java/Kotlin/Swift, where an
 * enum implements interfaces.
 */
export const HIERARCHY_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'class',
  'interface',
  'struct',
  'trait',
  'protocol',
  'enum',
  'type_alias',
  'union',
]);

/** Member kinds an override can be declared on. */
const OVERRIDABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'method',
  'function',
  'property',
  'field',
]);

/** Levels walked upward. A chain deeper than this is a generated-code artefact. */
export const MAX_ANCESTOR_DEPTH = 8;

/** Levels walked downward. Depth, not breadth — the fan itself is capped separately. */
export const MAX_DESCENDANT_DEPTH = 6;

/**
 * Subtypes returned across the whole downward walk.
 *
 * A framework base class can have thousands, and the caller caps again for
 * display; this bound is what stops the *query* from walking them. When it
 * bites, {@link TypeHierarchy.bounded} says so — a fan that quietly stopped at
 * 400 would read as a complete answer.
 */
export const MAX_DESCENDANTS = 400;

/** Ancestors whose members are read when matching overrides. */
const MAX_OVERRIDE_ANCESTORS = 12;

/**
 * Implementations at or above which a call through the type cannot be resolved
 * statically at all — the same threshold `codegraph_explore` uses before it
 * announces an interface-dispatch boundary.
 */
export const DISPATCH_MIN_IMPLEMENTERS = 8;

// =============================================================================
// Shapes
// =============================================================================

/** How a subtype is tied to the type above it. */
export type HierarchyRelation = 'extends' | 'implements';

/** One type in the tree, and the single edge that puts it there. */
export interface HierarchyEntry {
  node: Node;
  /** Steps from the focus. 1 = declared directly on the focus (either way). */
  depth: number;
  /**
   * The entry one step NEARER the focus — the row this one hangs off when the
   * tree is drawn. The focus's own id for a depth-1 entry.
   */
  parentId: string;
  relation: HierarchyRelation;
  /** The edge itself, always oriented subtype → supertype as the code declares it. */
  edge: Edge;
  /**
   * The edge was synthesized rather than parsed — Go's implicit interface
   * satisfaction, a framework registry. Drawn dashed, with its wiring site.
   */
  synthesized: boolean;
  /** Direct subtypes this entry has that are NOT in the returned set. */
  hiddenSubtypes: number;
}

/** A member of the focus that redeclares a member of one of its ancestors. */
export interface OverrideMatch {
  /** The member on the focus. */
  memberId: string;
  /** The member it redeclares. */
  baseId: string;
  /** The ancestor type that declares {@link baseId}. */
  baseTypeId: string;
  baseTypeName: string;
  /** How the focus reaches that ancestor — `implements` reads as "satisfies". */
  relation: HierarchyRelation;
}

/** What is above a type, what is below it, and what a call through it reaches. */
export interface TypeHierarchy {
  focus: Node;
  /** Supertypes, nearest first. Ordered so the focus's own parents lead. */
  ancestors: HierarchyEntry[];
  /** Subtypes, breadth-first, so depth 1 is complete before depth 2 begins. */
  descendants: HierarchyEntry[];
  /** True number of DIRECT subtypes, whatever `descendants` was capped to. */
  directSubtypes: number;
  /** Of {@link directSubtypes}, the ones tied by `implements`. */
  directImplementers: number;
  /**
   * The downward walk hit {@link MAX_DESCENDANTS} or {@link MAX_DESCENDANT_DEPTH}
   * — subtypes exist that are not in `descendants`.
   */
  bounded: boolean;
  /**
   * A call through this type dispatches at runtime rather than to one target.
   * `directImplementers >= DISPATCH_MIN_IMPLEMENTERS`.
   */
  polymorphic: boolean;
  /** Members of the focus that redeclare an ancestor's, keyed by member id. */
  overrides: Map<string, OverrideMatch>;
}

// =============================================================================
// The walk
// =============================================================================

/**
 * Whether a node could have a hierarchy at all.
 *
 * Cheap enough to gate on before doing any work: a function never has one, and
 * the overwhelming majority of symbols a reader opens are functions.
 */
export function canHaveHierarchy(node: Node): boolean {
  return HIERARCHY_KINDS.has(node.kind);
}

/**
 * The whole hierarchy of one type.
 *
 * Cost is one query per level in each direction plus one batched member read,
 * never one per node — a base class with 400 subtypes is 2–3 queries, not 400.
 *
 * Returns `null` when the node cannot have a hierarchy or has no
 * `extends`/`implements` edge in either direction, so a caller can gate on the
 * return value rather than on the emptiness of three lists.
 */
export function buildTypeHierarchy(
  cg: CodeGraph,
  focus: Node,
  options: { overrides?: boolean } = {}
): TypeHierarchy | null {
  if (!canHaveHierarchy(focus)) return null;

  const ancestors = walkAncestors(cg, focus);
  const down = walkDescendants(cg, focus);
  if (ancestors.length === 0 && down.entries.length === 0) return null;

  return {
    focus,
    ancestors,
    descendants: down.entries,
    directSubtypes: down.directTotal,
    directImplementers: down.directImplementers,
    bounded: down.bounded,
    polymorphic: down.directImplementers >= DISPATCH_MIN_IMPLEMENTERS,
    overrides: options.overrides === false ? new Map() : matchOverrides(cg, focus, ancestors),
  };
}

/**
 * Walk up. Multiple direct parents are normal (a class extends one and
 * implements three), so this is a BFS rather than a chain, ordered nearest
 * first and — within a level — `extends` before `implements`, because the one
 * that carries the implementation is the one a reader wants adjacent.
 */
function walkAncestors(cg: CodeGraph, focus: Node): HierarchyEntry[] {
  const out: HierarchyEntry[] = [];
  const seen = new Set<string>([focus.id]);
  let frontier = [focus.id];

  for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
    const edges = hierarchyEdges(cg, frontier, 'up');
    if (edges.length === 0) break;
    const nodes = cg.getNodesByIds(edges.map((e) => e.target));

    const level: HierarchyEntry[] = [];
    for (const edge of edges) {
      const node = nodes.get(edge.target);
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      level.push(toEntry(node, depth, edge.source, edge));
    }
    sortLevel(level);
    out.push(...level);
    frontier = level.map((e) => e.node.id);
  }

  return out;
}

/**
 * Walk down — the fan. Breadth-first so the cap always trims the deepest,
 * least-relevant end: a reader looking at an interface wants its direct
 * implementations complete before a subclass of a subclass appears at all.
 */
function walkDescendants(cg: CodeGraph, focus: Node): {
  entries: HierarchyEntry[];
  directTotal: number;
  directImplementers: number;
  bounded: boolean;
} {
  const entries: HierarchyEntry[] = [];
  const byId = new Map<string, HierarchyEntry>();
  const seen = new Set<string>([focus.id]);
  let frontier = [focus.id];
  let directTotal = 0;
  let directImplementers = 0;
  let bounded = false;

  for (let depth = 1; depth <= MAX_DESCENDANT_DEPTH && frontier.length > 0; depth++) {
    const edges = hierarchyEdges(cg, frontier, 'down');
    if (edges.length === 0) break;
    const nodes = cg.getNodesByIds(edges.map((e) => e.source));

    // One row per subtype, not per edge: a class tied to its supertype by both
    // a parsed `extends` and a synthesized `implements` is ONE implementation.
    // `extends` wins the relation because it is the one written in the file.
    const level: HierarchyEntry[] = [];
    const overflow = new Map<string, number>();
    const levelSeen = new Set<string>();
    for (const edge of edges) {
      const node = nodes.get(edge.source);
      if (!node || seen.has(node.id)) continue;
      const existing = levelSeen.has(node.id)
        ? level.find((e) => e.node.id === node.id)
        : undefined;
      if (existing) {
        if (existing.relation === 'implements' && edge.kind === 'extends') {
          existing.relation = 'extends';
          existing.edge = edge;
          existing.synthesized = edge.provenance === 'heuristic';
        }
        continue;
      }
      if (depth === 1) {
        directTotal++;
        if (edge.kind === 'implements') directImplementers++;
      }
      if (entries.length + level.length >= MAX_DESCENDANTS) {
        // Stop materialising rows, but keep counting depth 1 so
        // `directSubtypes` stays the true number.
        bounded = true;
        overflow.set(edge.target, (overflow.get(edge.target) ?? 0) + 1);
        levelSeen.add(node.id);
        continue;
      }
      levelSeen.add(node.id);
      level.push(toEntry(node, depth, edge.target, edge));
    }
    for (const entry of level) seen.add(entry.node.id);
    sortLevel(level);
    for (const entry of level) {
      entries.push(entry);
      byId.set(entry.node.id, entry);
    }
    for (const [parentId, count] of overflow) {
      const parent = byId.get(parentId);
      if (parent) parent.hiddenSubtypes += count;
    }
    if (bounded) break;

    frontier = level.map((e) => e.node.id);
    if (depth === MAX_DESCENDANT_DEPTH && frontier.length > 0) {
      // A level exists below the one we are about to stop at. Say so rather
      // than letting the deepest row read as a leaf.
      for (const edge of hierarchyEdges(cg, frontier, 'down')) {
        if (seen.has(edge.source)) continue;
        bounded = true;
        const parent = byId.get(edge.target);
        if (parent) parent.hiddenSubtypes++;
      }
    }
  }

  return { entries, directTotal, directImplementers, bounded };
}

/** One batched edge read per level, filtered to the two hierarchy kinds. */
function hierarchyEdges(cg: CodeGraph, ids: readonly string[], direction: 'up' | 'down'): Edge[] {
  const kinds = [...HIERARCHY_EDGE_KINDS];
  try {
    const edges =
      direction === 'up'
        ? cg.getOutgoingEdgesFrom(ids, kinds)
        : cg.getIncomingEdgesTo(ids, kinds);
    // Belt and braces: the kind filter is applied in SQL, but a caller reading
    // `entry.relation` must never see a third value.
    return edges.filter((e) => e.kind === 'extends' || e.kind === 'implements');
  } catch {
    return [];
  }
}

function toEntry(node: Node, depth: number, parentId: string, edge: Edge): HierarchyEntry {
  return {
    node,
    depth,
    parentId,
    relation: edge.kind === 'implements' ? 'implements' : 'extends',
    edge,
    synthesized: edge.provenance === 'heuristic',
    hiddenSubtypes: 0,
  };
}

/**
 * Deterministic order within one level: `extends` first, then by name, then by
 * file. Never by insertion — two runs against the same index must draw the same
 * tree, and SQLite's row order is not a promise.
 */
function sortLevel(level: HierarchyEntry[]): void {
  level.sort(
    (a, b) =>
      (a.relation === b.relation ? 0 : a.relation === 'extends' ? -1 : 1) ||
      a.node.name.localeCompare(b.node.name) ||
      a.node.filePath.localeCompare(b.node.filePath) ||
      a.node.startLine - b.node.startLine
  );
}

// =============================================================================
// Overrides
// =============================================================================

/**
 * Which of the focus's members redeclare an ancestor's.
 *
 * Nothing in the engine emits an `overrides` edge (the kind exists in the
 * schema and no extractor writes one), so this is a NAME match — but a name
 * match inside a chain the graph already established, which is exactly what
 * every language's dispatch rule is. It is reported as a match against a named
 * base member the reader can open, never as an edge, and it is deliberately
 * blind to signatures: an overload set would need type resolution the graph
 * does not have, and claiming "overrides" for the wrong overload is worse than
 * saying which type also declares this name.
 *
 * Two batched queries total, whatever the ancestor count.
 */
function matchOverrides(
  cg: CodeGraph,
  focus: Node,
  ancestors: readonly HierarchyEntry[]
): Map<string, OverrideMatch> {
  const result = new Map<string, OverrideMatch>();
  if (ancestors.length === 0) return result;

  const ownMembers = membersOf(cg, [focus.id]);
  if (ownMembers.length === 0) return result;

  // Nearest ancestors win: a method redeclared two levels up is still reported
  // against the type the reader would actually look in.
  const chain = ancestors.slice(0, MAX_OVERRIDE_ANCESTORS);
  const baseMembers = membersOf(
    cg,
    chain.map((a) => a.node.id)
  );
  if (baseMembers.length === 0) return result;

  const ancestorById = new Map(chain.map((a) => [a.node.id, a] as const));
  const byName = new Map<string, { member: Node; ownerId: string }>();
  // `chain` is nearest-first and `membersOf` preserves the order of the ids it
  // was given, so the first entry for a name is the nearest declaration.
  for (const { member, ownerId } of baseMembers) {
    if (!byName.has(member.name)) byName.set(member.name, { member, ownerId });
  }

  for (const { member } of ownMembers) {
    if (!OVERRIDABLE_KINDS.has(member.kind)) continue;
    const base = byName.get(member.name);
    if (!base || base.member.id === member.id) continue;
    const owner = ancestorById.get(base.ownerId);
    if (!owner) continue;
    result.set(member.id, {
      memberId: member.id,
      baseId: base.member.id,
      baseTypeId: owner.node.id,
      baseTypeName: owner.node.name,
      relation: owner.relation,
    });
  }

  return result;
}

/** Direct `contains` children of the given containers, in the containers' order. */
function membersOf(
  cg: CodeGraph,
  containerIds: readonly string[]
): Array<{ member: Node; ownerId: string }> {
  if (containerIds.length === 0) return [];
  let edges: Edge[];
  try {
    edges = cg.getOutgoingEdgesFrom(containerIds, ['contains']);
  } catch {
    return [];
  }
  if (edges.length === 0) return [];
  const nodes = cg.getNodesByIds(edges.map((e) => e.target));

  const rank = new Map(containerIds.map((id, i) => [id, i] as const));
  const out: Array<{ member: Node; ownerId: string }> = [];
  for (const edge of edges) {
    const member = nodes.get(edge.target);
    if (member) out.push({ member, ownerId: edge.source });
  }
  out.sort(
    (a, b) =>
      (rank.get(a.ownerId) ?? 0) - (rank.get(b.ownerId) ?? 0) ||
      a.member.startLine - b.member.startLine
  );
  return out;
}

// =============================================================================
// The fan, on its own
// =============================================================================

/**
 * How many distinct types extend or implement this one — the number
 * `codegraph_explore` prints when it announces an interface dispatch and the
 * number the viewer's fan draws.
 *
 * DISTINCT types, not edges: a class tied to a supertype by both an `extends`
 * and a synthesized `implements` edge is one implementation, and a count that
 * disagrees with the length of the list beside it is the bug this function
 * exists to prevent.
 */
export function countImplementers(cg: CodeGraph, typeId: string): number {
  try {
    const edges = cg.getIncomingEdgesTo([typeId], [...HIERARCHY_EDGE_KINDS]);
    return new Set(edges.map((e) => e.source)).size;
  } catch {
    return 0;
  }
}
