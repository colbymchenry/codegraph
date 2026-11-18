/**
 * OpenCode is told our tool names the way it lists them (#1267).
 *
 * OpenCode registers a direct MCP tool as `<server key>_<tool name>`, so under
 * the key `codegraph` that `codegraph install` writes, `codegraph_explore` is
 * `codegraph_codegraph_explore` there. OpenCode also hands our `initialize`
 * instructions to its model, and those named `codegraph_explore`: the model
 * called a tool that doesn't exist and got "unavailable tool". The tools keep
 * their names, since renaming them would break every other agent (#284); what
 * we say to an OpenCode client names them its way instead.
 *
 * Both ways a client is answered are covered: the session (the direct server
 * and every client of the shared daemon) and the proxy's local handshake, which
 * must say the same thing to the same client. `tools/list` changes for OpenCode
 * alone, without touching the tool handler a daemon shares between clients, and
 * every other client keeps today's bytes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CodeGraph } from '../src';
import { MCPSession, initializeInstructions } from '../src/mcp/session';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions';
import { getStaticTools, tools, type ToolDefinition } from '../src/mcp/tools';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport, JsonRpcRequest, JsonRpcNotification } from '../src/mcp/transport';

const TOOL_NAMES = tools.map((t) => t.name);
/** A tool name standing alone, not inside a longer name: a tool OpenCode doesn't list. */
const BARE_TOOL_NAME = new RegExp(`(?<![A-Za-z0-9_])(?:${TOOL_NAMES.join('|')})(?![A-Za-z0-9_])`, 'g');
/** Every defined tool on the surface, so descriptions that name other tools are listed. */
const ALL_TOOLS = TOOL_NAMES.map((n) => n.replace(/^codegraph_/, '')).join(',');
/** What OpenCode's MCP client sends as `clientInfo` (anomalyco/opencode, packages/server/src/routes.ts). */
const OPENCODE = { name: 'opencode', version: '2.0.0' };
const OTHER_CLIENTS = [
  { name: 'claude-code', version: '2.1.0' },
  { name: 'cursor-vscode', version: '1.0.0' },
  { name: 'codex-mcp-client', version: '0.50.0' },
  { name: 'gemini-cli-mcp-client', version: '0.1.0' },
  { name: 'Visual Studio Code', version: '1.105.0' },
];

let indexedDir: string;
let plainDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The update notice is appended to the instructions when one is cached: keep
  // it out so the session here and the spawned proxy compare like for like.
  for (const key of ['CODEGRAPH_NO_UPDATE_CHECK', 'CODEGRAPH_MCP_TOOLS']) savedEnv[key] = process.env[key];
  process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';
  indexedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oc1267-indexed-')));
  plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oc1267-plain-')));
  const cg = await CodeGraph.init(indexedDir);
  cg.close();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(indexedDir, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
});

