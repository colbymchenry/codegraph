/**
 * The wire shapes the viewer reads, and the rules for producing them.
 *
 * Two ideas run through this file:
 *
 * 1. **One round-trip per screen.** Every endpoint returns everything a screen
 *    draws, in the spirit of `codegraph_explore`: the Symbol view never has to
 *    ask a follow-up question to render a rail, a badge or a count.
 * 2. **Capped lists, honest totals.** A symbol with 545 callers cannot ship 545
 *    rows, but it must never claim it has fewer. Every capped list carries the
 *    true `total` beside the `shown` slice, so the UI can say "+N more" rather
 *    than quietly truncating.
 *
 * Nothing here reads the filesystem — that lives in `source.ts`, behind
 * `resolveProjectFile`.
 */

import type { Edge, EdgeKind, Language, Node, NodeKind } from '../../types';
import { isTestFile } from '../../search/query-utils';

// =============================================================================
// Caps and thresholds
// =============================================================================

/**
 * Fan-in at or above which a symbol is a "hub" — changing it is a
 * repo-wide event. Matches the threshold the Symbol view's `hub · N` badge
 * uses (design spec §3.2).
 */
export const HUB_THRESHOLD = 40;

/**
 * Below this resolution confidence an edge is a name-only guess. The viewer
 * folds these away behind "Uncertain · N name-only matches, confidence < 0.6"
 * rather than mixing them into the rails as if they were resolved.
 */
export const UNCERTAIN_BELOW = 0.6;

/** Caller groups (one per calling symbol) returned for a node. */
export const MAX_INCOMING_GROUPS = 300;

/** Callee groups (one per called symbol) returned for a node. */
export const MAX_OUTGOING_GROUPS = 200;

/** Edges kept inside a single group — one symbol calling another 400 times. */
export const MAX_EDGES_PER_GROUP = 40;

/** Test files named in a node's test-caller summary (explore uses the same shape). */
export const MAX_TEST_FILES = 6;

/**
 * Dependency hops the blast-radius summary walks. Matches the depth
 * `codegraph_explore` claims when it says "within 3 hops".
 */
export const BLAST_DEPTH = 3;

/** Caller hops walked looking for a test. Mirrors `codegraph_explore`'s "tests:" line. */
export const TEST_CALLER_HOPS = 3;

/** `getCallers` lookups the test walk may spend, so a god-symbol can't stall a request. */
export const TEST_CALLER_BUDGET = 64;

/** Unresolved references listed by name before the payload just counts them. */
export const MAX_OUTSIDE_INDEX_SAMPLES = 40;

/** Symbols in a file outline. Beyond this the outline is truncated, not dropped. */
export const MAX_OUTLINE_NODES = 3000;

/** Files listed in each direction of the File view's import rails. */
export const MAX_IMPORT_FILES = 300;

// =============================================================================
// Node shapes
// =============================================================================

/**
 * A symbol as it appears in a rail, an outline or a search result: enough to
 * draw a row and navigate to it, and nothing else. Deliberately excludes the
 * docstring — a 300-caller rail would otherwise ship 300 docstrings.
 */
export interface WireNodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  /** Project-relative, forward slashes on every platform. */
  file: string;
  line: number;
  endLine: number;
  language: Language;
  signature?: string;
  exported?: boolean;
  /** The file this symbol lives in looks like test/fixture code. */
  test: boolean;
  /**
   * The file this symbol lives in is tool-generated, so the row draws in ink-4.
   *
   * OPTIONAL and absent by default: the verdict is a bounded lookup
   * (`generatedFilePredicate`), affordable over a screen's worth of rows and
   * not over a 545-caller rail. An endpoint fills it where it shows.
   */
  generated?: boolean;
}

/** The focal symbol of a Symbol view — the ref, plus everything the header shows. */
export interface WireNodeDetail extends WireNodeRef {
  startColumn: number;
  endColumn: number;
  docstring?: string;
  visibility?: string;
  async?: boolean;
  static?: boolean;
  abstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  /** `endLine - line + 1`, so the header can print "N lines" without the source. */
  lines: number;
}

