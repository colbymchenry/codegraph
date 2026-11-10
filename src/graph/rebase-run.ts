/**
 * `codegraph diff --rebase`: resolve the refs, build the graphs for the new
 * base, the branch and each of its commits, and replay them.
 */
import { commitsBetween, mergeBase, parentOf, resolveRef, subjectOf, textualMergeConflicts } from '../sync/git-refs';
import { snapshotOfCommit } from './ref-graph';
import { replayCommits, type ReplayResult } from './rebase';

export type RebaseStatus = 'nothing-to-rebase' | 'fast-forward' | 'safe' | 'breaks-at-commit' | 'no-common-history';

export interface RebaseReport {
  branch: string;
  branchSha: string;
  onto: string;
  ontoSha: string;
  baseSha: string | null;
  status: RebaseStatus;
  /** Commits replayed / on the branch beyond `limit`. */
  replayed: number;
  notReplayed: number;
  /** Whole-branch textual merge with the new base, as a hint where git will stop. */
  textualConflict: boolean | null;
  result: ReplayResult | null;
}

export async function runRebase(
  repoRoot: string,
  branch: string,
  onto: string,
  options: { limit?: number; onProgress?: (message: string) => void } = {},
): Promise<RebaseReport> {
  const branchSha = resolveRef(repoRoot, branch);
  if (!branchSha) throw new Error(`Cannot resolve ${branch} to a commit`);
  const ontoSha = resolveRef(repoRoot, onto);
  if (!ontoSha) throw new Error(`Cannot resolve ${onto} to a commit`);
  const head = { branch, branchSha, onto, ontoSha, replayed: 0, notReplayed: 0, textualConflict: null, result: null };

  const baseSha = mergeBase(repoRoot, ontoSha, branchSha);
  if (!baseSha) return { ...head, baseSha: null, status: 'no-common-history' };
  if (baseSha === branchSha) return { ...head, baseSha, status: 'nothing-to-rebase' };

  const all = commitsBetween(repoRoot, baseSha, branchSha, true);
  const limit = options.limit ?? 20;
  const chosen = all.slice(0, limit);
  const textualConflict = textualMergeConflicts(repoRoot, ontoSha, branchSha);

  // The branch sits directly on the new base: the rebase moves nothing.
  if (baseSha === ontoSha) {
    return { ...head, baseSha, status: 'fast-forward', replayed: 0, notReplayed: 0, textualConflict: false };
  }

  const progress = options.onProgress;
  const base = await snapshotOfCommit(repoRoot, baseSha, progress);
  const target = await snapshotOfCommit(repoRoot, ontoSha, progress);
  const tip = await snapshotOfCommit(repoRoot, branchSha, progress);

  const inputs = [];
  for (const sha of chosen) {
    const parentSha = parentOf(repoRoot, sha);
    if (!parentSha) continue;
    inputs.push({
      sha,
      subject: subjectOf(repoRoot, sha),
      parent: await snapshotOfCommit(repoRoot, parentSha, progress),
      commit: await snapshotOfCommit(repoRoot, sha, progress),
    });
  }
  const result = replayCommits(base, target, tip, inputs);
  return {
    ...head,
    baseSha,
    status: result.firstBreaking ? 'breaks-at-commit' : 'safe',
    replayed: inputs.length,
    notReplayed: all.length - chosen.length,
    textualConflict,
    result,
  };
}
