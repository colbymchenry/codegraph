/**
 * Treat a failed stdout as a shutdown signal — issue #2991.
 *
 * A host can stop reading an MCP stdio server's output while it keeps the
 * server's stdin open and stays alive itself. The next response the server
 * writes then fails (EPIPE on a pipe, ECONNRESET on a socket), and with no
 * `'error'` listener on stdout Node hands it to the last-resort fatal handler,
 * which exits 1 at once (`src/bin/fatal-handler.ts`). That skips the
 * shutdown that stops the engine, releases the writer lock and waits for query
 * workers still starting (a process that exits under one of those can crash
 * on Windows). Nothing else notices this failure: stdin is still open, the
 * host's PID is alive and the event loop is healthy, so the stdin teardown
 * (#799), the PPID watchdog and the liveness watchdog all stay quiet.
 *
 * So listen for `'error'`, and for the `'close'` that follows a failed stream,
 * destroy stdout so later writes are dropped, and run the owner's shutdown,
 * at most once. The listener stays attached: a write queued before the
 * failure can still fail while the shutdown runs. A `write()` that returns
 * false is backpressure, not failure, and is left alone. A reader that goes
 * away while the server is silent is noticed at its next write.
 *
 * The twin of {@link treatStdinFailureAsShutdown} (`stdin-teardown.ts`).
 * `stream` is injectable for tests; it defaults to `process.stdout`.
 */
export function treatStdoutFailureAsShutdown(
  onTerminal: () => void,
  stream: NodeJS.WritableStream = process.stdout
): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    try {
      (stream as Partial<{ destroy(): void }>).destroy?.();
    } catch {
      /* already gone */
    }
    onTerminal();
  };
  stream.on('error', fire);
  stream.on('close', fire);
}
