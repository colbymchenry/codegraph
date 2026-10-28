/**
 * A stdio client may close its response pipe while keeping stdin and its host
 * process alive. PPID, stdin and main-thread watchdogs cannot see that failure.
 * Route stdout's asynchronous write errors / close through the owner's normal
 * shutdown, so it can release its engine or detach from the shared daemon.
 *
 * This observes stream failure, not inactivity. An anonymous pipe whose reader
 * closed silently is only detected when the next response is written. A false
 * write() return / 'drain' is ordinary backpressure, never a shutdown signal.
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
  // Keep the error handler after the first failure: a queued write can still
  // report another error during graceful shutdown, and must not escape it.
  stream.on('error', fire);
  stream.on('close', fire);
}
