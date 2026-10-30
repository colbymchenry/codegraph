/**
 * A `tools/call` whose `arguments` is not an object is a malformed request,
 * answered with a JSON-RPC invalid-params error (-32602) like a call that
 * names no tool, and never run (#2981).
 *
 * Before, the session handed a string or number straight to the tool handler,
 * where `'_cgExploreSession' in args` threw, and the call came back as a tool
 * result flagged isError saying "This is an internal codegraph error — retry
 * the call once; if it persists, continue without codegraph": a client's bug
 * reported as codegraph's own, with advice to stop using it. An array went
 * through as if it were the arguments. No arguments, or null, still mean none.
 *
 * Both ways a call is served are covered: the session (the direct stdio server
 * and every client of the shared daemon), and the stdio proxy serving in
 * process while the daemon is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport, JsonRpcRequest, JsonRpcNotification } from '../src/mcp/transport';

const MALFORMED: unknown[] = ['alpha', 42, true, [1], [{ query: 'q' }]];
const NONE: unknown[] = [undefined, null, ''];

describe('a tools/call whose arguments are not an object (#2981)', () => {
  function session() {
    let handle: ((m: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
    const results: Array<{ id: unknown; result: unknown }> = [];
    const errors: Array<{ id: unknown; code: number; message: string }> = [];
    const executed: unknown[] = [];
    const transport: JsonRpcTransport = {
      start(h) { handle = h as typeof handle; },
      stop() { /* nothing to tear down */ },
      send() { /* unused */ },
      notify() { /* unused */ },
      async request() { return {}; },
      sendResult(id, result) { results.push({ id, result }); },
      sendError(id, code, message) { errors.push({ id, code, message }); },
    };
    const engine = {
      ensureInitialized: async () => { /* already open */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => '/repo',
      retryInitializeSync: () => { /* nothing to retry */ },
      getToolHandler: () => ({
        getTools: () => [],
        execute: async (_name: string, args: unknown) => {
          executed.push(args);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      }),
    } as unknown as MCPEngine;
    new MCPSession(transport, engine).start();
    const call = (id: number, args: unknown) =>
      handle!({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: args === undefined ? { name: 'codegraph_explore' } : { name: 'codegraph_explore', arguments: args },
      } as JsonRpcRequest);
    return { call, results, errors, executed };
  }

  it('is answered with invalid params, and never reaches a tool', async () => {
    const s = session();
    for (const [i, args] of MALFORMED.entries()) await s.call(i, args);
    expect(s.errors).toEqual(MALFORMED.map((_, i) => ({ id: i, code: -32602, message: 'Tool arguments must be an object' })));
    expect(s.executed).toEqual([]);
    expect(s.results).toEqual([]);
  });

  it('runs a call with an object, or with no arguments at all', async () => {
    const s = session();
    await s.call(1, { query: 'q' });
    for (const [i, args] of NONE.entries()) await s.call(10 + i, args);
    expect(s.errors).toEqual([]);
    expect(s.executed).toEqual([{ query: 'q' }, {}, {}, {}]);
  });

  it('is answered the same way by the proxy while the daemon is unavailable', async () => {
    const proxyModule = path.resolve(__dirname, '../dist/mcp/proxy.js');
    // The real proxy entry point, with no daemon and an engine that says when
    // a tool runs.
    const script = `
      const { runLocalHandshakeProxy } = require(${JSON.stringify(proxyModule)});
      const say = (s) => require('fs').writeSync(1, s + '\\n');
      runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => null,
        makeEngine: () => ({
          ensureInitialized: async () => {},
          isReadOnly: () => true,
          getToolHandler: () => ({ execute: async (name, args) => {
            say('EXECUTED ' + JSON.stringify(args));
            return { content: [{ type: 'text', text: 'ok' }] };
          } }),
          stop: async () => {},
        }),
      });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
        CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0',
        CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0', CODEGRAPH_DAEMON_RETRY_MS: '60000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const send = (msg: object) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    const reply = (id: number) =>
      out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((m) => m.id === id);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`no reply: ${out}\n${err}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      send({ id: 1, method: 'initialize', params: {} });
      await until(() => !!reply(1));
      send({ id: 2, method: 'tools/call', params: { name: 'codegraph_explore', arguments: 'alpha' } });
      send({ id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: [1] } });
      send({ id: 4, method: 'tools/call', params: { name: 'codegraph_status' } });
      await until(() => !!reply(2) && !!reply(3) && !!reply(4));
      expect(reply(2).error).toEqual({ code: -32602, message: 'Tool arguments must be an object' });
      expect(reply(3).error).toEqual({ code: -32602, message: 'Tool arguments must be an object' });
      expect(reply(4).result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
      expect(out.match(/^EXECUTED .*$/gm)).toEqual(['EXECUTED {}']);
    } finally {
      child.stdin!.end();
      child.kill('SIGKILL');
      await exited;
    }
  }, 30_000);
});
