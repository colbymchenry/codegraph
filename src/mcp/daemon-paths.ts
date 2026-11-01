/**
 * Daemon socket + lockfile path helpers — issue #411.
 *
 * One shared `codegraph serve --mcp` daemon per project root means we need a
 * stable, project-keyed rendezvous between cooperating processes. The IPC
 * surface area is just two file paths:
 *
 *   - `daemon.sock` — Unix domain socket / named pipe the daemon listens on.
 *   - `daemon.pid` — atomic-create lockfile holding the daemon's identity record
 *     ({@link DaemonLockInfo}: pid, version, bound socket path, start time, and
 *     the lock stamp naming the project and the physical index it serves).
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

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot, getCodeGraphDir } from '../directory';
import { isForeignLockRecord, type LockStamp } from './writer-lock';

/** Soft upper bound for in-project socket paths. */
const POSIX_SOCKET_PATH_LIMIT = 100;

/**
 * Short stable identifier for a project root — used in tmpdir/pipe names.
 *
 * Hashed over {@link canonicalProjectRoot}, never a raw `path.resolve`: the key
 * is a rendezvous, so every spelling of one directory must land on one name or
 * a proxy probes a pipe the running daemon never bound (see that function).
 */
function projectHash(projectRoot: string): string {
  // `crypto` is the slowest builtin to load, and every CLI command loads this file.
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(canonicalProjectRoot(projectRoot)).digest('hex').slice(0, 16);
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

/**
 * Structured contents of the pid lockfile. The stamp fields (`root`, `dirId`,
 * `dbId`, see {@link LockStamp}) name the project and the physical index the
 * writing daemon serves. A copied `.codegraph/` (cp -r, rsync, a cloned VM
 * disk) carries the source's daemon.pid along, and the stamp is what lets the
 * copy tell that record apart from one of its own: when it is foreign by
 * {@link isForeignLockRecord}, {@link decodeLockInfo} drops it. The stamp is
 * absent in older-format records; for every record that is not foreign, pid
 * liveness decides.
 */
export interface DaemonLockInfo extends Partial<LockStamp> {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
}

/** Whether a lock record contains enough identity data for a socket hello. */
export function canProbeDaemonIdentity(info: DaemonLockInfo): boolean {
  return (
    Number.isInteger(info.pid) &&
    info.pid > 0 &&
    typeof info.socketPath === 'string' &&
    info.socketPath.length > 0
  );
}

/**
 * Verify that the process named by a lockfile is the CodeGraph daemon serving
 * its socket. A bare PID liveness probe is insufficient because OSes reuse PIDs
 * after an OOM/SIGKILL (#1553).
 */
export function probeDaemonIdentity(info: DaemonLockInfo, timeoutMs = 1_000): Promise<boolean> {
  if (!canProbeDaemonIdentity(info)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let socket: net.Socket;
    let buffer = '';
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      socket = net.createConnection(info.socketPath);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 4096) return finish(false);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const hello = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        finish(
          hello.protocol === 1 &&
          hello.pid === info.pid &&
          (info.version === 'unknown' || hello.codegraph === info.version)
        );
      } catch {
        finish(false);
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
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
 *
 * The stamp fields (`root`, `dirId`, `dbId`) are passed through when the
 * record carries them as strings. When `projectRoot` is given and the record
 * is FOREIGN (see {@link isForeignLockRecord}; in practice a pidfile copied
 * along with a `.codegraph/` from elsewhere), the record is not this project's
 * daemon and decodes to null, exactly like a corrupt leftover: the caller sees
 * "no daemon here" and never probes or signals the source project's daemon
 * through it. Every other record is decoded in full and pid liveness decides.
 */
export function decodeLockInfo(raw: string, projectRoot?: string): DaemonLockInfo | null {
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
      if (projectRoot !== undefined && isForeignLockRecord(parsed, projectRoot)) return null;
      // A non-string stamp field is not a stamp: drop it rather than hand
      // callers a mistyped field. Every other field passes through unchanged.
      for (const key of ['root', 'dirId', 'dbId'] as const) {
        if (key in parsed && typeof parsed[key] !== 'string') delete parsed[key];
      }
      return parsed as DaemonLockInfo;
    }
  } catch {
    // Fall through to legacy plain-pid handling.
  }
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  if (Number.isSafeInteger(pid)) {
    return { pid, version: 'unknown', socketPath: '', startedAt: 0 };
  }
  return null;
}
