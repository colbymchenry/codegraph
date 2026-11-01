/**
 * Project writer lock (#1740).
 *
 * At most one long-lived MCP *writer* (shared daemon OR direct-mode /
 * in-process engine that owns the FileWatcher) may serve a given project.
 * The shared daemon already multiplexes N stdio proxies onto one writer; this
 * lock closes the same-OS gap where two direct-mode `serve --mcp` processes
 * (via `CODEGRAPH_NO_DAEMON=1` or proxy→in-process fallback) each start a
 * watcher, contend on `codegraph.lock`, and degrade auto-sync.
 *
 * Deliberately separate from `daemon.pid`: proxies probe the daemon socket
 * and may clear a live pid that has no socket. A direct-mode holder must not
 * look like a daemon. `writer.pid` is only about "who owns live auto-sync".
 *
 * Every record also carries a {@link LockStamp}: the writer's canonical
 * project root and the identity of the physical index it had open, the
 * `dev:ino` of the `.codegraph` directory and of `codegraph.db`. A copied
 * project carries its original's `.codegraph/` records with it, and their pids
 * are live (the original's server), so pid liveness alone would keep the copy
 * locked out forever. A record is FOREIGN ({@link isForeignLockRecord}) when
 * its recorded root is another project's AND neither recorded identity is this
 * project's index as it is now AND this project's database has one hard link.
 * A copy at another path (cp -R, rsync, clonefile: all make new inodes, and a
 * database with one link) has foreign records, and they are treated like a
 * dead holder: stale, cleared, retried, and invisible to readers.
 *
 * Everything else is decided by pid liveness, because the live holder may
 * still have that database open and calling it stale would start a second
 * writer on it:
 *   - a record at this same root, even with both inodes new: a `.codegraph/`
 *     moved aside and copied back to the same path (a restore) is followed by
 *     its live holder, which reopens the replaced database at that path;
 *   - a project moved with `mv` within one filesystem: a new root, but the
 *     same inodes;
 *   - any record at a project whose `codegraph.db` has more than one hard
 *     link: the file is shared by definition, whatever the record's stamp
 *     says, because a holder that followed a database restored in place keeps
 *     the stamp of the one it first opened.
 * A move across filesystems copies: new inodes and a new root, so its records
 * are foreign there, which is safe: the old holder has only the old, now
 * unlinked files open, not the moved index.
 */

import * as fs from 'fs';
import * as path from 'path';
import { canonicalProjectRoot, getCodeGraphDir, statInode } from '../directory';
/** Signal-0 liveness (EPERM ⇒ alive). Local copy to avoid a daemon↔writer cycle. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}


/**
 * Who wrote a lock record, stamped into every project lock: `writer.pid`,
 * `rebuild.pid`, `daemon.pid` and `codegraph.lock`. The identities are
 * `dev:ino` strings read as bigints, in {@link statInode}'s form, so inodes
 * above 2^53 keep their precision.
 */
export interface LockStamp {
  /**
   * `canonicalProjectRoot` of the writer's project. Alone it decides nothing,
   * because a path can name a different index than the one the writer opened;
   * it limits {@link isForeignLockRecord}: a record at the reader's own root is
   * never foreign.
   */
  root: string;
  /** Identity of the writer's `.codegraph` directory. Present together with `dbId`, or not at all. */
  dirId?: string;
  /** Identity of the writer's `codegraph.db`. Present together with `dirId`, or not at all. */
  dbId?: string;
}

/**
 * Identity of the physical index at `projectRoot` as it is NOW: the `dev:ino`
 * of its data directory and of its database, and the database's hard-link
 * count. Null when either cannot be stat'd (no database yet, a stat error),
 * and always null on Windows, where {@link statInode} reports no usable inode
 * (`st_ino` there is not stable across every filesystem and handle); the
 * directory is read first, so the database is never stat'd there. The
 * database is read with ONE bigint stat, so its `dbId` (built in
 * {@link statInode}'s `dev:ino` form) and `dbLinks` describe the same file
 * even if it is replaced meanwhile. The database path is the one
 * `getDatabasePath` names, built here so the lock modules do not load the
 * SQLite layer.
 */
