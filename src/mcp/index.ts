/**
 * CodeGraph MCP Server
 *
 * Model Context Protocol server that exposes CodeGraph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'codegraph';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 *
 * Runtime modes (decided in {@link MCPServer.start}):
 *
 * - **Direct** — one process serves one MCP client over stdio. The pre-#411
 *   behavior; used when the user opts out (`CODEGRAPH_NO_DAEMON=1`), no
 *   `.codegraph/` is reachable, or the daemon machinery fails for any reason.
 * - **Proxy** — what an MCP host actually talks to when sharing is on: a thin
 *   stdio↔socket pipe to the shared daemon. The proxy carries the #277 PPID
 *   watchdog, so a SIGKILL'd host reaps its proxy promptly. See {@link ./proxy.ts}.
 * - **Daemon** — a *detached* background process (its own session/process
 *   group) that serves N proxies over a Unix-domain socket / named pipe,
 *   sharing one CodeGraph + watcher + SQLite handle. Spawned on demand; never a
 *   child of any host, so it survives individual sessions and is reaped by
 *   client-refcount + idle timeout. See {@link ./daemon.ts} and issue #411.
 *
 * The detached-daemon + always-proxy split is the fix for the review finding
 * that the original in-process daemon (a) was the first host's child, so closing
 * that terminal severed every other client, and (b) disabled the PPID watchdog,
 * regressing #277 (orphaned daemons on host SIGKILL).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, StdioOptions } from 'child_process';
import { findNearestCodeGraphRoot } from '../index';
import { getCodeGraphDir } from '../directory';
import { StdioTransport } from './transport';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import {
  Daemon,
  clearStaleDaemonLock,
  isProcessAlive,
  tryAcquireDaemonLock,
} from './daemon';
import { runProxy } from './proxy';
import { getDaemonSocketPath } from './daemon-paths';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';

/**
 * How often to poll `process.ppid` to detect parent process death (see #277).
 * 5s is a deliberate trade-off: the failure mode being guarded against is rare
 * (parent SIGKILL'd), and longer poll = less wakeup overhead while idle.
 */
const DEFAULT_PPID_POLL_MS = 5000;

/**
 * Env var that marks a process as the *detached daemon* itself (set by
 * {@link spawnDetachedDaemon} when it re-invokes the CLI). Without it a
 * `serve --mcp` invocation is a launcher that connects-or-spawns; with it, the
 * process IS the daemon and must never try to spawn another (infinite spawn).
 */
const DAEMON_INTERNAL_ENV = 'CODEGRAPH_DAEMON_INTERNAL';

/**
 * Retries for the detached daemon arbitrating the O_EXCL lock against a racing
 * sibling. Tiny — the lock resolves on the first round in practice; the retries
 * only cover clearing a genuinely stale (dead-pid) lockfile.
 */
const TAKEOVER_MAX_RETRIES = 5;
const TAKEOVER_RETRY_DELAY_MS = 100;

/**
 * How long a launcher waits for a freshly-spawned daemon to bind its socket
 * before giving up and running in-process. The daemon binds the socket *before*
 * the (backgrounded) engine/grammar warm-up, so this only needs to cover node
 * process startup. 60 × 100ms = 6s of headroom for a cold/slow box; on the
 * common path the socket appears within a few rounds.
 */
const DAEMON_CONNECT_MAX_RETRIES = 60;
const DAEMON_CONNECT_RETRY_DELAY_MS = 100;

/**
 * Resolve the PPID watchdog poll interval from an env override. A value of
 * `0` disables the watchdog entirely (escape hatch for embedded scenarios
 * where the parent legitimately re-parents the server on purpose). Anything
 * non-numeric or negative falls back to the default.
 */
function parsePpidPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PPID_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PPID_POLL_MS;
  if (parsed < 0) return DEFAULT_PPID_POLL_MS;
  return Math.floor(parsed);
}

/**
 * Parse the host PID propagated across the `--liftoff-only` re-exec
 * ({@link HOST_PPID_ENV}). Returns a positive integer PID, or null when
 * unset/invalid — the direct-launch path, where the watchdog falls back to
 * `process.ppid` divergence. PIDs of 0/1 are rejected (0 = unknown, 1 = init,
 * i.e. already orphaned), so the watchdog doesn't latch onto init.
 */
