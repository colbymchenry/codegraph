/**
 * CodeGraph Utilities
 *
 * Common utility functions for memory management, concurrency, batching,
 * and security validation.
 *
 * @module utils
 *
 * @example
 * ```typescript
 * import { Mutex, processInBatches, MemoryMonitor, validatePathWithinRoot } from 'codegraph';
 *
 * // Use mutex for concurrent safety
 * const mutex = new Mutex();
 * await mutex.withLock(async () => {
 *   await performCriticalOperation();
 * });
 *
 * // Process items in batches to manage memory
 * const results = await processInBatches(items, 100, async (item) => {
 *   return await processItem(item);
 * });
 *
 * // Monitor memory usage
 * const monitor = new MemoryMonitor(512, (usage) => {
 *   console.warn(`Memory usage exceeded 512MB: ${usage / 1024 / 1024}MB`);
 * });
 * monitor.start();
 * ```
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================
// SECURITY UTILITIES
// ============================================================

/**
 * Sensitive system directories that should never be used as project roots.
 * Checked on all platforms; non-applicable paths are harmlessly skipped.
 */
const SENSITIVE_PATHS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys',
  '/root', '/boot', '/lib', '/lib64', '/opt',
  'c:\\', 'c:\\windows', 'c:\\windows\\system32',
]);

/**
 * Credential and config folders in the home directory. Unlike the system set,
 * everything under them is refused too.
 */
const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config'];

/**
 * How long the real paths of the sensitive home folders are reused. The viewer
 * re-checks its root on every file it reads, so they are not re-read per check,
 * but a folder linked somewhere new while the process runs is noticed soon.
 */
const SENSITIVE_HOME_TTL_MS = 2_000;

let sensitiveHomeCache: { home: string; expires: number; trees: string[] } | undefined;
let sensitiveSystemRealPaths: Set<string> | undefined;

/**
 * Config "languages" whose nodes are pure key/value DATA lifted from a config
 * file (e.g. Spring `application.{yml,properties}`), not source code.
 */
export const CONFIG_LEAF_LANGUAGES: ReadonlySet<string> = new Set(['yaml', 'properties']);

/**
 * A config-leaf node is a single key lifted out of a pure config/data file —
 * `kind: 'constant'` in a {@link CONFIG_LEAF_LANGUAGES} language. Its on-disk
 * line is `key = <value>`, and that value is routinely a secret (DB password,
 * API key, JDBC URL with embedded creds). CodeGraph must surface the KEY only
 * and never read/return the value, or it pushes secrets into agent context
 * unbidden — the value isn't needed for resolution, and an agent that genuinely
 * needs it can read the file directly. (#383)
 */
export function isConfigLeafNode(node: { kind: string; language?: string }): boolean {
  return node.kind === 'constant' && !!node.language && CONFIG_LEAF_LANGUAGES.has(node.language);
}

/**
 * Whether `child` is `parent` or lies under it, compared exactly as given.
 *
 * A root (`C:\`, `\\server\share\`, `/`) already ends with its separator, so
 * none is added to it. Adding one made `C:\\` the prefix, which no path under
 * the root starts with, so a project at a drive root indexed nothing (#415).
 */
function isSameOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Whether `child` is `parent` itself or sits underneath it. Case-insensitive on
 * Windows — NTFS is case-insensitive, and realpathSync can hand back a different
 * case than the lexical root, which would otherwise false-reject a valid file.
 */
function isWithinDir(child: string, parent: string): boolean {
  if (process.platform === 'win32') {
    return isSameOrUnder(child.toLowerCase(), parent.toLowerCase());
  }
  return isSameOrUnder(child, parent);
}

/**
 * The lexical half of {@link validatePathWithinRoot}, on its own.
 *
 * Returns the resolved absolute path when `filePath` stays inside
 * `projectRoot` after `../` segments are applied, or null when it escapes.
 * No filesystem access — for callers on a hot path that only need to refuse a
 * lexical escape, and for which the realpath half would be both unnecessary
 * and far too expensive (the existence probe in resolution's `fileExists`,
 * #1631: two `realpathSync` calls per probe made it ~70x slower).
 *
 * This is NOT a substitute for `validatePathWithinRoot` on any path whose
 * contents get served — those must keep the symlink-aware check (#527).
 */
