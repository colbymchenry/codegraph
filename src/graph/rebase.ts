/**
 * Replaying a branch's commits onto a new base, in graph terms.
 *
 * `git rebase` applies the commits one at a time and stops when the text will
 * not apply. It cannot tell that commit 3 now calls something the new base
 * removed. Each commit is checked as a cherry-pick onto "the new base plus the
 * commits already replayed", so what an earlier commit introduced is there for
 * the next one. Pure over snapshots; the git side is `rebase-run.ts`.
 */
import { analyzeCherryPick, verdictOf, type CherryPickAnalysis, type CherryPickVerdict } from './cherry-pick';
import { applyDiff, type GraphSnapshot } from './graph-diff';
import { analyzeMerge, type SemanticConflict } from './merge-conflicts';

export interface ReplayInput {
  sha: string;
  subject: string;
  /** Graph of the commit's parent and of the commit itself. */
  parent: GraphSnapshot;
  commit: GraphSnapshot;
}

export interface ReplayStep {
  sha: string;
  subject: string;
  verdict: CherryPickVerdict;
  analysis: CherryPickAnalysis;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** First commit that would not replay cleanly, or null. */
  firstBreaking: ReplayStep | null;
  /**
   * Conflicts in the final result (new base vs whole branch, from their
   * merge-base). Empty when a later commit repairs what an earlier one broke.
   */
  endConflicts: SemanticConflict[];
}

export function replayCommits(
  mergeBase: GraphSnapshot,
  onto: GraphSnapshot,
  branchTip: GraphSnapshot,
  commits: readonly ReplayInput[],
): ReplayResult {
  const steps: ReplayStep[] = [];
  let effective = onto;
  for (const c of commits) {
    const analysis = analyzeCherryPick(c.parent, c.commit, effective);
    steps.push({ sha: c.sha, subject: c.subject, verdict: verdictOf(analysis, null), analysis });
    effective = applyDiff(effective, analysis.change);
  }
  return {
    steps,
    firstBreaking: steps.find((s) => s.verdict !== 'safe') ?? null,
    endConflicts: analyzeMerge(mergeBase, onto, branchTip).conflicts,
  };
}
