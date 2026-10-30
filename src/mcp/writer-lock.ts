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

/**
 * How long a writer may stay at `ready: false` before it is stale (#2918).
 *
 * Deliberately far longer than normal catch-up (and the 30 s reader wait in
 * project-lifecycle.ts), and far shorter than the ~28 h wedged daemon in
 * #2918. A live pid is not, by itself, proof of a live writer: one that never
 * reports ready is indistinguishable from a wedged one once this long has
 * passed. Overridable for tests and very large projects via
 * `CODEGRAPH_WRITER_READY_TIMEOUT_MS`.
 */
export const WRITER_READY_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveWriterReadyTimeoutMs(): number {
  const raw = Number(process.env.CODEGRAPH_WRITER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : WRITER_READY_TIMEOUT_MS;
}

/**
 * True only for a record that explicitly says `ready: false` and whose
 * `startedAt` is at least the ready timeout old. `ready: true`, a missing
 * `startedAt`, and a future `startedAt` are never stale here, so legacy
 * records without a `ready` field are not reaped by this check.
 */
export function isWriterReadyStale(info: WriterLockInfo | null, now = Date.now()): boolean {
  if (!info || info.ready !== false || !(info.startedAt > 0)) return false;
  return now - info.startedAt >= resolveWriterReadyTimeoutMs();
}

/**
 * Modes that run an MCP writer and publish `ready: true` once its first
 * catch-up finishes. Only these can go stale by staying at `ready: false`:
 * `rebuild`, `cleanup` and `handover` also take `writer.pid` (or its sibling
 * `rebuild.pid`) but never publish readiness, so age alone is not evidence
 * they are wedged — a full re-index stays `ready: false` for as long as it
 * runs. Kept narrow on purpose: an unknown mode is never stolen.
 */
const READY_PUBLISHING_MODES = new Set(['daemon', 'direct', 'fallback']);

function isReapableNotReadyWriter(info: WriterLockInfo | null): boolean {
  return !!info && READY_PUBLISHING_MODES.has(info.mode) && isWriterReadyStale(info);
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
 * by a dead PID, clear and retry once. A live MCP writer that has stayed at
 * `ready: false` past `WRITER_READY_TIMEOUT_MS` is also stale (#2918) and is
 * cleared the same pid-verified way, with a stderr line naming its pid and
 * the lock file. A holder that is ready, or still within the timeout, is
 * never stolen — no matter how old — and the stale holder is never signalled
 * (#1978, #2819): only the lock is cleared, so a live process that later
 * exits still cannot delete the successor's record (see releaseWriterLock).
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

  let result = attempt();
  if (result.kind === 'taken' && result.existing && result.existing.pid === process.pid) {
    // Same process already holds it (daemon acquired before engine watch).
    return { kind: 'acquired', pidPath: result.pidPath, info: result.existing };
  }
  if (result.kind === 'taken') {
    const existing = result.existing;
    if (!existing || existing.pid <= 0 || !isProcessAlive(existing.pid) || isReapableNotReadyWriter(existing)) {
      // Stale — clear (pid-verified) and retry once.
      try {
        const raw = fs.readFileSync(pidPath, 'utf8');
        const cur = decodeWriterLockInfo(raw);
        if (!cur || cur.pid === existing?.pid) {
          if (!cur || cur.pid <= 0 || !isProcessAlive(cur.pid) || isReapableNotReadyWriter(cur)) {
            fs.unlinkSync(pidPath);
            // Only the lock is cleared — never the holder (#1978, #2819). The
            // wedged process is left to the user's daemon controls.
            if (cur && cur.pid !== process.pid && isReapableNotReadyWriter(cur)) {
              console.error(
                `CodeGraph writer lock: cleared stale not-ready writer PID ${cur.pid} (${cur.mode}) at ${pidPath} ` +
                `after ${Math.round((Date.now() - cur.startedAt) / 1000)}s without reporting ready; a new writer may now acquire the lock.`,
              );
            }
          }
        }
      } catch { /* ENOENT ok */ }
      result = attempt();
    }
  }
  return result;
}

/** Publish catch-up readiness without exposing a partially-written pidfile. */
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
 * the record was replaced. Never throws.
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
  const notReady = existing && existing.ready === false && existing.startedAt > 0
    ? ` It started at ${new Date(existing.startedAt).toISOString()} and has not reported ready.`
    : '';
  return (
    'CodeGraph writer lock held by ' + who + '. ' +
    'Only one live MCP writer may serve a project (auto-sync / index). ' +
    'Stop the other server (if it is the shared daemon, pick it in `codegraph daemon` to stop it; otherwise end the other MCP session), ' +
    'or unset CODEGRAPH_NO_DAEMON so additional clients proxy to the shared daemon. ' +
    'If this is stale, delete ' + pidPath + '.' + notReady
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
