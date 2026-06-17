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
 * indexer's `buildScopeIgnore` (built-in default-ignore dirs + the project's
 * .gitignore) — on Linux they're never descended into (so they cost no watch),
 * and on macOS/Windows the single recursive stream still covers them but their
 * events are dropped before any sync is scheduled. Either way the watcher's
 * scope matches the indexer's (#276 / #407).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSourceFile, buildScopeIgnore, type ScopeIgnore } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { isCodeGraphDataDir } from '../directory';
import { watchDisabledReason } from './watch-policy';

/**
 * Number of consecutive lock-contention retries the watcher tolerates before
 * it gives up and degrades auto-sync. Brief contention (another writer for a
 * few cycles) stays under this; a long-lived external writer crosses it.
 */
const MAX_LOCK_RETRIES = 5;
/** Cap on the exponential lock-retry backoff so it never sleeps absurdly long. */
const MAX_LOCK_RETRY_DELAY_MS = 30_000;

/** Actionable degrade message; both exhaustion paths share it verbatim. */
const EXHAUSTION_REASON =
  'OS watch/file limit exhausted; auto-sync disabled. Run `codegraph sync` ' +
  '(or install git sync hooks) to refresh the graph after changes.';

/**
 * Actionable, NON-fatal warning for Linux inotify watch-count exhaustion.
 * Unlike {@link EXHAUSTION_REASON} this does not disable the watcher — the
 * watches already installed keep working — so it names the exact kernel knob to
 * raise instead.
 */
const INOTIFY_LIMIT_REASON =
  'Linux inotify watch limit reached (fs.inotify.max_user_watches); live ' +
  'watching now covers only part of the project, so edits in unwatched ' +
  'directories will not auto-sync. Raise the limit (e.g. `sudo sysctl ' +
  'fs.inotify.max_user_watches=1048576`, persisted in /etc/sysctl.d) and ' +
  'restart, or run `codegraph sync` (or install git sync hooks) to refresh.';

/**
 * True when an error is OS watch/file-descriptor exhaustion (EMFILE/ENFILE).
 * Prefers the structured `err.code`; falls back to message matching ONLY when
 * no code is present (some platforms surface a bare Error from `fs.watch`).
 */
function isWatchResourceExhaustion(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === 'EMFILE' || e?.code === 'ENFILE') return true;
  if (!e?.code && e?.message) {
    return /EMFILE|ENFILE|too many open files/i.test(e.message);
  }
  return false;
}

/**
 * True when an error is Linux inotify *watch-count* exhaustion. `fs.watch`
 * surfaces a hit `fs.inotify.max_user_watches` as ENOSPC ("no space" = no watch
 * descriptors left, NOT disk space). This only arises on the Linux
 * per-directory path; it is non-fatal (raise the limit and partial watching
 * keeps working), so it warns rather than degrading.
 */
function isInotifyWatchExhaustion(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC';
}

/**
 * Native recursive `fs.watch` is only reliable on macOS and Windows; on Linux
 * (and AIX) it throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. We branch on this
 * to pick the recursive vs per-directory strategy.
 */
function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * Indirection over `fs.watch` so tests can inject a fake that throws or emits
 * `EMFILE`/`ENFILE` deterministically (real watch-resource exhaustion can't be
 * provoked reliably, and `fs.watch` is a non-configurable property so it can't
 * be spied). Production always uses the real `fs.watch`.
 */
type WatchFn = typeof fs.watch;
let watchImpl: WatchFn = fs.watch;

