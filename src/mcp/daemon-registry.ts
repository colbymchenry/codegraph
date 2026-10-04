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
  getDaemonIndexDir,
  getDaemonSocketCandidates,
  decodeLockInfo,
  canProbeDaemonIdentity,
  probeDaemonIdentity,
  type DaemonLockInfo,
} from './daemon-paths';
import { readWriterLock, releaseWriterLock, tryAcquireWriterLock } from './writer-lock';
import { WORKER_START_SETTLE_MS } from '../worker-teardown';

export interface DaemonRecord {
  /** Realpath'd project root the daemon serves. */
  root: string;
  /** Canonical index directory served by this daemon, independent of the reader's environment. */
  indexDir: string;
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
 * One record per canonical index directory, keyed the same way as its socket.
 * A project may have multiple CODEGRAPH_DIR namespaces running concurrently.
 */
function recordPath(indexDir: string): string {
  const hash = crypto.createHash('sha256').update(canonicalProjectRoot(indexDir)).digest('hex').slice(0, 16);
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
export function registerDaemon(rec: Omit<DaemonRecord, 'indexDir'>): void {
  try {
    const record: DaemonRecord = { ...rec, indexDir: getDaemonIndexDir(rec.root) };
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    fs.writeFileSync(recordPath(record.indexDir), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* best-effort — list's liveness prune tolerates a missing record */
  }
}

/** Best-effort: drop this daemon's record on graceful shutdown. */
export function deregisterDaemon(root: string, indexDir = getDaemonIndexDir(root)): void {
  try {
    fs.unlinkSync(recordPath(indexDir));
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
    const alive = typeof rec?.pid === 'number' && isProcessAlive(rec.pid);
    const valid = rec && typeof rec.root === 'string' && typeof rec.indexDir === 'string' && path.isAbsolute(rec.indexDir);
    if (valid && alive) {
      live.push(rec!);
    } else if (prune && !alive) {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
    // An unidentifiable live record belongs to an uncertain running process:
    // leave its discovery metadata intact, without selecting or stopping it.
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
    else if (prune) deregisterDaemon(check.rec.root, check.rec.indexDir);
  }
  return verified;
}

/** Remove stale artifacts while holding the project writer slot exclusively. */
function cleanupDaemonArtifacts(
  root: string,
  expectedLockContents: string | null,
  indexDir: string,
): boolean {
  const pidPath = getDaemonPidPath(root, indexDir);
  // A daemon owns writer.pid before binding or relocating its socket. Claiming
  // the writer slot therefore freezes every legitimate daemon artifact writer
  // while we compare the inspected lock snapshot and clean it up.
  if (readWriterLock(root, 'writer.pid', indexDir)?.pid === process.pid) return false;
  const claim = tryAcquireWriterLock(root, 'cleanup', 'writer.pid', indexDir);
  if (claim.kind === 'taken') return false;

  try {
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
      for (const candidate of getDaemonSocketCandidates(root, indexDir)) {
        try { fs.unlinkSync(candidate); } catch { /* gone */ }
      }
    }
    deregisterDaemon(root, indexDir);
    try { fs.unlinkSync(pidPath); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    return true;
  } finally {
    releaseWriterLock(root, 'writer.pid', indexDir);
  }
}

/** Remove daemon artifacts only when no matching daemon answers the socket hello. */
export async function clearStaleDaemonArtifacts(root: string): Promise<boolean> {
  const indexDir = getDaemonIndexDir(root);
  const pidPath = getDaemonPidPath(root, indexDir);
  const hadArtifacts = fs.existsSync(pidPath) || (
    process.platform !== 'win32' && getDaemonSocketCandidates(root, indexDir).some((p) => fs.existsSync(p))
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
  return cleanupDaemonArtifacts(root, lockContents, indexDir);
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
  options: { preserveUnverified?: boolean; shutdownGraceMs?: number; indexDir?: string } = {},
): Promise<StopResult> {
  const indexDir = canonicalProjectRoot(options.indexDir ?? getDaemonIndexDir(root));
  let pid: number | null = null;
  let identity: DaemonLockInfo | null = null;
  let lockContents: string | null = null;
  try {
    lockContents = fs.readFileSync(getDaemonPidPath(root, indexDir), 'utf8');
    identity = decodeLockInfo(lockContents);
    pid = identity?.pid ?? null;
  } catch {
    /* no lockfile */
  }
  if (pid == null) {
    const rec = listDaemons({ prune: false }).find(
      (r) => canonicalProjectRoot(r.indexDir) === indexDir
    );
    pid = rec?.pid ?? null;
    if (rec) identity = rec;
  }

  if (pid == null) {
    cleanupDaemonArtifacts(root, lockContents, indexDir);
    return { root, pid: null, outcome: 'no-daemon' };
  }
  if (!isProcessAlive(pid)) {
    const removed = cleanupDaemonArtifacts(root, lockContents, indexDir);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }
  // Never signal a process merely because it reused a stale daemon PID. The
  // daemon's immediate hello is the process-identity proof (#1553).
  if (!identity || !canProbeDaemonIdentity(identity)) {
    return { root, pid, outcome: 'unverified' };
  }
  if (!await probeDaemonIdentity(identity)) {
    if (options.preserveUnverified) return { root, pid, outcome: 'unverified' };
    const removed = cleanupDaemonArtifacts(root, lockContents, indexDir);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }

  // Identity probing awaits I/O: never act on a superseded ownership record.
  const sameLock = (): boolean => {
    try { return fs.readFileSync(getDaemonPidPath(root, indexDir), 'utf8') === lockContents; }
    catch { return lockContents === null; }
  };
  if (!sameLock()) return { root, pid, outcome: 'unverified' };

  // POSIX: SIGTERM runs the daemon's graceful shutdown. Windows: TerminateProcess
  // (no graceful path), so we always sweep artifacts ourselves below.
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  let outcome: StopResult['outcome'] = 'term';
  if (!(await waitForDeath(pid, DAEMON_TERM_WAIT_MS))) {
    // Re-prove identity before escalating; the old PID may have been reused.
    if (sameLock() && await probeDaemonIdentity(identity) && sameLock()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
      if (!(await waitForDeath(pid, 2000))) {
        return { root, pid, outcome: 'still-running' };
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
      if (!(await waitForDeath(pid, options.shutdownGraceMs ?? DAEMON_SHUTDOWN_GRACE_MS))) {
        return { root, pid, outcome: 'still-running' };
      }
    }
  }
  // Compares the lock with the one we signalled, so a successor's is kept.
  cleanupDaemonArtifacts(root, lockContents, indexDir);
  return { root, pid, outcome };
}

/** Stop every registered, live daemon. */
export async function stopAllDaemons(): Promise<StopResult[]> {
  const results: StopResult[] = [];
  for (const rec of await listVerifiedDaemons()) {
    results.push(await stopDaemonAt(rec.root, { indexDir: rec.indexDir }));
  }
  return results;
}
