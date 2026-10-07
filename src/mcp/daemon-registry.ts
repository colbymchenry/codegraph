/**
 * Global daemon registry + stop/list control — the discovery layer behind
 * `codegraph list` and `codegraph stop [--all]`.
 *
 * Every per-project daemon already writes an authoritative lockfile at
 * `<root>/.codegraph/daemon.pid`. That's enough to stop ONE daemon you can name,
 * but there's no central place to find them ALL — which `list` and `stop --all`
 * need. So each daemon also drops a tiny record under `~/.codegraph/daemons/` on
 * start and removes it on graceful shutdown.
 *
 * The registry is a DISCOVERY index, never a source of truth: the live pid is.
 * A SIGKILL'd daemon can't remove its own record, so readers prune any record
 * whose pid is dead (`isProcessAlive`). Every write/read is best-effort — a
 * registry hiccup must never break the daemon or a command; worst case `list`
 * momentarily misses or over-lists one, which the next liveness prune corrects.
 *
 * Cross-platform by construction: only files + `process.kill(pid, signal)`,
 * which behave consistently on macOS/Linux (real signals) and Windows (mapped to
 * TerminateProcess). Validated live on all three.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { canonicalProjectRoot } from '../directory';
import {
  getDaemonPidPath,
  getDaemonSocketCandidates,
  decodeLockInfo,
  canProbeDaemonIdentity,
  probeDaemonIdentity,
  type DaemonLockInfo,
} from './daemon-paths';
import {
  readWriterLock,
  releaseWriterLock,
  swapWriterLock,
  tryAcquireWriterLock,
  type WriterLockInfo,
} from './writer-lock';
import { isOlderRelease } from './version';
import { WORKER_START_SETTLE_MS } from '../worker-teardown';

export interface DaemonRecord {
  /** Realpath'd project root the daemon serves. */
  root: string;
  pid: number;
  version: string;
  socketPath: string;
  /** Epoch ms when the daemon bound its socket. */
  startedAt: number;
}

/**
 * `~/.codegraph/daemons` — GLOBAL, keyed off the home install dir. (The
 * `CODEGRAPH_DIR` env var only renames the per-project index dir, not this.)
 */
export function getRegistryDir(): string {
  return path.join(os.homedir(), '.codegraph', 'daemons');
}

/**
 * One record per project, so it is keyed the same way the daemon socket is:
 * over {@link canonicalProjectRoot}, not a raw `path.resolve` — otherwise the
 * same project spelled with another drive-letter case files two records, and
 * `list` over-lists while `stop --all` misses one.
 */
function recordPath(root: string): string {
  const hash = crypto.createHash('sha256').update(canonicalProjectRoot(root)).digest('hex').slice(0, 16);
  return path.join(getRegistryDir(), `${hash}.json`);
}

/**
 * Is `pid` a live process? `kill(pid, 0)` sends no signal — it just probes:
 * ESRCH ⇒ dead, EPERM ⇒ alive but not ours (still alive). Same liveness check
 * the PPID watchdog (#277) and daemon lock arbitration use.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort: record this daemon so `list`/`stop --all` can find it. */
