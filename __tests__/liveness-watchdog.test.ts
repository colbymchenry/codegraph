import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseWatchdogTimeoutMs,
  deriveCheckIntervalMs,
  installMainThreadWatchdog,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
} from '../src/mcp/liveness-watchdog';

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
  it('returns null (spawns nothing) when CODEGRAPH_NO_WATCHDOG is set', () => {
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
 * End-to-end: spawn a real process, install the real watchdog (which spawns a
 * separate watchdog child), and prove it kills a wedged main thread — including
 * the case a worker thread could NOT (a non-allocating loop under heap pressure,
 * which strands a same-process worker on V8's global safepoint, #850). Drives
 * the built module the way mcp-ppid-watchdog.test.ts drives the built CLI.
 */
describe('liveness watchdog (spawned, real watchdog process)', () => {
  const MODULE = path.resolve(__dirname, '../dist/mcp/liveness-watchdog.js');

  beforeAll(() => {
    if (!fs.existsSync(MODULE)) {
      throw new Error(`Build the project first: ${MODULE} is missing (run npm run build).`);
    }
  });

  function runChild(
    env: Record<string, string>,
    body: string,
    hardTimeoutMs: number,
    progressPaths?: string[]
  ): Promise<{ code: number | null; signal: NodeJS.Signals | 'TIMEOUT' | null }> {
    const src = `
      const { installMainThreadWatchdog } = require(${JSON.stringify(MODULE)});
      installMainThreadWatchdog(${progressPaths ? JSON.stringify({ progressPaths }) : ''});
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

  // Assert the watchdog terminated the process. POSIX surfaces the external
  // SIGKILL as signal 'SIGKILL'; Windows has no real signals, so the watchdog's
  // `process.kill(pid, 'SIGKILL')` maps to TerminateProcess and an observer sees
  // signal=null with a non-zero exit code. Either is a kill; the synthetic
  // 'TIMEOUT' (the watchdog never fired) is the failure we're guarding against.
  function expectKilled(r: { code: number | null; signal: NodeJS.Signals | 'TIMEOUT' | null }): void {
    expect(r.signal === 'SIGKILL' || (r.signal === null && r.code !== 0 && r.code !== null)).toBe(true);
  }

  it('SIGKILLs a process whose main thread wedges in a sync loop', async () => {
    const r = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      'setTimeout(() => { while (true) {} }, 150);',
      8000
    );
    expectKilled(r);
  }, 12000);

  it('SIGKILLs a non-allocating wedge under heap pressure (the case worker threads stalled on)', async () => {
    const r = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      // ~40MB retained so a GC is likely, then a tight NON-allocating loop — the
      // exact shape that deadlocks a same-process worker on the global safepoint.
      'const k=[]; for (let i=0;i<40;i++) k.push(Buffer.alloc(1024*1024,i)); global.__k=k; setTimeout(() => { while (true) {} }, 150);',
      8000
    );
    expectKilled(r);
  }, 12000);

  it('does NOT kill a healthy process that keeps its event loop turning', async () => {
    const { code, signal } = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      'const iv = setInterval(() => {}, 50); setTimeout(() => { clearInterval(iv); process.exit(7); }, 1500);',
      8000
    );
    expect(signal).toBeNull(); // never signalled
    expect(code).toBe(7); // exited on its own terms
  }, 12000);

  // --- disk-progress deferral (#1231): a blocked event loop is NOT a wedge
  // when the watched DB files keep advancing (a slow synchronous SQLite
  // statement on degraded storage). ---

  /** Grow `file` every 150ms for `forMs`; resolves when done. */
  function growFile(file: string, forMs: number): Promise<void> {
    return new Promise((resolve) => {
      const iv = setInterval(() => { fs.appendFileSync(file, 'x'.repeat(64)); }, 150);
      setTimeout(() => { clearInterval(iv); resolve(); }, forMs);
    });
  }

  it('does NOT kill a blocked loop while the watched files advance (slow store, not a wedge)', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cg-wd-')), 'db-wal');
    fs.writeFileSync(tmp, 'seed');
    // Base timeout 500ms; the loop blocks for 2.5s (5 timeouts, under the 10×
    // cap) while the test process grows the watched file. Old behavior: killed
    // at ~500ms. New: deferred, exits on its own with code 5.
    const [r] = await Promise.all([
      runChild(
        { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
        'setTimeout(() => { const end = Date.now() + 2500; while (Date.now() < end) {} process.exit(5); }, 200);',
        10_000,
        [tmp]
      ),
      growFile(tmp, 3200),
    ]);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(5);
  }, 15000);

  it('still kills a blocked loop when the watched files do NOT advance (a true wedge)', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cg-wd-')), 'db-wal');
    fs.writeFileSync(tmp, 'seed');
    // Same blocked loop, nobody grows the file: the base timeout kills it long
    // before its own exit(5) at 2.5s.
    const r = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      'setTimeout(() => { const end = Date.now() + 2500; while (Date.now() < end) {} process.exit(5); }, 200);',
      10_000,
      [tmp]
    );
    expectKilled(r);
  }, 15000);

  it('kills at the hard cap even with ongoing file activity (bounded deferral)', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cg-wd-')), 'db-wal');
    fs.writeFileSync(tmp, 'seed');
    // Base timeout 300ms ⇒ cap 3s. The loop blocks for 8s with continuous file
    // growth: deferral carries it past 300ms but the cap kills it around ~3s,
    // well before its own exit(5).
    const [r] = await Promise.all([
      runChild(
        { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '300' },
        'setTimeout(() => { const end = Date.now() + 8000; while (Date.now() < end) {} process.exit(5); }, 200);',
        15_000,
        [tmp]
      ),
      growFile(tmp, 9000),
    ]);
    expectKilled(r);
  }, 20000);

  it('does NOT kill a wedged process when CODEGRAPH_NO_WATCHDOG=1', async () => {
    const { code, signal } = await runChild(
      { CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500', CODEGRAPH_NO_WATCHDOG: '1' },
      'setTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end) {} process.exit(3); }, 150);',
      8000
    );
    // It exits with its OWN code 3 — proving nothing killed it. (Checking only
    // signal=null is insufficient on Windows, where a kill also reports null.)
    expect(signal).toBeNull();
    expect(code).toBe(3);
  }, 12000);
});
