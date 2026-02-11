/**
 * Sync Module
 *
 * Provides synchronization and git hooks functionality for keeping
 * the code graph up-to-date.
 */

export {
  GitHooksManager,
  createGitHooksManager,
  HookInstallResult,
  HookRemoveResult,
} from './git-hooks';