export function registerDaemon(rec: DaemonRecord): void {
  try {
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    fs.writeFileSync(recordPath(rec.root), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* best-effort — list's liveness prune tolerates a missing record */
  }
}

/** Best-effort: drop this daemon's record on graceful shutdown. */
export function deregisterDaemon(root: string): void {
  try {
    fs.unlinkSync(recordPath(root));
  } catch {
    /* already gone */
  }
}

/**
 * All registered daemons whose process is still alive, newest first. Dead/garbage
 * records are deleted as a side effect (self-healing) unless `prune` is false.
 */
export function listDaemons(opts: { prune?: boolean } = {}): DaemonRecord[] {
  const prune = opts.prune ?? true;
  const dir = getRegistryDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no registry dir yet
  }

  const live: DaemonRecord[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let rec: DaemonRecord | null = null;
    try {
      rec = JSON.parse(fs.readFileSync(full, 'utf8')) as DaemonRecord;
    } catch {
      rec = null;
    }
    const valid = rec && typeof rec.pid === 'number' && typeof rec.root === 'string';
    if (valid && isProcessAlive(rec!.pid)) {
      live.push(rec!);
    } else if (prune) {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
  }
  return live.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Registry entries whose socket hello proves the recorded process is the
 * daemon. Used by every user-facing list/stop-all path so a reused PID cannot
 * appear as a phantom running daemon (#1553).
 */
export async function listVerifiedDaemons(opts: { prune?: boolean } = {}): Promise<DaemonRecord[]> {
  const prune = opts.prune ?? true;
  const candidates = listDaemons({ prune });
  const checks = await Promise.all(candidates.map(async (rec) => ({
    rec,
    verified: await probeDaemonIdentity(rec),
  })));
  const verified: DaemonRecord[] = [];
  for (const check of checks) {
    if (check.verified) verified.push(check.rec);
    else if (prune) deregisterDaemon(check.rec.root);
  }
  return verified;
}

/** Remove stale artifacts while holding the project writer slot exclusively. */
function cleanupDaemonArtifacts(
  root: string,
  expectedLockContents: string | null,
): boolean {
  // A daemon owns writer.pid before binding or relocating its socket. Claiming
  // the writer slot therefore freezes every legitimate daemon artifact writer
  // while we compare the inspected lock snapshot and clean it up.
  if (readWriterLock(root)?.pid === process.pid) return false;
  const claim = tryAcquireWriterLock(root, 'cleanup');
  if (claim.kind === 'taken') return false;

  try {
    return removeDaemonArtifacts(root, expectedLockContents);
  } finally {
    releaseWriterLock(root);
  }
}

/** The removal behind {@link cleanupDaemonArtifacts}, for a caller already holding the writer slot. */
function removeDaemonArtifacts(root: string, expectedLockContents: string | null): boolean {
  const pidPath = getDaemonPidPath(root);
  if (expectedLockContents === null) {
    if (fs.existsSync(pidPath)) return false;
  } else {
    try {
      if (fs.readFileSync(pidPath, 'utf8') !== expectedLockContents) return false;
    } catch {
      return false;
    }
  }
  // POSIX sockets are real files; Windows named pipes vanish with the process.
  // Sweep every candidate before releasing daemon.pid, so no successor can
  // acquire the lock and bind a socket that this cleanup then removes.
  if (process.platform !== 'win32') {
    for (const candidate of getDaemonSocketCandidates(root)) {
      try { fs.unlinkSync(candidate); } catch { /* gone */ }
    }
  }
  deregisterDaemon(root);
  try { fs.unlinkSync(pidPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return true;
}

/** Remove daemon artifacts only when no matching daemon answers the socket hello. */
export async function clearStaleDaemonArtifacts(root: string): Promise<boolean> {
  const pidPath = getDaemonPidPath(root);
  const hadArtifacts = fs.existsSync(pidPath) || (
    process.platform !== 'win32' && getDaemonSocketCandidates(root).some((p) => fs.existsSync(p))
  );
  if (!hadArtifacts) return false;
  let info: DaemonLockInfo | null = null;
  let lockContents: string | null = null;
  try {
    lockContents = fs.readFileSync(pidPath, 'utf8');
    info = decodeLockInfo(lockContents);
  } catch { /* missing/corrupt */ }
  if (info && isProcessAlive(info.pid)) {
    // A live legacy holder has no socket path to probe. That is inconclusive,
    // not proof of PID reuse, so preserve its lock rather than risk two writers.
    if (!canProbeDaemonIdentity(info) || await probeDaemonIdentity(info)) return false;
  }
  return cleanupDaemonArtifacts(root, lockContents);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long `stopDaemonAt` gives a daemon to exit on SIGTERM before looking closer. */
const DAEMON_TERM_WAIT_MS = 3_000;

/**
 * How much longer `stopDaemonAt` waits for a daemon that is partway through its
 * own shutdown: it has stopped answering its socket (or let go of its lock) but
 * not yet exited. That shutdown waits up to {@link WORKER_START_SETTLE_MS} for a
 * query worker still starting up before it exits, so this covers that plus the
 * rest of the shutdown (#2311).
 */
const DAEMON_SHUTDOWN_GRACE_MS = WORKER_START_SETTLE_MS + 2_000;

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

export interface StopResult {
  root: string;
  pid: number | null;
  /** 'term' graceful, 'kill' force, 'still-running' refused, 'not-running' stale, 'no-daemon' absent, 'unverified' preserved. */
  outcome: 'term' | 'kill' | 'still-running' | 'not-running' | 'no-daemon' | 'unverified';
  /** The daemon's version as its lock recorded it, when the stop got that far. */
  version?: string;
}

/**
 * Stop the daemon serving `root`: SIGTERM, wait, then SIGKILL if it won't go,
 * then sweep its artifacts. `root` must be realpath'd (match how the daemon
 * keys its socket/lockfile). Resolves the pid from the authoritative lockfile,
 * falling back to the registry. Rebuild callers preserve unverified live locks
 * instead of interpreting a failed probe as permission to discard the database.
 * A daemon still finishing its own shutdown is waited for, up to
 * `shutdownGraceMs` more (default {@link DAEMON_SHUTDOWN_GRACE_MS}; tests
 * shorten it), before it is reported `still-running`.
 */
export async function stopDaemonAt(
  root: string,
  options: { preserveUnverified?: boolean; shutdownGraceMs?: number } = {},
): Promise<StopResult> {
  let pid: number | null = null;
  let identity: DaemonLockInfo | null = null;
  let lockContents: string | null = null;
  try {
    lockContents = fs.readFileSync(getDaemonPidPath(root), 'utf8');
    identity = decodeLockInfo(lockContents);
    pid = identity?.pid ?? null;
  } catch {
    /* no lockfile */
  }
  if (pid == null) {
    const rec = listDaemons({ prune: false }).find(
      (r) => canonicalProjectRoot(r.root) === canonicalProjectRoot(root)
    );
    pid = rec?.pid ?? null;
    if (rec) identity = rec;
  }

  if (pid == null) {
    cleanupDaemonArtifacts(root, lockContents);
    return { root, pid: null, outcome: 'no-daemon' };
  }
  if (!isProcessAlive(pid)) {
    const removed = cleanupDaemonArtifacts(root, lockContents);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }
  // Never signal a process merely because it reused a stale daemon PID. The
  // daemon's immediate hello is the process-identity proof (#1553).
  if (!identity || !canProbeDaemonIdentity(identity)) {
    return { root, pid, outcome: 'unverified' };
  }
  if (!await probeDaemonIdentity(identity)) {
    if (options.preserveUnverified) return { root, pid, outcome: 'unverified' };
    const removed = cleanupDaemonArtifacts(root, lockContents);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }
  return stopVerifiedDaemon(root, identity, lockContents, options.shutdownGraceMs);
}

/**
 * The signalling half of a stop, for a daemon whose socket hello just proved
 * `identity` against the lock read as `lockContents`: SIGTERM, wait, SIGKILL
 * only one that still answers, then sweep its artifacts.
 */
async function stopVerifiedDaemon(
  root: string,
  identity: DaemonLockInfo,
  lockContents: string | null,
  shutdownGraceMs = DAEMON_SHUTDOWN_GRACE_MS,
): Promise<StopResult> {
  const { pid, version } = identity;
  // Identity probing awaits I/O: never act on a superseded ownership record.
  const sameLock = (): boolean => {
    try { return fs.readFileSync(getDaemonPidPath(root), 'utf8') === lockContents; }
    catch { return lockContents === null; }
  };
  if (!sameLock()) return { root, pid, outcome: 'unverified', version };

  // POSIX: SIGTERM runs the daemon's graceful shutdown. Windows: TerminateProcess
  // (no graceful path), so we always sweep artifacts ourselves below.
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  let outcome: StopResult['outcome'] = 'term';
  if (!(await waitForDeath(pid, DAEMON_TERM_WAIT_MS))) {
    // Re-prove identity before escalating; the old PID may have been reused.
    if (sameLock() && await probeDaemonIdentity(identity) && sameLock()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
      if (!(await waitForDeath(pid, 2000))) {
        return { root, pid, outcome: 'still-running', version };
      }
      outcome = 'kill';
    } else {
      // No longer answering its socket, or no longer holding the lock it held
      // when it was signalled: a daemon partway through its own shutdown, which
      // closes the socket first and can then wait on a query worker still
      // starting up before it releases the lock and exits (#2311). On Windows,
      // where SIGTERM is TerminateProcess, this is a termination still settling.
      // Its identity can't be re-proven without the socket, so signal nothing
      // more; just wait, bounded, for the PID to go. One that outlives the
      // wait is reported, as before.
      if (!(await waitForDeath(pid, shutdownGraceMs))) {
        return { root, pid, outcome: 'still-running', version };
      }
    }
  }
  // Compares the lock with the one we signalled, so a successor's is kept.
  cleanupDaemonArtifacts(root, lockContents);
  return { root, pid, outcome, version };
}

/**
 * Stop the daemon serving `root` when it runs an older CodeGraph release than
 * `version`, so the caller can start one from its own install (#2335). A
 * daemon keeps running the code it started with: one that outlived an upgrade
 * goes on loading grammars from files the upgrade removed, while it holds the
 * project's writer lock and file watcher. Only a daemon whose lock records an
 * older release ({@link isOlderRelease}) and whose socket hello confirms that
 * lock is signalled, exactly as {@link stopDaemonAt} would; one of the same, a
 * newer or an unknown version is never touched, so two installs cannot take
 * turns stopping each other's daemon.
 *
 * The project's writer slot never falls free on the way: before the signal,
 * this process takes it over from the old daemon (mode `handover`), and the
 * caller hands it on to the daemon it starts, which takes it over in turn
 * ({@link swapWriterLock}). The old daemon's sessions serve themselves
 * in-process the moment it goes, and one that found the slot free would claim
 * it as their writer — with the code of an install the upgrade removed — and
 * keep the new daemon from starting. When the old daemon is not stopped, the
 * slot goes back to it.
 *
 * Resolves null when the lock names no older daemon (there is none, or another
 * launcher already replaced it) or the slot could not be taken (another
 * launcher holds it to replace the same daemon). Otherwise says what became of
 * the daemon: `term` or `kill` when it was stopped, and this process now holds
 * the slot for its successor (release it with {@link releaseWriterLock} once
 * that one has taken over or failed); `not-running` when it had already exited
 * (its successor clears the stale lock); `unverified` or `still-running` when
 * it is still there.
 */
export async function stopOlderDaemon(
  root: string,
  version: string,
  options: { shutdownGraceMs?: number } = {},
): Promise<StopResult | null> {
  let lockContents: string;
  try {
    lockContents = fs.readFileSync(getDaemonPidPath(root), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { root, pid: null, outcome: 'unverified' };
  }
  const identity = decodeLockInfo(lockContents);
  if (!identity) return { root, pid: null, outcome: 'unverified' };
  if (!isOlderRelease(identity.version, version)) return null;
  const { pid } = identity;
  if (!isProcessAlive(pid)) return { root, pid, outcome: 'not-running', version: identity.version };
  // The hello must name this pid and version (#1553): a reused pid is no daemon.
  if (!canProbeDaemonIdentity(identity) || !await probeDaemonIdentity(identity)) {
    return { root, pid, outcome: 'unverified', version: identity.version };
  }
  const slot = takeWriterSlotFrom(root, pid);
  if (!slot) return null;
  const result = await stopVerifiedDaemon(root, identity, lockContents, options.shutdownGraceMs);
  if (result.outcome === 'term' || result.outcome === 'kill') {
    // The stop's own sweep needs the slot this process now holds: clear what
    // the old daemon left (all of it on Windows, where the stop is
    // TerminateProcess), so its successor starts on a clean lock.
    removeDaemonArtifacts(root, lockContents);
  } else {
    slot.giveBack();
  }
  return result;
}

/**
 * Take the project's writer slot from the daemon `pid` this process is about
 * to stop (see {@link stopOlderDaemon}), whether the record is that daemon's,
 * stale, or absent. Returns how to give it back to that daemon, or null when
 * the slot could not be taken: another live process holds it (another
 * launcher replacing the same daemon), or the swap lost a race.
 */
function takeWriterSlotFrom(root: string, pid: number): { giveBack(): void } | null {
  const previous = readWriterLock(root);
  if (previous && previous.pid !== pid && previous.pid !== process.pid && isProcessAlive(previous.pid)) return null;
  const claim: WriterLockInfo = { pid: process.pid, mode: 'handover', startedAt: Date.now(), ready: false };
  const held = previous
    ? swapWriterLock(root, previous.pid, claim)
    : tryAcquireWriterLock(root, 'handover').kind === 'acquired';
  if (!held) return null;
  return {
    giveBack: () => {
      if (previous?.pid === pid) swapWriterLock(root, process.pid, previous);
      else releaseWriterLock(root);
    },
  };
}

/** Stop every registered, live daemon. */
export async function stopAllDaemons(): Promise<StopResult[]> {
  const results: StopResult[] = [];
  for (const rec of await listVerifiedDaemons()) {
    results.push(await stopDaemonAt(rec.root));
  }
  return results;
}