function readIndexIdentity(projectRoot: string): { dirId: string; dbId: string; dbLinks: bigint } | null {
  const dir = getCodeGraphDir(projectRoot);
  const dirId = statInode(dir);
  if (dirId === null) return null;
  try {
    const db = fs.statSync(path.join(dir, 'codegraph.db'), { bigint: true });
    return { dirId, dbId: `${db.dev}:${db.ino}`, dbLinks: db.nlink };
  } catch {
    return null;
  }
}

/**
 * The {@link LockStamp} for a record this process writes on `projectRoot`:
 * its canonical root, and its index identity when that can be read. A record
 * written without an identity is never foreign anywhere: pid liveness alone
 * decides it, as for a record of the older format. The link count is read
 * fresh by every reader and never recorded.
 */
export function lockStamp(projectRoot: string): LockStamp {
  const identity = readIndexIdentity(projectRoot);
  return {
    root: canonicalProjectRoot(projectRoot),
    ...(identity !== null ? { dirId: identity.dirId, dbId: identity.dbId } : {}),
  };
}

/**
 * Whether a lock record was written for another project's physical index,
 * i.e. it was copied in with a `.codegraph/` from elsewhere. True only when
 * ALL of these hold:
 *
 *   - the recorded `root` is a non-empty string that differs from
 *     `canonicalProjectRoot(projectRoot)`, compared exactly as recorded (no
 *     trim, no normalisation of the recorded value);
 *   - the record carries both identities, `dirId` and `dbId`;
 *   - this project's identity can be read now (a database exists, the stats
 *     succeed, not Windows);
 *   - this project's `codegraph.db` has exactly one hard link;
 *   - neither identity matches it: the directory differs AND the database
 *     differs.
 *
 * So a copy at another path, which has a new root, a new directory and a new
 * database with one link (cp -R, rsync and clonefile all write a new file), is
 * foreign. A record at this same root is never foreign, even when both inodes
 * changed: a `.codegraph/` moved aside and copied back (a restore) is followed
 * by its live holder (`CodeGraph.reopenIfReplaced` opens the replaced database
 * at the same path), so calling that holder stale would start a second writer
 * on the database it now has open. Nothing is foreign at a project whose
 * database has more than one hard link: that file is shared by definition, and
 * another project's live holder may have it open. A project moved within one
 * filesystem (same inodes, new root) is not foreign either. Every record that
 * is not foreign, including one with no root or no identity (older formats),
 * is decided by pid liveness alone. `record` is any parsed record; only its
 * `root`, `dirId` and `dbId` are read.
 *
 * Limits. A record's stamp describes the index its writer opened, and a writer
 * that later follows a database replaced in place keeps its original stamp
 * (same-root records and hardlinked databases are never foreign, which covers
 * that). A filesystem alias that reports different `dev:ino` for one file
 * (some FUSE or network mounts) is outside what the stamp can see.
 */
export function isForeignLockRecord(record: unknown, projectRoot: string): boolean {
  if (record === null || typeof record !== 'object') return false;
  const { root, dirId, dbId } = record as Record<string, unknown>;
  if (typeof root !== 'string' || root === '' || root === canonicalProjectRoot(projectRoot)) return false;
  if (typeof dirId !== 'string' || dirId === '' || typeof dbId !== 'string' || dbId === '') return false;
  const current = readIndexIdentity(projectRoot);
  if (current === null) return false;
  // A database with a second name is shared: pid liveness decides, as for a
  // record of the older format.
  if (current.dbLinks > 1n) return false;
  return dirId !== current.dirId && dbId !== current.dbId;
}

/** Absolute path to the writer pid lockfile for `projectRoot`. */
export function getWriterPidPath(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): string {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* keep lexical */ }
  return path.join(getCodeGraphDir(root), lockName);
}

/**
 * Structured contents of the writer pidfile. The stamp fields are absent in
 * older-format records; pid liveness alone decides those.
 */
export interface WriterLockInfo extends Partial<LockStamp> {
  pid: number;
  /** `direct` | `daemon` | `fallback` — for actionable error text only. */
  mode: string;
  startedAt: number;
  /** False until the MCP owner has finished its initial catch-up. */
  ready?: boolean;
}

