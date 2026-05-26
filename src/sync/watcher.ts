/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers debounced sync
 * operations to keep the code graph up-to-date.
 *
 * Uses chokidar, whose `ignored` callback filters directories BEFORE they are
 * watched — so we never register inotify watches on excluded trees like
 * node_modules/, dist/, .git/ (fixes #276: recursive fs.watch exhausted the
 * kernel watch budget on large repos). The ignore decision reuses the indexer's
 * `buildDefaultIgnore` (built-in default-ignore dirs + the project's .gitignore)
 * so the watcher watches exactly the set the indexer indexes — in particular,
 * node_modules/build/cache dirs are excluded even when the repo has no
 * .gitignore (#407), which a .gitignore-only filter would miss.
 */

import * as path from 'path';
import type { Stats } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import type { Ignore } from 'ignore';
import { isSourceFile, buildDefaultIgnore } from '../extraction';
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
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (chokidar filters excluded directories before
 *   registering an inotify watch — see module docs / #276)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .codegraph/ and .git/ regardless of .gitignore
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChanges = false;
  private syncing = false;
  private stopped = false;
  // The shared ignore matcher (built-in defaults + project .gitignore), built
  // once at start(). Same source of truth the indexer uses, so watcher scope
  // can never diverge from index scope.
  private ignoreMatcher: Ignore | null = null;

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

    // Reuse the indexer's ignore set so the watcher and indexer agree on scope.
    // chokidar only registers an inotify watch on directories that pass this
    // filter — that's the #276 fix.
    this.ignoreMatcher = buildDefaultIgnore(this.projectRoot);

    try {
      this.watcher = chokidar.watch(this.projectRoot, {
        // chokidar calls this for every path it encounters and only watches
        // those that pass — so excluded trees (node_modules/, dist/, .git/, …)
        // never get an inotify watch in the first place.
        ignored: (testPath: string, stats?: Stats) => this.shouldIgnore(testPath, stats),
      });

      // chokidar emits 'all' for every event type; we only sync source files.
      this.watcher.on('all', (_event: string, filePath: string) => {
        if (this.stopped) return;

        const normalized = normalizePath(path.relative(this.projectRoot, filePath));

        // Defense in depth: `ignored` should already keep these out, but events
        // can still arrive during setup or via symlink traversal.
        if (this.isAlwaysIgnored(normalized)) return;
        if (!isSourceFile(normalized)) return;

        logDebug('File change detected', { file: normalized });
        this.hasChanges = true;
        this.scheduleSync();
      });

      // Handle watcher errors gracefully — don't crash, the user can restart.
      this.watcher.on('error', (err: unknown) => {
        logWarn('File watcher error', { error: String(err) });
      });

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    } catch (err) {
      // Watcher setup failed (e.g., permission denied, missing directory).
      logWarn('Could not start file watcher', { error: String(err) });
      return false;
    }
  }

  /** Our own dirs are always ignored, regardless of .gitignore. */
  private isAlwaysIgnored(rel: string): boolean {
    return (
      rel === '.codegraph' || rel.startsWith('.codegraph/') ||
      rel === '.git' || rel.startsWith('.git/')
    );
  }

  /**
   * chokidar `ignored` predicate — true for any path that should NOT be watched.
   * Uses chokidar's provided `stats` to decide directory-vs-file so a dir-only
   * rule like `build/` matches, without an extra `statSync` per path.
   */
  private shouldIgnore(testPath: string, stats?: Stats): boolean {
    const rel = normalizePath(path.relative(this.projectRoot, testPath));
    if (!rel || rel === '.' || rel.startsWith('..')) return false; // root / outside
    if (this.isAlwaysIgnored(rel)) return true;
    if (!this.ignoreMatcher) return false;
    if (stats) {
      return this.ignoreMatcher.ignores(stats.isDirectory() ? rel + '/' : rel);
    }
    // Stats unknown: test both forms so a directory match isn't missed.
    return this.ignoreMatcher.ignores(rel) || this.ignoreMatcher.ignores(rel + '/');
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
    this.ignoreMatcher = null;
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