function parseHostPpid(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  return parsed;
}

/** Whether `CODEGRAPH_NO_DAEMON` was set to a truthy value. */
function daemonOptOutSet(): boolean {
  const raw = process.env.CODEGRAPH_NO_DAEMON;
  if (!raw) return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/** Whether this process was spawned to BE the detached daemon. */
function daemonInternalSet(): boolean {
  const raw = process.env[DAEMON_INTERNAL_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Resolve the project root the daemon machinery should key on. Returns
 * `null` when no `.codegraph/` is reachable from the candidate path — in
 * that case the caller must run in direct mode, since the daemon lockfile
 * and socket both live under `.codegraph/`.
 *
 * The result is canonicalized with `realpathSync` so every client converges on
 * the same socket/lock path regardless of how it expressed the path: a client
 * launched with cwd under a symlink (e.g. macOS `/var` → `/private/var`, where
 * spawned `process.cwd()` is already realpath'd) and one that passed a
 * symlinked `rootUri` would otherwise hash to different sockets and silently
 * fail to share the daemon.
 */
function resolveDaemonRoot(explicitPath: string | null): string | null {
  const candidate = explicitPath ?? process.cwd();
  const root = findNearestCodeGraphRoot(candidate);
  if (!root) return null;
  try { return fs.realpathSync(root); } catch { return root; }
}

/**
 * Spawn the shared daemon as a fully detached background process: its own
 * session/process group (so a SIGHUP/SIGINT to the launcher's terminal can't
 * reach it) with stdio decoupled from the launcher (logs to
 * `.codegraph/daemon.log`). Re-invokes the *same* CLI faithfully across dev and
 * bundled launches by reusing `process.argv[0]` (the right node), the current
 * `process.execArgv` (carries `--liftoff-only`, so the daemon never re-execs)
 * and `process.argv[1]` (this script). The spawned process self-arbitrates the
 * O_EXCL lock, so racing launchers may each spawn one — losers exit and every
 * launcher proxies through the single winner.
 */
function spawnDetachedDaemon(root: string): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    // No resolvable CLI entry point to re-invoke — let the caller fall back to
    // direct mode rather than spawn something broken.
    throw new Error('cannot resolve CLI script path to spawn the daemon');
  }

  let logFd: number | null = null;
  let stdio: StdioOptions = 'ignore';
  try {
    logFd = fs.openSync(path.join(getCodeGraphDir(root), 'daemon.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore'; // no log file — discard daemon output rather than fail
  }
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, scriptPath, 'serve', '--mcp', '--path', root],
      {
        detached: true,
        stdio,
        windowsHide: true,
        env: { ...process.env, [DAEMON_INTERNAL_ENV]: '1' },
      },
    );
    child.unref();
  } finally {
    // The child holds its own dup of the log fd now; the launcher doesn't need it.
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
  }
}

/**
 * MCP Server for CodeGraph
 *
 * Implements the Model Context Protocol to expose CodeGraph
 * functionality as tools that can be called by AI assistants.
 *
 * Backwards-compatible constructor and `start()` signature with the
 * pre-issue-#411 implementation: callers continue to do
 * `new MCPServer(path).start()`. Internally we now pick from direct / proxy /
 * daemon at start time.
 */
export class MCPServer {
  private projectPath: string | null;
  // Direct-mode-only state. In daemon mode the per-connection sessions live
  // inside the Daemon class; in proxy mode there is no session at all.
  private session: MCPSession | null = null;
  private engine: MCPEngine | null = null;
  private daemon: Daemon | null = null;
  private ppidWatchdog: ReturnType<typeof setInterval> | null = null;
  // PPID watchdog baseline — captured at construction so we always have a
  // baseline, even if start() runs after a fork-style reparent.
  private originalPpid: number = process.ppid;
  private hostPpid: number | null = parseHostPpid(process.env[HOST_PPID_ENV]);
  // Idempotency guard for stop().
  private stopped = false;
  private mode: 'unstarted' | 'direct' | 'proxy' | 'daemon' = 'unstarted';

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
  }

  /**
   * Start the MCP server.
   *
   * Decision order:
   *   1. `CODEGRAPH_NO_DAEMON=1` → direct mode (unchanged pre-#411 behavior).
   *   2. `CODEGRAPH_DAEMON_INTERNAL=1` → we ARE the detached daemon; listen.
   *   3. No `.codegraph/` reachable → direct mode (the daemon's lockfile and
   *      socket both live under `.codegraph/`).
   *   4. Otherwise connect to (or spawn) the shared daemon and proxy to it.
   *
   * On any unexpected failure in step 4 we transparently fall back to direct
   * mode — a misbehaving daemon must never block a session from starting.
   */
  async start(): Promise<void> {
    // The detached daemon process itself. Checked before the opt-out so the
    // daemon honors the same env it was spawned with (it never sets NO_DAEMON).
    if (daemonInternalSet()) {
      return this.startDaemonProcess();
    }

    // Direct mode if the user opted out. Setting the env var is sufficient to
    // get the pre-#411 single-process behavior.
    if (daemonOptOutSet()) {
      return this.startDirect('CODEGRAPH_NO_DAEMON set');
    }

    const root = resolveDaemonRoot(this.projectPath);
    if (!root) {
      // No initialized project found — daemon mode has nowhere to put its
      // socket. The fresh-checkout / outside-project case; behave as before.
      return this.startDirect('no .codegraph/ root found');
    }

    try {
      const mode = await this.connectOrSpawnDaemon(root);
      if (mode === 'fallback') {
        return this.startDirect('daemon unavailable; fallback to direct');
      }
      // 'proxy': connectOrSpawnDaemon ran the stdio↔socket pipe to completion
      // (it only returns once the host disconnected). The process is now
      // expected to terminate naturally — the proxy installed its own watchdog.
      this.mode = 'proxy';
      return;
    } catch (err) {
      // Belt-and-braces: if anything throws inside the daemon machinery,
      // never wedge the user — fall back to a working direct-mode session.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Daemon path failed (${msg}); falling back to direct mode.\n`);
      return this.startDirect('daemon path threw');
    }
  }

  /**
   * Stop the server. In daemon mode this triggers graceful shutdown of every
   * connected session; in direct mode it mirrors the pre-#411 behavior (close
   * cg, exit). Proxy mode never routes through here — the proxy exits itself.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ppidWatchdog) {
      clearInterval(this.ppidWatchdog);
      this.ppidWatchdog = null;
    }
    if (this.daemon) {
      void this.daemon.stop('stop()');
      // Daemon.stop calls process.exit; nothing else to do.
      return;
    }
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    if (this.engine) {
      this.engine.stop();
      this.engine = null;
    }
    process.exit(0);
  }

  /** Single-process stdio MCP session — the pre-issue-#411 code path. */
  private async startDirect(reason: string): Promise<void> {
    if (reason && process.env.CODEGRAPH_MCP_DEBUG) {
      process.stderr.write(`[CodeGraph MCP] Direct mode: ${reason}.\n`);
    }
    this.engine = new MCPEngine();
    const transport = new StdioTransport();
    this.session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.projectPath,
    });

    if (this.projectPath) {
      // Background init so the initialize response stays fast (#172).
      void this.engine.ensureInitialized(this.projectPath);
    }

    this.session.start();

    // Detect parent-process death — same logic as pre-refactor. When stdin
    // closes we go through StdioTransport's `process.exit(0)` already, but
    // SIGKILL of the parent doesn't reliably close stdin on Linux (#277).
    process.stdin.on('end', () => this.stop());
    process.stdin.on('close', () => this.stop());

    this.mode = 'direct';
    this.installSignalHandlers();
    this.installPpidWatchdog();
  }

  /**
   * Run as the detached shared daemon (process spawned with
   * `CODEGRAPH_DAEMON_INTERNAL=1`). Arbitrate the O_EXCL lock, then either
   * become the daemon (bind the socket, serve forever) or — if a live daemon
   * already holds the lock — exit so we don't leak a redundant process.
   *
   * No PPID watchdog and no stdin handlers: the daemon is detached on purpose
   * and reaps itself via client-refcount + idle timeout (see {@link Daemon}).
   */
  private async startDaemonProcess(): Promise<void> {
    const root = resolveDaemonRoot(this.projectPath) ?? this.projectPath ?? process.cwd();
    for (let attempt = 0; attempt < TAKEOVER_MAX_RETRIES; attempt++) {
      const lock = tryAcquireDaemonLock(root);

      if (lock.kind === 'acquired') {
        const daemon = new Daemon(root);
        await daemon.start();
        this.daemon = daemon;
        this.mode = 'daemon';
        return; // the net.Server keeps the process alive
      }

      // Taken. If the holder is alive, another daemon already serves (or is
      // binding) — we're redundant; exit cleanly so the launcher proxies to it.
      const existing = lock.existing;
      if (existing && existing.pid > 0 && isProcessAlive(existing.pid)) {
        process.stderr.write(
          `[CodeGraph daemon] Another daemon (pid ${existing.pid}) already holds the lock; exiting.\n`
        );
        process.exit(0);
      }

      // Holder is dead (or the record is unreadable) — clear it (pid-verified,
      // so we never delete a live daemon's lock) and retry the acquire.
      clearStaleDaemonLock(lock.pidPath, existing?.pid);
      await sleep(TAKEOVER_RETRY_DELAY_MS);
    }

    process.stderr.write('[CodeGraph daemon] Could not acquire the daemon lock; exiting.\n');
    process.exit(0);
  }

  /**
   * Become a proxy to the shared daemon, spawning the daemon first if none is
   * reachable. Returns 'proxy' once the proxied session has run to completion
   * (the host disconnected), or 'fallback' if the caller should run in-process.
   */
  private async connectOrSpawnDaemon(root: string): Promise<'proxy' | 'fallback'> {
    const socketPath = getDaemonSocketPath(root);

    // Fast path: a daemon may already be listening. On success runProxy pipes
    // stdio until the host disconnects, so a 'proxied' outcome means this
    // process has finished its entire job.
    let probe = await runProxy(socketPath);
    if (probe.outcome === 'proxied') return 'proxy';
    if (probe.reason === 'version mismatch') return 'fallback';

    // No reachable daemon — spawn one (detached) and wait for it to bind.
    spawnDetachedDaemon(root);

    for (let attempt = 0; attempt < DAEMON_CONNECT_MAX_RETRIES; attempt++) {
      await sleep(DAEMON_CONNECT_RETRY_DELAY_MS);
      probe = await runProxy(socketPath);
      if (probe.outcome === 'proxied') return 'proxy';
      if (probe.reason === 'version mismatch') return 'fallback';
    }

    // Daemon never came up in time — run in-process so the user is never blocked.
    return 'fallback';
  }

  /** Standard SIGINT/SIGTERM handlers that route to our `stop()` (direct mode). */
  private installSignalHandlers(): void {
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * PPID watchdog (#277) — direct mode only. Daemon mode is detached on purpose
   * and reaps via idle timeout; proxy mode installs its own watchdog inside
   * {@link runProxy}. So this only ever runs for an in-process direct session.
   */
  private installPpidWatchdog(): void {
    if (this.mode !== 'direct') return;
    const pollMs = parsePpidPollMs(process.env.CODEGRAPH_PPID_POLL_MS);
    if (pollMs <= 0) return;
    this.ppidWatchdog = setInterval(() => {
      const current = process.ppid;
      const ppidChanged = current !== this.originalPpid;
      const hostGone = this.hostPpid !== null && !isProcessAlive(this.hostPpid);
      if (ppidChanged || hostGone) {
        const reason = ppidChanged
          ? `ppid ${this.originalPpid} -> ${current}`
          : `host pid ${this.hostPpid} exited`;
        process.stderr.write(
          `[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`
        );
        this.stop();
      }
    }, pollMs);
    this.ppidWatchdog.unref();
  }
}

function sleep(ms: number): Promise<void> {
  // Deliberately NOT unref'd. During the daemon connect/takeover retry loop we
  // may be between processes — no socket bound yet, no transport, no listener
  // pinning the event loop. An unref'd timer would let Node drain the loop and
  // exit silently before we get a chance to try again.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
// Surface a few daemon-mode bits for tests + diagnostics.
export { Daemon } from './daemon';
export { CodeGraphPackageVersion } from './version';
