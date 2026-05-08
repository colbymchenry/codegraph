/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers
 * debounced sync operations to keep the code graph up-to-date.
 *
 * Uses Node.js native fs.watch with recursive mode (macOS FSEvents,
 * Windows ReadDirectoryChangesW, Linux inotify on Node 19+).
 */

import * as fs from 'fs';
import { CodeGraphConfig } from '../types';
import { shouldIncludeFile } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';

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
 * - Minimal resource usage (native OS file events, no polling)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters against CodeGraph include/exclude patterns
 * - Ignores .codegraph/ directory changes
 */
export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChanges = false;
  private syncing = false;
  private stopped = false;

  private readonly projectRoot: string;
  private readonly config: CodeGraphConfig;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];

  constructor(
    projectRoot: string,
    config: CodeGraphConfig,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.config = config;
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

    try {
      this.watcher = fs.watch(
        this.projectRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || this.stopped) return;

          // Normalize path separators
          const normalized = normalizePath(filename);

          // Ignore .codegraph/ directory changes (our own DB writes)
          if (
            normalized === '.codegraph' ||
            normalized.startsWith('.codegraph/') ||
            normalized.startsWith('.codegraph\\')
          ) {
            return;
          }

          // Filter against include/exclude patterns
          if (!shouldIncludeFile(normalized, this.config)) {
            return;
          }

          logDebug('File change detected', { file: normalized });
          this.hasChanges = true;
          this.scheduleSync();
        }
      );

      // Handle watcher errors gracefully
      this.watcher.on('error', (err) => {
        logWarn('File watcher error', { error: String(err) });
        // Don't crash — watcher may recover or user can restart
      });

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    } catch (err) {
      // Recursive watch not supported (e.g., Linux < Node 19)
      logWarn('Could not start file watcher — recursive fs.watch not supported on this platform', { error: String(err) });
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
