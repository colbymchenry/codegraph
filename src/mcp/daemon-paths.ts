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
 * uninit`) sweeps them up for free — the socket unless it falls back to
 * tmpdir or, for a group-writable `.codegraph/`, the runtime folder (below).
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

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot, getCodeGraphDir } from '../directory';

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
 * Whether users other than its owner could replace a socket in a folder with
 * this `mode`: its group or others can write to it, and no sticky bit keeps a
 * file for its owner to remove. The prompt hook connects to no socket in such
 * a folder (see `./hook-client`).
 */
export function othersCanReplaceIn(mode: number): boolean {
  return (mode & 0o022) !== 0 && (mode & 0o1000) === 0;
}

/**
 * The socket path in this user's runtime folder, or null when there is none to
 * trust: an absolute `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`, the folder
 * systemd makes for each user and sets the variable to. So a process started
 * without the variable (cron, a host that clears the environment) finds the
 * same folder, and so does one whose variable names a folder others can write
 * to (WSLg's shared one). Either must be a folder this user owns that no one
 * else can write to, so a socket in it can be neither planted nor swapped.
 */
function runtimeDirSocketPath(projectRoot: string): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  for (const dir of [fromEnv && path.isAbsolute(fromEnv) ? fromEnv : null, `/run/user/${uid}`]) {
    if (!dir || !privateFolderOf(dir, uid)) continue;
    const socketPath = path.join(dir, `codegraph-${projectHash(projectRoot)}.sock`);
    if (socketPath.length <= POSIX_SOCKET_PATH_LIMIT) return socketPath;
  }
  return null;
}

/** Whether `dir` is a folder `uid` owns that no one else can write to. */
function privateFolderOf(dir: string, uid: number): boolean {
  try {
    const stat = fs.statSync(dir);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Whether others could replace a socket in `folder`; false when it can't be read. */
function folderOthersCanReplace(folder: string): boolean {
  try {
    return othersCanReplaceIn(fs.statSync(folder).mode);
  } catch {
    return false;
  }
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
 *   - `.codegraph/` writable by its group or others (umask 0002; #3417), with a
 *     private runtime folder: `[ <runtime dir> , .codegraph/daemon.sock ,
 *     <tmpdir> ]`. The list then also depends on that folder's mode and on the
 *     environment, which the daemon and its clients share.
 */
export function getDaemonSocketCandidates(projectRoot: string): string[] {
  if (process.platform === 'win32') {
    return [`\\\\.\\pipe\\codegraph-${projectHash(projectRoot)}`];
  }
  const inProject = path.join(getCodeGraphDir(projectRoot), 'daemon.sock');
  const tmp = tmpdirSocketPath(projectRoot);
  if (inProject.length > POSIX_SOCKET_PATH_LIMIT) return [tmp];
  // A `.codegraph/` its group can write to, as a umask of 0002 makes it, holds
  // no socket the prompt hook will trust (#3417). The runtime folder comes
  // first then: no one else can plant a socket there, as they can in tmpdir.
  if (folderOthersCanReplace(path.dirname(inProject))) {
    const runtime = runtimeDirSocketPath(projectRoot);
    if (runtime) return [runtime, inProject, tmp];
  }
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

/** Whether `CODEGRAPH_NO_DAEMON` was set to a truthy value. */
export function daemonOptOutSet(): boolean {
  const raw = process.env.CODEGRAPH_NO_DAEMON;
  if (!raw) return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
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
