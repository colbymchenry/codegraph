/**
 * Unit coverage for the PPID-watchdog decision logic (#277, #692).
 *
 * The live watchdog timers in `proxy.ts` / `index.ts` are integration-tested on
 * POSIX in `mcp-ppid-watchdog.test.ts`, but that test is skipped on Windows
 * (`process.kill(pid, 'SIGKILL')` and reparenting are POSIX-specific). That gap
 * is exactly how the Windows leak (#692) shipped: on Windows `process.ppid`
 * never changes when the parent dies, so the old change-only check could never
 * fire. These pure-function tests exercise the Windows branch on any OS by
 * stubbing `isAlive` and `platform`.
 */
import { describe, it, expect } from 'vitest';
import { supervisionLostReason, parsePpidPollMs, parseHostPpid, DEFAULT_PPID_POLL_MS } from '../src/mcp/ppid-watchdog';

const alive = () => true;
const dead = () => false;
/** Alive for everyone except the listed pids. */
const deadOnly = (...pids: number[]) => (pid: number) => !pids.includes(pid);

describe('supervisionLostReason', () => {
  describe('POSIX (parent death reparents → ppid changes)', () => {
    it('returns null while the parent is unchanged', () => {
      expect(
        supervisionLostReason({
          originalPpid: 100,
          currentPpid: 100,
          hostPpid: null,
          isAlive: alive,
          platform: 'linux',
        }),
      ).toBeNull();
    });

    it('detects a reparent (ppid divergence) as the death signal', () => {
      const reason = supervisionLostReason({
        originalPpid: 100,
        currentPpid: 1, // reparented to init
        hostPpid: null,
        isAlive: alive,
        platform: 'linux',
      });
      expect(reason).toBe('ppid 100 -> 1');
    });

    it('does NOT use liveness on POSIX — a dead original ppid is not orphaning', () => {
      // A double-forked grandparent can die while we stay correctly parented.
      // POSIX must rely on the change-check only, or it would false-positive.
      expect(
        supervisionLostReason({
          originalPpid: 100,
          currentPpid: 100,
          hostPpid: null,
          isAlive: dead,
          platform: 'linux',
        }),
      ).toBeNull();
    });
  });

  describe('Windows (ppid is stable across parent death → poll liveness)', () => {
    it('returns null while the original parent is still alive', () => {
      expect(
        supervisionLostReason({
          originalPpid: 100,
          currentPpid: 100,
          hostPpid: null,
          isAlive: alive,
          platform: 'win32',
        }),
      ).toBeNull();
    });

    it('detects parent death by liveness even though ppid is unchanged (the #692 fix)', () => {
      const reason = supervisionLostReason({
        originalPpid: 100,
        currentPpid: 100, // Windows never reparents
        hostPpid: null,
        isAlive: deadOnly(100),
        platform: 'win32',
      });
      expect(reason).toBe('parent pid 100 exited');
    });

    it('ignores pid 0/1 — never a real Windows parent, must not trigger shutdown', () => {
      for (const ppid of [0, 1]) {
        expect(
          supervisionLostReason({
            originalPpid: ppid,
            currentPpid: ppid,
            hostPpid: null,
            isAlive: dead,
            platform: 'win32',
          }),
        ).toBeNull();
      }
    });
  });

  describe('threaded host pid (reached past an intermediate launcher shim)', () => {
    it('shuts down when the host pid is gone, on either platform', () => {
      for (const platform of ['linux', 'win32'] as const) {
        const reason = supervisionLostReason({
          originalPpid: 100,
          currentPpid: 100,
          hostPpid: 42,
          isAlive: deadOnly(42), // shim 100 alive, host 42 dead
          platform,
        });
        expect(reason).toBe('host pid 42 exited');
      }
    });

    it('stays supervised while the host pid is alive', () => {
      expect(
        supervisionLostReason({
          originalPpid: 100,
          currentPpid: 100,
          hostPpid: 42,
          isAlive: alive,
          platform: 'linux',
        }),
      ).toBeNull();
    });
  });

  describe('signal precedence', () => {
    it('reports the ppid change ahead of a host-gone reason', () => {
      const reason = supervisionLostReason({
        originalPpid: 100,
        currentPpid: 1,
        hostPpid: 42,
        isAlive: dead,
        platform: 'linux',
      });
      expect(reason).toBe('ppid 100 -> 1');
    });
  });
});

describe('parsePpidPollMs', () => {
  it('defaults when unset / empty / non-numeric / negative', () => {
    expect(parsePpidPollMs(undefined)).toBe(DEFAULT_PPID_POLL_MS);
    expect(parsePpidPollMs('')).toBe(DEFAULT_PPID_POLL_MS);
    expect(parsePpidPollMs('abc')).toBe(DEFAULT_PPID_POLL_MS);
    expect(parsePpidPollMs('-5')).toBe(DEFAULT_PPID_POLL_MS);
  });
  it('honours a positive override and floors it', () => {
    expect(parsePpidPollMs('200')).toBe(200);
    expect(parsePpidPollMs('150.9')).toBe(150);
  });
  it('treats 0 as the explicit "disable" sentinel (caller skips the timer)', () => {
    expect(parsePpidPollMs('0')).toBe(0);
  });
});

describe('parseHostPpid', () => {
  it('returns null for unset / empty / non-integer / orphan-sentinel pids', () => {
    expect(parseHostPpid(undefined)).toBeNull();
    expect(parseHostPpid('')).toBeNull();
    expect(parseHostPpid('x')).toBeNull();
    expect(parseHostPpid('0')).toBeNull();  // unknown
    expect(parseHostPpid('1')).toBeNull();  // init = already orphaned
  });
  it('returns a real positive pid', () => {
    expect(parseHostPpid('4242')).toBe(4242);
  });
});
