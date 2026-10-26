import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';

const MODULE = path.resolve(__dirname, '../dist/mcp/proxy.js');
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for proxy lifecycle');
    await delay(25);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Exercise the real local-handshake entry point and its real watchdog child,
// with only the daemon/engine dependencies replaced to inject bounded faults.
async function exercise(mode: 'connecting-wedge' | 'fallback-wedge' | 'slow-fallback'): Promise<void> {
  const child = spawn(process.execPath, ['-e', `
    const { runLocalHandshakeProxy } = require(${JSON.stringify(MODULE)});
    const mode = ${JSON.stringify(mode)};
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    function wedge() {
      require('fs').writeSync(1, 'WEDGED\\n');
      while (true) {}
    }
    runLocalHandshakeProxy({
      root: process.cwd(),
      getDaemonSocket: async () => {
        if (mode === 'connecting-wedge') {
          await delay(300);
          wedge();
        }
        return null;
      },
      makeEngine: () => ({
        ensureInitialized: async () => {},
        getToolHandler: () => ({ execute: async () => {
          if (mode === 'fallback-wedge') wedge();
          // Longer than two watchdog deadlines, but yielding healthy work.
          await delay(2500);
          return { content: [{ type: 'text', text: 'finished' }] };
        } }),
        // Slow, like a stop waiting on a query worker still starting up: the
        // proxy must not exit before it settles.
        stop: () => mode === 'slow-fallback'
          ? delay(300).then(() => { require('fs').writeSync(1, 'STOPPED\\n'); })
          : undefined,
      }),
    });
  `], {
    env: {
      ...process.env,
      CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
      CODEGRAPH_NO_WATCHDOG: '0', CODEGRAPH_WATCHDOG_TIMEOUT_MS: '1000',
      CODEGRAPH_MCP_DEBUG: '1', CODEGRAPH_PPID_POLL_MS: '0',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const watchdogPid = () => Number(/armed \(child pid (\d+)\)/.exec(stderr)?.[1]);
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    if (mode !== 'connecting-wedge') {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'test', arguments: {} } }) + '\n');
    }
    if (mode === 'slow-fallback') {
      await until(() => stdout.includes('finished') || exited());
      expect(stdout, stderr).toContain('finished');
      expect(exited()).toBe(false);
      child.stdin.end();
      await until(exited);
      expect(child.exitCode, stderr).toBe(0);
      expect(child.signalCode).toBeNull();
      expect(stdout, stderr).toContain('STOPPED');
    } else {
      await until(() => stdout.includes('WEDGED') || exited());
      expect(stdout, stderr).toContain('WEDGED');
      // This assertion MUST precede test cleanup: killing a survivor in finally
      // must never turn a missing watchdog into a passing test.
      await until(exited);
      expect(stderr).toContain('Main thread unresponsive');
      expect(child.signalCode === 'SIGKILL' || (child.exitCode !== null && child.exitCode !== 0)).toBe(true);
    }
    expect(watchdogPid()).toBeGreaterThan(0);
    await until(() => !alive(watchdogPid()));
  } finally {
    if (!exited()) child.kill('SIGKILL');
    await until(exited);
    const pid = watchdogPid();
    if (pid && alive(pid)) {
      try { await until(() => !alive(pid)); }
      finally { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
    }
    child.stdin.destroy();
  }
}

describe('local proxy liveness (#943)', () => {
  it.runIf(process.platform === 'win32')('terminates a wedged proxy during daemon connection and reaps its watchdog', async () => {
    await exercise('connecting-wedge');
  }, 20000);

  it('terminates a wedged fallback tool call and reaps its watchdog', async () => {
    await exercise('fallback-wedge');
  }, 20000);

  it('allows slow yielding fallback work, then exits cleanly on stdin EOF with no watchdog orphan', async () => {
    await exercise('slow-fallback');
  }, 20000);
});
