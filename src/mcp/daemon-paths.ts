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

import * as crypto from 'crypto';
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
 * Compute the socket / named-pipe path the daemon should listen on (and the
 * proxy should connect to) for `projectRoot`. Deterministic given a project
 * root, so independent processes converge without coordination.
 */
export function getDaemonSocketPath(projectRoot: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\codegraph-${projectHash(projectRoot)}`;
  }
  const inProject = path.join(getCodeGraphDir(projectRoot), 'daemon.sock');
  if (inProject.length <= POSIX_SOCKET_PATH_LIMIT) return inProject;
  // Long project paths (deep monorepos, Bazel out dirs) need tmpdir fallback
  // or `bind` returns EADDRINUSE / ENAMETOOLONG. Hash keeps it project-scoped.
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
