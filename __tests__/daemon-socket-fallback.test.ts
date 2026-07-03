/**
 * Daemon support on socket-incapable filesystems — issue #997 (and the adjacent
 * #974 WSL2 DrvFs hazard).
 *
 * A project on an ExFAT/FAT external volume (or some network mounts / WSL2 DrvFs)
 * breaks the daemon at TWO points, BOTH surfacing as ENOTSUP (verified on a real
 * macOS fskit ExFAT volume):
 *
 *   1. Lock acquisition `link()`s a temp file onto `.codegraph/daemon.pid` for
 *      race-free exclusivity (#411). ExFAT has no hard links, so this throws
 *      first — before the socket is ever reached. The fix falls back to an
 *      O_EXCL create (`acquireLockViaExclusiveOpen`).
 *   2. The socket `listen()` then throws ENOTSUP regardless of path length, so
 *      the old length-only tmpdir fallback never triggered. The fix makes the
 *      socket path an ORDERED candidate list (in-project, then a deterministic
 *      tmpdir path); the daemon binds the first that works and the proxy connects
 *      the first that answers, so both converge on the fallback with zero
 *      coordination.
 *
 * Both failures report a DIFFERENT errno per OS — ENOTSUP (macOS), EPERM (Linux),
 * EISDIR (Windows) — so the fix deliberately does NOT gate on an enumerated set:
 * the lock falls back on ANY non-EEXIST link error, the socket relocates on ANY
 * non-EADDRINUSE bind error. These tests pin that policy (incl. a deliberately
 * unanticipated errno), the candidate list, the candidate-walk binder, and the
 * exclusive-open lock primitive. (Throwaway scripts drove the full daemon end-to-
 * end on a real macOS ExFAT image, a Linux FAT loopback mount, and a Windows
 * exFAT VHD — relocate, serve a real client, rewrite the pidfile — none of which
 * can run in CI.)
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  getDaemonPidPath,
  getDaemonSocketCandidates,
  getDaemonSocketPath,
} from '../src/mcp/daemon-paths';
import type { DaemonLockInfo } from '../src/mcp/daemon-paths';
import { decodeLockInfo } from '../src/mcp/daemon-paths';
import {
  acquireLockViaExclusiveOpen,
  bindFirstUsableSocket,
  tryAcquireDaemonLock,
} from '../src/mcp/daemon';

const POSIX = process.platform !== 'win32';

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpFiles.length) {
    try { fs.rmSync(tmpFiles.pop()!, { force: true }); } catch { /* best-effort */ }
  }
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** A stand-in net.Server — bindFirstUsableSocket only ever passes it through. */
const fakeServer = (tag: string): net.Server => ({ tag } as unknown as net.Server);

