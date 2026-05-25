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
 * Three runtime modes (decided in {@link MCPServer.start}):
 *
 * - **Direct** — one process serves one MCP client over stdio. Today's
 *   behavior; used when no shareable daemon is reachable or the user opted
 *   out via `CODEGRAPH_NO_DAEMON=1`.
 * - **Daemon** — accept N concurrent MCP clients over a Unix-domain socket /
 *   named pipe, sharing one CodeGraph + watcher + SQLite handle. See
 *   {@link ./daemon.ts} and issue #411 for the rationale.
 * - **Proxy** — pure stdio↔socket pipe to an existing daemon. See
 *   {@link ./proxy.ts}.
 */

import { findNearestCodeGraphRoot } from '../index';
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
 * Max retries when a stale-lock takeover races other candidates. After this
 * many failed acquire+probe rounds we give up and fall back to direct mode —
 * something is wedged enough that adding our own daemon to the mix would only
 * make it worse.
 */
const TAKEOVER_MAX_RETRIES = 3;

/**
 * Brief sleep between takeover retries so a freshly-spawned daemon has time
 * to bind its socket. 100ms is well under any realistic startup, so a
 * legitimate races resolves on the first or second retry.
 */
const TAKEOVER_RETRY_DELAY_MS = 100;

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

/**
 * Resolve the project root the daemon machinery should key on. Returns
 * `null` when no `.codegraph/` is reachable from the candidate path — in
 * that case the caller must run in direct mode, since the daemon lockfile
 * and socket both live under `.codegraph/`.
 */
function resolveDaemonRoot(explicitPath: string | null): string | null {
  const candidate = explicitPath ?? process.cwd();
  return findNearestCodeGraphRoot(candidate);
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
  // Direct-mode-only state. In daemon mode the per-connection session lives
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
   *   1. If `CODEGRAPH_NO_DAEMON=1` → direct mode (unchanged behavior).
   *   2. If no `.codegraph/` reachable → direct mode (daemon needs a lockfile
   *      and socket location, which both live under `.codegraph/`).
   *   3. Try to attach to an existing daemon as a proxy.
   *   4. Otherwise become the daemon ourselves.
   *
   * On any unexpected failure in steps 3–4 we transparently fall back to
   * direct mode — a misbehaving daemon must never block a session from
   * starting.
   */
  async start(): Promise<void> {
    // Direct mode if the user opted out. Done first so debugging is simple:
    // setting the env var is sufficient to get the pre-#411 behavior.
    if (daemonOptOutSet()) {
      return this.startDirect('CODEGRAPH_NO_DAEMON set');
    }

    const root = resolveDaemonRoot(this.projectPath);
    if (!root) {
      // No initialized project found — daemon mode has nowhere to put its
      // socket. This is the fresh-checkout / outside-project case; behave
      // exactly as before.
      return this.startDirect('no .codegraph/ root found');
    }

    // Try the daemon attach/spawn dance.
    try {
      const mode = await this.startDaemonOrProxy(root);
      if (mode === 'fallback') {
        return this.startDirect('daemon attach/start failed; fallback to direct');
      }
      this.mode = mode;
      this.installSignalHandlers();
      this.installPpidWatchdog();
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
   * connected session; in proxy mode the proxy's own resolve handler exits
   * the process and `stop()` is a no-op; in direct mode this mirrors the
   * pre-#411 behavior (close cg, exit).
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
   * Try to attach as proxy or start as daemon. Returns 'proxy' / 'daemon' on
   * success, 'fallback' if the caller should retry in direct mode.
   */
  private async startDaemonOrProxy(root: string): Promise<'proxy' | 'daemon' | 'fallback'> {
    for (let attempt = 0; attempt < TAKEOVER_MAX_RETRIES; attempt++) {
      const lock = tryAcquireDaemonLock(root);

      if (lock.kind === 'acquired') {
        const daemon = new Daemon(root, { lockFd: lock.lockFd });
        await daemon.start();
        // The MCP host launched us over stdio and is waiting for our
        // `initialize` response — attach it as the daemon's first session
        // so we never silently drop the launcher. Subsequent invocations
        // discover us via the socket and proxy in.
        daemon.attachStdioLauncherSession();
        this.daemon = daemon;
        return 'daemon';
      }

      // Lock is taken — that *should* mean a daemon is alive. Probe.
      const socketPath = lock.existing?.socketPath || getDaemonSocketPath(root);
      const probe = await runProxy(socketPath);
      if (probe.outcome === 'proxied') {
        // runProxy only returns when the connection has CLOSED — meaning we
        // already piped stdio and are now exiting. From here we should not
        // start anything else. The process is expected to terminate
        // naturally after this function returns.
        return 'proxy';
      }

      // Proxy didn't attach. Possible causes:
      //   (a) Daemon is mid-startup and hasn't bound the socket yet — retry.
      //   (b) Daemon crashed but lockfile leaked — clear it and retry.
      //   (c) Daemon is alive but version-mismatched — fall back to direct.
      if (probe.reason === 'version mismatch') {
        return 'fallback';
      }

      if (lock.existing && lock.existing.pid > 0 && isProcessAlive(lock.existing.pid)) {
        // Daemon process is alive but its socket isn't accepting — probably
        // (a). Sleep briefly and try again.
        await sleep(TAKEOVER_RETRY_DELAY_MS);
        continue;
      }

      // Dead pid (or unreadable lockfile): clear it and retry. If we lose
      // the next race to another candidate, that's fine — they'll be the
      // new daemon and we'll proxy through them.
      clearStaleDaemonLock(lock.pidPath);
      await sleep(TAKEOVER_RETRY_DELAY_MS);
    }

    // Repeated failures — something is very wrong (perms?). Direct mode it is.
    return 'fallback';
  }

  /** Standard SIGINT/SIGTERM handlers that route to our `stop()`. */
  private installSignalHandlers(): void {
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * PPID watchdog. The daemon mode owns its own lifecycle (idle timeout +
   * client refcount), so we deliberately do NOT enable the PPID watchdog
   * there — otherwise the very first proxy that spawned the daemon would
   * drag it down when it exited. Direct mode and proxy mode both enable it.
   */
  private installPpidWatchdog(): void {
    if (this.mode === 'daemon') return;
    if (this.mode === 'proxy') return; // proxy.ts installs its own.
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
  // Deliberately NOT unref'd. During the daemon takeover retry loop we may
  // be between processes — no socket bound yet, no transport, no listener
  // pinning the event loop. An unref'd timer would let Node drain the loop
  // and exit silently before we get a chance to try again.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
// Surface a few daemon-mode bits for tests + diagnostics.
export { Daemon } from './daemon';
export { CodeGraphPackageVersion } from './version';