export type WriterAcquireResult =
  | { kind: 'acquired'; pidPath: string; info: WriterLockInfo }
  | { kind: 'taken'; existing: WriterLockInfo | null; pidPath: string };

function encode(info: WriterLockInfo): string {
  return JSON.stringify(info) + '\n';
}

/**
 * Parse a writer record. Passes the stamp fields (`root`, `dirId`, `dbId`)
 * through when they are strings. With `projectRoot`, a record foreign to that
 * project ({@link isForeignLockRecord}) decodes as null, exactly like an
 * unreadable record, so callers see no holder.
 */
export function decodeWriterLockInfo(raw: string, projectRoot?: string): WriterLockInfo | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WriterLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.mode !== 'string') return null;
    if (projectRoot !== undefined && isForeignLockRecord(parsed, projectRoot)) return null;
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      ...(typeof parsed.ready === 'boolean' ? { ready: parsed.ready } : {}),
      ...(typeof parsed.root === 'string' ? { root: parsed.root } : {}),
      ...(typeof parsed.dirId === 'string' ? { dirId: parsed.dirId } : {}),
      ...(typeof parsed.dbId === 'string' ? { dbId: parsed.dbId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically create `writer.pid` (link-into-place, O_EXCL fallback). The
 * record carries this project's {@link lockStamp}. If held by a dead PID, or
 * by a foreign record (another project's, copied in with its `.codegraph/`:
 * see {@link isForeignLockRecord}), clear and retry once. Never steals from a
 * live holder whose record is not foreign, which includes every record
 * written at this project's root.
 */
export function tryAcquireWriterLock(
  projectRoot: string,
  mode: string,
  lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid',
): WriterAcquireResult {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const info: WriterLockInfo = {
    pid: process.pid,
    mode,
    startedAt: Date.now(),
    ready: false,
    ...lockStamp(projectRoot),
  };

  const attempt = (): WriterAcquireResult => {
    const tmp = `${pidPath}.${process.pid}.tmp`;
    let acquired = false;
    try {
      fs.writeFileSync(tmp, encode(info), { mode: 0o600 });
      try {
        fs.linkSync(tmp, pidPath);
        acquired = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // taken
        } else {
          // No hard links — O_EXCL create.
          try {
            const fd = fs.openSync(pidPath, 'wx', 0o600);
            try {
              fs.writeSync(fd, encode(info));
              acquired = true;
            } finally {
              fs.closeSync(fd);
            }
          } catch (e2: unknown) {
            if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
          }
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }

    if (acquired) return { kind: 'acquired', pidPath, info };

    let existing: WriterLockInfo | null = null;
    try {
      // A foreign record decodes as null, so it is stale below like a dead one.
      existing = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'), projectRoot);
    } catch { /* unreadable */ }
    return { kind: 'taken', existing, pidPath };
  };

  let result = attempt();
  if (result.kind === 'taken' && result.existing && result.existing.pid === process.pid) {
    // Same process already holds it (daemon acquired before engine watch).
    return { kind: 'acquired', pidPath: result.pidPath, info: result.existing };
  }
  if (result.kind === 'taken') {
    const existing = result.existing;
    if (!existing || existing.pid <= 0 || !isProcessAlive(existing.pid)) {
      // Stale (dead, unreadable or foreign): re-read, and unlink only if the
      // record is still that stale one, then retry once.
      try {
        const raw = fs.readFileSync(pidPath, 'utf8');
        const cur = decodeWriterLockInfo(raw, projectRoot);
        if (!cur || cur.pid === existing?.pid) {
          if (!cur || cur.pid <= 0 || !isProcessAlive(cur.pid)) {
            fs.unlinkSync(pidPath);
          }
        }
      } catch { /* ENOENT ok */ }
      result = attempt();
    }
  }
  return result;
}

/**
 * Publish catch-up readiness without exposing a partially-written pidfile.
 * The rewritten record keeps the stamp it was acquired with.
 */
export function markWriterReady(projectRoot: string): void {
  const pidPath = getWriterPidPath(projectRoot);
  const info = readWriterLock(projectRoot);
  if (!info || info.pid !== process.pid) return;
  const tmp = `${pidPath}.${process.pid}.ready.tmp`;
  try {
    fs.writeFileSync(tmp, encode({ ...info, ready: true }), { mode: 0o600 });
    fs.renameSync(tmp, pidPath);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

/** Waits between retries of a writer-record swap refused by Windows (another process has the file open). */
const SWAP_RETRY_DELAYS_MS = [25, 50, 100, 200];

/**
 * Replace the writer record of `fromPid` with `next`, and only that record, so
 * the slot passes between two processes without ever falling free (#2335). A
 * stopped daemon's sessions serve themselves in-process the moment it goes, and
 * one that found the slot free or stale would claim it as their own writer.
 * Compare and rename are separate steps, so callers check the result: whether
 * the record was replaced. `next` is written as given, stamp included or not:
 * a hand-back restores the previous holder's record exactly, so a caller
 * building a fresh claim adds {@link lockStamp} itself. Never throws.
 */
export function swapWriterLock(projectRoot: string, fromPid: number, next: WriterLockInfo): boolean {
  const pidPath = getWriterPidPath(projectRoot);
  const tmp = `${pidPath}.${process.pid}.swap.tmp`;
  try {
    if (readWriterLock(projectRoot)?.pid !== fromPid) return false;
    fs.writeFileSync(tmp, encode(next), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, pidPath);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const delay = SWAP_RETRY_DELAYS_MS[attempt];
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || delay === undefined) {
          return false;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        if (readWriterLock(projectRoot)?.pid !== fromPid) return false;
      }
    }
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed, or never written */ }
  }
}

/** Release if we still own the lock (pid match). */
export function releaseWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): void {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  try {
    if (!fs.existsSync(pidPath)) return;
    const info = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
    if (info && info.pid === process.pid) {
      fs.unlinkSync(pidPath);
    }
  } catch { /* best-effort */ }
}

/**
 * Read current lock without acquiring. A foreign record (another project's,
 * copied in with its `.codegraph/`: {@link isForeignLockRecord}) reads as
 * null: no holder.
 */
export function readWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): WriterLockInfo | null {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  try {
    return decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'), projectRoot);
  } catch {
    return null;
  }
}