const rel = (p: string): string => p.replace(/\\/g, '/');

export function toNodeRef(node: Node): WireNodeRef {
  const file = rel(node.filePath);
  const ref: WireNodeRef = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    file,
    line: node.startLine,
    endLine: node.endLine,
    language: node.language,
    test: isTestFile(file),
  };
  if (node.signature) ref.signature = node.signature;
  if (node.isExported) ref.exported = true;
  return ref;
}

export function toNodeDetail(node: Node): WireNodeDetail {
  const detail: WireNodeDetail = {
    ...toNodeRef(node),
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    lines: Math.max(1, node.endLine - node.startLine + 1),
  };
  if (node.docstring) detail.docstring = node.docstring;
  if (node.visibility) detail.visibility = node.visibility;
  if (node.isAsync) detail.async = true;
  if (node.isStatic) detail.static = true;
  if (node.isAbstract) detail.abstract = true;
  if (node.decorators?.length) detail.decorators = node.decorators;
  if (node.typeParameters?.length) detail.typeParameters = node.typeParameters;
  if (node.returnType) detail.returnType = node.returnType;
  return detail;
}

// =============================================================================
// Edge shapes
// =============================================================================

/**
 * One edge, flattened.
 *
 * `metadata` is a free-form JSON blob in the schema; the fields lifted out here
 * are the ones the viewer draws with — confidence decides the uncertain fold,
 * `provenance`/`synthesizedBy`/`via`/`registeredAt` decide how a connector is
 * dashed and what the "via <mechanism>" pill says, `valueRef` distinguishes
 * "passes as value" from "calls". Anything else in the blob stays out: it is
 * resolver bookkeeping, not something a reader can act on.
 */
export interface WireEdge {
  kind: EdgeKind;
  line?: number;
  col?: number;
  confidence?: number;
  resolvedBy?: string;
  provenance?: string;
  synthesizedBy?: string;
  via?: string;
  registeredAt?: string;
  valueRef?: boolean;
  /**
   * The conditions the call site runs under (`!isUploading && isCollected`),
   * read from the source at request time — see `graph/branch-guards.ts`.
   * Absent when the site is unconditional or the language has no rules.
   */
  when?: string;
}

export function toWireEdge(edge: Edge): WireEdge {
  const meta = (edge.metadata ?? {}) as Record<string, unknown>;
  const wire: WireEdge = { kind: edge.kind };
  if (typeof edge.line === 'number') wire.line = edge.line;
  if (typeof edge.column === 'number') wire.col = edge.column;
  if (typeof meta.confidence === 'number') wire.confidence = meta.confidence;
  if (typeof meta.resolvedBy === 'string') wire.resolvedBy = meta.resolvedBy;
  if (edge.provenance) wire.provenance = edge.provenance;
  if (typeof meta.synthesizedBy === 'string') wire.synthesizedBy = meta.synthesizedBy;
  if (typeof meta.via === 'string') wire.via = meta.via;
  if (typeof meta.registeredAt === 'string') wire.registeredAt = meta.registeredAt;
  if (meta.valueRef === true) wire.valueRef = true;
  return wire;
}

// =============================================================================
// Relations — edges grouped by the symbol at the other end
// =============================================================================

/**
 * Every edge between the focal symbol and ONE other symbol, as a single row.
 *
 * Grouping is what makes the rails readable: a helper called from eleven lines
 * of the same function is one row with eleven call-site chips, not eleven rows.
 */
