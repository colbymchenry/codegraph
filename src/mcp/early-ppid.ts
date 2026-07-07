/**
 * Parent-pid baseline captured as early as possible in process life (#1185).
 *
 * The PPID watchdog's POSIX signal is "`process.ppid` CHANGED since startup" —
 * but a launcher killed within the first ~100ms of our boot (an MCP host's
 * config probe, an instant user cancel, an initialize-timeout teardown) can
 * reparent this process to init BEFORE the serve/proxy code captured its
 * baseline. The baseline then reads `1`, never diverges, and the watchdog is
 * permanently blind — the orphaned-server accumulation reported in #1185.
 * Reproduced on macOS: SIGKILL the launcher 50ms after spawn while the host
 * holds the stdio pipes open, and the server survived indefinitely; at 150ms
 * the old capture had already run and the watchdog reaped it.
 *
 * The CLI entry imports this module before anything else, so the capture runs
 * within the first few ms of JS execution — the earliest a Node process can
 * observe its parent. A kill landing in the remaining pre-JS window (process
 * spawn → first require) still captures `1`; that residual case is covered by
 * the startup-handshake timeout (see ./startup-handshake.ts), which reaps a
 * server that never receives any MCP traffic.
 *
 * Library consumers don't load the CLI entry; for them the capture runs at
 * first import of the MCP layer — no worse than the previous per-call-site
 * capture, and identical once the module cache warms.
 */
export const EARLY_PPID: number = process.ppid;
