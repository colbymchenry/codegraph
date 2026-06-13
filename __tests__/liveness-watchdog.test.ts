import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  stepHeartbeat,
  parseWatchdogTimeoutMs,
  deriveCheckIntervalMs,
  installMainThreadWatchdog,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
} from '../src/mcp/liveness-watchdog';

describe('stepHeartbeat (wedge-detection reducer)', () => {
  it('resets the stale count when the counter advances', () => {
    const r = stepHeartbeat({ lastCounter: 5, staleChecks: 3 }, 6, 4);
    expect(r.wedged).toBe(false);
    expect(r.next).toEqual({ lastCounter: 6, staleChecks: 0 });
  });

  it('accumulates stale checks while the counter is frozen', () => {
    let s = { lastCounter: 9, staleChecks: 0 };
    for (let i = 1; i < 4; i++) {
      const r = stepHeartbeat(s, 9, 4);
      expect(r.wedged).toBe(false);
      expect(r.next.staleChecks).toBe(i);
      s = r.next;
    }
  });

  it('reports wedged once the stale count reaches the threshold', () => {
    const r = stepHeartbeat({ lastCounter: 9, staleChecks: 3 }, 9, 4);
    expect(r.wedged).toBe(true);
  });

  it('a single late heartbeat rescues the process (sleep/clock-jump safety)', () => {
    // 3 stale checks, then progress (as if the main thread resumed after a
    // system sleep) — must NOT be considered wedged.
    let s = { lastCounter: 1, staleChecks: 0 };
    s = stepHeartbeat(s, 1, 4).next; // stale 1
    s = stepHeartbeat(s, 1, 4).next; // stale 2
    s = stepHeartbeat(s, 1, 4).next; // stale 3
    const resumed = stepHeartbeat(s, 2, 4); // counter advanced
    expect(resumed.wedged).toBe(false);
    expect(resumed.next.staleChecks).toBe(0);
  });
});

describe('config parsing', () => {
  it('parseWatchdogTimeoutMs falls back for missing/invalid input', () => {
    expect(parseWatchdogTimeoutMs(undefined)).toBe(DEFAULT_WATCHDOG_TIMEOUT_MS);
    expect(parseWatchdogTimeoutMs('not-a-number')).toBe(DEFAULT_WATCHDOG_TIMEOUT_MS);
    expect(parseWatchdogTimeoutMs('0')).toBe(DEFAULT_WATCHDOG_TIMEOUT_MS);
    expect(parseWatchdogTimeoutMs('-5')).toBe(DEFAULT_WATCHDOG_TIMEOUT_MS);
    expect(parseWatchdogTimeoutMs('1500')).toBe(1500);
  });

  it('deriveCheckIntervalMs stays within [50, 2000] and scales with the timeout', () => {
    expect(deriveCheckIntervalMs(60_000)).toBe(2000); // clamped high
    expect(deriveCheckIntervalMs(500)).toBe(100); // 500/5
    expect(deriveCheckIntervalMs(10)).toBe(50); // clamped low
  });
});

describe('installMainThreadWatchdog opt-out', () => {
  it('returns null (no worker) when CODEGRAPH_NO_WATCHDOG is set', () => {
    const prev = process.env.CODEGRAPH_NO_WATCHDOG;
    process.env.CODEGRAPH_NO_WATCHDOG = '1';
    try {
      expect(installMainThreadWatchdog()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_NO_WATCHDOG;
      else process.env.CODEGRAPH_NO_WATCHDOG = prev;
    }
  });
});

/**
 * End-to-end: spawn a real process, install the real worker, and prove it kills
 * a wedged main thread (and ONLY a wedged one). Drives the built module the same
 * way mcp-ppid-watchdog.test.ts drives the built CLI.
 */
describe('liveness watchdog (spawned, real worker)', () => {
  const MODULE = path.resolve(__dirname, '../dist/mcp/liveness-watchdog.js');

  beforeAll(() => {
    if (!fs.existsSync(MODULE)) {
      throw new Error(`Build the project first: ${MODULE} is missing (run npm run build).`);
    }
  });

  function runChild(
    env: Record<string, string>,
    body: string,
    hardTimeoutMs: number
  ): Promise<{ code: number | null; signal: NodeJS.Signals | 'TIMEOUT' | null }> {
    const src = `
      const { installMainThreadWatchdog } = require(${JSON.stringify(MODULE)});
      installMainThreadWatchdog();
      ${body}
    `;
    const child = spawn(process.execPath, ['-e', src], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, signal: 'TIMEOUT' });
      }, hardTimeoutMs);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  it('SIGKILLs a process whose main thread wedges in a sync loop', async () => {
    const { signal } = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      'setTimeout(() => { while (true) {} }, 150);', // wedge the event loop forever
      8000
    );
    expect(signal).toBe('SIGKILL');
  }, 12000);

  it('does NOT kill a healthy process that keeps its event loop turning', async () => {
    const { code, signal } = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      // Stay responsive for 1.5s (3× the timeout), then exit cleanly with 7.
      'const iv = setInterval(() => {}, 50); setTimeout(() => { clearInterval(iv); process.exit(7); }, 1500);',
      8000
    );
    expect(signal).toBeNull(); // never signalled
    expect(code).toBe(7); // exited on its own terms
  }, 12000);

  it('does NOT kill a wedged process when CODEGRAPH_NO_WATCHDOG=1', async () => {
    const { signal } = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500', CODEGRAPH_NO_WATCHDOG: '1' },
      // Wedge briefly, but the test's hard timeout reaps it (the watchdog must not).
      'setTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end) {} process.exit(3); }, 150);',
      8000
    );
    // Killed by neither the watchdog (disabled) nor the hard timeout — it ran
    // its bounded busy-loop and exited 3 on its own.
    expect(signal).toBeNull();
  }, 12000);
});