/**
 * Actionable message when another live process owns the writer lock (#1740).
 */
export function writerLockHeldMessage(
  existing: WriterLockInfo | null,
  pidPath: string,
): string {
  const who = existing && existing.pid > 0
    ? `PID ${existing.pid} (${existing.mode || 'unknown'} mode)`
    : 'another process';
  return (
    'CodeGraph writer lock held by ' + who + '. ' +
    'Only one live MCP writer may serve a project (auto-sync / index). ' +
    'Stop the other server (if it is the shared daemon, pick it in `codegraph daemon` to stop it; otherwise end the other MCP session), ' +
    'or unset CODEGRAPH_NO_DAEMON so additional clients proxy to the shared daemon. ' +
    'If this is stale, delete ' + pidPath
  );
}

/**
 * An index rebuild (`codegraph index`) owns the database. Expected and brief,
 * so the MCP layer answers it as guidance, never as a tool error (#1325).
 */
export class RebuildInProgressError extends Error {
  constructor() {
    super('CodeGraph index rebuild is in progress; retry when it finishes.');
    this.name = 'RebuildInProgressError';
  }
}

export function assertNoRebuild(root: string): void {
  if (isRebuildInProgress(root)) throw new RebuildInProgressError();
}

/**
 * Whether another live process holds the project's rebuild lock (`codegraph
 * index`). Rebuild intent is separate from writer ownership: the rebuild takes
 * `rebuild.pid` BEFORE stopping the daemon, so its disconnected proxies cannot
 * reopen SQLite in the gap. A foreign `rebuild.pid` (another project's,
 * copied in with its `.codegraph/`) is not a rebuild of this one.
 */
export function isRebuildInProgress(root: string): boolean {
  const lock = readWriterLock(root, 'rebuild.pid');
  return !!lock && lock.pid !== process.pid && isProcessAlive(lock.pid);
}
