/**
 * Difference between two code graphs (two git refs), read by `codegraph diff`.
 *
 * Node ids are not comparable across graphs: they hash the start line, so a
 * line shift renames every symbol below it. Symbols are matched on
 * `(file, kind, qualified name)` instead, with an ordinal to tell apart
 * overloads that share one. This module is a pure function of plain snapshots,
 * so it needs neither git nor SQLite to test.
 */

export interface SnapshotNodeInput {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  signature?: string;
  returnType?: string;
  visibility?: string;
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  /** Hash of the symbol's source text, when the caller could compute one. */
  bodyHash?: string;
}

export interface SnapshotEdgeInput {
  source: string;
  target: string;
  kind: string;
}

export interface SnapNode {
  key: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  /** Attributes whose change makes the symbol "changed" (not merely moved). */
  shape: Record<string, string>;
}

export interface GraphSnapshot {
  nodes: Map<string, SnapNode>;
  /** Edge keys (see `edgeKey`) over symbol keys. */
  edges: Set<string>;
}

/** Kinds that describe structure rather than a symbol someone edits. */
const NON_SYMBOL_KINDS = new Set(['file', 'import', 'export', 'parameter']);
/** Edges that are scaffolding, not dependencies. */
const NON_DEPENDENCY_EDGES = new Set(['contains']);

// Symbol keys contain NULs, so edge keys use a different separator.
const EDGE_SEP = '\u0001';

export function edgeKey(source: string, kind: string, target: string): string {
  return `${source}${EDGE_SEP}${kind}${EDGE_SEP}${target}`;
}

export function parseEdgeKey(key: string): { source: string; kind: string; target: string } {
  const [source = '', kind = '', target = ''] = key.split(EDGE_SEP);
  return { source, kind, target };
}

/** Human-readable form of a symbol key. */
export function describeKey(key: string): string {
  const [file = '', kind = '', qn = ''] = key.split('\0');
  return `${qn.split('#')[0]} (${kind}, ${file})`;
}

function shapeOf(n: SnapshotNodeInput): Record<string, string> {
  const shape: Record<string, string> = {};
  if (n.signature) shape.signature = n.signature;
  if (n.returnType) shape.returnType = n.returnType;
  if (n.visibility) shape.visibility = n.visibility;
  if (n.isExported !== undefined) shape.exported = String(n.isExported);
  if (n.isAsync) shape.async = 'true';
  if (n.isStatic) shape.static = 'true';
  if (n.isAbstract) shape.abstract = 'true';
  if (n.decorators?.length) shape.decorators = n.decorators.join(',');
  if (n.bodyHash) shape.body = n.bodyHash;
  return shape;
}

export function buildSnapshot(
  nodes: readonly SnapshotNodeInput[],
  edges: readonly SnapshotEdgeInput[],
): GraphSnapshot {
  const idToKey = new Map<string, string>();
  const out = new Map<string, SnapNode>();
  const ordered = nodes
    .filter((n) => !NON_SYMBOL_KINDS.has(n.kind))
    .slice()
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.id.localeCompare(b.id));
  const seen = new Map<string, number>();
  for (const n of ordered) {
    const base = `${n.filePath}\0${n.kind}\0${n.qualifiedName}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    // Ordinal only when a name repeats, so the common key stays readable.
    const key = ordinal === 0 ? base : `${base}#${ordinal}`;
    idToKey.set(n.id, key);
    out.set(key, {
      key,
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      filePath: n.filePath,
      startLine: n.startLine,
      shape: shapeOf(n),
    });
  }
  const edgeSet = new Set<string>();
  for (const e of edges) {
    if (NON_DEPENDENCY_EDGES.has(e.kind)) continue;
    const s = idToKey.get(e.source);
    const t = idToKey.get(e.target);
    if (s && t && s !== t) edgeSet.add(edgeKey(s, e.kind, t));
  }
  return { nodes: out, edges: edgeSet };
}

export interface ChangedSymbol {
  key: string;
  /** Names of the attributes that differ, e.g. `signature`, `body`. */
  fields: string[];
  before: SnapNode;
  after: SnapNode;
}

export interface GraphDiff {
  added: SnapNode[];
  removed: SnapNode[];
  changed: ChangedSymbol[];
  /** Same symbol, same shape, different line only. Counted, never listed. */
  movedCount: number;
  edgesAdded: string[];
  edgesRemoved: string[];
}

export function diffGraphs(before: GraphSnapshot, after: GraphSnapshot): GraphDiff {
  const added: SnapNode[] = [];
  const removed: SnapNode[] = [];
  const changed: ChangedSymbol[] = [];
  let movedCount = 0;

  for (const [key, node] of after.nodes) {
    const prev = before.nodes.get(key);
    if (!prev) {
      added.push(node);
      continue;
    }
    const fields = changedFields(prev.shape, node.shape);
    if (fields.length > 0) changed.push({ key, fields, before: prev, after: node });
    else if (prev.startLine !== node.startLine) movedCount += 1;
  }
  for (const [key, node] of before.nodes) if (!after.nodes.has(key)) removed.push(node);

  const edgesAdded = [...after.edges].filter((e) => !before.edges.has(e)).sort();
  const edgesRemoved = [...before.edges].filter((e) => !after.edges.has(e)).sort();
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  return {
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    changed: changed.sort(byKey),
    movedCount,
    edgesAdded,
    edgesRemoved,
  };
}

/**
 * The snapshot you would get by making `diff`'s change on top of `snap`. Used
 * to replay a run of commits one after another without checking anything out:
 * what an earlier commit introduced is then there for the next one to use.
 * Moves are ignored (a line number is not part of what a caller depends on).
 */
export function applyDiff(snap: GraphSnapshot, diff: GraphDiff): GraphSnapshot {
  const nodes = new Map(snap.nodes);
  for (const n of diff.removed) nodes.delete(n.key);
  for (const n of diff.added) nodes.set(n.key, n);
  for (const c of diff.changed) nodes.set(c.key, c.after);
  const edges = new Set(snap.edges);
  for (const e of diff.edgesRemoved) edges.delete(e);
  for (const e of diff.edgesAdded) edges.add(e);
  return { nodes, edges };
}

function changedFields(a: Record<string, string>, b: Record<string, string>): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((n) => a[n] !== b[n]).sort();
}

/** Attributes that change what a caller sees, as opposed to the body. */
export const CONTRACT_FIELDS = ['signature', 'returnType', 'visibility', 'exported', 'static', 'abstract', 'async'];

export function changesContract(c: ChangedSymbol): boolean {
  return c.fields.some((f) => CONTRACT_FIELDS.includes(f));
}
