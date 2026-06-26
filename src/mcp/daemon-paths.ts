/**
 * Daemon socket + lockfile path helpers — issue #411.
 *
 * One shared `codegraph serve --mcp` daemon per project root means we need a
 * stable, project-keyed rendezvous between cooperating processes. The IPC
 * surface area is just two file paths:
 *
 *   - `daemon.sock` — Unix domain socket / named pipe the daemon listens on.
 *   - `daemon.pid` — atomic-create lockfile holding the daemon's pid + version.
 *
 * Both live under `.codegraph/` so the project-scoped uninstall (`codegraph
 * uninit`) sweeps them up for free.
 *
 * Special-case: Unix domain socket paths have a hard length limit (~104 on
 * macOS, ~108 on Linux); when the in-project path exceeds it we fall back to
 * an absolute-path hash under `os.tmpdir()`. The pidfile always stays in the
 * project (it doesn't have a length limit) — and acts as the authoritative
 * pointer to the socket path the daemon chose.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';

/** Soft upper bound for in-project socket paths. */
const POSIX_SOCKET_PATH_LIMIT = 100;

/** Short stable identifier for a project root — used in tmpdir/pipe names. */
function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/**
 * Per-device cache for AF_UNIX socket support. Keyed by `fs.statSync().dev`
 * so the probe runs at most once per mounted filesystem.
 */
const socketSupportCache = new Map<number, boolean>();

/**
 * Probe whether `dir` lives on a filesystem that supports AF_UNIX sockets.
 * ExFAT, NTFS-3G, some FUSE mounts, and network shares don't — `listen()`
 * fails with ENOTSUP / EOPNOTSUPP. The result is cached per device so
 * subsequent calls for the same mount are free.
 *
 * Exported for testing.
 */
export function canSocketInDir(dir: string): boolean {
  let dev: number;
  try {
    dev = fs.statSync(dir).dev;
  } catch {
    return true; // can't stat → optimistic, let listen() fail naturally
  }
  const cached = socketSupportCache.get(dev);
  if (cached !== undefined) return cached;

  const probe = path.join(dir, `.sock-probe-${process.pid}`);
  try {
    // getDaemonSocketPath is synchronous but net.Server.listen is async.
    // Bridge with execFileSync: spawn a short-lived child that attempts to
    // bind a Unix socket and exits 0 (success) or 1 (ENOTSUP / similar).
    execFileSync(process.execPath, [
      '-e',
      `const n=require("net"),f=require("fs"),p=${JSON.stringify(probe)};` +
        'const s=n.createServer();' +
        's.on("error",()=>{try{f.unlinkSync(p)}catch{};process.exit(1)});' +
        's.listen(p,()=>{s.close();try{f.unlinkSync(p)}catch{};process.exit(0)})',
    ], { timeout: 3000, stdio: 'ignore' });
    socketSupportCache.set(dev, true);
    return true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* probe may not exist */ }
    socketSupportCache.set(dev, false);
    return false;
  }
}

/**
 * Clear the socket-support cache. Exported for testing only.
 */
export function clearSocketSupportCache(): void {
  socketSupportCache.clear();
}

/**
 * Compute the socket / named-pipe path the daemon should listen on (and the
 * proxy should connect to) for `projectRoot`. Deterministic given a project
 * root, so independent processes converge without coordination.
 */
export function getDaemonSocketPath(projectRoot: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\codegraph-${projectHash(projectRoot)}`;
  }
  const inProject = path.join(getCodeGraphDir(projectRoot), 'daemon.sock');
  if (inProject.length <= POSIX_SOCKET_PATH_LIMIT && canSocketInDir(path.dirname(inProject))) {
    return inProject;
  }
  // Long project paths, or filesystem doesn't support AF_UNIX sockets
  // (ExFAT, NTFS-3G, etc. — #997). Hash keeps it project-scoped.
  return path.join(os.tmpdir(), `codegraph-${projectHash(projectRoot)}.sock`);
}

/** Absolute path to the daemon pid lockfile for `projectRoot`. */
export function getDaemonPidPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), 'daemon.pid');
}

/** Structured contents of the pid lockfile. */
export interface DaemonLockInfo {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
}

/**
 * Serialize a {@link DaemonLockInfo} for writing to the pidfile. JSON for
 * human readability — operators occasionally `cat` this when debugging.
 */
export function encodeLockInfo(info: DaemonLockInfo): string {
  return JSON.stringify(info, null, 2) + '\n';
}

/**
 * Parse a pidfile body. Tolerant of old-format pidfiles (plain decimal pid) so
 * a 0.10.x daemon doesn't trip over a 0.9.x lockfile if that ever happens —
 * we treat such a lockfile as "process is unknown version, refuse to share."
 */
export function decodeLockInfo(raw: string): DaemonLockInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.version === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as DaemonLockInfo;
    }
    return null;
  } catch {
    // Fall through to legacy plain-pid handling.
  }
  const pid = Number(trimmed);
  if (Number.isFinite(pid) && pid > 0) {
    return { pid, version: 'unknown', socketPath: '', startedAt: 0 };
  }
  return null;
}
