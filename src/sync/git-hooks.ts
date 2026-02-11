/**
 * Git Hooks Manager
 *
 * Installs/removes post-commit hooks to automatically sync the code graph
 * after commits.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from '../errors';

const CODEGRAPH_MARKER = '# codegraph-hook';

const POST_COMMIT_SCRIPT = `#!/bin/sh
${CODEGRAPH_MARKER}
# Auto-sync CodeGraph index after commits
codegraph sync-if-dirty "$GIT_DIR/.." &
`;

export interface HookInstallResult {
  success: boolean;
  message: string;
  hookPath?: string;
}

export interface HookRemoveResult {
  success: boolean;
  message: string;
}

export class GitHooksManager {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Check if the project root is a git repository
   */
  isGitRepository(): boolean {
    const gitDir = this.resolveGitDir();
    return gitDir !== null;
  }

  /**
   * Resolve the .git directory (supports worktrees)
   */
  private resolveGitDir(): string | null {
    const gitPath = path.join(this.projectRoot, '.git');

    if (!fs.existsSync(gitPath)) {
      return null;
    }

    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }

    // Worktree: .git is a file with "gitdir: <path>"
    if (stat.isFile()) {
      try {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match && match[1]) {
          const resolvedPath = path.isAbsolute(match[1])
            ? match[1]
            : path.resolve(this.projectRoot, match[1]);
          if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
          }
        }
      } catch (error) {
        logWarn('Failed to resolve git worktree', {
          error: String(error),
        });
      }
    }

    return null;
  }

  /**
   * Get the hooks directory path
   */
  private getHooksDir(): string | null {
    const gitDir = this.resolveGitDir();
    if (!gitDir) return null;

    // Check for core.hooksPath configuration
    // For simplicity, use the default location
    return path.join(gitDir, 'hooks');
  }

  /**
   * Install the post-commit hook
   */
  installHook(): HookInstallResult {
    if (!this.isGitRepository()) {
      return {
        success: false,
        message: 'Not a git repository',
      };
    }

    const hooksDir = this.getHooksDir();
    if (!hooksDir) {
      return {
        success: false,
        message: 'Could not determine hooks directory',
      };
    }

    const hookPath = path.join(hooksDir, 'post-commit');

    try {
      // Ensure hooks directory exists
      fs.mkdirSync(hooksDir, { recursive: true });

      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, 'utf-8');

        // Already installed
        if (existing.includes(CODEGRAPH_MARKER)) {
          return {
            success: true,
            message: 'Hook already installed',
            hookPath,
          };
        }

        // Append to existing hook
        const updated = existing.trimEnd() + '\n\n' + POST_COMMIT_SCRIPT;
        fs.writeFileSync(hookPath, updated, { mode: 0o755 });
        logDebug('Appended codegraph hook to existing post-commit', {
          hookPath,
        });
      } else {
        // Create new hook
        fs.writeFileSync(hookPath, POST_COMMIT_SCRIPT, { mode: 0o755 });
        logDebug('Created codegraph post-commit hook', { hookPath });
      }

      return {
        success: true,
        message: 'Hook installed successfully',
        hookPath,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to install hook: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Remove the post-commit hook (or just the codegraph portion)
   */
  removeHook(): HookRemoveResult {
    const hooksDir = this.getHooksDir();
    if (!hooksDir) {
      return {
        success: false,
        message: 'Could not determine hooks directory',
      };
    }

    const hookPath = path.join(hooksDir, 'post-commit');

    if (!fs.existsSync(hookPath)) {
      return {
        success: true,
        message: 'No post-commit hook found',
      };
    }

    try {
      const content = fs.readFileSync(hookPath, 'utf-8');

      if (!content.includes(CODEGRAPH_MARKER)) {
        return {
          success: true,
          message: 'Hook does not contain codegraph section',
        };
      }

      // Remove the codegraph section
      const lines = content.split('\n');
      const filtered: string[] = [];
      let inCodegraphSection = false;

      for (const line of lines) {
        if (line.includes(CODEGRAPH_MARKER)) {
          inCodegraphSection = true;
          continue;
        }
        if (inCodegraphSection) {
          // Skip lines until next section or end
          if (line.startsWith('#') && !line.startsWith('# codegraph')) {
            inCodegraphSection = false;
            filtered.push(line);
          }
          continue;
        }
        filtered.push(line);
      }

      const remaining = filtered.join('\n').trim();

      if (!remaining || remaining === '#!/bin/sh') {
        // Nothing left, remove the file
        fs.unlinkSync(hookPath);
        logDebug('Removed codegraph post-commit hook file', { hookPath });
      } else {
        // Write back without codegraph section
        fs.writeFileSync(hookPath, remaining + '\n', { mode: 0o755 });
        logDebug('Removed codegraph section from post-commit hook', {
          hookPath,
        });
      }

      return {
        success: true,
        message: 'Hook removed successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to remove hook: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Check if the codegraph hook is installed
   */
  isHookInstalled(): boolean {
    const hooksDir = this.getHooksDir();
    if (!hooksDir) return false;

    const hookPath = path.join(hooksDir, 'post-commit');
    if (!fs.existsSync(hookPath)) return false;

    try {
      const content = fs.readFileSync(hookPath, 'utf-8');
      return content.includes(CODEGRAPH_MARKER);
    } catch {
      return false;
    }
  }
}

/**
 * Create a GitHooksManager instance
 */
export function createGitHooksManager(projectRoot: string): GitHooksManager {
  return new GitHooksManager(projectRoot);
}
