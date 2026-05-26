/**
 * Shared MCP daemon — issue #411.
 *
 * One detached `codegraph serve --mcp` daemon process per project root,
 * accepting N concurrent MCP clients over a Unix-domain socket (or named pipe
 * on Windows). Each incoming connection gets its own {@link MCPSession}; all
 * sessions share a single {@link MCPEngine}, which means a single file watcher
 * (one inotify set), a single SQLite connection (one WAL writer), and a single
 * tree-sitter warm-up — paid once, amortized across every agent talking to the
 * project.
 *
 * Lifecycle (see also `./index.ts` and `./proxy.ts`):
 *   - The daemon is spawned **detached** (its own session/process group, stdio
 *     decoupled) by the first launcher that finds no daemon running. It is NOT
 *     a child of any MCP host, so closing one terminal / Ctrl-C'ing one session
 *     can't take it down and sever the others. That's why this process has no
 *     PPID watchdog: it deliberately outlives every individual client.
 *   - Every MCP host talks to the daemon through a thin `proxy` process (the
 *     thing the host actually spawned). The proxy keeps the #277 PPID watchdog,
 *     so a SIGKILL'd host still reaps its proxy promptly; the proxy's socket
 *     close then decrements the daemon's refcount.
 *   - When the last client disconnects the daemon lingers for
 *     `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default 300s) so back-to-back agent
 *     runs in the same project don't repay startup, then exits cleanly. This is
 *     what keeps a single-agent session from leaking a daemon forever (#277).
 *
 * What this file owns:
 *   - Listening on the daemon socket and spawning per-connection sessions.
 *   - The handshake "hello" line that lets a proxy verify it found a
 *     same-version daemon before piping any JSON-RPC through it.
 *   - The lockfile (`.codegraph/daemon.pid`) competing daemons arbitrate
 *     against — atomic `O_EXCL` create with the full record written in the same
 *     breath (no empty-file window) + cleanup on exit.
 *   - Reference counting + idle timeout.
 *   - Graceful shutdown on SIGTERM/SIGINT and idle exit.
 *
 * What this file does NOT own:
 *   - The proxy side (`./proxy.ts`).
 *   - The decision of *whether* to run as daemon at all — that's `MCPServer`.
 *   - The MCP protocol state machine — that's `./session.ts`.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import { SocketTransport } from './transport';
import {
  DaemonLockInfo,
  decodeLockInfo,
  encodeLockInfo,
  getDaemonPidPath,
  getDaemonSocketPath,
} from './daemon-paths';
import { CodeGraphPackageVersion } from './version';

/** Default idle linger after the last client disconnects. */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Bytes/parse-window for an oversized hello line — bounded against a malicious peer. */
const MAX_HELLO_LINE_BYTES = 4096;

/**
 * Wire format for the one-shot hello line the daemon emits on every new
 * connection. Versioned with the package's own semver so a 0.9.x proxy never
 * pipes through a 0.10.x daemon (or vice-versa) — the proxy falls back to
 * direct mode on mismatch rather than risk subtle wire incompatibilities.
 */
export interface DaemonHello {
  codegraph: string; // package version (must match the proxy's own version)
  pid: number;       // daemon pid (informational; for `ps` debugging)
  socketPath: string; // echoed back so the proxy can log it
  protocol: 1;       // bump if the hello shape changes
}

export interface DaemonStartResult {
  /** Always-non-null for a successfully-started daemon. */
  socketPath: string;
  /** Lockfile contents as written. */
  lock: DaemonLockInfo;
}

/**
 * Run as the shared daemon for `projectRoot`. Resolves once the socket is
 * listening. The Daemon owns the socket, the engine, and the lockfile until
 * `stop()` is called or it exits on idle/signal.
 *
 * Race-safe: callers must first call `tryAcquireDaemonLock(projectRoot)` and
 * only construct a Daemon if they got the lock (`kind: 'acquired'`). The atomic
 * `O_EXCL` create inside the acquire helper — which now also writes the full
 * record before returning — is the only synchronization between competing
 * daemons.
 */
export class Daemon {
  private server: net.Server | null = null;
  private clients = new Set<MCPSession>();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private engine: MCPEngine;
  private stopping = false;
  private socketPath: string;
  private pidPath: string;

