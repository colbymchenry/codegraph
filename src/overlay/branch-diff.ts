/**
 * Branch Diff Indexer
 *
 * Identifies files changed on the current feature branch relative to
 * a base branch (e.g., main), enabling selective indexing of only the
 * developer's changes instead of the entire codebase.
 *
 * Uses `git diff --name-status` against the merge-base to correctly
 * handle diverged branches: only files the developer actually touched
 * appear in the diff, not upstream commits merged into main since the
 * branch point.
 */

import { execSync } from 'child_process';
import { BranchDiffResult } from './types';

/**
 * Detects files changed on the current branch relative to a base branch.
 *
 * Usage:
 * ```ts
 * const diff = new BranchDiffIndexer('/path/to/repo');
 * const result = diff.getChangedFiles('main');
 * console.log(result.added, result.modified, result.deleted);
 * ```
 */
export class BranchDiffIndexer {
  private projectRoot: string;

  /**
   * @param projectRoot - Absolute path to the git repository root
   */
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Get all files changed between the current HEAD and the base branch.
   *
   * Uses `git merge-base` to find the common ancestor, then
   * `git diff --name-status` to categorize changes as added,
   * modified, or deleted.
   *
   * @param baseBranch - Name of the base branch (e.g., 'main')
   * @returns Categorized diff result with file lists
   * @throws Error if not inside a git repository or the base branch doesn't exist
   */
  getChangedFiles(baseBranch: string): BranchDiffResult {
    const currentBranch = this.getCurrentBranch();
    const mergeBase = this.getMergeBase(baseBranch);

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // git diff --name-status gives lines like:
    //   A\tpath/to/new-file.ts
    //   M\tpath/to/changed-file.ts
    //   D\tpath/to/removed-file.ts
    //   R100\told-name.ts\tnew-name.ts
    const output = this.exec(
      `git diff --name-status ${mergeBase} HEAD`
    ).trim();

    if (!output) {
      return { added, modified, deleted, currentBranch, baseBranch };
    }

    for (const line of output.split('\n')) {
      const parts = line.split('\t');
      const status = parts[0];
      // For renames (R###), the new file path is in parts[2]
      const filePath = status?.startsWith('R') ? parts[2] : parts[1];

      if (!status || !filePath) continue;

      if (status.startsWith('A')) {
        added.push(filePath);
      } else if (status.startsWith('M') || status.startsWith('R')) {
        modified.push(filePath);
      } else if (status.startsWith('D')) {
        deleted.push(filePath);
      }
    }

    return { added, modified, deleted, currentBranch, baseBranch };
  }

  /**
   * Get the list of files that need to be indexed for the overlay.
   *
   * Returns the union of added and modified files — these are the
   * files whose graph data differs from the base branch. Deleted
   * files are excluded (they need to be masked, not indexed).
   *
   * @param baseBranch - Name of the base branch
   * @returns Array of relative file paths to index
   */
  getFilesToIndex(baseBranch: string): string[] {
    const diff = this.getChangedFiles(baseBranch);
    return [...diff.added, ...diff.modified];
  }

  /**
   * Get the name of the currently checked-out branch.
   *
   * @returns Branch name, or 'HEAD' if in detached-HEAD state
   */
  getCurrentBranch(): string {
    return this.exec('git rev-parse --abbrev-ref HEAD').trim();
  }

  /**
   * Find the merge-base (common ancestor) between the base branch and HEAD.
   *
   * @param baseBranch - Name of the base branch
   * @returns Commit hash of the merge-base
   * @throws Error if the base branch doesn't exist
   */
  getMergeBase(baseBranch: string): string {
    try {
      return this.exec(`git merge-base ${baseBranch} HEAD`).trim();
    } catch {
      throw new Error(
        `Cannot find merge-base between '${baseBranch}' and HEAD. ` +
        `Does the branch '${baseBranch}' exist?`
      );
    }
  }

  /**
   * Execute a git command in the project root.
   *
   * @param command - Shell command to run
   * @returns stdout as a string
   */
  private exec(command: string): string {
    return execSync(command, {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}