/** @internal Test-only seam to inject a fake fs.watch implementation. */
export function __setFsWatchForTests(fn: WatchFn | null): void {
  watchImpl = fn ?? fs.watch;
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
   * Callback fired ONCE when live watching degrades permanently and auto-sync
   * is disabled — OS watch-resource exhaustion (EMFILE/ENFILE), or a write lock
   * held past the retry budget. The string is an actionable, human-readable
   * reason. Lets a host (MCP server, daemon, CLI) tell the user that the index
   * will no longer auto-update instead of silently serving stale results.
   */
  onDegraded?: (reason: string) => void;

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
  /**
   * Set once the Linux inotify watch limit (ENOSPC) is hit. Double duty: we
   * warn only once, AND we stop attempting new directory watches for the rest
   * of the session — once the kernel budget is exhausted every further
   * `inotify_add_watch` fails too, so trying the rest of the tree is pure
   * waste. NON-fatal (does not degrade): installed watches keep working.
   */
  private inotifyLimitWarned = false;
  /**
   * One-way latch: the reason live watching was permanently disabled at runtime
   * (watch-resource exhaustion, or lock contention past the retry budget), or
   * null while healthy. Set by {@link degrade}; cleared only by a fresh start().
   */
  private degradedReason: string | null = null;
  /** Consecutive lock-contention retries for watcher-triggered syncs. */
  private lockRetryCount = 0;
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
  // The shared scope matcher (built-in defaults + project .gitignore, with
  // embedded child repos matched by their OWN rules — #514), built once at
  // start(). Same source of truth the indexer uses, so watcher scope can
  // never diverge from index scope. An embedded repo created after start()
  // joins the scope on the next watcher restart / re-index.
  private ignoreMatcher: ScopeIgnore | null = null;

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private readonly onDegraded?: WatchOptions['onDegraded'];
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
    this.onDegraded = options.onDegraded;
    this.inertForTests = options.inertForTests ?? false;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.recursiveWatcher || this.dirWatchers.size > 0 || this.inert) return true; // Already watching
    this.stopped = false;
    this.degradedReason = null;
    this.lockRetryCount = 0;

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
    this.ignoreMatcher = buildScopeIgnore(this.projectRoot);

    try {
      if (this.inertForTests) {
        // Test-only: install no OS watcher; the seam drives events instead.
        this.inert = true;
      } else if (supportsRecursiveWatch()) {
        this.startRecursive();
      } else {
        this.startPerDirectory();
      }

      // The per-directory (Linux) path catches watch-resource exhaustion inside
      // watchTree and degrades synchronously rather than throwing, so it never
      // reaches the catch below. Surface that as a failed start here so both
      // strategies report exhaustion identically (start() === false).
      if (this.degradedReason) return false;

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
      // Watcher setup failed. Watch-resource exhaustion (EMFILE/ENFILE on the
      // recursive path) is terminal — degrade cleanly with one actionable
      // warning instead of leaving a half-broken watcher. Everything else
      // (permission denied, missing directory) keeps the prior quiet-stop.
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err) });
      } else {
        logWarn('Could not start file watcher', { error: String(err) });
        this.stop();
      }
      return false;
    }
  }

  /**
   * macOS/Windows: one recursive watcher for the whole tree. O(1) descriptors.
   * `filename` arrives relative to the project root (with subdirectories), so
   * it maps straight to a project-relative path.
   */
  private startRecursive(): void {
    this.recursiveWatcher = watchImpl(
      this.projectRoot,
      { recursive: true, persistent: true },
      (_event, filename) => {
        if (this.stopped || filename == null) return;
        this.handleChange(normalizePath(String(filename)));
      }
    );
    this.recursiveWatcher.on('error', (err: unknown) => {
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err) });
        return;
      }
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
    // A degrade() mid-walk (exhaustion on an earlier directory) calls stop(),
    // which sets `stopped`; bail so the recursion unwinds without adding more
    // watches to a watcher that is shutting down. `inotifyLimitWarned` does the
    // same after ENOSPC — the kernel budget is gone, so stop trying the rest of
    // the tree (every add would fail) while keeping the watches already set.
    if (this.stopped || this.degradedReason || this.inotifyLimitWarned) return;
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
      w = watchImpl(dir, { persistent: true }, (_event, filename) =>
        this.handleDirEvent(dir, filename)
      );
    } catch (err) {
      // EMFILE/ENFILE means the PROCESS is out of descriptors — every further
      // directory would fail too, so degrade the whole watcher rather than
      // limping along with a partial watch set.
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err), dir });
      } else if (isInotifyWatchExhaustion(err)) {
        // ENOSPC = inotify watch budget exhausted. NON-fatal: keep the watches
        // we have and tell the user the knob to raise (warn once).
        this.warnInotifyLimit({ error: String(err), dir });
      }
      // ENOENT / EACCES on a single directory stays non-fatal: skip it quietly.
      return;
    }
    w.on('error', (err: unknown) => {
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err), dir });
        return;
      }
      if (isInotifyWatchExhaustion(err)) {
        this.warnInotifyLimit({ error: String(err), dir });
      }
      this.unwatchDir(dir);
    });
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
   * Permanently disable live watching after a terminal runtime failure
   * (watch-resource exhaustion, or lock contention past the retry budget).
   * Idempotent: logs one actionable warning, fires {@link WatchOptions.onDegraded}
   * once, and stops the watcher. A subsequent start() clears the latch.
   */
  private degrade(reason: string, context: Record<string, unknown> = {}): void {
    if (this.degradedReason) return;
    this.degradedReason = reason;
    logWarn('File watcher disabled', { projectRoot: this.projectRoot, reason, ...context });
    this.onDegraded?.(reason);
    this.stop();
  }

  /**
   * Warn ONCE that the Linux inotify watch budget is exhausted (ENOSPC), and
   * stop adding new watches for the rest of this session — every further
   * `inotify_add_watch` would fail too, so walking the rest of the tree is
   * waste. Unlike {@link degrade} this is NON-fatal: the watches already
   * installed keep firing, and `codegraph sync` covers the unwatched remainder.
   * The message names the kernel knob to raise (`fs.inotify.max_user_watches`).
   */
  private warnInotifyLimit(context: Record<string, unknown> = {}): void {
    if (this.inotifyLimitWarned) return;
    this.inotifyLimitWarned = true;
    logWarn(INOTIFY_LIMIT_REASON, { watchedDirs: this.dirWatchers.size, ...context });
  }

  /**
   * Whether live watching has degraded permanently (until the next start()).
   * Distinct from {@link isActive}: a degraded watcher is inactive, but an
   * inactive watcher is not necessarily degraded (it may simply be stopped or
   * never started). Hosts use this to tell the user auto-sync is off.
   */
  isDegraded(): boolean {
    return this.degradedReason !== null;
  }

  /** The reason live watching degraded, or null if it is healthy. */
  getDegradedReason(): string | null {
    return this.degradedReason;
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
    this.inotifyLimitWarned = false;
    this.lockRetryCount = 0;
    // NB: degradedReason is intentionally NOT reset here — it must survive the
    // stop() that degrade() triggers so isDegraded() stays true. start() clears it.
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
   * Schedule a normal debounced sync after a source edit.
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
   * Schedule a retry after a recoverable sync failure (lock contention). Kept
   * separate from {@link scheduleSync} so prolonged contention backs off
   * exponentially instead of hammering the lock every debounce cycle.
   */
  private scheduleRetrySync(delayMs: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, delayMs);
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
      this.lockRetryCount = 0; // a clean sync clears any contention backoff
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
        this.lockRetryCount += 1;
        // Lock-failure no-op (another writer holds the lock). pendingFiles
        // stays intact and the `finally` block reschedules with backoff. Keep
        // brief contention quiet (debug-only — a long external index would
        // otherwise spam stderr every cycle), but stop retrying forever: once a
        // writer holds the lock past the budget, degrade auto-sync explicitly.
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingFiles.size,
          retryCount: this.lockRetryCount,
        });
        if (this.lockRetryCount > MAX_LOCK_RETRIES) {
          this.degrade(
            'CodeGraph file lock held by another process past the retry budget; ' +
              'auto-sync disabled. Run `codegraph sync` once the other writer finishes ' +
              '(or install git sync hooks) to refresh the graph.',
            { pendingFiles: this.pendingFiles.size, retryCount: this.lockRetryCount }
          );
        }
      } else {
        this.lockRetryCount = 0; // a non-lock failure isn't contention; reset backoff
        const error = err instanceof Error ? err : new Error(String(err));
        logWarn('Watch sync failed', { error: error.message });
        this.onSyncError?.(error);
      }
      // Failure: leave pendingFiles untouched. Every edit it tracks is
      // still unindexed; the rescheduled sync sees the same set.
    } finally {
      this.syncing = false;

      // If pending files remain (mid-sync events, or this sync failed),
      // schedule another pass. After lock contention, back off exponentially
      // (debounceMs · 2^(n-1), capped) instead of retrying at the normal
      // debounce cadence; a clean sync resets lockRetryCount so normal edits
      // keep the fast debounce. A degrade() above already set `stopped`, so
      // this won't reschedule a watcher that has given up.
      if (this.pendingFiles.size > 0 && !this.stopped) {
        if (this.lockRetryCount > 0) {
          const retryDelayMs = Math.min(
            this.debounceMs * 2 ** Math.max(0, this.lockRetryCount - 1),
            MAX_LOCK_RETRY_DELAY_MS
          );
          this.scheduleRetrySync(retryDelayMs);
        } else {
          this.scheduleSync();
        }
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