  constructor(
    private projectRoot: string,
    opts: { idleTimeoutMs?: number } = {},
  ) {
    this.socketPath = getDaemonSocketPath(projectRoot);
    this.pidPath = getDaemonPidPath(projectRoot);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? resolveIdleTimeoutMs();
    this.engine = new MCPEngine();
    this.engine.setProjectPathHint(projectRoot);
  }

  /**
   * Bind the socket, kick off engine init, and register signal handlers. The
   * lockfile body was already written atomically by `tryAcquireDaemonLock`, so
   * there is nothing to write here. The promise resolves once the server is
   * listening — the daemon then sticks around until idle/shutdown.
   */
  async start(): Promise<DaemonStartResult> {
    // Engine init is deliberately backgrounded — see #172. The first session
    // to land waits on `ensureInitialized` either way, and unloaded sessions
    // (cross-project tool calls only) shouldn't pay any open cost.
    void this.engine.ensureInitialized(this.projectRoot);

    // Stale socket file (left over from a SIGKILL'd previous daemon) will
    // wedge `listen` with EADDRINUSE. We arrived here holding the lockfile,
    // which means there's no live daemon, so it's safe to clear.
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* not-exists is fine */ }
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', (err) => reject(err));
      server.listen(this.socketPath, () => {
        // POSIX: tighten permissions to user-only — the socket lives under
        // `.codegraph/`, which is git-ignored but may be on a shared FS.
        if (process.platform !== 'win32') {
          try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best-effort */ }
        }
        this.server = server;
        resolve();
      });
    });

    const lock: DaemonLockInfo = {
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath: this.socketPath,
      startedAt: Date.now(),
    };

    process.stderr.write(
      `[CodeGraph daemon] Listening on ${this.socketPath} (pid ${process.pid}, v${CodeGraphPackageVersion}). Idle timeout ${this.idleTimeoutMs}ms.\n`
    );

    // No clients yet: arm the idle timer immediately so a daemon that nobody
    // ever connects to (e.g. spawned then abandoned because the launcher died)
    // doesn't pin resources forever.
    this.armIdleTimer();

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    return { socketPath: this.socketPath, lock };
  }

  /** Currently-connected client count. Exposed for tests / status output. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** The socket path the daemon is (or will be) listening on. */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Graceful shutdown: close all sessions, the engine, and clean up the lock. */
  async stop(reason: string = 'stop'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    process.stderr.write(`[CodeGraph daemon] Shutting down (${reason}; clients=${this.clients.size}).\n`);
    for (const session of [...this.clients]) {
      try { session.stop(); } catch { /* best-effort */ }
    }
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.engine.stop();
    this.cleanupLockfile();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* may already be gone */ }
    }
    process.exit(0);
  }

  private handleConnection(socket: net.Socket): void {
    // Hello first so the proxy can verify versions before piping any
    // application bytes. The proxy reads exactly one line, then forwards.
    const hello: DaemonHello = {
      codegraph: CodeGraphPackageVersion,
      pid: process.pid,
      socketPath: this.socketPath,
      protocol: 1,
    };
    socket.write(JSON.stringify(hello) + '\n');

    const transport = new SocketTransport(socket);
    const session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.projectRoot,
    });
    transport.onClose(() => this.dropClient(session));
    this.clients.add(session);
    this.disarmIdleTimer();
    session.start();
  }

  private dropClient(session: MCPSession): void {
    if (!this.clients.delete(session)) return;
    if (this.clients.size === 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.stopping) return;
    if (this.idleTimeoutMs <= 0) return; // 0 = never idle-exit
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Last-second sanity check: if a connection landed between the timer
      // firing and now, don't exit. (setImmediate-ordering is the only way
      // this races; cheap to defend against.)
      if (this.clients.size > 0) {
        this.armIdleTimer();
        return;
      }
      void this.stop('idle timeout');
    }, this.idleTimeoutMs);
    // Don't keep the event loop alive just for this — the net.Server keeps the
    // loop alive while listening, so the timer still fires; once we stop() the
    // loop should drain naturally.
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cleanupLockfile(): void {
    try {
      if (fs.existsSync(this.pidPath)) {
        // Only remove if it still belongs to us — another daemon may have
        // already taken over while we were shutting down (extremely rare).
        const raw = fs.readFileSync(this.pidPath, 'utf8');
        const info = decodeLockInfo(raw);
        if (info && info.pid === process.pid) {
          fs.unlinkSync(this.pidPath);
        }
      }
    } catch { /* best-effort; we're exiting anyway */ }
  }
}

