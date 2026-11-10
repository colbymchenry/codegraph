/**
 * Run the merge analysis of `codegraph diff` for every branch against one
 * target and rank the results, so "which of these branches is safe to merge
 * into main" is one command. Snapshots are memoized by sha for the run: the
 * target and any shared merge-base are built once however many branches use them.
 */
import { listLocalBranches, mergeBase, resolveRef, textualMergeConflicts } from '../sync/git-refs';
import { describeKey, type GraphSnapshot } from './graph-diff';
import { analyzeMerge, type SemanticConflict } from './merge-conflicts';
import { snapshotOfCommit } from './ref-graph';

export type SweepStatus =
  | 'semantic-conflict' // merges textually (or not) but breaks the program
  | 'textual-conflict' // git itself would stop
  | 'clean'
  | 'up-to-date' // nothing on the branch that the target lacks
  | 'no-common-history';

export interface SweepEntry {
  branch: string;
  sha: string;
  status: SweepStatus;
  textualConflict: boolean | null;
  /** Symbols the branch adds / removes / changes relative to the merge-base. */
  added: number;
  removed: number;
  changed: number;
  conflicts: SemanticConflict[];
}

export interface SweepResult {
  target: string;
  targetSha: string;
  entries: SweepEntry[];
  /** Branches left out because of `limit`. */
  skipped: string[];
}

const RANK: Record<SweepStatus, number> = {
  'semantic-conflict': 0,
  'textual-conflict': 1,
  'no-common-history': 2,
  clean: 3,
  'up-to-date': 4,
};

export function rankSweep(entries: readonly SweepEntry[]): SweepEntry[] {
  return entries
    .slice()
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        b.conflicts.length - a.conflicts.length ||
        a.branch.localeCompare(b.branch),
    );
}

export interface SweepOptions {
  /** Glob over branch names (`*`, `?`). Default: every local branch. */
  branches?: string;
  /** Most branches to analyse, newest commit first. Default 20. */
  limit?: number;
  onProgress?: (message: string) => void;
}

export async function sweepBranches(repoRoot: string, target: string, options: SweepOptions = {}): Promise<SweepResult> {
  const targetSha = resolveRef(repoRoot, target);
  if (!targetSha) throw new Error(`Cannot resolve ${target} to a commit`);

  const limit = options.limit ?? 20;
  const all = listLocalBranches(repoRoot, options.branches).filter((b) => resolveRef(repoRoot, b) !== null);
  // Skip the target itself, by name and by the commit it points at.
  const candidates = all.filter((b) => b !== target && resolveRef(repoRoot, b) !== targetSha);
  const chosen = candidates.slice(0, limit);
  const skipped = candidates.slice(limit);

  const memo = new Map<string, Promise<GraphSnapshot>>();
  const snap = (sha: string): Promise<GraphSnapshot> => {
    let p = memo.get(sha);
    if (!p) memo.set(sha, (p = snapshotOfCommit(repoRoot, sha, options.onProgress)));
    return p;
  };

  const entries: SweepEntry[] = [];
  for (const [i, branch] of chosen.entries()) {
    options.onProgress?.(`[${i + 1}/${chosen.length}] ${branch}`);
    const sha = resolveRef(repoRoot, branch)!;
    const base = mergeBase(repoRoot, targetSha, sha);
    if (!base) {
      entries.push({ branch, sha, status: 'no-common-history', textualConflict: null, added: 0, removed: 0, changed: 0, conflicts: [] });
      continue;
    }
    // Nothing on the branch that the target lacks: already merged.
    if (base === sha) {
      entries.push({ branch, sha, status: 'up-to-date', textualConflict: false, added: 0, removed: 0, changed: 0, conflicts: [] });
      continue;
    }
    const [baseSnap, targetSnap, branchSnap] = [await snap(base), await snap(targetSha), await snap(sha)];
    const analysis = analyzeMerge(baseSnap, targetSnap, branchSnap);
    const textual = textualMergeConflicts(repoRoot, targetSha, sha);
    const status: SweepStatus =
      analysis.conflicts.length > 0 ? 'semantic-conflict' : textual ? 'textual-conflict' : 'clean';
    entries.push({
      branch,
      sha,
      status,
      textualConflict: textual,
      added: analysis.b.added.length,
      removed: analysis.b.removed.length,
      changed: analysis.b.changed.length,
      conflicts: analysis.conflicts,
    });
  }
  return { target, targetSha, entries: rankSweep(entries), skipped };
}

/** One-line summary of a conflict, for the table. */
export function summarizeConflict(c: SemanticConflict): string {
  return `${c.kind}: ${describeKey(c.key)}`;
}
