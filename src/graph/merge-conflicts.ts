/**
 * Semantic conflicts between two lines of work, found by comparing each
 * side's graph change against their merge-base. A textual merge can be clean
 * and still leave the program broken: one side renames a function while the
 * other adds a call to it. Pure over snapshots, like `graph-diff.ts`.
 */
import {
  changesContract,
  describeKey,
  diffGraphs,
  parseEdgeKey,
  type GraphDiff,
  type GraphSnapshot,
} from './graph-diff';

export type ConflictKind =
  | 'both-changed' // same symbol edited differently on both sides
  | 'broken-caller' // one side removes / re-contracts a symbol the other starts using
  | 'delete-vs-edit'; // one side deletes a file's symbols, the other edits them

export interface SemanticConflict {
  kind: ConflictKind;
  /** Symbol key the conflict is about. */
  key: string;
  /** Which side made the breaking change; `both` for both-changed. */
  side: 'a' | 'b' | 'both';
  message: string;
  /** Symbol keys on the other side that depend on it (broken-caller only). */
  dependents: string[];
}

export interface MergeAnalysis {
  a: GraphDiff;
  b: GraphDiff;
  conflicts: SemanticConflict[];
}

export function analyzeMerge(base: GraphSnapshot, a: GraphSnapshot, b: GraphSnapshot): MergeAnalysis {
  const da = diffGraphs(base, a);
  const db = diffGraphs(base, b);
  const conflicts: SemanticConflict[] = [
    ...bothChanged(da, db),
    ...brokenCallers(da, db, 'a'),
    ...brokenCallers(db, da, 'b'),
    ...deleteVsEdit(base, a, da, db, 'a'),
    ...deleteVsEdit(base, b, db, da, 'b'),
  ];
  conflicts.sort((x, y) => x.key.localeCompare(y.key) || x.kind.localeCompare(y.kind));
  return { a: da, b: db, conflicts };
}

function bothChanged(da: GraphDiff, db: GraphDiff): SemanticConflict[] {
  const out: SemanticConflict[] = [];
  const bChanged = new Map(db.changed.map((c) => [c.key, c]));
  for (const c of da.changed) {
    const other = bChanged.get(c.key);
    if (!other) continue;
    // Both sides arrived at the same result: nothing to reconcile.
    const same = JSON.stringify(c.after.shape) === JSON.stringify(other.after.shape);
    if (same) continue;
    out.push({
      kind: 'both-changed',
      key: c.key,
      side: 'both',
      message: `${describeKey(c.key)} is edited on both sides (${[...new Set([...c.fields, ...other.fields])].join(', ')})`,
      dependents: [],
    });
  }
  return out;
}

/**
 * `breaker` removes or re-contracts a symbol; `other` adds a dependency on it.
 * The new dependency exists only in `other`'s graph, so it is found among the
 * edges `other` added, not among the edges of the breaker's graph.
 */
function brokenCallers(breaker: GraphDiff, other: GraphDiff, side: 'a' | 'b'): SemanticConflict[] {
  const broken = new Map<string, string>();
  for (const r of breaker.removed) broken.set(r.key, 'removed');
  for (const c of breaker.changed) if (changesContract(c)) broken.set(c.key, `changed (${c.fields.join(', ')})`);
  if (broken.size === 0) return [];

  const dependents = new Map<string, string[]>();
  for (const e of other.edgesAdded) {
    const { source, target } = parseEdgeKey(e);
    if (!broken.has(target)) continue;
    const list = dependents.get(target) ?? [];
    list.push(source);
    dependents.set(target, list);
  }
  const out: SemanticConflict[] = [];
  for (const [key, callers] of dependents) {
    out.push({
      kind: 'broken-caller',
      key,
      side,
      message: `${describeKey(key)} is ${broken.get(key)} on side ${side}, but the other side adds ${callers.length} use(s) of it`,
      dependents: [...new Set(callers)].sort(),
    });
  }
  return out;
}

function deleteVsEdit(
  base: GraphSnapshot,
  deleterAfter: GraphSnapshot,
  deleter: GraphDiff,
  editor: GraphDiff,
  side: 'a' | 'b',
): SemanticConflict[] {
  const baseFiles = new Map<string, number>();
  for (const n of base.nodes.values()) baseFiles.set(n.filePath, (baseFiles.get(n.filePath) ?? 0) + 1);
  const removedPerFile = new Map<string, number>();
  for (const r of deleter.removed) removedPerFile.set(r.filePath, (removedPerFile.get(r.filePath) ?? 0) + 1);
  // A file the deleter still has symbols in was rewritten, not deleted: a
  // rename inside it removes every old symbol too.
  const filesLeft = new Set<string>();
  for (const n of deleterAfter.nodes.values()) filesLeft.add(n.filePath);

  const editedFiles = new Set<string>();
  for (const n of editor.added) editedFiles.add(n.filePath);
  for (const c of editor.changed) editedFiles.add(c.after.filePath);

  const out: SemanticConflict[] = [];
  for (const [file, removed] of removedPerFile) {
    if (removed !== baseFiles.get(file) || filesLeft.has(file) || !editedFiles.has(file)) continue;
    out.push({
      kind: 'delete-vs-edit',
      key: `${file}\0file\0${file}`,
      side,
      message: `${file} loses all its symbols on side ${side}, but the other side edits it`,
      dependents: [],
    });
  }
  return out;
}
