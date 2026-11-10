/**
 * Will a commit still make sense when it is applied somewhere else?
 *
 * A cherry-pick replays one commit's change onto a branch that may lack what
 * the commit was written against. Git only checks that the text applies. This
 * checks the graph: does everything the commit starts to use, or edits, exist
 * on the target, in the shape the commit expects? Pure over snapshots, like
 * `graph-diff.ts`.
 */
import { diffGraphs, parseEdgeKey, type GraphDiff, type GraphSnapshot } from './graph-diff';
import { analyzeMerge, type SemanticConflict } from './merge-conflicts';

export type MissingKind =
  | 'absent' // the commit uses a symbol the target does not have
  | 'contract-changed' // the target has it, but with a different signature than the commit saw
  | 'edits-absent'; // the commit edits a symbol the target does not have

export interface MissingDependency {
  kind: MissingKind;
  /** Symbol key on which the commit depends. */
  key: string;
  /** Symbol keys, in the commit, that use it. Empty for edits-absent. */
  usedBy: string[];
}

export interface CherryPickAnalysis {
  /** What the commit changes relative to its parent. */
  change: GraphDiff;
  missing: MissingDependency[];
  /** Conflicts that are not already explained by a missing dependency. */
  conflicts: SemanticConflict[];
}

export function analyzeCherryPick(
  parent: GraphSnapshot,
  commit: GraphSnapshot,
  onto: GraphSnapshot,
): CherryPickAnalysis {
  const change = diffGraphs(parent, commit);
  const missing: MissingDependency[] = [];

  // Symbols the commit itself introduces travel with it, so only what it
  // reaches that already existed in its parent can be missing.
  const introduced = new Set(change.added.map((n) => n.key));
  const usedBy = new Map<string, Set<string>>();
  for (const e of change.edgesAdded) {
    const { source, target } = parseEdgeKey(e);
    if (introduced.has(target) || !parent.nodes.has(target)) continue;
    let set = usedBy.get(target);
    if (!set) usedBy.set(target, (set = new Set()));
    set.add(source);
  }
  for (const [key, users] of usedBy) {
    const there = onto.nodes.get(key);
    const expected = parent.nodes.get(key)!;
    if (!there) {
      missing.push({ kind: 'absent', key, usedBy: [...users].sort() });
    } else if (shapeSignature(there.shape) !== shapeSignature(expected.shape)) {
      missing.push({ kind: 'contract-changed', key, usedBy: [...users].sort() });
    }
  }
  for (const c of change.changed) {
    if (!onto.nodes.has(c.key)) missing.push({ kind: 'edits-absent', key: c.key, usedBy: [] });
  }
  missing.sort((a, b) => a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind));

  // The target as "side b": it removing or re-contracting something the
  // commit starts using is the same finding as a missing dependency.
  const covered = new Set(missing.map((m) => m.key));
  const conflicts = analyzeMerge(parent, commit, onto).conflicts.filter(
    (c) => !(c.kind === 'broken-caller' && c.side === 'b') || !covered.has(c.key),
  );

  return { change, missing, conflicts };
}

/** Signature and visibility are the parts a caller depends on; the body is not. */
function shapeSignature(shape: Record<string, string>): string {
  const { body: _body, ...contract } = shape;
  return JSON.stringify(Object.entries(contract).sort(([a], [b]) => a.localeCompare(b)));
}

export type CherryPickVerdict = 'safe' | 'missing-dependencies' | 'conflicts';

export function verdictOf(a: CherryPickAnalysis, textualConflict: boolean | null): CherryPickVerdict {
  if (a.conflicts.length > 0 || textualConflict) return 'conflicts';
  if (a.missing.length > 0) return 'missing-dependencies';
  return 'safe';
}
