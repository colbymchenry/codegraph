/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers debounced sync
 * operations to keep the code graph up-to-date.
 *
 * Uses Node's built-in `fs.watch` directly (no third-party watcher, no native
 * addon) with a per-platform strategy chosen to keep the open-descriptor /
 * kernel-watch cost BOUNDED rather than growing with the number of files:
 *
 *   - macOS / Windows: a SINGLE recursive `fs.watch(root, {recursive:true})`.
 *     libuv maps this to one FSEvents stream (macOS) / one
 *     ReadDirectoryChangesW handle (Windows), so it costs O(1) descriptors no
 *     matter how large the tree. This is the fix for the macOS file-table
 *     exhaustion (#644 / #496 / #555 / #628): the previous watcher held one
 *     open fd PER WATCHED FILE on macOS (tens of thousands of REG fds), which
 *     exhausted `kern.maxfiles` and crashed unrelated processes system-wide.
 *
 *   - Linux: recursive `fs.watch` is unsupported, so we watch each (non-ignored)
 *     DIRECTORY with one inotify watch — O(directories), NOT O(files). New
 *     directories are picked up dynamically and an overall watch cap bounds
 *     inotify usage on pathological monorepos (#579). A single inotify watch on
 *     a directory already reports create/modify/delete for its children, so
 *     per-file watches are never needed.
 *
 * Excluded trees (node_modules/, dist/, .git/, …) are filtered via the
 * indexer's `buildDefaultIgnore` (built-in default-ignore dirs + the project's
 * .gitignore) — on Linux they're never descended into (so they cost no watch),
 * and on macOS/Windows the single recursive stream still covers them but their
 * events are dropped before any sync is scheduled. Either way the watcher's
 * scope matches the indexer's (#276 / #407).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Ignore } from 'ignore';
import { isSourceFile, buildDefaultIgnore } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { isCodeGraphDataDir } from '../directory';
import { watchDisabledReason } from './watch-policy';

/**
 * Native recursive `fs.watch` is only reliable on macOS and Windows; on Linux
 * (and AIX) it throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. We branch on this
 * to pick the recursive vs per-directory strategy.
 */
function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * Upper bound on simultaneously-watched directories on the Linux per-directory
 * path. Each is one inotify watch; the kernel's `fs.inotify.max_user_watches`
 * is the hard limit (commonly 8k–128k). We stop adding watches past this and
 * log once — partial live-watch (with `codegraph sync` as the backstop) is far
 * better than exhausting the user's inotify budget and breaking watching
 * system-wide (#579). Tunable via CODEGRAPH_MAX_DIR_WATCHES.
 */
const DEFAULT_MAX_DIR_WATCHES = 50_000;

function maxDirWatches(): number {
  const raw = process.env.CODEGRAPH_MAX_DIR_WATCHES;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
  }
  return DEFAULT_MAX_DIR_WATCHES;
}

/**
 * Test seam (see {@link __emitWatchEventForTests}). Maps a watcher's project
 * root to its live instance so tests can synthesize a change event
 * deterministically — real fs.watch delivery latency races under parallel
 * vitest (the reason the previous chokidar mock existed). Only populated under
 * a test runner, so production carries no bookkeeping or retained references.
 */
const liveWatchersForTests = new Map<string, FileWatcher>();
const IS_TEST_RUNTIME = !!(process.env.VITEST || process.env.NODE_ENV === 'test');

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

  /**
   * Test-only. When true, `start()` installs NO OS-level fs.watch — the
   * watcher is "inert" and only the {@link __emitWatchEventForTests} /
   * {@link FileWatcher.ingestEventForTests} seam drives its pipeline. This
   * restores the deterministic, OS-free behavior the unit tests need (real
   * FSEvents/inotify delivery races under parallel vitest). Production never
   * sets it.
   */
  inertForTests?: boolean;
}

