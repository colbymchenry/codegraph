/**
 * Process supervision for long-running CLI commands (`index` / `init --index`).
 *
 * Indexing a large repo can run for a while on the main thread, and #999
 * surfaced two ways that goes wrong when nothing is watching it:
 *
 *   1. **Orphaned worker.** `index` runs in a child re-exec'd with
 *      `--liftoff-only` (the WASM-flag relaunch). Its parent blocks in
 *      `spawnSync`, so when the parent shim is killed it cannot forward the
 *      signal — the child keeps running, now orphaned, pinning a core. The PPID
 *      watchdog (#277) notices the parent/host went away and exits the child.
 *   2. **Wedged indexer.** The `#850` main-thread liveness watchdog — which
 *      SIGKILLs a process whose event loop stops turning — was wired only into
 *      the MCP `serve` path, so a wedged `index`/`init` was never auto-killed.
 *
 * Both reuse the exact mechanisms `serve` already uses; this just makes them
 * available to a one-shot command. Best-effort and self-disabling: a missing
 * watchdog never blocks the command from running. Both honour the same env
 * switches as `serve` (`CODEGRAPH_NO_WATCHDOG`, `CODEGRAPH_PPID_POLL_MS=0`).
 */
import { installMainThreadWatchdog } from '../mcp/liveness-watchdog';
import { supervisionLostReason, parsePpidPollMs, parseHostPpid } from '../mcp/ppid-watchdog';
import { isProcessAlive } from '../mcp/daemon-registry';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';

export interface CommandSupervision {
  /** Tear down both watchdogs. Idempotent; call when the command finishes. */
  stop(): void;
}

/**
 * Install the liveness + PPID watchdogs for the duration of a CLI command.
 * `label` is used in the shutdown notice (e.g. `"index"`). Returns a handle
 * whose `stop()` must be called when the command completes so neither watchdog
 * outlives it.
 */
export function installCommandSupervision(label: string): CommandSupervision {
  // Liveness watchdog: a separate process that SIGKILLs us if our event loop
  // stops turning for too long (a wedged synchronous loop). Self-disables on
  // CODEGRAPH_NO_WATCHDOG.
  const liveness = installMainThreadWatchdog();

  // PPID watchdog: detect that the parent (or the host threaded past the
  // relaunch shim) died and we've been orphaned, then exit instead of leaking.
  const originalPpid = process.ppid;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const pollMs = parsePpidPollMs(process.env.CODEGRAPH_PPID_POLL_MS);
  let ppidTimer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    ppidTimer = setInterval(() => {
      const reason = supervisionLostReason({
        originalPpid,
        currentPpid: process.ppid,
        hostPpid,
        isAlive: isProcessAlive,
      });
      if (reason) {
        try {
          process.stderr.write(`[CodeGraph ${label}] Parent process exited (${reason}); aborting.\n`);
        } catch { /* stderr gone with the parent — exit anyway */ }
        process.exit(1);
      }
    }, pollMs);
    // Never let the watchdog itself keep the process alive past its real work.
    ppidTimer.unref();
  }

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (ppidTimer) clearInterval(ppidTimer);
      liveness?.stop();
    },
  };
}
