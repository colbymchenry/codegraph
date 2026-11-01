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
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { isPidLockPending, withPidLock } from './pid-lock';
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


/** Absolute path to the writer pid lockfile for `projectRoot`. */
export function getWriterPidPath(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): string {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* keep lexical */ }
  return path.join(getCodeGraphDir(root), lockName);
}

/** Structured contents of the writer pidfile. */
export interface WriterLockInfo {
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

export function decodeWriterLockInfo(raw: string): WriterLockInfo | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WriterLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.mode !== 'string') return null;
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      ...(typeof parsed.ready === 'boolean' ? { ready: parsed.ready } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically create `writer.pid` (link-into-place, O_EXCL fallback). If held
 * by a dead PID, clear and retry once under the PID-record mutation barrier.
 * Does not steal from a live holder or an unfinished exclusive-create write.
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
      existing = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
    } catch { /* unreadable */ }
    return { kind: 'taken', existing, pidPath };
  };

  const acquire = (): WriterAcquireResult => {
    const result = attempt();
    if (result.kind === 'acquired') return result;
    if (result.existing?.pid === process.pid) {
      // Same process already holds it (daemon acquired before engine watch).
      return { kind: 'acquired', pidPath, info: result.existing };
    }
    try {
      // The barrier spans this reread, stale removal, and retry publication.
      const raw = fs.readFileSync(pidPath, 'utf8');
      if (isPidLockPending(pidPath, raw)) return result;
      const current = decodeWriterLockInfo(raw);
      if (current && current.pid > 0 && isProcessAlive(current.pid)) return result;
      fs.unlinkSync(pidPath);
    } catch (err) {
      // An unreadable record is not evidence of staleness.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return result;
    }
    return attempt();
  };
  const taken = () => ({ kind: 'taken' as const, existing: readWriterLock(projectRoot, lockName), pidPath });
  return withPidLock(pidPath, acquire, () => {
    const result = taken();
    if (result.existing?.pid !== process.pid) return result;
    // A handover can restore this process's ownership while the barrier is
    // busy. Decide whether to wait from this snapshot taken after contention,
    // then revalidate under the barrier before reporting same-process ownership.
    return withPidLock(pidPath, acquire, taken, { wait: true });
  });
}

/** Publish readiness atomically, waiting briefly for a concurrent writer mutation. */
export function markWriterReady(projectRoot: string): void {
  const pidPath = getWriterPidPath(projectRoot);
  withPidLock(pidPath, () => {
    const info = readWriterLock(projectRoot);
    if (!info || info.pid !== process.pid) return;
    const tmp = `${pidPath}.${process.pid}.ready.tmp`;
    try {
      fs.writeFileSync(tmp, encode({ ...info, ready: true }), { mode: 0o600 });
      fs.renameSync(tmp, pidPath);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    }
  }, () => { throw new Error(`Timed out publishing writer readiness; inspect ${pidPath}.break for its current owner.`); }, { wait: true });
}

/** Waits between retries of a writer-record swap refused by Windows (another process has the file open). */
const SWAP_RETRY_DELAYS_MS = [25, 50, 100, 200];

/**
 * Replace the writer record of `fromPid` with `next`, and only that record, so
 * the slot passes between two processes without ever falling free (#2335). A
 * stopped daemon's sessions serve themselves in-process the moment it goes, and
 * one that found the slot free or stale would claim it as their own writer.
 * The PID-record barrier keeps compare and rename exclusive, including Windows
 * retries. Waits briefly for a contending mutation; returns false on timeout,
 * changed ownership, or I/O failure; never throws.
 */
export function swapWriterLock(projectRoot: string, fromPid: number, next: WriterLockInfo): boolean {
  const pidPath = getWriterPidPath(projectRoot);
  return withPidLock(pidPath, () => {
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
  }, () => false, { wait: true });
}

/** Best-effort release after waiting briefly for the barrier, only while the PID still matches. */
export function releaseWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): void {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  withPidLock(pidPath, () => {
    try {
      const info = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
      if (info && info.pid === process.pid) fs.unlinkSync(pidPath);
    } catch { /* best-effort */ }
  }, () => {}, { wait: true });
}

/** Read current lock without acquiring. */
export function readWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): WriterLockInfo | null {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  try {
    return decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
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
    'If this is stale, inspect ' + pidPath + ' and ' + pidPath + '.break; remove only records whose owner has exited.'
  );
}

/** Rebuild intent is separate from writer ownership: acquire BEFORE stopping
 * the daemon, so its disconnected proxies cannot reopen SQLite in the gap. */
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

/** Whether another live process holds the project's rebuild lock (`codegraph index`). */
export function isRebuildInProgress(root: string): boolean {
  const lock = readWriterLock(root, 'rebuild.pid');
  return !!lock && lock.pid !== process.pid && isProcessAlive(lock.pid);
}
