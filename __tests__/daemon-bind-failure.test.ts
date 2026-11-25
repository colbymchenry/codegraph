/**
 * Daemon bind-failure cleanup — issue #974.
 *
 * A detached daemon acquires the `.codegraph/daemon.pid` lock (via
 * `tryAcquireDaemonLock`) BEFORE it binds its socket. If the bind then fails —
 * e.g. AF_UNIX is unsupported/unreliable on the filesystem (the WSL2 DrvFs
 * hazard behind #974) — `Daemon.start()` must release that lockfile before it
 * propagates the error and exits. Otherwise the next launcher reads a stale lock
 * pointing at the now-dead pid and the process pileup the issue reported recurs.
 *
 * We force a deterministic bind failure by planting a *directory* at the socket
 * path: `unlinkSync` (the daemon's stale-socket clear) can't remove a directory,
 * so it survives and `listen()` fails with EADDRINUSE.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Daemon, tryAcquireDaemonLock, finalizeDaemonExit } from '../src/mcp/daemon';
import { getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';

const tmpRoots: string[] = [];
afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()!;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('Daemon.start() bind failure (#974)', () => {
  it.runIf(process.platform !== 'win32')('releases the lockfile it acquired when the socket cannot bind', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bind-'));
    tmpRoots.push(root);

    // Acquire the lock exactly as the detached-daemon startup does.
    const lock = tryAcquireDaemonLock(root);
    expect(lock.kind).toBe('acquired');
    const pidPath = getDaemonPidPath(root);
    expect(fs.existsSync(pidPath)).toBe(true);

    // Make the socket path un-bindable: a directory can't be unlink'd by the
    // daemon's stale-socket clear, and listen() on it fails with EADDRINUSE.
    const sockPath = getDaemonSocketPath(root);
    fs.mkdirSync(sockPath, { recursive: true });
    // The tmpdir-fallback socket path can live outside `root`; clean it too.
    tmpRoots.push(sockPath);

    const daemon = new Daemon(root);
    await expect(daemon.start()).rejects.toThrow();

    // The lockfile must be gone so the next launcher doesn't spin on a stale lock.
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});

/**
 * Windows shutdown must not force `process.exit()` while the recursive file
 * watcher is still tearing down — that aborts the daemon with a libuv
 * `UV_HANDLE_CLOSING` assertion (0xC0000409), reproducible when the indexed tree
 * contains a nested repo. `finalizeDaemonExit` drains on Windows and exits
 * immediately elsewhere; both branches are exercised here by injecting the
 * platform + exit fn (so it runs on any host).
 */
describe('finalizeDaemonExit — Windows drains instead of aborting mid-watcher-close', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`exits immediately on ${platform}`, () => {
      const exit = vi.fn();
      const backstop = finalizeDaemonExit(platform, exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(backstop).toBeNull();
    });
  }

  it('on win32 defers exit (lets the loop drain), then force-exits via an unref\'d backstop', () => {
    vi.useFakeTimers();
    const prevExitCode = process.exitCode;
    const exit = vi.fn();
    try {
      const backstop = finalizeDaemonExit('win32', exit);
      // No synchronous exit — the process must drain its closing watch handles first.
      expect(exit).not.toHaveBeenCalled();
      expect(backstop).not.toBeNull();
      // Success code is set so a natural drain exits 0.
      expect(process.exitCode).toBe(0);
      // If a stray handle keeps the loop alive, the backstop still forces exit.
      vi.advanceTimersByTime(2_000);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
      process.exitCode = prevExitCode; // don't leak a 0 exit code into the runner
    }
  });
});