export interface WireRelation {
  node: WireNodeRef;
  /** Distinct edge kinds between the two, in first-seen order. */
  edgeKinds: EdgeKind[];
  /** Up to {@link MAX_EDGES_PER_GROUP} edges, ordered by line. */
  edges: WireEdge[];
  /** True number of edges, even when `edges` was capped. */
  edgeCount: number;
  /** Distinct call-site lines, ascending — what the gutter ports anchor to. */
  lines: number[];
  /** Highest confidence any edge in the group carries; null when none does. */
  confidence: number | null;
  /** The whole group is a name-only guess (see {@link UNCERTAIN_BELOW}). */
  uncertain: boolean;
  /** At least one edge was synthesized rather than parsed (dynamic dispatch). */
  synthesized: boolean;
  /** Fan-in of the other symbol — the `hub · N` pill. Only filled where the UI shows it. */
  fanIn?: number;
  hub?: boolean;
}

/** A capped list that still knows how long it really is. */
export interface WireList<T> {
  total: number;
  shown: number;
  truncated: boolean;
  items: T[];
}

export function wireList<T>(items: T[], total: number): WireList<T> {
  return { total, shown: items.length, truncated: items.length < total, items };
}

/**
 * Fold edges into one relation per counterpart symbol.
 *
 * @param edges     edges all sharing the focal node at one end
 * @param endpoint  which end of each edge names the OTHER symbol
 * @param nodes     batch-resolved endpoint nodes (never a lookup per edge)
 */
export function groupRelations(
  edges: readonly Edge[],
  endpoint: (edge: Edge) => string,
  nodes: Map<string, Node>
): WireRelation[] {
  const byNode = new Map<string, Edge[]>();
  for (const edge of edges) {
    const id = endpoint(edge);
    const bucket = byNode.get(id);
    if (bucket) bucket.push(edge);
    else byNode.set(id, [edge]);
  }

  const relations: WireRelation[] = [];
  for (const [id, group] of byNode) {
    const node = nodes.get(id);
    // An edge whose endpoint is missing from `nodes` means the graph and the
    // node table disagree — skip it rather than invent a row. Callers still see
    // it in the totals they computed from the raw edge list.
    if (!node) continue;
    const ordered = [...group].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const wireEdges = ordered.slice(0, MAX_EDGES_PER_GROUP).map(toWireEdge);

    const edgeKinds: EdgeKind[] = [];
    for (const edge of ordered) if (!edgeKinds.includes(edge.kind)) edgeKinds.push(edge.kind);

    const lines = [
      ...new Set(ordered.map((e) => e.line).filter((l): l is number => typeof l === 'number' && l > 0)),
    ].sort((a, b) => a - b);

    let confidence: number | null = null;
    let synthesized = false;
    for (const edge of ordered) {
      const value = (edge.metadata as Record<string, unknown> | undefined)?.confidence;
      if (typeof value === 'number' && (confidence === null || value > confidence)) confidence = value;
      if (edge.provenance === 'heuristic') synthesized = true;
    }

    relations.push({
      node: toNodeRef(node),
      edgeKinds,
      edges: wireEdges,
      edgeCount: ordered.length,
      lines,
      confidence,
      // No confidence recorded is NOT uncertain: tree-sitter edges extracted
      // straight from the AST carry none precisely because they are certain.
      uncertain: confidence !== null && confidence < UNCERTAIN_BELOW,
      synthesized,
    });
  }
  return relations;
}

/** First call-site line of a relation, for line-anchored ordering. Unlined rows sort last. */
export function firstLine(relation: WireRelation): number {
  return relation.lines[0] ?? Number.MAX_SAFE_INTEGER;
}

/** Node kinds that count as "a type" for the Symbol view's "types used" chips. */
export const TYPE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'interface',
  'type_alias',
  'class',
  'struct',
  'enum',
  'union',
  'trait',
  'protocol',
]);

/** Container kinds whose members the outline nests one level deeper. */
export const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'file',
  'module',
  'namespace',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'enum',
  'union',
]);

/** The four edge kinds `getCallers` treats as "reaches this symbol". */
export const CALLER_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'calls',
  'references',
  'imports',
  'instantiates',
  'navigates',
]);

export { rel as toPosixPath };
