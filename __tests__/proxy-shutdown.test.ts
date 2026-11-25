/**
 * The local-handshake proxy's shutdown waits for every in-process engine it
 * owns, and starts nothing new once it is shutting down (#2311). An engine's
 * stop can wait on a query worker still starting up — exiting before it
 * settles is the Windows crash QueryPool.destroy avoids — and stopping is
 * what releases the writer lock.
 *
 * Each case runs the real proxy entry point in a child process, with only the
 * daemon and engine dependencies replaced. Engines print `ENGINE n` when made
 * and `STOPPED n` once a deliberately slow stop settles.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODULE = path.resolve(__dirname, '../dist/mcp/proxy.js');
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

const line = (msg: object): string => JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';
const INITIALIZE = line({ id: 1, method: 'initialize', params: {} });
const toolCall = (id: number): string => line({ id, method: 'tools/call', params: { name: 'test', arguments: {} } });

/** Shared by every scenario: the proxy, with markers on stdout. */
const PRELUDE = `
  const { runLocalHandshakeProxy } = require(${JSON.stringify(MODULE)});
  const fs = require('fs');
  const net = require('net');
  const say = (s) => fs.writeSync(1, s + '\\n');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let engines = 0;
  const makeEngine = ({ readOnly, callMs, stopMs }) => () => {
    const n = ++engines;
    say('ENGINE ' + n);
    return {
      ensureInitialized: async () => {},
      isReadOnly: () => { say('RETRY ' + n); return readOnly; },
      getToolHandler: () => ({ execute: async () => {
        await delay(n === 1 ? callMs : 0);
        return { content: [{ type: 'text', text: 'finished ' + n }] };
      } }),
      stop: () => delay(stopMs).then(() => say('STOPPED ' + n)),
    };
  };
`;

interface Proxy {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: () => boolean;
  write: (s: string) => void;
  dispose: () => Promise<void>;
}

function startProxy(script: string, env: Record<string, string> = {}): Proxy {
  const child = spawn(process.execPath, ['-e', PRELUDE + script], {
    env: {
      ...process.env,
      CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
      CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      CODEGRAPH_DAEMON_RETRY_MS: '200',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout!.on('data', (d) => { stdout += d; });
  child.stderr!.on('data', (d) => { stderr += d; });
  // On a proxy that has already exited, a write fails with EPIPE; the
  // assertions say what went wrong, not an unhandled stream error.
  child.stdin!.on('error', () => { /* proxy gone */ });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  return {
    child,
    out: () => stdout,
    err: () => stderr,
    exited,
    write: (s) => { if (!exited()) child.stdin!.write(s); },
    dispose: async () => {
      if (!exited()) child.kill('SIGKILL');
      await until(exited, 'the proxy to exit');
      child.stdin!.destroy();
    },
  };
}

describe('local proxy shutdown (#2311)', () => {
  it('waits for an engine being retired before it exits', async () => {
    // A writing engine is retired so a daemon can take its lock: the retry
    // hands it back once its call answers. stdin closes while the retirement is
    // still waiting on that call, so `engine` is already null at shutdown.
    const proxy = startProxy(`
      runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => null,
        makeEngine: makeEngine({ readOnly: false, callMs: 10000, stopMs: 500 }),
      });
    `);
    try {
      proxy.write(INITIALIZE);
      proxy.write(toolCall(2));
      await until(() => proxy.out().includes('RETRY 1') || proxy.exited(), 'the retry to retire the engine');
      expect(proxy.out(), proxy.err()).toContain('RETRY 1');
      proxy.child.stdin!.end();
      await until(proxy.exited, 'the proxy to exit');
      expect(proxy.child.exitCode, proxy.err()).toBe(0);
      expect(proxy.out(), proxy.err()).toContain('STOPPED 1');
      expect(proxy.out()).not.toContain('finished 1');
    } finally {
      await proxy.dispose();
    }
  }, 20_000);

  it('starts no engine for client input that arrives once shutdown has begun', async () => {
    // A read-only engine is retired after the daemon comes back; the daemon
    // then drops again, so calls are served in-process with no live engine.
    // The host pid exiting starts shutdown while stdin is still open, and a
    // call written then must not start an engine shutdown() never stops.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proxy-stop-'));
    const sock = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-proxy-stop-${process.pid}-${Date.now()}`
      : path.join(dir, 'd.sock');
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const hostGone = new Promise<void>((resolve) => host.once('exit', () => resolve()));
    const proxy = startProxy(`
      const conns = [];
      const server = net.createServer((c) => { conns.push(c); c.on('data', () => {}); });
      let gets = 0;
      server.listen(${JSON.stringify(sock)}, () => runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => {
          if (++gets !== 2) return null;
          const s = net.createConnection(${JSON.stringify(sock)});
          await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('error', reject); });
          setTimeout(() => { for (const c of conns) c.destroy(); }, 100);
          return s;
        },
        makeEngine: makeEngine({ readOnly: true, callMs: 10000, stopMs: 1500 }),
      }));
    `, { CODEGRAPH_PPID_POLL_MS: '50', CODEGRAPH_HOST_PPID: String(host.pid) });
    try {
      proxy.write(INITIALIZE);
      proxy.write(toolCall(2));
      await until(() => proxy.err().includes('Shared daemon connection lost') || proxy.exited(), 'the daemon to drop');
      expect(proxy.out(), proxy.err()).toContain('ENGINE 1');
      host.kill('SIGKILL');
      await hostGone;
      await until(() => proxy.err().includes('Parent process exited') || proxy.exited(), 'shutdown to begin');
      proxy.write(toolCall(3));
      await until(proxy.exited, 'the proxy to exit');
      expect(proxy.child.exitCode, proxy.err()).toBe(0);
      expect(proxy.out(), proxy.err()).toContain('STOPPED 1');
      expect(proxy.out(), proxy.err()).not.toContain('ENGINE 2');
      expect(proxy.out()).not.toContain('"id":3');
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await proxy.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
