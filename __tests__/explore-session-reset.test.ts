/**
 * Resetting one caller's already-sent record.
 *
 * Bucketing the record per caller context (see explore-cross-call-dedup) fixes
 * the subagent misfire, but a bucket still has to be forgettable: after a
 * compact the agent's context no longer holds the source the server believes it
 * was sent, so the next call gets pointers to text that is gone — the "codegraph
 * doesn't have it" shape that costs a Read. The host knows when that happens and
 * nothing else does, so the reset arrives from OUTSIDE the MCP conversation:
 *
 *   1. the daemon's control line — one JSON line on a fresh connection, one
 *      reply, no MCP session, and never a crash whatever the line says;
 *   2. the `codegraph hooks` CLI entry points the host actually invokes, which
 *      must ALWAYS exit 0 and keep stdout clean, since stdout IS the hook
 *      protocol and a non-zero exit disrupts the agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Daemon, parseDaemonControlLine } from '../src/mcp/daemon';
import { MCPSession } from '../src/mcp/session';
import { getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport } from '../src/mcp/transport';
import type { ExploreEmission } from '../src/mcp/explore-session-state';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

const servers: net.Server[] = [];
const tmpDirs: string[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tmpProject(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  // `.codegraph/codegraph.db` is what makes a directory look indexed, which is
  // what the hook needs before it goes looking for a daemon.
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  return dir;
}

function emission(projectRoot: string): ExploreEmission {
  return {
    projectRoot,
    query: 'q',
    files: [{ path: 'a.ts', ranges: [{ start: 1, end: 10 }], bytes: 100 }],
    sourceBytes: 100,
    responseBytes: 400,
  };
}

/** A transport that is never driven — these tests reach the session directly. */
const idleTransport = (): JsonRpcTransport => ({
  start() { /* no messages in this test */ },
  stop() { /* nothing to tear down */ },
  send() { /* unused */ },
  notify() { /* unused */ },
  async request() { return {}; },
  sendResult() { /* unused */ },
  sendError() { /* unused */ },
});

/** Send one line to a socket and resolve the first reply line carrying `ok`. */
function control(socketPath: string, line: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffered = '';
    const done = (value: Record<string, unknown> | null): void => {
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      for (const reply of buffered.split('\n')) {
        try {
          const parsed = JSON.parse(reply);
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) { done(parsed); return; }
        } catch { /* the daemon hello, or a partial line */ }
      }
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
  });
}