/** Build an ErrnoException carrying a specific code, like a real listen() error. */
function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`listen ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('getDaemonSocketCandidates (#997)', () => {
  it.runIf(POSIX)('returns [in-project, tmpdir] for a normal short path', () => {
    const root = path.join(os.tmpdir(), 'cg-cand-short');
    const candidates = getDaemonSocketCandidates(root);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(path.join(root, '.codegraph', 'daemon.sock'));
    expect(candidates[1]!.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(candidates[1]!)).toMatch(/^codegraph-[0-9a-f]{16}\.sock$/);
  });

  it.runIf(POSIX)('drops straight to [tmpdir] when the in-project path is too long', () => {
    // A deep root pushes `.codegraph/daemon.sock` past the POSIX socket limit.
    const root = path.join('/tmp', 'x'.repeat(120));
    const candidates = getDaemonSocketCandidates(root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startsWith(os.tmpdir())).toBe(true);
  });

  it.runIf(POSIX)('is deterministic and project-scoped: same root → same tmpdir fallback', () => {
    const root = path.join(os.tmpdir(), 'cg-cand-determinism');
    const a = getDaemonSocketCandidates(root);
    const b = getDaemonSocketCandidates(root);
    expect(a).toEqual(b);
    // A different root yields a different (hashed) tmpdir fallback.
    const other = getDaemonSocketCandidates(root + '-other');
    expect(other[other.length - 1]).not.toBe(a[a.length - 1]);
  });

  it.runIf(!POSIX)('returns a single named pipe on Windows', () => {
    const candidates = getDaemonSocketCandidates('C:/dev/proj');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startsWith('\\\\.\\pipe\\codegraph-')).toBe(true);
  });

  it('getDaemonSocketPath returns the preferred candidate (index 0)', () => {
    const root = path.join(os.tmpdir(), 'cg-cand-primary');
    expect(getDaemonSocketPath(root)).toBe(getDaemonSocketCandidates(root)[0]);
  });
});

describe('bindFirstUsableSocket (#997)', () => {
  it('binds the first candidate when it works, without relocating', async () => {
    const tried: string[] = [];
    const relocations: string[] = [];
    const result = await bindFirstUsableSocket(
      ['/proj/.codegraph/daemon.sock', '/tmp/fallback.sock'],
      (p) => { tried.push(p); return Promise.resolve(fakeServer(p)); },
      { onRelocate: (from, to) => relocations.push(`${from}->${to}`) },
    );
    expect(result.socketPath).toBe('/proj/.codegraph/daemon.sock');
    expect(tried).toEqual(['/proj/.codegraph/daemon.sock']); // never touched the fallback
    expect(relocations).toEqual([]);
  });

  it('relocates to the tmpdir fallback when the in-project bind throws ENOTSUP', async () => {
    const tried: string[] = [];
    const relocations: Array<[string, string, string]> = [];
    const result = await bindFirstUsableSocket(
      ['/exfat/proj/.codegraph/daemon.sock', '/tmp/fallback.sock'],
      (p) => {
        tried.push(p);
        if (p.includes('/exfat/')) return Promise.reject(errno('ENOTSUP'));
        return Promise.resolve(fakeServer(p));
      },
      { onRelocate: (from, to, code) => relocations.push([from, to, code]) },
    );
    expect(result.socketPath).toBe('/tmp/fallback.sock');
    expect(tried).toEqual(['/exfat/proj/.codegraph/daemon.sock', '/tmp/fallback.sock']);
    expect(relocations).toEqual([
      ['/exfat/proj/.codegraph/daemon.sock', '/tmp/fallback.sock', 'ENOTSUP'],
    ]);
  });

  it('does NOT relocate on EADDRINUSE — it propagates even with a fallback present', async () => {
    const tried: string[] = [];
    await expect(
      bindFirstUsableSocket(
        ['/proj/.codegraph/daemon.sock', '/tmp/fallback.sock'],
        (p) => { tried.push(p); return Promise.reject(errno('EADDRINUSE')); },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(tried).toEqual(['/proj/.codegraph/daemon.sock']); // fallback never tried
  });

  it('propagates a capability error on the LAST candidate (nowhere left to go)', async () => {
    // When tmpdir itself can't host a socket, the single-candidate long-path list
    // (or the exhausted tail of a longer one) has no fallback — the daemon must
    // surface the error so the launcher drops to direct mode (#974).
    await expect(
      bindFirstUsableSocket(
        ['/tmp/only.sock'],
        () => Promise.reject(errno('ENOTSUP')),
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' });
  });

  it('walks past multiple unusable candidates to the first that binds', async () => {
    const tried: string[] = [];
    const result = await bindFirstUsableSocket(
      ['/a.sock', '/b.sock', '/c.sock'],
      (p) => {
        tried.push(p);
        if (p === '/a.sock') return Promise.reject(errno('ENOTSUP'));
        if (p === '/b.sock') return Promise.reject(errno('EACCES'));
        return Promise.resolve(fakeServer(p));
      },
    );
    expect(result.socketPath).toBe('/c.sock');
    expect(tried).toEqual(['/a.sock', '/b.sock', '/c.sock']);
  });

  it('relocates on an UNEXPECTED errno too — the policy is "anything but EADDRINUSE", not a fixed list', async () => {
    // ExFAT/FAT report different bind errnos per OS (ENOTSUP macOS, EPERM Linux),
    // so we must NOT gate relocation on an enumerated set — a code we never
    // anticipated must still fall through to tmpdir. 'EWEIRD' stands in for any
    // such surprise.
    const result = await bindFirstUsableSocket(
      ['/odd/proj/.codegraph/daemon.sock', '/tmp/fallback.sock'],
      (p) => p.includes('/odd/') ? Promise.reject(errno('EWEIRD')) : Promise.resolve(fakeServer(p)),
    );
    expect(result.socketPath).toBe('/tmp/fallback.sock');
  });
});

describe('lock acquisition without hard links (#997)', () => {
  // The hard-link-FAILS path (link() → O_EXCL fallback) can't be forced on a
  // normal FS — fs.linkSync's namespace export is non-configurable, so it can't
  // be spied. It's proven instead end-to-end on real ExFAT/FAT/exFAT volumes
  // (macOS ENOTSUP, Linux EPERM, Windows EISDIR — all acquire via the fallback).
  // Here we just guard that the refactored catch block didn't break the normal
  // link path: a clean acquire, and a second caller correctly sees it held.
  it.runIf(POSIX)('tryAcquireDaemonLock still acquires on a normal FS, and a second caller is told it is taken', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-'));
    tmpDirs.push(root);

    const first = tryAcquireDaemonLock(root);
    expect(first.kind).toBe('acquired');
    const pidPath = getDaemonPidPath(root);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(decodeLockInfo(fs.readFileSync(pidPath, 'utf8'))?.pid).toBe(process.pid);

    const second = tryAcquireDaemonLock(root); // link() → EEXIST → taken
    expect(second.kind).toBe('taken');
    if (second.kind === 'taken') expect(second.existing?.pid).toBe(process.pid);
  });

  it.runIf(POSIX)('acquireLockViaExclusiveOpen creates the pidfile with a complete, parseable record', () => {
    const pidPath = path.join(os.tmpdir(), `cg-excl-${process.pid}-${Date.now()}.pid`);
    tmpFiles.push(pidPath);
    const info: DaemonLockInfo = {
      pid: 4242,
      version: '9.9.9-test',
      socketPath: '/tmp/whatever.sock',
      startedAt: 1_700_000_000_000,
    };

    const acquired = acquireLockViaExclusiveOpen(pidPath, info);
    expect(acquired).toBe(true);
    // The file is non-empty and decodes back to exactly what we wrote — i.e. no
    // empty-file window left behind for a reader to mistake for a corrupt lock.
    expect(decodeLockInfo(fs.readFileSync(pidPath, 'utf8'))).toEqual(info);
  });

  it.runIf(POSIX)('acquireLockViaExclusiveOpen is exclusive: the second caller loses (EEXIST → false)', () => {
    const pidPath = path.join(os.tmpdir(), `cg-excl2-${process.pid}-${Date.now()}.pid`);
    tmpFiles.push(pidPath);
    const winner: DaemonLockInfo = { pid: 1, version: 'a', socketPath: '/s1', startedAt: 1 };
    const loser: DaemonLockInfo = { pid: 2, version: 'b', socketPath: '/s2', startedAt: 2 };

    expect(acquireLockViaExclusiveOpen(pidPath, winner)).toBe(true);
    expect(acquireLockViaExclusiveOpen(pidPath, loser)).toBe(false); // does not clobber
    // The winner's record is intact — the loser never overwrote it.
    expect(decodeLockInfo(fs.readFileSync(pidPath, 'utf8'))).toEqual(winner);
  });
});