/**
 * Thrown by a `syncFn` to signal that the underlying sync couldn't acquire
 * the cross-process write lock (#449). The watcher treats this as "no
 * progress" — preserves `pendingFiles`, skips `onSyncComplete`, and the
 * `finally` block reschedules. Quiet (debug-only) because a long-running
 * external indexer can hit this every debounce cycle.
 */
export class LockUnavailableError extends Error {
  constructor(message = 'CodeGraph file lock unavailable; another process is writing') {
    super(message);
    this.name = 'LockUnavailableError';
  }
}

/**
 * Per-file pending entry — tracks a source file the watcher saw an event for
 * but hasn't yet synced into the index. Exposed via {@link FileWatcher.getPendingFiles}
 * so MCP tool responses can mark stale results without forcing a wait.
 */
export interface PendingFile {
  /** Project-relative POSIX path (e.g. "src/foo.ts"). */
  path: string;
  /** Wall-clock ms at the first event we saw for this path since the last sync. */
  firstSeenMs: number;
  /** Wall-clock ms at the most recent event we saw for this path. */
  lastSeenMs: number;
  /**
   * True when a sync is currently in flight that began AFTER this file's most
   * recent event — i.e. the next successful sync will pick it up. False when
   * the file is still in the debounce window (no sync running yet).
   */
  indexing: boolean;
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Bounded resource usage: O(1) descriptors on macOS/Windows (one recursive
 *   watch), O(directories) inotify watches on Linux — never O(files), which
 *   was the system-crashing fd leak on macOS (#644/#496/#555/#628).
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .codegraph/ and .git/ regardless of .gitignore
 * - Tracks per-file pending state so MCP tools can flag stale results
 *   without blocking on a sync (issue #403)
 */
export class FileWatcher {
  /** macOS/Windows: the single recursive watcher. Null on Linux. */
  private recursiveWatcher: fs.FSWatcher | null = null;
  /** Linux: one watcher per watched directory (keyed by absolute path). */
  private dirWatchers = new Map<string, fs.FSWatcher>();
  /** Set once the per-directory watch cap is hit, so we log only once. */
  private dirCapWarned = false;
  /** Test-only inert mode: started, but with no OS watcher installed. */
  private inert = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Files seen by the watcher since the last successful sync — populated on
   * every change event, cleared at the start of a sync, and re-populated by
   * events that arrive mid-sync (or restored on sync failure). Keyed by the
   * same project-relative POSIX path the rest of the codebase uses, so a
   * caller can intersect tool-response file paths against this map cheaply.
   */
  private pendingFiles = new Map<string, { firstSeenMs: number; lastSeenMs: number }>();
  /**
   * Wall-clock ms at which the in-flight sync began. Combined with
   * {@link pendingFiles}'s `lastSeenMs`, this distinguishes "still in the
   * debounce window" (lastSeen > syncStarted, sync hasn't started yet for
   * this edit) from "currently being indexed" (lastSeen <= syncStarted).
   */
  private syncStartedMs = 0;
  private syncing = false;
  private stopped = false;
  /**
   * True once the initial watch set is established. Unlike the previous
   * chokidar implementation there is no asynchronous initial "crawl" emitting
   * an `add` per existing file — `fs.watch` only reports changes from the
   * moment it's installed — so this flips to true synchronously at the end of
   * `start()`. The startup reconcile against on-disk state is handled
   * separately by the engine's catch-up sync, not by the watcher.
   */
  private ready = false;
  /**
   * Callbacks that resolve when the watch set is established. Used by tests
   * (and any production caller that cares about a clean baseline) to
   * deterministically gate on watcher readiness.
   */
  private readyWaiters: Array<() => void> = [];
  // The shared ignore matcher (built-in defaults + project .gitignore), built
  // once at start(). Same source of truth the indexer uses, so watcher scope
  // can never diverge from index scope.
  private ignoreMatcher: Ignore | null = null;

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private readonly inertForTests: boolean;

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
    this.inertForTests = options.inertForTests ?? false;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.recursiveWatcher || this.dirWatchers.size > 0 || this.inert) return true; // Already watching
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
    this.ignoreMatcher = buildDefaultIgnore(this.projectRoot);

    try {
      if (this.inertForTests) {
        // Test-only: install no OS watcher; the seam drives events instead.
        this.inert = true;
      } else if (supportsRecursiveWatch()) {
        this.startRecursive();
      } else {
        this.startPerDirectory();
      }

      // No async crawl to wait on: as soon as the watch set is installed we
      // have a clean baseline (pendingFiles is only populated by post-start
      // events). Clear defensively and flip ready.
      this.pendingFiles.clear();
      this.ready = true;
      for (const cb of this.readyWaiters) cb();
      this.readyWaiters.length = 0;
      if (IS_TEST_RUNTIME) liveWatchersForTests.set(this.projectRoot, this);

      logDebug('File watcher started', {
        projectRoot: this.projectRoot,
        debounceMs: this.debounceMs,
        mode: this.inertForTests ? 'inert' : supportsRecursiveWatch() ? 'recursive' : 'per-directory',
        watchedDirs: this.dirWatchers.size || undefined,
      });
      return true;
    } catch (err) {
      // Watcher setup failed (e.g., permission denied, missing directory).
      logWarn('Could not start file watcher', { error: String(err) });
      this.stop();
      return false;
    }
  }

  /**
   * macOS/Windows: one recursive watcher for the whole tree. O(1) descriptors.
   * `filename` arrives relative to the project root (with subdirectories), so
   * it maps straight to a project-relative path.
   */
  private startRecursive(): void {
    this.recursiveWatcher = fs.watch(
      this.projectRoot,
      { recursive: true, persistent: true },
      (_event, filename) => {
        if (this.stopped || filename == null) return;
        this.handleChange(normalizePath(String(filename)));
      }
    );
    this.recursiveWatcher.on('error', (err: unknown) => {
      logWarn('File watcher error', { error: String(err) });
    });
  }

  /**
   * Linux: walk the (non-ignored) tree and watch each directory. One inotify
   * watch per directory reports create/modify/delete for that directory's
   * direct children, so we never watch individual files.
   */
  private startPerDirectory(): void {
    this.watchTree(this.projectRoot, /* markExisting */ false);
  }

  /**
   * Add an inotify watch for `dir` and recurse into its non-ignored
   * subdirectories. When `markExisting` is true (a directory that appeared
   * AFTER startup), the source files already inside it are recorded as pending
   * — this closes the `mkdir + write` race where files created before the new
   * directory's watch is installed would otherwise be missed until the next
   * full sync. The initial startup walk passes false (the engine's catch-up
   * sync owns the baseline).
   */
  private watchTree(dir: string, markExisting: boolean): void {
    if (this.dirWatchers.has(dir)) return;
    if (this.dirWatchers.size >= maxDirWatches()) {
      if (!this.dirCapWarned) {
        this.dirCapWarned = true;
        logWarn('File watcher hit directory-watch cap; remaining subtrees rely on manual/periodic sync', {
          cap: maxDirWatches(),
        });
      }
      return;
    }

    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, { persistent: true }, (_event, filename) =>
        this.handleDirEvent(dir, filename)
      );
    } catch {
      // ENOENT / EACCES / too-many-open-files — skip this directory quietly.
      return;
    }
    w.on('error', () => this.unwatchDir(dir));
    this.dirWatchers.set(dir, w);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.shouldIgnoreDir(child)) continue;
        this.watchTree(child, markExisting);
      } else if (markExisting && entry.isFile()) {
        this.handleChange(normalizePath(path.relative(this.projectRoot, child)));
      }
    }
  }

  /**
   * Linux per-directory event handler. `filename` is relative to `dir`. A new
   * sub-directory is picked up by extending the watch tree; everything else is
   * routed through the shared change handler.
   */
  private handleDirEvent(dir: string, filename: string | Buffer | null): void {
    if (this.stopped || filename == null) return;
    const full = path.join(dir, String(filename));

    // A newly-created directory needs its own watch (recursive isn't available
    // on Linux). statSync is cheap and these events are rare relative to file
    // edits. If the path vanished (rapid create/delete) the stat throws and we
    // fall through to the change handler, which no-ops on a non-source path.
    try {
      if (fs.statSync(full).isDirectory()) {
        if (!this.shouldIgnoreDir(full)) this.watchTree(full, /* markExisting */ true);
        return;
      }
    } catch {
      // deleted/inaccessible — treat as a normal change below
    }

    this.handleChange(normalizePath(path.relative(this.projectRoot, full)));
  }

  /**
   * Shared change handler for both watch strategies. `rel` is a
   * project-relative POSIX path. Applies the ignore + source-file filters and,
   * for a real source change, records it as pending (#403) and schedules a
   * debounced sync.
   *
   * The recursive (macOS/Windows) watcher reports events for ignored trees too
   * (one stream covers the whole repo), so the ignore check here is load-bearing
   * — it drops node_modules/dist/.git churn before any sync is scheduled.
   */
  private handleChange(rel: string): void {
    if (!rel || rel === '.' || rel.startsWith('..')) return;
    if (this.isAlwaysIgnored(rel)) return;
    if (this.ignoreMatcher && this.ignoreMatcher.ignores(rel)) return;
    if (!isSourceFile(rel)) return;

    logDebug('File change detected', { file: rel });
    if (this.ready) {
      const now = Date.now();
      const existing = this.pendingFiles.get(rel);
      this.pendingFiles.set(rel, {
        firstSeenMs: existing?.firstSeenMs ?? now,
        lastSeenMs: now,
      });
    }
    this.scheduleSync();
  }

  /** Close and forget the watch for a directory that errored/was removed. */
  private unwatchDir(dir: string): void {
    const w = this.dirWatchers.get(dir);
    if (w) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
      this.dirWatchers.delete(dir);
    }
  }

  /** Our own dirs are always ignored, regardless of .gitignore. */
  private isAlwaysIgnored(rel: string): boolean {
    // First path segment. Ignore any CodeGraph data dir — the active one AND a
    // sibling like `.codegraph-win` a second environment (Windows/WSL) created
    // in the same tree, so neither side watches the other's index (#636).
    const top = rel.split('/')[0] ?? rel;
    return (
      isCodeGraphDataDir(top) ||
      rel === '.git' || rel.startsWith('.git/')
    );
  }

  /**
   * True for any directory that should NOT be watched (used while building the
   * Linux per-directory watch tree). Tests the directory form of the path so a
   * dir-only ignore rule like `build/` matches.
   */
  private shouldIgnoreDir(dirPath: string): boolean {
    const rel = normalizePath(path.relative(this.projectRoot, dirPath));
    if (!rel || rel === '.' || rel.startsWith('..')) return false; // root / outside
    if (this.isAlwaysIgnored(rel)) return true;
    if (!this.ignoreMatcher) return false;
    return this.ignoreMatcher.ignores(rel + '/');
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

    if (this.recursiveWatcher) {
      try {
        this.recursiveWatcher.close();
      } catch {
        /* already closed */
      }
      this.recursiveWatcher = null;
    }
    for (const w of this.dirWatchers.values()) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.dirWatchers.clear();
    this.dirCapWarned = false;
    this.inert = false;

    this.pendingFiles.clear();
    this.ready = false;
    this.ignoreMatcher = null;
    if (IS_TEST_RUNTIME) liveWatchersForTests.delete(this.projectRoot);
    logDebug('File watcher stopped');
  }

  /**
   * @internal Test-only: feed a synthetic project-relative change through the
   * same filter → pendingFiles → debounced-sync path a real fs.watch event
   * takes. Lets the watcher / staleness-banner suites stay deterministic
   * instead of racing on OS watch-delivery latency. See
   * {@link __emitWatchEventForTests}.
   */
  ingestEventForTests(relPath: string): void {
    this.handleChange(normalizePath(relPath));
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return (this.recursiveWatcher !== null || this.dirWatchers.size > 0 || this.inert) && !this.stopped;
  }

  /**
   * Resolves once the watch set has been installed (or immediately if it
   * already has). Useful for tests that need a deterministic boundary before
   * asserting on `pendingFiles`.
   *
   * Production callers don't need this: `pendingFiles` is read continuously,
   * the staleness banner is always correct (empty or populated), and there is
   * no asynchronous initial-scan window with `fs.watch`.
   */
  waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(handler);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = () => { clearTimeout(t); resolve(); };
      this.readyWaiters.push(handler);
    });
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
   *
   * pendingFiles is NOT cleared at the start of sync — entries are removed
   * only after sync commits successfully, and only for entries whose
   * lastSeenMs <= syncStartedMs. That way, a query that arrives mid-sync
   * still sees the affected files marked stale (the DB hasn't been updated
   * yet), and an event that lands mid-sync persists into the follow-up.
   *
   * On sync failure pendingFiles is left untouched — every edit is still
   * unindexed, and the rescheduled sync will absorb the same set next time.
   */
  private async flush(): Promise<void> {
    // If already syncing, the post-sync check will re-trigger
    if (this.syncing || this.stopped) return;

    this.syncStartedMs = Date.now();
    this.syncing = true;

    try {
      const result = await this.syncFn();
      // Remove entries whose most recent event predates this sync — those
      // edits are now in the DB. Entries with lastSeenMs > syncStartedMs
      // arrived mid-sync; whether the in-flight sync captured them depends
      // on when sync read that file, so we keep them as pending and let
      // the follow-up sync handle them. We prefer false positives ("shown
      // stale, actually fresh" → at worst one extra Read) over false
      // negatives ("shown fresh, actually stale" → misleads the agent).
      for (const [filePath, info] of this.pendingFiles) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingFiles.delete(filePath);
        }
      }
      this.onSyncComplete?.(result);
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        // Lock-failure no-op (another writer holds the lock). pendingFiles
        // stays intact and the `finally` block reschedules. Debug-only —
        // a long external index would otherwise spam stderr every cycle.
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingFiles.size,
        });
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        logWarn('Watch sync failed', { error: error.message });
        this.onSyncError?.(error);
      }
      // Failure: leave pendingFiles untouched. Every edit it tracks is
      // still unindexed; the rescheduled sync sees the same set.
    } finally {
      this.syncing = false;

      // If pending files remain (mid-sync events, or this sync failed),
      // schedule another pass.
      if (this.pendingFiles.size > 0 && !this.stopped) {
        this.scheduleSync();
      }
    }
  }

  /**
   * Snapshot of files seen by the watcher since the last successful sync.
   *
   * Used by MCP tool responses to mark stale results without blocking on a
   * sync: a tool that returns a hit in `src/foo.ts` while `src/foo.ts` is in
   * this list tells the agent "Read this file directly, the index lags."
   *
   * `indexing` is true when a sync is currently in flight whose start time is
   * AFTER this file's most recent event — i.e. that sync will absorb the
   * edit. False means the file is still inside the debounce window and no
   * sync has started yet (a follow-up call a few hundred ms later may show
   * `indexing: true` or the file may have left the list entirely).
   *
   * Cheap: O(pendingFiles.size), no I/O, no locks.
   */
  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = [];
    for (const [filePath, info] of this.pendingFiles) {
      result.push({
        path: filePath,
        firstSeenMs: info.firstSeenMs,
        lastSeenMs: info.lastSeenMs,
        indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
      });
    }
    return result;
  }
}

/**
 * Test-only: synthesize a source-file change for the live watcher running at
 * `projectRoot`, exercising the real filter → pendingFiles → debounced-sync
 * logic without depending on fs.watch delivery timing (which races under
 * parallel vitest). `relPath` is project-relative POSIX (e.g. "src/foo.ts").
 * Returns false if no live watcher is registered for that root (e.g. outside a
 * test runtime, where the registry is intentionally not populated).
 */
export function __emitWatchEventForTests(projectRoot: string, relPath: string): boolean {
  const w = liveWatchersForTests.get(projectRoot);
  if (!w) return false;
  w.ingestEventForTests(relPath);
  return true;
}
