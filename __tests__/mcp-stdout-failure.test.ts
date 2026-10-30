/**
 * A host that stops reading an MCP server's output, while keeping its stdin
 * open and staying alive itself, must get the server's normal shutdown, not a
 * crash (#2991).
 *
 * The next response the server wrote failed (EPIPE), and with no listener on
 * stdout Node handed the error to the last-resort fatal handler, which exits 1
 * at once. That skipped the shutdown that stops the engine, releases the
 * writer lock and waits for query workers still starting, which on Windows can
 * crash a process that exits under them. Stdin, the host's PID and the
 * liveness watchdog all still look healthy, so nothing else notices.
 *
 * Each case runs a real server or proxy in a child process, destroys the
 * test's end of the child's stdout, then sends one more request so its
 * response meets the broken pipe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PROXY = path.resolve(__dirname, '../dist/mcp/proxy.js');

const line = (msg: object): string => JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';
const INITIALIZE = line({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
});
const call = (id: number, name = 'codegraph_status'): string =>
  line({ id, method: 'tools/call', params: { name, arguments: {} } });
/** No watchdogs, prompt hook or handshake timer: only the stdout failure can end these processes. */
const QUIET = {
  CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
  CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0', CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
};

interface Child {
  child: ChildProcessWithoutNullStreams;
  out: () => string;
  err: () => string;
  exit: Promise<number | null>;
  write: (s: string) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

/** Remove `dir` once nothing holds it: Windows can keep it busy a moment after a child exits. */
async function removeWhenReleased(dir: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
      await delay(50);
    }
  }
}

function answered(c: Child, id: number): boolean {
  return c.out().split('\n').some((l) => {
    try { return JSON.parse(l).id === id; } catch { return false; }
  });
}

describe('MCP stdio output failure (#2991)', () => {
  const children: Child[] = [];
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const { child, exit } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const dir of dirs.splice(0)) await removeWhenReleased(dir);
  });

  function start(args: string[], env: Record<string, string> = {}): Child {
    const child = spawn(process.execPath, args, {
      // Off every fixture, so a child still exiting cannot hold one (Windows EBUSY).
      cwd: os.tmpdir(),
      env: { ...process.env, ...QUIET, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdout.on('error', () => { /* destroyed by the test on purpose */ });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => { /* the child is gone */ });
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const handle: Child = {
      child, out: () => out, err: () => err, exit,
      write: (s) => { if (child.exitCode === null) child.stdin.write(s); },
    };
    children.push(handle);
    return handle;
  }

  /** The host stops reading; the next response meets the broken pipe. Stdin stays open. */
  async function breakOutputThenCall(c: Child, id: number, name?: string): Promise<number | null> {
    c.child.stdout.destroy();
    c.write(call(id, name));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 30_000); });
    const result = await Promise.race([c.exit, timedOut]);
    clearTimeout(timer);
    if (result === 'timeout') throw new Error(`still running 30 s after its output failed:\n${c.err()}`);
    return result;
  }

  it('stops a direct-mode server through its normal shutdown, which releases the writer lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdout-direct-'));
    dirs.push(dir);
    CodeGraph.initSync(dir).close();
    const writerPid = path.join(dir, '.codegraph', 'writer.pid');

    // The runtime flags make this child the server itself, not a relauncher.
    const server = start([...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--path', dir], { CODEGRAPH_NO_DAEMON: '1' });
    server.write(INITIALIZE);
    await until(() => answered(server, 1), 'the initialize response');
    server.write(line({ method: 'notifications/initialized' }));
    server.write(call(2));
    await until(() => answered(server, 2), 'the first tool call');
    expect(JSON.parse(fs.readFileSync(writerPid, 'utf8')).pid).toBe(server.child.pid);

    expect(await breakOutputThenCall(server, 3), server.err()).toBe(0);
    expect(server.err()).not.toMatch(/Uncaught exception/);
    expect(fs.existsSync(writerPid)).toBe(false);
  }, 60_000);

  it('stops the local proxy\'s in-process engine before the proxy exits', async () => {
    const proxy = start(['-e', `
      const fs = require('fs');
      const { runLocalHandshakeProxy } = require(${JSON.stringify(PROXY)});
      runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => null,
        makeEngine: () => ({
          ensureInitialized: async () => {},
          isReadOnly: () => true,
          getToolHandler: () => ({ execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
          stop: () => new Promise((resolve) => setTimeout(resolve, 100)).then(() => fs.writeSync(2, 'ENGINE STOPPED\\n')),
        }),
      });
    `], { CODEGRAPH_DAEMON_RETRY_MS: '0' });
    proxy.write(INITIALIZE);
    proxy.write(call(2, 'test'));
    await until(() => answered(proxy, 2), 'the first tool call');

    expect(await breakOutputThenCall(proxy, 3, 'test'), proxy.err()).toBe(0);
    expect(proxy.err()).toContain('ENGINE STOPPED');
    expect(proxy.err()).not.toMatch(/Uncaught exception/);
  }, 60_000);

  it('detaches the local proxy from the shared daemon and leaves the daemon\'s other clients alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdout-daemon-'));
    dirs.push(dir);
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-stdout-daemon-${process.pid}-${Date.now()}`
      : path.join(dir, 'd.sock');
    // Stands in for the shared daemon: answers every request on every connection.
    const connections = new Set<net.Socket>();
    const daemon = net.createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.on('error', () => { /* only this fixture's clients */ });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const request = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const msg = JSON.parse(request);
            if (msg.id !== undefined) socket.write(line({ id: msg.id, result: { content: [{ type: 'text', text: 'daemon' }] } }));
          } catch { /* not a request */ }
        }
      });
    });
    await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of connections) socket.destroy();
      daemon.close(() => resolve());
    }));
    const other = net.createConnection(socketPath);
    cleanups.unshift(() => { other.destroy(); });
    await new Promise<void>((resolve, reject) => { other.once('connect', () => resolve()); other.once('error', reject); });
    await until(() => connections.size === 1, 'the other client to connect');

    const proxy = start(['-e', `
      const net = require('net');
      const { runLocalHandshakeProxy } = require(${JSON.stringify(PROXY)});
      runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => {
          const socket = net.createConnection(${JSON.stringify(socketPath)});
          await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
          return socket;
        },
        makeEngine: () => { throw new Error('no in-process engine while the daemon serves'); },
      });
    `], { CODEGRAPH_DAEMON_RETRY_MS: '0' });
    proxy.write(INITIALIZE);
    proxy.write(call(2, 'test'));
    await until(() => answered(proxy, 2), 'a tool call answered through the daemon');
    expect(connections.size).toBe(2);

    expect(await breakOutputThenCall(proxy, 3, 'test'), proxy.err()).toBe(0);
    expect(proxy.err()).not.toMatch(/Uncaught exception/);
    await until(() => connections.size === 1, 'only the proxy\'s own connection to close');
    expect(daemon.listening).toBe(true);
    let reply = '';
    other.on('data', (chunk) => { reply += String(chunk); });
    other.write(call(9, 'test'));
    await until(() => reply.includes('"id":9'), 'the daemon to answer its other client');
  }, 60_000);
});
