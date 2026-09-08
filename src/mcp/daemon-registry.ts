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
import {
  getDaemonPidPath,
  getDaemonSocketCandidates,
  decodeLockInfo,
  probeDaemonIdentity,
  type DaemonLockInfo,
} from './daemon-paths';

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

function recordPath(root: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
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

/** Remove a stopped daemon's leftover lockfile + socket + registry record. */
function cleanupDaemonArtifacts(root: string): void {
  try { fs.unlinkSync(getDaemonPidPath(root)); } catch { /* gone */ }
  // POSIX sockets are real files; Windows named pipes vanish with the process.
  // Sweep every candidate — a daemon that relocated past an unusable in-project
  // FS (ExFAT/FAT; #997) left its socket at the tmpdir fallback, not candidate 0.
  if (process.platform !== 'win32') {
    for (const candidate of getDaemonSocketCandidates(root)) {
      try { fs.unlinkSync(candidate); } catch { /* gone */ }
    }
  }
  deregisterDaemon(root);
}

/** Remove daemon artifacts only when no matching daemon answers the socket hello. */
export async function clearStaleDaemonArtifacts(root: string): Promise<boolean> {
  const pidPath = getDaemonPidPath(root);
  const hadArtifacts = fs.existsSync(pidPath) || (
    process.platform !== 'win32' && getDaemonSocketCandidates(root).some((p) => fs.existsSync(p))
  );
  if (!hadArtifacts) return false;
  let info: DaemonLockInfo | null = null;
  try { info = decodeLockInfo(fs.readFileSync(pidPath, 'utf8')); } catch { /* missing/corrupt */ }
  if (info && isProcessAlive(info.pid) && await probeDaemonIdentity(info)) return false;
  cleanupDaemonArtifacts(root);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** 'term' graceful, 'kill' force, 'not-running' stale lock, 'no-daemon' none found. */
  outcome: 'term' | 'kill' | 'not-running' | 'no-daemon';
}

/**
 * Stop the daemon serving `root`: SIGTERM, wait, then SIGKILL if it won't go,
 * then sweep its artifacts. `root` must be realpath'd (match how the daemon
 * keys its socket/lockfile). Resolves the pid from the authoritative lockfile,
 * falling back to the registry.
 */
export async function stopDaemonAt(root: string): Promise<StopResult> {
  let pid: number | null = null;
  let identity: DaemonLockInfo | null = null;
  try {
    identity = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
    pid = identity?.pid ?? null;
  } catch {
    /* no lockfile */
  }
  if (pid == null) {
    const rec = listDaemons({ prune: false }).find(
      (r) => path.resolve(r.root) === path.resolve(root)
    );
    pid = rec?.pid ?? null;
    if (rec) identity = rec;
  }

  if (pid == null) {
    cleanupDaemonArtifacts(root);
    return { root, pid: null, outcome: 'no-daemon' };
  }
  if (!isProcessAlive(pid)) {
    cleanupDaemonArtifacts(root);
    return { root, pid, outcome: 'not-running' };
  }
  // Never signal a process merely because it reused a stale daemon PID. The
  // daemon's immediate hello is the process-identity proof (#1553).
  if (!identity || !await probeDaemonIdentity(identity)) {
    cleanupDaemonArtifacts(root);
    return { root, pid, outcome: 'not-running' };
  }

  // POSIX: SIGTERM runs the daemon's graceful shutdown. Windows: TerminateProcess
  // (no graceful path), so we always sweep artifacts ourselves below.
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  let outcome: StopResult['outcome'] = 'term';
  if (!(await waitForDeath(pid, 3000))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
    await waitForDeath(pid, 2000);
    outcome = 'kill';
  }
  cleanupDaemonArtifacts(root);
  return { root, pid, outcome };
}

/** Stop every registered, live daemon. */
export async function stopAllDaemons(): Promise<StopResult[]> {
  const results: StopResult[] = [];
  for (const rec of await listVerifiedDaemons()) {
    results.push(await stopDaemonAt(rec.root));
  }
  return results;
}
