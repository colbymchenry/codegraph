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

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Daemon, tryAcquireDaemonLock } from '../src/mcp/daemon';
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
