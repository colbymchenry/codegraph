/**
 * Shared MCP daemon — issue #411.
 *
 * One `codegraph serve --mcp` process per project root, accepting N concurrent
 * MCP clients over a Unix-domain socket (or named pipe on Windows). Each
 * incoming connection gets its own {@link MCPSession}; all sessions share a
 * single {@link MCPEngine}, which means a single file watcher (one inotify
 * set), a single SQLite connection (one WAL writer), and a single tree-sitter
 * warm-up — paid once, amortized across every agent talking to the project.
 *
 * What this file owns:
 *   - Listening on the daemon socket and spawning per-connection sessions.
 *   - The handshake "hello" line that lets a proxy verify it found a
 *     same-version daemon before piping any JSON-RPC through it.
 *   - The lockfile (`.codegraph/daemon.pid`) that races between daemons are
 *     resolved against — atomic `O_EXCL` create + cleanup on exit.
 *   - Reference counting + idle timeout: when the last client disconnects
 *     the daemon lingers for `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default
 *     300s) so back-to-back agent runs in the same project don't repay
 *     startup. New connection cancels the timer.
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
import { SocketTransport, StdioTransport } from './transport';
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
 * listening and the lockfile is committed. The returned Daemon owns the
 * socket, the engine, and the lockfile until `stop()` is called or it exits
 * on idle/signal.
 *
 * Race-safe: callers must first try `tryAcquireDaemonLock(projectRoot)` and
 * only call `Daemon.run` if they got the lock. The atomic `O_EXCL` create
 * inside the acquire helper is the only synchronization between competing
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
  private lockFd: number | null = null;

  constructor(
    private projectRoot: string,
    opts: { lockFd: number; idleTimeoutMs?: number } = { lockFd: -1 },
  ) {
    this.socketPath = getDaemonSocketPath(projectRoot);
    this.pidPath = getDaemonPidPath(projectRoot);
    this.lockFd = opts.lockFd >= 0 ? opts.lockFd : null;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? resolveIdleTimeoutMs();
    this.engine = new MCPEngine();
    this.engine.setProjectPathHint(projectRoot);
  }

  /**
   * Bind the socket, write the pidfile body, kick off engine init, and
   * register signal handlers. The promise resolves once the server is
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
    this.writeLockFile(lock);

    process.stderr.write(
      `[CodeGraph daemon] Listening on ${this.socketPath} (pid ${process.pid}, v${CodeGraphPackageVersion}). Idle timeout ${this.idleTimeoutMs}ms.\n`
    );

    // No clients yet: arm the idle timer immediately so a daemon that nobody
    // ever connects to (e.g. spawned by a misconfigured client) doesn't pin
    // resources forever.
    this.armIdleTimer();

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    return { socketPath: this.socketPath, lock };
  }

  /**
   * Attach an stdio session for the *launcher* — the MCP host that spawned
   * this very process. The launcher already opened a stdio pipe to us and is
   * waiting for an `initialize` response; that pipe gets its own session
   * just like any socket connection. The transport is configured with
   * `exitOnClose: false` so losing the launcher doesn't kill the daemon —
   * other socket clients are still entitled to service. When stdin closes
   * we just remove this session from the client set and arm the idle timer
   * if nothing else is connected.
   */
  attachStdioLauncherSession(): MCPSession {
    let session!: MCPSession;
    const transport = new StdioTransport({
      exitOnClose: false,
      onClose: () => {
        if (session) this.dropClient(session);
      },
    });
    session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.projectRoot,
    });
    this.clients.add(session);
    this.disarmIdleTimer();
    session.start();
    return session;
  }

  /** Currently-connected client count. Exposed for tests / status output. */
  getClientCount(): number {
    return this.clients.size;
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
    // Don't keep the event loop alive just for this — if the socket server
    // and active connections are all gone, the loop should drain naturally.
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private writeLockFile(info: DaemonLockInfo): void {
    const body = encodeLockInfo(info);
    if (this.lockFd !== null) {
      // We came in already holding the lockfile (acquired via `wx`); fill it
      // in atomically by writing the body and closing the fd. Subsequent
      // readers of the pidfile then see the full record.
      fs.writeSync(this.lockFd, body);
      fs.closeSync(this.lockFd);
      this.lockFd = null;
    } else {
      // Defensive path — should be unreachable because callers always go
      // through `tryAcquireDaemonLock` before constructing a Daemon.
      fs.writeFileSync(this.pidPath, body, { flag: 'w' });
    }
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
 * the daemon), or it already existed (caller should try to connect to the
 * existing daemon as a proxy).
 */
export type AcquireResult =
  | { kind: 'acquired'; lockFd: number; pidPath: string }
  | { kind: 'taken'; existing: DaemonLockInfo | null; pidPath: string };

/**
 * Atomic-create the daemon pidfile. Returns either an `acquired` result (the
 * caller is now the daemon-elect; must call `Daemon.run` which writes the
 * pidfile body and closes the fd) or a `taken` result (some other process
 * either is or was the daemon; caller should connect-or-take-over).
 *
 * The fd is left writable + truncate-only — Daemon.start() writes the actual
 * body (pid, version, socket path) once it's bound the socket. That way a
 * crash mid-acquire leaves an empty pidfile which any subsequent daemon
 * candidate can recognize as stale.
 */
export function tryAcquireDaemonLock(projectRoot: string): AcquireResult {
  const pidPath = getDaemonPidPath(projectRoot);
  // Make sure the .codegraph/ directory exists — the daemon may be the first
  // thing to touch it on a fresh-clone-but-already-initialized checkout.
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  try {
    const fd = fs.openSync(pidPath, 'wx', 0o600);
    return { kind: 'acquired', lockFd: fd, pidPath };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw err;
  }

  let existing: DaemonLockInfo | null = null;
  try {
    const raw = fs.readFileSync(pidPath, 'utf8');
    existing = decodeLockInfo(raw);
  } catch { /* unreadable lockfile — treat as malformed */ }
  return { kind: 'taken', existing, pidPath };
}

/**
 * Remove a stale pidfile and return whether we successfully cleared it. Used
 * by callers that detected a "taken" lock pointing at a dead pid.
 */
export function clearStaleDaemonLock(pidPath: string): boolean {
  try {
    fs.unlinkSync(pidPath);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return true;
    return false;
  }
}

/**
 * Probe whether `pid` is currently alive (signal-0). False on Windows for
 * pids of a different user since `kill` returns EPERM there; we accept that
 * as "still alive" to be conservative — better to fall back to direct mode
 * than to nuke a stranger's daemon.
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