/**
 * Result of `tryAcquireDaemonLock`. Either we got the lockfile (caller becomes
 * the daemon), or it already existed (caller should connect to the existing
 * daemon as a proxy, or — if the holder is dead — clear it and retry).
 */
export type AcquireResult =
  | { kind: 'acquired'; pidPath: string; info: DaemonLockInfo }
  | { kind: 'taken'; existing: DaemonLockInfo | null; pidPath: string };

/**
 * Atomically create the daemon pidfile with its full record already in place.
 * Returns either an `acquired` result (the caller is the daemon-elect and may
 * construct a {@link Daemon}) or a `taken` result.
 *
 * must-fix 1 (issue #411 review): the lockfile must appear in ONE atomic step,
 * already complete — never empty, even momentarily. The first attempt at this
 * (`O_EXCL` create then a separate `writeSync`) left a microsecond window where
 * the file existed but was empty; under concurrent daemon startup a third
 * candidate could read that empty file, decode it as `null`, and `unlink` the
 * winner's lock → two daemons (two watchers, two writers). The window was
 * normally too small to hit, but the chokidar watcher's extra startup time made
 * concurrent daemons overlap enough to reproduce it reliably.
 *
 * The fix writes the complete record to a private temp file, then hard-links it
 * into place: `link()` is atomic AND exclusive (EEXIST if the target exists), so
 * the pidfile becomes visible in one step already containing a full record.
 * Whoever links first wins; everyone else gets EEXIST and reads a complete file.
 * There is no empty-file window at all.
 */
export function tryAcquireDaemonLock(projectRoot: string): AcquireResult {
  const pidPath = getDaemonPidPath(projectRoot);
  // Make sure the .codegraph/ directory exists — the daemon may be the first
  // thing to touch it on a fresh-clone-but-already-initialized checkout.
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const info: DaemonLockInfo = {
    pid: process.pid,
    version: CodeGraphPackageVersion,
    socketPath: getDaemonSocketPath(projectRoot),
    startedAt: Date.now(),
  };

  // Temp name is pid-scoped so racing candidates never collide on it.
  const tmp = `${pidPath}.${process.pid}.tmp`;
  let acquired = false;
  try {
    fs.writeFileSync(tmp, encodeLockInfo(info), { mode: 0o600 });
    try {
      fs.linkSync(tmp, pidPath); // atomic + exclusive
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
  }

  if (acquired) return { kind: 'acquired', pidPath, info };

  // Taken. Because the pidfile was link'd atomically it always holds a complete
  // record — `existing` is null only for a genuinely corrupt leftover, never a
  // mid-write race.
  let existing: DaemonLockInfo | null = null;
  try {
    existing = decodeLockInfo(fs.readFileSync(pidPath, 'utf8'));
  } catch { /* unreadable lockfile — treat as malformed */ }
  return { kind: 'taken', existing, pidPath };
}

/**
 * Remove a stale pidfile, but only if it still names a dead process. Re-reads
 * the file immediately before unlinking so we never delete a lock that a live
 * daemon (re)acquired in the meantime.
 *
 * must-fix 1 (issue #411 review): the original unconditionally `unlink`'d,
 * which let a racing candidate delete a healthy daemon's lock. Passing
 * `expectedDeadPid` (the pid the caller believed was dead) makes the clear a
 * compare-and-delete: bail if the file now holds a different pid, or any live
 * pid. Returns true when the stale lock is gone (or was already gone).
 */
export function clearStaleDaemonLock(pidPath: string, expectedDeadPid?: number): boolean {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8');
    const info = decodeLockInfo(raw);
    if (info) {
      // A different pid took over since we read it — not ours to clear.
      if (expectedDeadPid !== undefined && info.pid !== expectedDeadPid) return false;
      // Holder is actually alive — never clear a live daemon's lock.
      if (info.pid > 0 && isProcessAlive(info.pid)) return false;
    }
    fs.unlinkSync(pidPath);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return true; // already gone
    return false;
  }
}

/**
 * Probe whether `pid` is currently alive (signal-0). Treats EPERM as alive on
 * every platform (the process exists, it's just not ours to signal) so we never
 * mistake a live daemon for a dead one and clear its lock.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true; // exists, just not ours to signal
    return false;
  }
}

function resolveIdleTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Exported for test stubs that need to bound the hello-line read. */
export { MAX_HELLO_LINE_BYTES };
