/**
 * Treat a stdin failure as a shutdown signal — issue #799.
 *
 * An MCP stdio server's lifeline is its stdin: when the host/client goes away,
 * stdin should end and the server should exit. The server paths listened for
 * `'end'` and `'close'` — but NOT `'error'`.
 *
 * That gap bites with a socket-backed stdin, which is the shape VS Code /
 * Claude Code use (a socketpair, not a pipe). When the client dies, the socket
 * can surface as an `'error'` (ECONNRESET / hangup) rather than a clean
 * `'close'`. With no `'error'` listener, Node escalates it to the process-wide
 * `uncaughtException` handler, which logs and keeps running — so the server
 * orphans instead of exiting. Worse, on Linux a `POLLHUP` socket fd left
 * registered in epoll wakes the event loop continuously, pinning a core at
 * 100% CPU (the spin reported in #799); once the main thread spins, the
 * `setInterval` PPID watchdog can't even fire, so the orphan runs forever.
 *
 * Fix: listen for `'error'` as well, and DESTROY the stdin stream on any
 * terminal event so the fd leaves epoll and can't keep churning, then run the
 * caller's shutdown. Fires `onTerminal` at most once — callers' shutdowns are
 * already re-entry-guarded, but the single-shot guard also keeps `destroy()`'s
 * follow-on `'close'` from re-invoking it.
 *
 * `stream` is injectable for tests; it defaults to `process.stdin`.
 */
export function treatStdinFailureAsShutdown(
  onTerminal: () => void,
  stream: NodeJS.ReadableStream = process.stdin
): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    // Drop the fd from epoll so a hung/half-closed socket can't keep waking
    // the loop. Best-effort: the stream may already be torn down.
    try {
      (stream as Partial<{ destroy(): void }>).destroy?.();
    } catch {
      /* already gone */
    }
    onTerminal();
  };
  stream.on('end', fire);
  stream.on('close', fire);
  stream.on('error', fire);
}
