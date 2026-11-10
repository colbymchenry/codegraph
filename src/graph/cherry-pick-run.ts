/**
 * `codegraph diff --cherry-pick`: resolve the refs, build the three graphs and
 * name the commits that would supply what a cherry-pick is missing.
 */
import {
  commitsIntroducing,
  parentCount,
  parentOf,
  resolveRef,
  textualCherryPickConflicts,
} from '../sync/git-refs';
import { analyzeCherryPick, verdictOf, type CherryPickAnalysis, type CherryPickVerdict } from './cherry-pick';
import { snapshotOfCommit } from './ref-graph';

export interface Prerequisite {
  /** Symbol key the commit needs. */
  key: string;
  /** Commits, oldest first, in the commit's history but not on the target, that touched it. */
  commits: Array<{ sha: string; subject: string }>;
}

export interface CherryPickReport {
  commit: string;
  commitSha: string;
  onto: string;
  ontoSha: string;
  parentSha: string;
  /** The commit has several parents; its first parent is the one compared. */
  mergeCommit: boolean;
  analysis: CherryPickAnalysis;
  textualConflict: boolean | null;
  verdict: CherryPickVerdict;
  prerequisites: Prerequisite[];
}

export async function runCherryPick(
  repoRoot: string,
  commit: string,
  onto: string,
  onProgress?: (message: string) => void,
): Promise<CherryPickReport> {
  const commitSha = resolveRef(repoRoot, commit);
  if (!commitSha) throw new Error(`Cannot resolve ${commit} to a commit`);
  const ontoSha = resolveRef(repoRoot, onto);
  if (!ontoSha) throw new Error(`Cannot resolve ${onto} to a commit`);
  const parentSha = parentOf(repoRoot, commitSha);
  if (!parentSha) throw new Error(`${commit} is a root commit: there is no earlier state to compare it with`);

  const parent = await snapshotOfCommit(repoRoot, parentSha, onProgress);
  const changed = await snapshotOfCommit(repoRoot, commitSha, onProgress);
  const target = await snapshotOfCommit(repoRoot, ontoSha, onProgress);

  const analysis = analyzeCherryPick(parent, changed, target);
  const textualConflict = textualCherryPickConflicts(repoRoot, ontoSha, commitSha);

  const prerequisites: Prerequisite[] = [];
  for (const m of analysis.missing) {
    if (m.kind === 'edits-absent') continue;
    const node = parent.nodes.get(m.key);
    if (!node) continue;
    const commits = commitsIntroducing(repoRoot, ontoSha, parentSha, node.name, node.filePath);
    prerequisites.push({ key: m.key, commits });
  }

  return {
    commit,
    commitSha,
    onto,
    ontoSha,
    parentSha,
    mergeCommit: parentCount(repoRoot, commitSha) > 1,
    analysis,
    textualConflict,
    verdict: verdictOf(analysis, textualConflict),
    prerequisites,
  };
}
