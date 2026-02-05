/**
 * Git Hooks Management
 *
 * Installs and manages git hooks for automatic incremental indexing.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Name of the post-commit hook file
 */
const POST_COMMIT_HOOK = 'post-commit';

/**
 * Marker comment to identify CodeGraph-managed hooks
 */
const CODEGRAPH_MARKER = '# CodeGraph auto-sync hook';

/**
 * The post-commit hook script content
 *
 * This script:
 * 1. Checks if codegraph CLI is available
 * 2. Falls back to npx if not
 * 3. Runs sync in the background to avoid blocking commits
 */
const POST_COMMIT_SCRIPT = `#!/bin/sh
${CODEGRAPH_MARKER}
# This hook was installed by CodeGraph to enable automatic incremental indexing.
# It runs after each commit to keep the code graph in sync.
# To remove this hook, run: codegraph hooks --remove
# Or delete this file manually.

# Run sync in background to avoid blocking the commit
(
  # Check if we're in a CodeGraph project
  if [ ! -d ".codegraph" ]; then
    exit 0
  fi

  LOGFILE=".codegraph/sync.log"

  # Try to run codegraph sync
  if command -v codegraph >/dev/null 2>&1; then
    codegraph sync --quiet 2>>"$LOGFILE" &
  elif command -v npx >/dev/null 2>&1; then
    npx codegraph sync --quiet 2>>"$LOGFILE" &
  fi
) &

exit 0
`;

/**
 * Result of hook installation
 */
export interface HookInstallResult {
  success: boolean;
  hookPath: string;
  message: string;
  previousHookBackedUp?: boolean;
  backupPath?: string;
}

/**
 * Result of hook removal
 */
export interface HookRemoveResult {
  success: boolean;
  message: string;
  restoredFromBackup?: boolean;
}

/**
 * Git hooks manager
 */
export class GitHooksManager {
  private gitDir: string;
  private hooksDir: string;

  constructor(projectRoot: string) {
    this.gitDir = this.resolveGitDir(projectRoot);
    this.hooksDir = path.join(this.gitDir, 'hooks');
  }

  /**
   * Resolve the actual .git directory path
   * Handles both regular repos and git worktrees
   */
  private resolveGitDir(projectRoot: string): string {
    const gitPath = path.join(projectRoot, '.git');
    
    if (!fs.existsSync(gitPath)) {
      return gitPath; // Will fail isGitRepository check
    }
    
    const stats = fs.statSync(gitPath);
    
    // Regular git repository
    if (stats.isDirectory()) {
      return gitPath;
    }
    
    // Git worktree - .git is a file containing "gitdir: <path>"
    if (stats.isFile()) {
      try {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        
        if (match && match[1]) {
          const worktreeGitDir = match[1];
          // Worktree path may be relative or absolute
          const absoluteWorktreeGitDir = path.isAbsolute(worktreeGitDir)
            ? worktreeGitDir
            : path.resolve(projectRoot, worktreeGitDir);
          
          // For worktrees, hooks are in the main repo's .git/hooks
          // Navigate up from worktrees/<name> to the main .git directory
          const mainGitDir = path.dirname(path.dirname(absoluteWorktreeGitDir));
          return mainGitDir;
        }
      } catch {
        // If we can't read/parse, fall through to return gitPath
      }
    }
    
    return gitPath;
  }

  /**
   * Check if the project is a git repository (including worktrees)
   */
  isGitRepository(): boolean {
    return fs.existsSync(this.gitDir) && fs.statSync(this.gitDir).isDirectory();
  }