describe('parseDaemonControlLine', () => {
  it('parses a control line, passing its fields through unvalidated', () => {
    expect(parseDaemonControlLine('{"codegraph_control":1,"op":"clear-session-record","sessionId":"A"}'))
      .toEqual({ op: 'clear-session-record', sessionId: 'A' });
    expect(parseDaemonControlLine('{"codegraph_control":1,"op":42}'))
      .toEqual({ op: 42, sessionId: undefined });
  });

  it('leaves a JSON-RPC first line alone — a client must not be hijacked', () => {
    expect(parseDaemonControlLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toBeNull();
    expect(parseDaemonControlLine('{"codegraph_client":1,"pid":7}')).toBeNull();
  });

  it('requires the exact marker', () => {
    expect(parseDaemonControlLine('{"codegraph_control":true,"op":"x"}')).toBeNull();
    expect(parseDaemonControlLine('{"codegraph_control":2,"op":"x"}')).toBeNull();
  });

  it('returns null for invalid / empty / non-object JSON', () => {
    expect(parseDaemonControlLine('not json')).toBeNull();
    expect(parseDaemonControlLine('')).toBeNull();
    expect(parseDaemonControlLine('42')).toBeNull();
    expect(parseDaemonControlLine('null')).toBeNull();
  });
});

describe('the daemon control line', () => {
  /**
   * A daemon serving two real sessions, reachable over a real socket. Only the
   * engine is absent — the control path never touches it (that is half the
   * point: a reset must not depend on an initialized index).
   */
  async function serveDaemon(): Promise<{
    socketPath: string;
    sessions: MCPSession[];
    clients: Set<MCPSession>;
  }> {
    const root = tmpProject('cg-control-');
    // idleTimeoutMs 0 = never arm a real idle timer in a unit test.
    const daemon = new Daemon(root, { idleTimeoutMs: 0 }) as unknown as {
      handleConnection: (socket: net.Socket) => void;
      clients: Set<MCPSession>;
      engine: { stop: () => void };
    };
    const engine = {} as MCPEngine;
    const sessions = [new MCPSession(idleTransport(), engine), new MCPSession(idleTransport(), engine)];
    for (const session of sessions) daemon.clients.add(session);
    // The engine the constructor built is never initialized here; stop it so no
    // worker pool outlives the test.
    try { daemon.engine.stop(); } catch { /* nothing started */ }

    const socketPath = getDaemonSocketCandidates(root)[0]!;
    const server = net.createServer((socket) => daemon.handleConnection(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    return { socketPath, sessions, clients: daemon.clients };
  }

  it('clears the named caller everywhere and reports how much it dropped', async () => {
    const { socketPath, sessions, clients } = await serveDaemon();
    // The caller knows its context id, not which connection carries it: bucket
    // "A" exists on both sessions, "B" only on the second.
    sessions[0]!.getExploreSessionState().record(emission('/repo/one'), 'A');
    sessions[1]!.getExploreSessionState().record(emission('/repo/two'), 'A');
    sessions[1]!.getExploreSessionState().record(emission('/repo/two'), 'B');

    expect(await control(socketPath, '{"codegraph_control":1,"op":"clear-session-record","sessionId":"A"}'))
      .toEqual({ ok: true, cleared: 2 });

    expect(sessions[0]!.getExploreSessionState().view('A').projects).toEqual([]);
    expect(sessions[1]!.getExploreSessionState().view('A').projects).toEqual([]);
    // B was never named, so B still holds everything it was served.
    expect(sessions[1]!.getExploreSessionState().view('B').projects[0]?.callCount).toBe(1);
    // A control connection is a command, not a client — it must not register as
    // one (that would make it count against the daemon's idle lifecycle).
    expect(clients.size).toBe(2);
  });

  it('refuses an unknown op and a non-string id, and keeps serving after both', async () => {
    const { socketPath, sessions } = await serveDaemon();
    sessions[0]!.getExploreSessionState().record(emission('/repo/one'), 'A');

    expect(await control(socketPath, '{"codegraph_control":1,"op":"drop-everything","sessionId":"A"}'))
      .toEqual({ ok: false });
    expect(await control(socketPath, '{"codegraph_control":1,"op":"clear-session-record","sessionId":{"nope":1}}'))
      .toEqual({ ok: false });
    // Nothing was cleared by either, and the daemon still answers a real one.
    expect(sessions[0]!.getExploreSessionState().view('A').projects[0]?.callCount).toBe(1);
    expect(await control(socketPath, '{"codegraph_control":1,"op":"clear-session-record","sessionId":"A"}'))
      .toEqual({ ok: true, cleared: 1 });
  });

  it('reports zero for a caller nobody has a record for', async () => {
    const { socketPath } = await serveDaemon();
    expect(await control(socketPath, '{"codegraph_control":1,"op":"clear-session-record","sessionId":"ghost"}'))
      .toEqual({ ok: true, cleared: 0 });
  });
});

/**
 * The CLI hook entry points. Run against the BUILT binary, because the contract
 * under test is a process contract — exit status and stdout bytes — not a
 * function's return value.
 */
describe('codegraph hooks', () => {
  /**
   * Spawned ASYNC on purpose: the fake daemon below serves from this very event
   * loop, and a synchronous spawn would block it — the hook would then time out
   * against a server that never got a turn to answer.
   */
  function runHook(args: string[], stdin: string, cwd?: string): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'hooks', ...args], {
        cwd,
        // Skip the daemon spawn and the wasm re-exec: a hook must resolve in one
        // fast process, and the test asserts what that process alone printed.
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      });
      let stdout = '';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.on('error', () => { /* a hook may never read stdin */ });
      child.stdin.end(stdin);
    });
  }

  describe('pre-tool-use', () => {
    const payload = (over: Record<string, unknown>): string => JSON.stringify({
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__codegraph__codegraph_explore',
      tool_input: { query: 'AuthService login', maxFiles: 8 },
      ...over,
    });

    it('stamps the main agent with the bare session id, keeping the original input', async () => {
      const { status, stdout } = await runHook(['pre-tool-use'], payload({}));
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { query: 'AuthService login', maxFiles: 8, sessionId: 'sess-1' },
        },
      });
    });

    it('scopes a subagent to its session — the whole point of the hook', async () => {
      const { status, stdout } = await runHook(['pre-tool-use'], payload({ agent_id: 'agent-42' }));
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          // Composite, not the bare agent id: a host that numbers agents only
          // per-session would otherwise cross-bucket two sessions' subagents.
          updatedInput: { query: 'AuthService login', maxFiles: 8, sessionId: 'sess-1:agent-42' },
        },
      });
    });

    /**
     * `permissionDecision` is opt-in per agent, declared by the wiring rather
     * than sniffed from the payload. Codex requires it paired with the rewrite
     * or discards the rewrite; Claude Code ACTS on it, so "allow" there would
     * override a user who chose not to allowlist codegraph. The default has to
     * be omission, and an unrecognized agent has to fall back to the default —
     * a wrong guess in this direction is a privilege escalation.
     */
    it('pairs permissionDecision with the rewrite for --agent codex', async () => {
      const { status, stdout } = await runHook(['pre-tool-use', '--agent', 'codex'], payload({}));
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { query: 'AuthService login', maxFiles: 8, sessionId: 'sess-1' },
        },
      });
    });

    it('omits permissionDecision by default and for any other agent', async () => {
      for (const args of [
        ['pre-tool-use'],
        ['pre-tool-use', '--agent', 'claude'],
        ['pre-tool-use', '--agent', 'not-an-agent'],
        ['pre-tool-use', '--agent', 'Codex'],
      ]) {
        const { status, stdout } = await runHook(args, payload({}));
        expect(status, args.join(' ')).toBe(0);
        expect(JSON.parse(stdout).hookSpecificOutput, args.join(' '))
          .not.toHaveProperty('permissionDecision');
        // Only that one field differs — the stamp is identical either way.
        expect(JSON.parse(stdout).hookSpecificOutput.updatedInput, args.join(' '))
          .toEqual({ query: 'AuthService login', maxFiles: 8, sessionId: 'sess-1' });
      }
    });

    it('keeps the main context and its own subagent in different buckets', async () => {
      const idFor = async (over: Record<string, unknown>): Promise<string> =>
        JSON.parse((await runHook(['pre-tool-use'], payload(over))).stdout)
          .hookSpecificOutput.updatedInput.sessionId;
      expect(await idFor({})).not.toBe(await idFor({ agent_id: 'agent-42' }));
      // Same agent id under a different session is a different bucket too.
      expect(await idFor({ agent_id: 'agent-42' }))
        .not.toBe(await idFor({ session_id: 'sess-2', agent_id: 'agent-42' }));
    });

    it('says nothing about a tool that is not explore', async () => {
      const { status, stdout } = await runHook(['pre-tool-use'], payload({ tool_name: 'Read' }));
      expect(status).toBe(0);
      expect(stdout).toBe('');
    });

    it('exits 0 with empty stdout on junk, empty, or id-less input', async () => {
      for (const input of ['not json', '', '{}', payload({ session_id: '', agent_id: '' })]) {
        const { status, stdout } = await runHook(['pre-tool-use'], input);
        expect(status, `input: ${input}`).toBe(0);
        expect(stdout, `input: ${input}`).toBe('');
      }
    });
  });

  describe('post-compact', () => {
    /** Stand in for the daemon: greet, capture one line, answer it. */
    async function fakeDaemon(root: string): Promise<{ received: string[] }> {
      const received: string[] = [];
      const server = net.createServer((socket) => {
        socket.write('{"codegraph":"0.0.0","pid":1,"socketPath":"x","protocol":1}\n');
        let buffered = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffered += chunk;
          const nl = buffered.indexOf('\n');
          if (nl === -1) return;
          received.push(buffered.slice(0, nl));
          buffered = '';
          socket.end('{"ok":true,"cleared":1}\n');
        });
        socket.on('error', () => { /* client may vanish */ });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(getDaemonSocketCandidates(root)[0]!, () => resolve()));
      return { received };
    }

    it('relays the compacted context id to the project daemon', async () => {
      const root = tmpProject('cg-postcompact-');
      const daemon = await fakeDaemon(root);
      const { status } = await runHook(['post-compact'], JSON.stringify({
        session_id: 'sess-9', cwd: root, hook_event_name: 'PostCompact', trigger: 'auto',
      }));
      expect(status).toBe(0);
      expect(JSON.parse(daemon.received[0]!)).toEqual({
        codegraph_control: 1, op: 'clear-session-record', sessionId: 'sess-9',
      });
    });

    it('relays a subagent id, and honours an explicit --session-id with no payload', async () => {
      const root = tmpProject('cg-postcompact-agent-');
      const daemon = await fakeDaemon(root);

      expect((await runHook(['post-compact'], JSON.stringify({
        session_id: 'sess-9', agent_id: 'agent-42', cwd: root,
      }))).status).toBe(0);
      // The reset must spell the id exactly as the stamping hook did.
      expect(JSON.parse(daemon.received[0]!).sessionId).toBe('sess-9:agent-42');

      // No hook payload at all — the relay path (LLMMesh), which knows the id
      // but has nothing on stdin to derive it from.
      expect((await runHook(['post-compact', '--path', root, '--session-id', 'relayed-7'], '')).status).toBe(0);
      expect(JSON.parse(daemon.received[1]!).sessionId).toBe('relayed-7');
    });

    it('exits 0 when no daemon is listening, on an unindexed cwd, and on junk input', async () => {
      const indexed = tmpProject('cg-postcompact-nodaemon-');
      const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-postcompact-bare-')));
      tmpDirs.push(bare);
      const payload = (cwd: string): string => JSON.stringify({ session_id: 'sess-9', cwd });

      // Indexed but nothing is serving; nothing indexed at all; unparseable.
      for (const [label, input] of [
        ['no daemon', payload(indexed)],
        ['unindexed', payload(bare)],
        ['junk', 'not json'],
      ] as const) {
        const { status, stdout } = await runHook(['post-compact'], input, bare);
        expect(status, label).toBe(0);
        expect(stdout, label).toBe('');
      }
    });
  });
});
