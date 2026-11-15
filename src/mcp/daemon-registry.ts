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
import { canonicalProjectRoot, isCodeGraphDataDir } from '../directory';
import {
  getDaemonPidPath,
  getDaemonIndexDir,
  getDaemonSocketCandidates,
  daemonNameHash,
  rootDaemonNameHash,
  rootDaemonSocketPath,
  sameDaemonIndex,
  socketAnswers,
  decodeLockInfo,
  canProbeDaemonIdentity,
  probeDaemonIdentity,
  type DaemonLockInfo,
} from './daemon-paths';
import {
  getWriterPidPath,
  readWriterLock,
  releaseWriterLock,
  swapWriterLock,
  tryAcquireWriterLock,
  writerLockHeldMessage,
  type WriterLockInfo,
} from './writer-lock';
import { classifyLockHolder, describeProcess } from './process-identity';
import { isOlderRelease } from './version';
import { WORKER_START_SETTLE_MS } from '../worker-teardown';

/** What a daemon writes to the registry. */
export interface DaemonRegistration {
  /** Realpath'd project root the daemon serves. */
  root: string;
  pid: number;
  version: string;
  socketPath: string;
  /** Epoch ms when the daemon bound its socket. */
  startedAt: number;
}

/** A registry record, as {@link listDaemons} read it. */
export interface DaemonRecord extends DaemonRegistration {
  /**
   * The index directory the daemon serves, whatever the reader's
   * `CODEGRAPH_DIR`. A record from a release before records named it gets the
   * one the record shows ({@link recordedIndexDir}), or null when nothing does:
   * such a record is never taken for any one index's daemon.
   */
  indexDir: string | null;
  /** The registry file the record was read from. */
  file: string;
}

/**
 * `~/.codegraph/daemons` — GLOBAL, keyed off the home install dir. (The
 * `CODEGRAPH_DIR` env var only renames the per-project index dir, not this.)
 */
export function getRegistryDir(): string {
  return path.join(os.homedir(), '.codegraph', 'daemons');
}

/**
 * One record per index, so it is keyed the same way the daemon socket is: over
 * the canonical index directory ({@link daemonNameHash}), not a raw
 * `path.resolve` — otherwise the same project spelled with another drive-letter
 * case files two records, and `list` over-lists while `stop --all` misses one.
 * Two `CODEGRAPH_DIR` indexes of one project each run a daemon, so each keeps a
 * record.
 */
function recordPath(indexDir: string): string {
  return path.join(getRegistryDir(), `${daemonNameHash(indexDir)}.json`);
}

/**
 * Where a release from before an index had names of its own filed the record
 * of whichever index of `root` its daemon served: under the root alone.
 */
function rootRecordPath(root: string): string {
  return path.join(getRegistryDir(), `${rootDaemonNameHash(root)}.json`);
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

/**
 * Best-effort: record this daemon, serving `indexDir`, so `list`/`stop --all`
 * can find it. Returns the record's file, or null when it couldn't be written.
 */
export function registerDaemon(rec: DaemonRegistration, indexDir = getDaemonIndexDir(rec.root)): string | null {
  try {
    const file = recordPath(indexDir);
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...rec, indexDir }, null, 2) + '\n', { mode: 0o600 });
    return file;
  } catch {
    /* best-effort — list's liveness prune tolerates a missing record */
    return null;
  }
}

/**
 * Best-effort: drop a daemon's record on graceful shutdown: the `file`
 * {@link registerDaemon} wrote, by default the record of `root`'s index. A
 * daemon passes its own, since the index its root resolves to can change while
 * it runs (#995). Given `pid`, only while the record names it, so a successor
 * that took the index over while this daemon shut down keeps its record.
 */
