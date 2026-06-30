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
 *
 * Second special-case (#997, #974): some filesystems can't host an AF_UNIX node
 * AT ALL — ExFAT/FAT external volumes, certain network mounts, WSL2 DrvFs — so
 * `listen()` throws ENOTSUP/EACCES regardless of path length. We can't cheaply
 * tell those apart from a normal volume up front, so instead of guessing we
 * expose an ORDERED candidate list (`getDaemonSocketCandidates`): the in-project
 * path first, the deterministic tmpdir path as the fallback of last resort. The
 * daemon binds the first that works (relocating past a capability error); the
 * proxy connects the first that answers. Both walk the SAME list, so they still
 * converge on whichever the daemon bound with zero coordination.
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
 * The deterministic tmpdir socket path for `projectRoot` — the fallback used
 * when the in-project location can't host a socket (too long, or an FS that
 * doesn't support AF_UNIX). Hash keeps it project-scoped, and being purely a
 * function of the root means the daemon and the proxy compute the identical
 * path without talking to each other.
 */
function tmpdirSocketPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `codegraph-${projectHash(projectRoot)}.sock`);
}

/**
 * Ordered socket / named-pipe path candidates the daemon should try to bind (and
 * the proxy should try to connect) for `projectRoot`, most-preferred first.
 * Deterministic given a project root, so independent processes converge without
 * coordination — even when the preferred candidate is unusable and both fall
 * through to the same fallback.
 *
 *   - Windows: a single named pipe (lives in the kernel pipe namespace, not on
 *     the project FS, so neither the length nor the ExFAT hazard applies).
 *   - Short in-project path: `[ .codegraph/daemon.sock , <tmpdir> ]` — try the
 *     project first, fall back to tmpdir if its FS can't host a socket (#997).
 *   - Long in-project path (deep monorepos, Bazel out dirs): `[ <tmpdir> ]` only
 *     — bind would throw ENAMETOOLONG, so we skip straight to tmpdir.
 */
export function getDaemonSocketCandidates(projectRoot: string): string[] {
  if (process.platform === 'win32') {
    return [`\\\\.\\pipe\\codegraph-${projectHash(projectRoot)}`];
  }
  const inProject = path.join(getCodeGraphDir(projectRoot), 'daemon.sock');
  const tmp = tmpdirSocketPath(projectRoot);
  if (inProject.length > POSIX_SOCKET_PATH_LIMIT) return [tmp];
  return [inProject, tmp];
}

/**
 * The PREFERRED (primary) socket path — candidate 0. Use this only where a
 * single representative path is wanted (the lockfile's informational
 * `socketPath` field, status display). For binding/connecting, walk the full
 * {@link getDaemonSocketCandidates} list — the daemon may bind a fallback when
 * candidate 0 is unusable.
 */
export function getDaemonSocketPath(projectRoot: string): string {
  // The candidate list is never empty (≥1 on every platform), so [0] is safe.
  return getDaemonSocketCandidates(projectRoot)[0]!;
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