export function lexicalPathWithinRoot(projectRoot: string, filePath: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  return isWithinDir(resolved, path.resolve(projectRoot)) ? resolved : null;
}

/**
 * Whether a filesystem error means nothing is at the path: ENOENT, or ENOTDIR,
 * which POSIX reports instead when a folder on the way is a file (Windows
 * reports ENOENT for both).
 */
export function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Validate that a file path stays within the project root, resolving symlinks.
 *
 * Two layers: a cheap lexical check that catches `../` traversal, then a
 * realpath check that catches symlink escapes — an in-repo symlink whose
 * logical path is inside the root but whose real target points outside it
 * (issue #527). A symlink that stays within the root is still allowed, so
 * legitimate in-tree symlinks keep working. Both content-serving read sinks
 * (codegraph_node `includeCode`, codegraph_explore source) go through here, so
 * this is the chokepoint that keeps out-of-root file contents from leaking.
 *
 * `allowSymlinkEscape` waives **only** the realpath-escape rejection (the
 * lexical `../` guard still applies) for the INDEXING read path. The directory
 * walk deliberately descends into in-root symlinks whose targets live outside
 * the root (e.g. a `game/` symlink in a Dota custom-game tree, #935); discovery
 * and the reader must agree, or every file the walk enumerated fails to index.
 * Indexing only reads paths it just discovered, into a local index — it never
 * serves them to an agent, so this does not widen the #527 leak surface. The
 * content-serving sinks must never pass this flag.
 *
 * @param projectRoot - The project root directory
 * @param filePath - The (relative or absolute) file path to validate
 * @param options.allowSymlinkEscape - Follow in-root symlinks out of the root
 *   (indexing read path only); defaults to the strict, leak-safe behavior.
 * @returns The resolved absolute path (realpath when it exists), or null if it
 *   escapes the root. A path that does not exist yet is judged by its nearest
 *   existing ancestor, and every path under a root that does not exist is null.
 */
export function validatePathWithinRoot(
  projectRoot: string,
  filePath: string,
  options?: { allowSymlinkEscape?: boolean }
): string | null {
  // 1. Lexical containment — cheap, catches `../` traversal. Applies even on
  //    the indexing read path: a crafted `../` escape is still rejected.
  const resolved = lexicalPathWithinRoot(projectRoot, filePath);
  if (resolved === null) {
    return null;
  }
  const normalizedRoot = path.resolve(projectRoot);

  // 2. Symlink-aware containment — resolve symlinks on both sides and re-check,
  //    so an in-repo symlink whose real target escapes the root is rejected.
  //    The indexing read path (allowSymlinkEscape) skips only this rejection so
  //    it stays consistent with the directory walk, which already followed the
  //    in-root symlink to enumerate these files (#935).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(normalizedRoot);
  } catch {
    return null;
  }

  try {
    const realResolved = fs.realpathSync(resolved);
    if (options?.allowSymlinkEscape) {
      return realResolved;
    }
    return isWithinDir(realResolved, realRoot) ? realResolved : null;
  } catch (err) {
    // A missing leaf may still sit below an EXISTING symlink. Resolve the
    // nearest existing ancestor before allowing a write path: otherwise
    // `project/.codegraph/ui -> /outside` plus a missing `trails/` directory
    // passes the lexical check and mkdir follows the symlink out of the root.
    // A path under a file (ENOTDIR on POSIX) is a missing leaf too.
    if (!isMissingPathError(err)) return null;
  }

  let ancestor = path.dirname(resolved);
  while (isWithinDir(ancestor, normalizedRoot)) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      if (options?.allowSymlinkEscape || isWithinDir(realAncestor, realRoot)) {
        return resolved;
      }
      return null;
    } catch (err) {
      if (!isMissingPathError(err)) return null;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
  return null;
}

/**
 * A path in the form the sensitive-folder check compares: lower-cased where the
 * file system ignores case by default (NTFS, APFS), so `~/.SSH` is `~/.ssh`.
 */
function foldPathCase(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * The plain spelling of a Win32 namespace path: `\\?\C:\x` and `\\.\C:\x` are
 * `C:\x`, and `\\?\UNC\host\share` is `\\host\share`. `path.resolve` keeps the
 * prefix, so a string comparison would never see the folder behind it. Other
 * namespace paths (a `\\?\Volume{…}\` name, a device) are returned unchanged;
 * the real path the caller also checks names their folder.
 */
function stripWin32NamespacePrefix(p: string): string {
  if (process.platform !== 'win32') return p;
  const prefix = /^[\\/]{2}[?.][\\/](UNC[\\/])?/i.exec(p);
  if (!prefix) return p;
  const rest = p.slice(prefix[0].length);
  if (prefix[1]) return `\\\\${rest}`;
  return /^[a-z]:[\\/]/i.test(rest) ? rest : p;
}

/**
 * The folder a path really names: links (symlinks, junctions, a `subst` drive)
 * followed, and the case and long names stored on disk. Null when it can't be
 * resolved, most often because it doesn't exist; the lexical check still runs.
 */
function nativeRealPath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * The system set's own real paths, folded. macOS keeps `/etc`, `/tmp` and
 * `/var` under `/private`, so a project whose real path is `/private/etc` is
 * `/etc`. Read once: these folders don't move.
 */
function sensitiveSystemPaths(): Set<string> {
  if (!sensitiveSystemRealPaths) {
    sensitiveSystemRealPaths = new Set();
    for (const entry of SENSITIVE_PATHS) {
      // Only this platform's entries: on Windows `/` would resolve to the root
      // of the current drive and refuse every project at a drive root.
      const native = process.platform === 'win32' ? /^[a-z]:\\/.test(entry) : entry.startsWith('/');
      if (!native) continue;
      const real = nativeRealPath(entry);
      if (real) sensitiveSystemRealPaths.add(foldPathCase(real));
    }
  }
  return sensitiveSystemRealPaths;
}

/**
 * The sensitive home folders, folded: as spelled under the home directory,
 * under the home's real path (a linked home), and each folder's own real path
 * (a `~/.ssh` that is itself a link into a dotfiles checkout).
 */
function sensitiveHomeTrees(): string[] {
  const home = os.homedir();
  const now = Date.now();
  if (sensitiveHomeCache && sensitiveHomeCache.home === home && now < sensitiveHomeCache.expires) {
    return sensitiveHomeCache.trees;
  }
  const trees = new Set<string>();
  const realHome = nativeRealPath(home);
  for (const dir of SENSITIVE_HOME_DIRS) {
    const spelled = path.join(home, dir);
    trees.add(foldPathCase(spelled));
    if (realHome) trees.add(foldPathCase(path.join(realHome, dir)));
    const real = nativeRealPath(spelled);
    if (real) trees.add(foldPathCase(real));
  }
  sensitiveHomeCache = { home, expires: now + SENSITIVE_HOME_TTL_MS, trees: [...trees] };
  return sensitiveHomeCache.trees;
}

/**
 * Validate that a path is a safe project root directory.
 *
 * Rejects sensitive system directories and ensures the path is
 * a real, existing directory. Used at MCP and API entry points
 * to prevent arbitrary directory access.
 *
 * The path is checked both as spelled and as the folder it really names, so a
 * link to `~/.ssh`, a case variant (`~/.SSH`) or a `\\?\` spelling is refused
 * like the folder itself (#1930). It is kept to one realpath per call, since the
 * viewer calls this for every file it reads: the sensitive folders' own real
 * paths are cached and re-read every couple of seconds.
 *
 * @param dirPath - The path to validate
 * @returns An error message if invalid, or null if valid
 */
export function validateProjectPath(dirPath: string): string | null {
  const resolved = path.resolve(dirPath);
  const lexical = path.resolve(stripWin32NamespacePrefix(dirPath));
  const real = nativeRealPath(lexical);
  const candidates = [lexical];
  if (real && real !== lexical) candidates.push(real);
  const named = (candidate: string): string =>
    candidate === resolved ? resolved : `${resolved} (resolves to ${candidate})`;

  // Block sensitive system directories
  const systemPaths = sensitiveSystemPaths();
  for (const candidate of candidates) {
    if (
      SENSITIVE_PATHS.has(candidate) ||
      SENSITIVE_PATHS.has(candidate.toLowerCase()) ||
      systemPaths.has(foldPathCase(candidate))
    ) {
      return `Refusing to operate on sensitive system directory: ${named(candidate)}`;
    }
  }

  // Also block common sensitive home subdirectories
  const homeTrees = sensitiveHomeTrees();
  for (const candidate of candidates) {
    const folded = foldPathCase(candidate);
    if (homeTrees.some((tree) => isSameOrUnder(folded, tree))) {
      return `Refusing to operate on sensitive directory: ${named(candidate)}`;
    }
  }

  // Verify it's a real directory
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return `Path is not a directory: ${resolved}`;
    }
  } catch {
    return `Path does not exist or is not accessible: ${resolved}`;
  }

  return null;
}

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database metadata.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Clamp a numeric value to a range.
 * Used to enforce sane limits on MCP tool inputs.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a file path to use forward slashes.
 * Fixes Windows backslash paths so glob matching works consistently.
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Escape `text` to match itself literally inside a regular expression.
 * Symbol names are not always plain words: C++'s `operator++` and
 * `operator()`, Scala's `++`, a Kotlin name in backticks. Pass every name
 * through this before writing it into a `new RegExp(…)` pattern, or the name
 * is read as pattern syntax and may not compile at all.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface FileLockOptions {
  /** @internal Test-only synchronization hook for verifying concurrency barriers */
  __testHook?: (stage: 'afterReadEntries' | 'afterRmdir') => void;
}

/**
 * Cross-process file lock using a lock file with PID tracking.
 *
 * Prevents multiple processes (e.g., git hooks, CLI, MCP server) from
 * writing to the same database simultaneously.
 */
export class FileLock {
  private lockPath: string;
  private held = false;
  private options?: FileLockOptions;

  constructor(lockPath: string, options?: FileLockOptions) {
    this.lockPath = lockPath;
    this.options = options;
  }

  /**
   * Acquire the lock. Throws if the lock is held by another live process.
   */
  acquire(isRetry = false): void {
    // 1. Fast-path: attempt to acquire the lock directly using exclusive creation
    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });

      // If a takeover coordination directory exists and is held by a live process, back off
      const takeoverDir = `${this.lockPath}.takeover.d`;
      if (fs.existsSync(takeoverDir) && this.hasActiveLiveTakeover(takeoverDir)) {
        try { fs.unlinkSync(this.lockPath); } catch {}
        throw new Error(
          'CodeGraph database is locked by another process. ' +
          `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
        );
      }

      this.held = true;
      return;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('locked by another process')) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    // 2. Lock file exists. Read PID and check if held by a live process
    let content = '';
    try {
      content = fs.readFileSync(this.lockPath, 'utf-8').trim();
    } catch {
      // If deleted between wx and read, restart acquisition through the guarded path once
      if (!isRetry) {
        return this.acquire(true);
      }
      throw new Error(
        'CodeGraph database is locked by another process. ' +
        `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
      );
    }

    const pid = parseInt(content, 10);
    // A long sync can hold the lock for hours. Its age says nothing about
    // whether the writer is still alive; only a dead PID is stale.
    if (!isNaN(pid) && this.isProcessAlive(pid)) {
      throw new Error(
        `CodeGraph database is locked by another process (PID ${pid}). ` +
        `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
      );
    }

    // 3. Stale lock detected (dead process, unparseable, or empty PID).
    // Coordinate takeover using an exclusive takeover directory to ensure deterministic
    // mutual exclusion under arbitrary process scheduling (#2979).
    const takeoverDir = `${this.lockPath}.takeover.d`;
    const acquiredCoordination = this.acquireTakeoverCoordination(takeoverDir);

    if (!acquiredCoordination) {
      throw new Error(
        'CodeGraph database is locked by another process. ' +
        `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
      );
    }

    try {
      // Double check under exclusive takeover coordination:
      // Confirm the target lock file is not held by another live process.
      if (fs.existsSync(this.lockPath)) {
        try {
          const curContent = fs.readFileSync(this.lockPath, 'utf-8').trim();
          const curPid = parseInt(curContent, 10);
          if (!isNaN(curPid) && this.isProcessAlive(curPid) && curPid !== process.pid) {
            throw new Error(
              `CodeGraph database is locked by another process (PID ${curPid}). ` +
              `If this is stale, run 'codegraph unlock' or delete ${this.lockPath}`
            );
          }
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
      }

      // Atomically replace the lock file with our PID
      const tempLockFile = `${this.lockPath}.new.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tempLockFile, String(process.pid));
        try {
          fs.renameSync(tempLockFile, this.lockPath);
        } catch {
          // Fallback for filesystems that do not allow atomic rename over existing file:
          // Unlink the verified stale file, then recreate exclusively with 'wx'.
          // Using 'wx' guarantees that if another process grabbed the path during
          // the gap, EEXIST is thrown and no live lock is ever overwritten.
          try { fs.unlinkSync(this.lockPath); } catch {}
          fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
        }
      } finally {
        try { if (fs.existsSync(tempLockFile)) fs.unlinkSync(tempLockFile); } catch {}
      }

      this.held = true;
    } finally {
      // Clean up takeover coordination directory
      try {
        const myPidFile = path.join(takeoverDir, String(process.pid));
        try { fs.unlinkSync(myPidFile); } catch {}
        fs.rmdirSync(takeoverDir);
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Release the lock
   */
  release(): void {
    if (!this.held) return;
    try {
      // Only remove if we still own it (check PID)
      const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
      if (parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file already gone - that's fine
    }
    this.held = false;
  }

  /**
   * Acquire exclusive right to take over a stale lock using an atomic directory claim.
   *
   * POSIX and Windows filesystem semantics guarantee:
   * 1. A pre-populated temporary directory atomically moved (rename) into place succeeds
   *    for at most one process.
   * 2. rmdirSync fails with ENOTEMPTY if the directory contains any entry.
   * 3. A delayed process attempting to unlink a dead PID entry cannot delete another
   *    process's live PID entry because the file name includes the specific PID.
   */
  private acquireTakeoverCoordination(takeoverDir: string): boolean {
    const parentDir = path.dirname(takeoverDir);
    const tempDir = path.join(
      parentDir,
      `.takeover.tmp.${process.pid}.${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    const myPidFile = path.join(tempDir, String(process.pid));

    try {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(myPidFile, '');
    } catch {
      return false;
    }

    try {
      // 1. Fast path: attempt to rename our populated temp directory into takeoverDir
      try {
        fs.renameSync(tempDir, takeoverDir);
        return true;
      } catch {
        // Destination already exists; inspect existing takeover directory
      }

      // 2. Check if existing takeoverDir is held by a live process or is stale
      try {
        if (this.hasActiveLiveTakeover(takeoverDir)) {
          return false;
        }

        // Test hook to allow deterministic barrier testing
        this.options?.__testHook?.('afterReadEntries');

        // All entries belong to dead processes (or directory is empty).
        // Safely remove only verified dead PID entries. Even under arbitrary scheduling
        // pauses, unlinking a specific dead PID name can never touch a live process's PID file.
        const entries = fs.readdirSync(takeoverDir);
        for (const entry of entries) {
          const entryPid = parseInt(entry, 10);
          if (isNaN(entryPid) || !this.isProcessAlive(entryPid)) {
            try {
              fs.unlinkSync(path.join(takeoverDir, entry));
            } catch {
              // Harmless if another process unlinked it
            }
          }
        }

        // Remove empty directory (will fail with ENOTEMPTY if another live process claimed it)
        try {
          fs.rmdirSync(takeoverDir);
        } catch {
          // If another process removed it or it's not empty, ignore
        }

        // Test hook to allow deterministic barrier testing
        this.options?.__testHook?.('afterRmdir');

        // Attempt to atomically claim takeoverDir
        try {
          fs.renameSync(tempDir, takeoverDir);
          return true;
        } catch {
          return false;
        }
      } catch {
        return false;
      }
    } finally {
      // Ensure tempDir is cleaned up if it was not renamed into takeoverDir
      try {
        if (fs.existsSync(tempDir)) {
          try { fs.unlinkSync(myPidFile); } catch {}
          fs.rmdirSync(tempDir);
        }
      } catch {}
    }
  }

  /**
   * Execute a function while holding the lock
   */
  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  /**
   * Execute an async function while holding the lock
   */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Check if a process is still running
   */
  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return true;
      return false;
    }
  }

  /**
   * Check whether takeover coordination is actively held by another living process.
   */
  private hasActiveLiveTakeover(takeoverDir: string): boolean {
    try {
      const entries = fs.readdirSync(takeoverDir);
      for (const entry of entries) {
        const entryPid = parseInt(entry, 10);
        if (!isNaN(entryPid) && entryPid !== process.pid && this.isProcessAlive(entryPid)) {
          return true;
        }
      }
    } catch {
      // Directory missing or unreadable
    }
    return false;
  }
}

/**
 * Process items in batches to manage memory
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per batch
 * @param processor - Function to process each item
 * @param onBatchComplete - Optional callback after each batch
 * @returns Array of results
 */
export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>,
  onBatchComplete?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchResults = await Promise.all(
      batch.map((item, idx) => processor(item, i + idx))
    );
    results.push(...batchResults);

    if (onBatchComplete) {
      onBatchComplete(Math.min(i + batchSize, items.length), items.length);
    }

    // Allow GC between batches
    if (global.gc) {
      global.gc();
    }
  }

  return results;
}

/**
 * Simple mutex lock for preventing concurrent operations
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  /**
   * Acquire the lock
   *
   * @returns A release function to call when done
   */
  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.locked = true;

    return () => {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    };
  }

  /**
   * Execute a function while holding the lock
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if the lock is currently held
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Chunked file reader for large files
 *
 * Reads a file in chunks to avoid loading entire file into memory.
 */
export async function* readFileInChunks(
  filePath: string,
  chunkSize: number = 64 * 1024
): AsyncGenerator<string, void, undefined> {
  const fs = await import('fs');

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize);

  try {
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null)) > 0) {
      yield buffer.toString('utf-8', 0, bytesRead);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Debounce a function
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle a function
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn(...args);
      }, remaining);
    }
  };
}

/**
 * Estimate memory usage of an object (rough approximation)
 *
 * @param obj - Object to measure
 * @returns Approximate size in bytes
 */
export function estimateSize(obj: unknown): number {
  const seen = new WeakSet();

  function sizeOf(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }

    switch (typeof value) {
      case 'boolean':
        return 4;
      case 'number':
        return 8;
      case 'string':
        return 2 * (value as string).length;
      case 'object':
        if (seen.has(value as object)) {
          return 0;
        }
        seen.add(value as object);

        if (Array.isArray(value)) {
          return value.reduce((acc: number, item) => acc + sizeOf(item), 0);
        }

        return Object.entries(value as object).reduce(
          (acc, [key, val]) => acc + sizeOf(key) + sizeOf(val),
          0
        );
      default:
        return 0;
    }
  }

  return sizeOf(obj);
}

/**
 * Memory monitor for tracking usage during operations
 */
export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private peakUsage = 0;
  private threshold: number;
  private onThresholdExceeded?: (usage: number) => void;

  constructor(
    thresholdMB: number = 500,
    onThresholdExceeded?: (usage: number) => void
  ) {
    this.threshold = thresholdMB * 1024 * 1024;
    this.onThresholdExceeded = onThresholdExceeded;
  }

  /**
   * Start monitoring memory usage
   */
  start(intervalMs: number = 1000): void {
    this.stop();
    this.peakUsage = 0;

    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage().heapUsed;
      if (usage > this.peakUsage) {
        this.peakUsage = usage;
      }
      if (usage > this.threshold && this.onThresholdExceeded) {
        this.onThresholdExceeded(usage);
      }
    }, intervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get peak memory usage in bytes
   */
  getPeakUsage(): number {
    return this.peakUsage;
  }

  /**
   * Get current memory usage in bytes
   */
  getCurrentUsage(): number {
    return process.memoryUsage().heapUsed;
  }
}