export function deregisterDaemon(root: string, pid?: number, file = recordPath(getDaemonIndexDir(root))): void {
  if (pid !== undefined) {
    removeRecordFile(file, (rec) => rec.pid === pid);
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** Remove the registry file `file` while the record in it passes `owned`. */
function removeRecordFile(file: string, owned: (rec: Partial<DaemonRegistration>) => boolean): void {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaemonRegistration> | null;
    if (rec && owned(rec)) fs.unlinkSync(file);
  } catch {
    /* gone, or unreadable: the next listing's prune takes it */
  }
}

/**
 * The index directory a record names, or for a record from a release before
 * records named one, the one the record shows. Such a record names only its
 * root, and its daemon served whatever index its `CODEGRAPH_DIR` gave it: an
 * in-project socket is `<index dir>/daemon.sock`, and otherwise (the tmpdir
 * fallback, a named pipe) the index is the root's data directory whose lock
 * names this daemon. Null when neither shows it — never the reader's own index,
 * which may be another one entirely.
 */
function recordedIndexDir(rec: DaemonRegistration & { indexDir?: unknown }): string | null {
  if (typeof rec.indexDir === 'string' && path.isAbsolute(rec.indexDir)) return rec.indexDir;
  if (typeof rec.socketPath !== 'string' || !path.isAbsolute(rec.root)) return null;
  if (path.basename(rec.socketPath) === 'daemon.sock') {
    const dir = path.dirname(rec.socketPath);
    if (canonicalProjectRoot(path.dirname(dir)) === canonicalProjectRoot(rec.root)) return dir;
  }
  let names: string[];
  try {
    names = fs.readdirSync(rec.root);
  } catch {
    return null;
  }
  const holders = names.filter(isCodeGraphDataDir).map((name) => path.join(rec.root, name)).filter((dir) => {
    try {
      const lock = decodeLockInfo(fs.readFileSync(getDaemonPidPath(rec.root, dir), 'utf8'));
      return lock?.pid === rec.pid && lock.socketPath === rec.socketPath;
    } catch {
      return false;
    }
  });
  return holders.length === 1 ? holders[0]! : null;
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
    let rec: DaemonRegistration | null = null;
    try {
      rec = JSON.parse(fs.readFileSync(full, 'utf8')) as DaemonRegistration;
    } catch {
      rec = null;
    }
    const valid = rec && typeof rec.pid === 'number' && typeof rec.root === 'string';
    if (valid && isProcessAlive(rec!.pid)) {
      live.push({ ...rec!, indexDir: recordedIndexDir(rec!), file: full });
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
    // By the file it was read from, while it still holds this record: an older
    // release filed its record under the root, so a name worked out from the
    // record's fields can be another daemon's.
    else if (prune) removeRecordFile(check.rec.file, (rec) => rec.pid === check.rec.pid && rec.startedAt === check.rec.startedAt);
  }
  return verified;
}

/**
 * Remove stale artifacts while holding the index's writer slot exclusively:
 * those of the daemon `stopped` (by default the one `expectedLockContents`
 * names).
 */
async function cleanupDaemonArtifacts(
  root: string,
  expectedLockContents: string | null,
  indexDir: string,
  stopped: DaemonLockInfo | null = null,
): Promise<boolean> {
  // An index directory that is gone holds no lock to fence, and claiming its
  // writer slot would make it again: on a Windows drive under WSL, an empty
  // `.codegraph-wsl` would then be the project's default index (#995).
  if (!fs.existsSync(indexDir)) return removeDaemonArtifacts(root, expectedLockContents, indexDir, stopped);
  // A daemon owns writer.pid before binding or relocating its socket. Claiming
  // the writer slot therefore freezes every legitimate daemon artifact writer
  // while we compare the inspected lock snapshot and clean it up.
  if (readWriterLock(root, 'writer.pid', indexDir)?.pid === process.pid) return false;
  const claim = tryAcquireWriterLock(root, 'cleanup', 'writer.pid', indexDir);
  if (claim.kind === 'taken') return false;

  try {
    return await removeDaemonArtifacts(root, expectedLockContents, indexDir, stopped);
  } finally {
    releaseWriterLock(root, 'writer.pid', indexDir);
  }
}

/** The removal behind {@link cleanupDaemonArtifacts}, for a caller already holding the writer slot. */
async function removeDaemonArtifacts(
  root: string,
  expectedLockContents: string | null,
  indexDir: string,
  stopped: DaemonLockInfo | null = null,
): Promise<boolean> {
  const pidPath = getDaemonPidPath(root, indexDir);
  if (expectedLockContents === null) {
    if (fs.existsSync(pidPath)) return false;
  } else {
    try {
      if (fs.readFileSync(pidPath, 'utf8') !== expectedLockContents) return false;
    } catch {
      return false;
    }
  }
  const lock = expectedLockContents === null ? null : decodeLockInfo(expectedLockContents);
  const daemon = stopped ?? lock;
  // POSIX sockets are real files; Windows named pipes vanish with the process.
  // Sweep every candidate before releasing daemon.pid, so no successor can
  // acquire the lock and bind a socket that this cleanup then removes.
  if (process.platform !== 'win32') {
    for (const candidate of getDaemonSocketCandidates(root, indexDir)) {
      try { fs.unlinkSync(candidate); } catch { /* gone */ }
    }
    // A release from before an index had names of its own bound the fallback
    // named after the root, for whichever index it served. That socket goes
    // too, but only while nothing listens on it: an older daemon of another
    // index may have bound it since.
    const rootSocket = rootDaemonSocketPath(root);
    if (lock?.socketPath === rootSocket && !await socketAnswers(rootSocket)) {
      try { fs.unlinkSync(rootSocket); } catch { /* gone */ }
    }
  }
  // This index's record, and the one such a release filed under the root, each
  // only while it names this daemon by pid and socket: a live daemon that got
  // a reused pid keeps its record.
  if (daemon) {
    for (const file of new Set([recordPath(indexDir), rootRecordPath(root)])) {
      removeRecordFile(file, (rec) => rec.pid === daemon.pid && rec.socketPath === daemon.socketPath);
    }
  }
  try { fs.unlinkSync(pidPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return true;
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
    if (canProbeDaemonIdentity(info)) {
      if (await probeDaemonIdentity(info)) return false;
    } else if (!await holderIsForeign(info.pid)) {
      // A live legacy holder has no socket path to probe. That is inconclusive,
      // not proof of PID reuse, so preserve its lock rather than risk two
      // writers, unless the OS shows the process isn't a CodeGraph server.
      return false;
    }
  }
  return cleanupDaemonArtifacts(root, lockContents, indexDir);
}

/**
 * Whether the OS shows that the live process `pid` can't be a CodeGraph daemon
 * (#2770): its command line is not a CodeGraph MCP server's. A lock naming it
 * is stale, as one naming a dead process is. A process the OS won't describe
 * is never counted, and neither is this one.
 */
async function holderIsForeign(pid: number): Promise<boolean> {
  if (pid === process.pid) return false;
  return classifyLockHolder(await describeProcess(pid)) === 'other';
}

/**
 * Clear the lock of a live holder that {@link holderIsForeign} rules out as a
 * daemon, the way a dead holder's is cleared, never signalling it. Resolves
 * null when the holder may be a daemon.
 */
async function clearForeignHolder(
  root: string,
  holder: DaemonLockInfo,
  lockContents: string | null,
  indexDir: string,
): Promise<StopResult | null> {
  const { pid } = holder;
  if (!await holderIsForeign(pid)) return null;
  const removed = await cleanupDaemonArtifacts(root, lockContents, indexDir, holder);
  return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
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
  options: { preserveUnverified?: boolean; shutdownGraceMs?: number; indexDir?: string } = {},
): Promise<StopResult> {
  const indexDir = options.indexDir ?? getDaemonIndexDir(root);
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
    // Only a record known to be this index's: one from an older release that
    // doesn't show its index may be another index's daemon.
    const rec = listDaemons({ prune: false }).find((r) => r.indexDir !== null && sameDaemonIndex(r.indexDir, indexDir));
    pid = rec?.pid ?? null;
    if (rec) identity = rec;
  }

  if (pid == null || !identity) {
    await cleanupDaemonArtifacts(root, lockContents, indexDir);
    return { root, pid: null, outcome: 'no-daemon' };
  }
  if (!isProcessAlive(pid)) {
    const removed = await cleanupDaemonArtifacts(root, lockContents, indexDir, identity);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }
  // Never signal a process merely because it reused a stale daemon PID. The
  // daemon's immediate hello is the process-identity proof (#1553). A holder
  // the OS shows is no CodeGraph server is no daemon either: its lock is
  // stale, and is cleared without signalling it (#2770).
  if (!canProbeDaemonIdentity(identity)) {
    return await clearForeignHolder(root, identity, lockContents, indexDir) ?? { root, pid, outcome: 'unverified' };
  }
  if (!await probeDaemonIdentity(identity)) {
    if (options.preserveUnverified) {
      return await clearForeignHolder(root, identity, lockContents, indexDir) ?? { root, pid, outcome: 'unverified' };
    }
    const removed = await cleanupDaemonArtifacts(root, lockContents, indexDir, identity);
    return { root, pid, outcome: removed ? 'not-running' : 'unverified' };
  }
  return stopVerifiedDaemon(root, identity, lockContents, indexDir, options.shutdownGraceMs);
}

/** The OS command that stops process `pid`, for advice text. */
function stopCommand(pid: number, force = false): string {
  if (process.platform === 'win32') return `taskkill /PID ${pid} /F`;
  return force ? `kill -9 ${pid}` : `kill ${pid}`;
}

/**
 * What `codegraph index` reports when {@link stopDaemonAt} left the project's
 * daemon lock in place (outcome `unverified` or `still-running`): the process
 * that holds it, what that process is, and a command that clears it (#2770).
 */
export async function daemonStopFailureMessage(root: string, result: StopResult): Promise<string> {
  const retry = 'then retry `codegraph index`';
  if (result.outcome === 'still-running' && result.pid !== null) {
    return `The CodeGraph daemon serving this project (process ${result.pid}) did not exit when asked to stop. ` +
      `Stop it with \`${stopCommand(result.pid, true)}\`, ${retry}.`;
  }
  const lockPath = getDaemonPidPath(root);
  let holder: number | null = null;
  try {
    const current = decodeLockInfo(fs.readFileSync(lockPath, 'utf8'));
    if (current && isProcessAlive(current.pid)) holder = current.pid;
  } catch { /* no lock now */ }
  if (holder !== null && result.pid !== null && holder !== result.pid) {
    return `A new CodeGraph daemon (process ${holder}) started for this project while \`codegraph index\` was stopping the old one; ` +
      'retry `codegraph index`.';
  }
  const kind = holder === null ? null : classifyLockHolder(await describeProcess(holder));
  if (holder !== null && kind === 'codegraph-server') {
    return `Process ${holder} runs a CodeGraph server (\`codegraph serve --mcp\`) and holds this project's daemon lock, ` +
      'but did not answer as its daemon, so it was left running. It is probably an older or stuck CodeGraph daemon: ' +
      `stop it with \`${stopCommand(holder)}\`, ${retry}.`;
  }
  if (holder !== null && kind === 'unknown') {
    return `Process ${holder} holds this project's daemon lock (${lockPath}) but did not answer as a CodeGraph daemon, ` +
      'and CodeGraph could not tell what it is, so it was left running. ' +
      `If it is a CodeGraph server, stop it with \`${stopCommand(holder)}\`; if it is not, delete ${lockPath}. ` +
      'Then retry `codegraph index`.';
  }
  // The daemon lock names no daemon: no live process, or one that is not
  // CodeGraph. Such a lock is only cleared while holding the project's writer
  // lock, so that is what kept it.
  const writer = readWriterLock(root);
  const writerPath = getWriterPidPath(root);
  if (writer && writer.pid > 0 && writer.pid !== process.pid && isProcessAlive(writer.pid)) {
    if (writer.pid === holder) {
      return `The project's writer lock (${writerPath}) names process ${holder}, which is not a CodeGraph process, ` +
        `so it is stale: delete ${writerPath}, ${retry}.`;
    }
    return writerLockHeldMessage(writer, writerPath);
  }
  if (holder !== null) {
    return `Process ${holder} is not a CodeGraph process, so this project's daemon lock is stale, but it could not be removed: ` +
      `delete ${lockPath}, ${retry}.`;
  }
  return 'The project\'s CodeGraph daemon changed while `codegraph index` was stopping it; retry `codegraph index`.';
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
  indexDir: string,
  shutdownGraceMs = DAEMON_SHUTDOWN_GRACE_MS,
): Promise<StopResult> {
  const { pid, version } = identity;
  // Identity probing awaits I/O: never act on a superseded ownership record.
  const sameLock = (): boolean => {
    try { return fs.readFileSync(getDaemonPidPath(root, indexDir), 'utf8') === lockContents; }
    catch { return lockContents === null; }
  };
  if (!sameLock()) return { root, pid, outcome: 'unverified', version };

  const outcome = await signalVerifiedDaemon(identity, sameLock, shutdownGraceMs);
  if (outcome === 'still-running') return { root, pid, outcome, version };
  // Compares the lock with the one we signalled, so a successor's is kept.
  await cleanupDaemonArtifacts(root, lockContents, indexDir, identity);
  return { root, pid, outcome, version };
}

/**
 * SIGTERM the daemon `identity` names, wait, and SIGKILL it only while it still
 * answers as that daemon and `owned()` (the record it was verified against is
 * still in place) holds.
 */
async function signalVerifiedDaemon(
  identity: DaemonLockInfo,
  owned: () => boolean,
  shutdownGraceMs: number,
): Promise<'term' | 'kill' | 'still-running'> {
  const { pid } = identity;
  // POSIX: SIGTERM runs the daemon's graceful shutdown. Windows: TerminateProcess
  // (no graceful path), so the caller always sweeps artifacts itself.
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  if (await waitForDeath(pid, DAEMON_TERM_WAIT_MS)) return 'term';
  // Re-prove identity before escalating; the old PID may have been reused.
  if (owned() && await probeDaemonIdentity(identity) && owned()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
    return await waitForDeath(pid, 2000) ? 'kill' : 'still-running';
  }
  // No longer answering its socket, or no longer holding the lock it held
  // when it was signalled: a daemon partway through its own shutdown, which
  // closes the socket first and can then wait on a query worker still
  // starting up before it releases the lock and exits (#2311). On Windows,
  // where SIGTERM is TerminateProcess, this is a termination still settling.
  // Its identity can't be re-proven without the socket, so signal nothing
  // more; just wait, bounded, for the PID to go. One that outlives the
  // wait is reported, as before.
  return await waitForDeath(pid, shutdownGraceMs) ? 'term' : 'still-running';
}

/**
 * Stop the daemon a registry record names ({@link listDaemons}). One whose
 * index is known is stopped by that index's lock, as {@link stopDaemonAt} stops
 * one. A record from an older release that shows no index has no lock to go
 * by: its daemon is stopped by pid, only once the hello on its socket proves
 * the pid is still that daemon (#1553), and its record and dead socket go
 * after it. Its lock is left to the next daemon of its index, which clears a
 * dead holder's.
 */
export async function stopRecordedDaemon(
  rec: DaemonRecord,
  options: { shutdownGraceMs?: number } = {},
): Promise<StopResult> {
  if (rec.indexDir !== null) return stopDaemonAt(rec.root, { indexDir: rec.indexDir, shutdownGraceMs: options.shutdownGraceMs });
  const { root, pid, version } = rec;
  const clear = async (): Promise<void> => {
    removeRecordFile(rec.file, (current) => current.pid === pid && current.socketPath === rec.socketPath);
    const socketPath = rec.socketPath;
    if (process.platform !== 'win32' && socketPath === rootDaemonSocketPath(root) && !await socketAnswers(socketPath)) {
      try { fs.unlinkSync(socketPath); } catch { /* gone */ }
    }
  };
  if (!isProcessAlive(pid)) {
    await clear();
    return { root, pid, outcome: 'not-running', version };
  }
  if (!canProbeDaemonIdentity(rec) || !await probeDaemonIdentity(rec)) return { root, pid, outcome: 'unverified', version };
  const outcome = await signalVerifiedDaemon(rec, () => true, options.shutdownGraceMs ?? DAEMON_SHUTDOWN_GRACE_MS);
  if (outcome !== 'still-running') await clear();
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
  const indexDir = getDaemonIndexDir(root);
  let lockContents: string;
  try {
    lockContents = fs.readFileSync(getDaemonPidPath(root, indexDir), 'utf8');
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
  const result = await stopVerifiedDaemon(root, identity, lockContents, indexDir, options.shutdownGraceMs);
  if (result.outcome === 'term' || result.outcome === 'kill') {
    // The stop's own sweep needs the slot this process now holds: clear what
    // the old daemon left (all of it on Windows, where the stop is
    // TerminateProcess, and the socket and record an older release named after
    // the root), so its successor starts on a clean lock.
    await removeDaemonArtifacts(root, lockContents, indexDir, identity);
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
    results.push(await stopRecordedDaemon(rec));
  }
  return results;
}