  /**
   * Check if the post-commit hook is installed by CodeGraph
   */
  isHookInstalled(): boolean {
    const hookPath = path.join(this.hooksDir, POST_COMMIT_HOOK);

    if (!fs.existsSync(hookPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(hookPath, 'utf-8');
      return content.includes(CODEGRAPH_MARKER);
    } catch {
      return false;
    }
  }

  /**
   * Install the post-commit hook
   *
   * If a hook already exists:
   * - If it's a CodeGraph hook, update it
   * - If it's a user hook, back it up and install ours
   */
  installHook(): HookInstallResult {
    const hookPath = path.join(this.hooksDir, POST_COMMIT_HOOK);

    // Check if this is a git repository
    if (!this.isGitRepository()) {
      return {
        success: false,
        hookPath,
        message: 'Not a git repository. Initialize git first with: git init',
      };
    }

    // Ensure hooks directory exists
    if (!fs.existsSync(this.hooksDir)) {
      try {
        fs.mkdirSync(this.hooksDir, { recursive: true });
      } catch (error) {
        return {
          success: false,
          hookPath,
          message: `Failed to create hooks directory: ${error}`,
        };
      }
    }

    // Check for existing hook
    let previousHookBackedUp = false;
    let backupPath: string | undefined;

    if (fs.existsSync(hookPath)) {
      try {
        const existingContent = fs.readFileSync(hookPath, 'utf-8');

        // If it's already our hook, just update it
        if (existingContent.includes(CODEGRAPH_MARKER)) {
          fs.writeFileSync(hookPath, POST_COMMIT_SCRIPT, { mode: 0o755 });
          return {
            success: true,
            hookPath,
            message: 'Post-commit hook updated.',
          };
        }

        // It's a user hook - back it up
        backupPath = `${hookPath}.codegraph-backup`;
        fs.copyFileSync(hookPath, backupPath);
        previousHookBackedUp = true;
      } catch (error) {
        return {
          success: false,
          hookPath,
          message: `Failed to backup existing hook: ${error}`,
        };
      }
    }

    // Write the hook
    try {
      fs.writeFileSync(hookPath, POST_COMMIT_SCRIPT, { mode: 0o755 });
    } catch (error) {
      return {
        success: false,
        hookPath,
        message: `Failed to write hook: ${error}`,
      };
    }

    const message = previousHookBackedUp
      ? `Post-commit hook installed. Previous hook backed up to: ${backupPath}`
      : 'Post-commit hook installed.';

    return {
      success: true,
      hookPath,
      message,
      previousHookBackedUp,
      backupPath,
    };
  }

  /**
   * Remove the CodeGraph post-commit hook
   *
   * If a backup exists, restore it.
   */
  removeHook(): HookRemoveResult {
    const hookPath = path.join(this.hooksDir, POST_COMMIT_HOOK);
    const backupPath = `${hookPath}.codegraph-backup`;

    // Check if hook exists
    if (!fs.existsSync(hookPath)) {
      return {
        success: true,
        message: 'No post-commit hook found.',
      };
    }

    // Check if it's our hook
    try {
      const content = fs.readFileSync(hookPath, 'utf-8');
      if (!content.includes(CODEGRAPH_MARKER)) {
        return {
          success: false,
          message: 'Post-commit hook was not installed by CodeGraph. Not removing.',
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to read hook: ${error}`,
      };
    }

    // Remove the hook
    try {
      fs.unlinkSync(hookPath);
    } catch (error) {
      return {
        success: false,
        message: `Failed to remove hook: ${error}`,
      };
    }

    // Restore backup if it exists
    if (fs.existsSync(backupPath)) {
      try {
        fs.renameSync(backupPath, hookPath);
        return {
          success: true,
          message: 'Post-commit hook removed. Previous hook restored from backup.',
          restoredFromBackup: true,
        };
      } catch (error) {
        return {
          success: true,
          message: `Post-commit hook removed. Warning: failed to restore backup: ${error}`,
          restoredFromBackup: false,
        };
      }
    }

    return {
      success: true,
      message: 'Post-commit hook removed.',
    };
  }

  /**
   * Get the path to the hooks directory
   */
  getHooksDir(): string {
    return this.hooksDir;
  }

  /**
   * Get the path to the post-commit hook
   */
  getHookPath(): string {
    return path.join(this.hooksDir, POST_COMMIT_HOOK);
  }
}

/**
 * Create a git hooks manager for a project
 */
export function createGitHooksManager(projectRoot: string): GitHooksManager {
  return new GitHooksManager(projectRoot);
}
