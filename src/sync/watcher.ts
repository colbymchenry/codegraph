/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers
 * debounced sync operations to keep the code graph up-to-date.
 *
 * Uses chokidar under the hood, which provides cross-platform file
 * watching with built-in filtering to avoid registering unnecessary
 * inotify watches (fixes #276: fs.watch recursive exhausts kernel
 * watch budget on large repos).
 */

import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import ignore, { Ignore } from 'ignore';
import { isSourceFile } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { watchDisabledReason } from './watch-policy';

/**
 * Options for the file watcher
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds.
   * After the last file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Callback when a sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * Callback when a sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error) => void;
}

/**
 * Represents a .gitignore file loaded from a specific directory.
 * Rules in a .gitignore are relative to that directory, mirroring
 * how git applies .gitignore files at every level.
 */
interface ScopedIgnore {
  dir: string;
  ig: Ignore;
}

/**
 * Load .gitignore files from projectRoot upward through parent
 * directories. Returns a list ordered from root to projectRoot
 * so nested rules (closest to the project) are checked first.
 */
function loadGitignoreChain(projectRoot: string): ScopedIgnore[] {
  const matchers: ScopedIgnore[] = [];
  let dir = projectRoot;

  // Determine the filesystem root (e.g. '/' on Linux)
  const root = path.parse(dir).root;

  while (dir !== root) {
    const giPath = path.join(dir, '.gitignore');
    try {
      if (fs.existsSync(giPath)) {
        matchers.unshift({
          dir,
          ig: ignore().add(fs.readFileSync(giPath, 'utf-8')),
        });
      }
    } catch {
      // Unreadable .gitignore — treat as absent
    }
    dir = path.dirname(dir);
  }

  return matchers;
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (chokidar with .gitignore-aware filtering
 *   avoids registering inotify watches on excluded directories)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .codegraph/ directory changes
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChanges = false;
  private syncing = false;
  private stopped = false;
  private gitignoreMatchers: ScopedIgnore[] = [];

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];

  constructor(
    projectRoot: string,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.watcher) return true; // Already watching
    this.stopped = false;

    // Some environments make filesystem watching unusable — most notably
    // WSL2 /mnt/ drives, where the underlying fs.watch calls block long
    // enough to break MCP startup handshakes (issue #199). Skip watching
    // there; callers fall back to manual `codegraph sync` or git sync hooks.
    const disabledReason = watchDisabledReason(this.projectRoot);
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
      return false;
    }

    // Load .gitignore rules from project root upward.
    // These drive chokidar's `ignored` callback so we never register
    // inotify watches on excluded directories (like node_modules/, .git/,
    // dist/, .next/, etc.), avoiding kernel watch-budget exhaustion (#276).
    this.gitignoreMatchers = loadGitignoreChain(this.projectRoot);

    try {
      this.watcher = chokidar.watch(this.projectRoot, {
        // Core fix for #276: filter directories BEFORE they are watched.
        // chokidar calls this for every file and directory it encounters,
        // and only registers an underlying fs.watch on those that pass.
        // This drops per-instance inotify watch count from hundreds of
        // thousands (on a monorepo) to hundreds — only the directories
        // that actually contain tracked source code.
        ignored: (testPath: string) => {
          const rel = normalizePath(path.relative(this.projectRoot, testPath));

          // Always ignore .codegraph/ (our own DB writes) and .git/
          if (
            rel === '.codegraph' ||
            rel.startsWith('.codegraph/') ||
            rel === '.git' ||
            rel.startsWith('.git/')
          ) {
            return true;
          }

          // Check .gitignore rules
          for (const { dir, ig } of this.gitignoreMatchers) {
            let matcherRel = normalizePath(path.relative(dir, testPath));
            if (!matcherRel || matcherRel.startsWith('..')) continue;

            // For directory-only .gitignore rules (e.g. "build/"),
            // append a trailing slash so the ignore package matches them.
            try {
              const stat = fs.statSync(testPath);
              if (stat.isDirectory()) matcherRel += '/';
            } catch {
              // If we can't stat, assume it's a file — don't append '/'
            }

            if (ig.ignores(matcherRel)) return true;
          }

          return false;
        },
      });

      // Wire up the file-change handler. chokidar emits 'all' for every
      // event type; we only care about files that were actually changed.
      this.watcher.on('all', (_event: string, filePath: string) => {
        if (this.stopped) return;

        const normalized = normalizePath(path.relative(this.projectRoot, filePath));

        // Defense in depth: filter again even though `ignored` should
        // have prevented watches on these directories. Events can still
        // arrive during watcher setup or from symlink traversal.
        if (
          normalized === '.codegraph' ||
          normalized.startsWith('.codegraph/') ||
          normalized === '.git' ||
          normalized.startsWith('.git/')
        ) {
          return;
        }

        // Only sync changes to files we can actually parse.
        if (!isSourceFile(normalized)) {
          return;
        }

        logDebug('File change detected', { file: normalized });
        this.hasChanges = true;
        this.scheduleSync();
      });

      // Handle watcher errors gracefully
      this.watcher.on('error', (err: unknown) => {
        logWarn('File watcher error', { error: String(err) });
      });

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    } catch (err) {
      // Watcher setup failed (e.g., permission denied, missing directory)
      logWarn('Could not start file watcher', { error: String(err) });
      return false;
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.hasChanges = false;
    this.gitignoreMatchers = [];
    logDebug('File watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.watcher !== null && !this.stopped;
  }

  /**
   * Schedule a debounced sync.
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * Flush pending changes by running sync.
   */
  private async flush(): Promise<void> {
    // If already syncing, the post-sync check will re-trigger
    if (this.syncing || this.stopped) return;

    this.hasChanges = false;
    this.syncing = true;

    try {
      const result = await this.syncFn();
      this.onSyncComplete?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logWarn('Watch sync failed', { error: error.message });
      this.onSyncError?.(error);
    } finally {
      this.syncing = false;

      // If new changes arrived during sync, schedule another
      if (this.hasChanges && !this.stopped) {
        this.scheduleSync();
      }
    }
  }
}