/** An engine with a project open whose tool handler lists the static surface. */
function fakeEngine(): MCPEngine {
  const handler = {
    getTools: () => getStaticTools(),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
  return {
    ensureInitialized: async () => { /* already open */ },
    hasDefaultCodeGraph: () => true,
    getProjectPath: () => indexedDir,
    retryInitializeSync: () => { /* nothing to retry */ },
    getToolHandler: () => handler,
  } as unknown as MCPEngine;
}

/** A session on `engine`, driven the way a transport drives it. */
function connect(engine: MCPEngine) {
  let handle: ((m: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
  const replies = new Map<unknown, any>();
  const transport: JsonRpcTransport = {
    start(h) { handle = h as typeof handle; },
    stop() { /* nothing to tear down */ },
    send() { /* unused */ },
    notify() { /* unused */ },
    async request() { return {}; },
    sendResult(id, result) { replies.set(id, result); },
    sendError(id, code, message) { replies.set(id, { error: { code, message } }); },
  };
  new MCPSession(transport, engine).start();
  let nextId = 1;
  return async (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    await handle!({ jsonrpc: '2.0', id, method, params } as JsonRpcRequest);
    return replies.get(id);
  };
}

function initializeParams(clientInfo: object | undefined, root: string): object {
  return {
    protocolVersion: '2025-06-18',
    capabilities: {},
    ...(clientInfo ? { clientInfo } : {}),
    rootUri: pathToFileURL(root).href,
  };
}

/** `instructions` as OpenCode is meant to get them, put back the way every other client gets them. */
function asForOtherClients(instructions: string): string {
  const lines = instructions.split('\n');
  const note = lines.findIndex((l) => l.includes('replaces the first `codegraph_`'));
  expect(note).toBeGreaterThan(0);
  expect(lines[note + 1]).toBe('');
  lines.splice(note, 2);
  return lines.join('\n').replace(/codegraph_codegraph_/g, 'codegraph_');
}

describe('initialize names our tools the way OpenCode lists them (#1267)', () => {
  for (const [variant, base, root] of [
    ['indexed root', () => SERVER_INSTRUCTIONS, () => indexedDir],
    ['no index at the root', () => SERVER_INSTRUCTIONS_NO_ROOT_INDEX, () => plainDir],
  ] as const) {
    it(`an OpenCode client gets every tool name with the server's key in front (${variant})`, async () => {
      for (const name of ['opencode', 'OpenCode']) {
        const request = connect(fakeEngine());
        const { instructions } = await request('initialize', initializeParams({ ...OPENCODE, name }, root()));

        expect(instructions.match(BARE_TOOL_NAME)).toBeNull();
        expect(instructions).toContain('`codegraph_codegraph_explore`');
        // One sentence for a server registered under another key.
        expect(instructions).toContain('if the server is registered under another key, that key replaces the first `codegraph_`');
        // The CLI and the environment variables read as they do for anyone else.
        expect(instructions).toContain('`codegraph init`');
        if (base() === SERVER_INSTRUCTIONS) expect(instructions).toContain('`CODEGRAPH_EXPLORE_DEDUP=1`');
        // Nothing else changes.
        expect(asForOtherClients(instructions)).toBe(initializeInstructions(base()));
      }
    });
  }

  it('every other client, and one that sends no clientInfo, gets today\'s instructions byte for byte', async () => {
    for (const [base, root] of [[SERVER_INSTRUCTIONS, indexedDir], [SERVER_INSTRUCTIONS_NO_ROOT_INDEX, plainDir]] as const) {
      for (const client of [...OTHER_CLIENTS, undefined]) {
        const request = connect(fakeEngine());
        const { instructions } = await request('initialize', initializeParams(client, root));
        expect(instructions, client?.name).toBe(initializeInstructions(base));
      }
    }
  });
});

describe('tools/list names our tools the way OpenCode lists them, for OpenCode alone (#1267)', () => {
  it('rewrites the descriptions an OpenCode client gets, keeps each tool\'s name, and leaves the shared handler and other clients alone', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = ALL_TOOLS;
    try {
      const engine = fakeEngine(); // one handler for both clients, as on the daemon
      const definitions = JSON.stringify(tools);
      const expected = getStaticTools();
      expect(JSON.stringify(expected).match(BARE_TOOL_NAME)!.length).toBeGreaterThan(TOOL_NAMES.length);

      const openCode = connect(engine);
      const claude = connect(engine);
      await openCode('initialize', initializeParams(OPENCODE, indexedDir));
      await claude('initialize', initializeParams(OTHER_CLIENTS[0], indexedDir));
      const listed: ToolDefinition[] = (await openCode('tools/list')).tools;

      // OpenCode adds the key itself, so each tool keeps its own name.
      expect(listed.map((t) => t.name)).toEqual(expected.map((t) => t.name));
      const described = JSON.stringify(listed.map(({ name: _name, ...rest }) => rest));
      expect(described.match(BARE_TOOL_NAME)).toBeNull();
      expect(described).toContain('codegraph_codegraph_explore');
      // Nothing but the names changed.
      expect(JSON.stringify(listed).replace(/codegraph_codegraph_/g, 'codegraph_')).toBe(JSON.stringify(expected));

      // The other client on the same handler, before and after, gets today's list.
      expect((await claude('tools/list')).tools).toEqual(expected);
      expect((await openCode('tools/list')).tools).toEqual(listed);
      expect((await claude('tools/list')).tools).toEqual(expected);
      expect(JSON.stringify(tools)).toBe(definitions);
    } finally {
      if (savedEnv.CODEGRAPH_MCP_TOOLS === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
      else process.env.CODEGRAPH_MCP_TOOLS = savedEnv.CODEGRAPH_MCP_TOOLS;
    }
  });
});

describe('the proxy\'s local handshake says what the session says (#1267)', () => {
  /** The real proxy, with no daemon: it answers initialize and tools/list itself. */
  async function proxyHandshake(clientInfo: object): Promise<{ init: any; list: any }> {
    const proxyModule = path.resolve(__dirname, '../dist/mcp/proxy.js');
    const script = `
      const { runLocalHandshakeProxy } = require(${JSON.stringify(proxyModule)});
      runLocalHandshakeProxy({
        root: process.cwd(),
        getDaemonSocket: async () => null,
        makeEngine: () => { throw new Error('no tool call is made'); },
      });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: indexedDir,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
        CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0',
        CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0', CODEGRAPH_DAEMON_RETRY_MS: '60000',
        CODEGRAPH_MCP_TOOLS: ALL_TOOLS,
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
      send({ id: 1, method: 'initialize', params: initializeParams(clientInfo, indexedDir) });
      send({ id: 2, method: 'tools/list', params: {} });
      await until(() => !!reply(1) && !!reply(2));
      return { init: reply(1).result, list: reply(2).result };
    } finally {
      child.stdin!.end();
      child.kill('SIGKILL');
      await exited;
    }
  }

  it('gives an OpenCode client, and any other, the same initialize and tools/list answers as the session', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = ALL_TOOLS;
    try {
      for (const client of [OPENCODE, OTHER_CLIENTS[0]]) {
        const proxy = await proxyHandshake(client);
        const request = connect(fakeEngine());
        expect(proxy.init, client.name).toEqual(await request('initialize', initializeParams(client, indexedDir)));
        expect(proxy.list, client.name).toEqual(await request('tools/list'));
        if (client !== OPENCODE) continue;
        // And what the proxy says to OpenCode is OpenCode's.
        expect(proxy.init.instructions.match(BARE_TOOL_NAME)).toBeNull();
        expect(proxy.init.instructions).toContain('`codegraph_codegraph_explore`');
        const described = proxy.list.tools.map(({ name: _name, ...rest }: ToolDefinition) => rest);
        expect(JSON.stringify(described).match(BARE_TOOL_NAME)).toBeNull();
      }
    } finally {
      if (savedEnv.CODEGRAPH_MCP_TOOLS === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
      else process.env.CODEGRAPH_MCP_TOOLS = savedEnv.CODEGRAPH_MCP_TOOLS;
    }
  }, 60_000);
});

describe('the rewrite touches whole tool names only (#1267)', () => {
  it('leaves longer identifiers, CODEGRAPH_* variables and the codegraph CLI alone, and is stable when run twice', async () => {
    const { withOpenCodeToolNames } = await import('../src/mcp/opencode-tool-names');
    const text = [
      'call `codegraph_explore`, then codegraph_node.',
      'my_codegraph_explore codegraph_explorer CODEGRAPH_EXPLORE_DEDUP=1 CODEGRAPH_MCP_TOOLS',
      'run `codegraph explore "x"` or codegraph init',
    ].join('\n');
    const once = withOpenCodeToolNames(text, TOOL_NAMES);
    expect(once).toBe([
      'call `codegraph_codegraph_explore`, then codegraph_codegraph_node.',
      'my_codegraph_explore codegraph_explorer CODEGRAPH_EXPLORE_DEDUP=1 CODEGRAPH_MCP_TOOLS',
      'run `codegraph explore "x"` or codegraph init',
    ].join('\n'));
    expect(withOpenCodeToolNames(once, TOOL_NAMES)).toBe(once);
  });
});
