/**
 * No-root-index session policy tests (#964).
 *
 * A server whose own root has no .codegraph/ still exposes its tools — gating
 * tool AVAILABILITY on whether `./` is indexed broke monorepos (only
 * sub-projects indexed) and hid the tools from a session that started before
 * `codegraph init`. So `initialize` returns the per-project instructions
 * variant (not the full single-project playbook, and NOT an "inactive" note),
 * `tools/list` exposes the tool surface, and a query against an indexed project
 * by `projectPath` works even with no default project. Safety is preserved by
 * the response SHAPE, not by hiding tools: a call against an un-indexed path
 * returns SUCCESS-shaped guidance ("pass projectPath / run codegraph init"),
 * never `isError: true` — one or two early isError responses teach an agent to
 * abandon codegraph for the whole session, and that failure mode is still
 * guarded below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Direct (in-process) mode — the unindexed path never has a daemon
    // anyway (the daemon socket lives in .codegraph/), and this keeps the
    // suite from leaking a detached daemon in the indexed test.
    // CODEGRAPH_WASM_RELAUNCHED skips the --liftoff-only re-exec: without
    // it the server runs as a GRANDCHILD that survives child.kill() on
    // Windows and holds the temp cwd/SQLite handles, failing teardown with
    // EPERM no matter how long rmSync retries (the class documented for
    // the mcp-initialize/mcp-roots suites).
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
  }) as ChildProcessWithoutNullStreams;
}

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout waiting for response id=${msg.id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === msg.id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // non-JSON noise on stdout — ignore
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

function initializeParams(projectPath: string) {
  return {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
    rootUri: `file://${projectPath}`,
  };
}

describe('No-root-index session policy', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unindexed-'));
  });

  afterEach(async () => {
    if (child) {
      // Wait for the child to actually exit before removing its cwd — on
      // Windows a just-killed process briefly holds the directory/SQLite
      // handles, and an immediate rmSync fails the teardown with EPERM
      // (the documented file-locking class that fails the sibling
      // mcp-initialize/mcp-roots suites). kill + await exit + retried
      // removal keeps this suite green on Windows.
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('initialize returns the per-project instructions (not "inactive", not the full playbook)', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const x = 1;\n');
    child = spawnServer(tempDir);

    const res = await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });
    const instructions = (res.result as { instructions: string }).instructions;

    // No longer an "inactive, do nothing" note — the tools are available.
    expect(instructions).not.toMatch(/inactive/i);
    // It steers the agent to target a project explicitly via projectPath...
    expect(instructions).toMatch(/projectPath/);
    expect(instructions).toMatch(/codegraph_explore/);
    expect(instructions).toMatch(/codegraph init/);
    // ...but it is NOT the full single-project playbook (that's sent only when
    // the root itself is indexed — keeps the common case tight).
    expect(instructions).not.toMatch(/## How to query/);
  });

  it('tools/list exposes the tools even when the server root has no index (#964)', async () => {
    child = spawnServer(tempDir);
    await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });

    const res = await request(child, { id: 1, method: 'tools/list' });
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.map((t) => t.name)).toContain('codegraph_explore');
  });

  it('a query by projectPath reaches an INDEXED sub-project of an unindexed root (monorepo) (#964)', async () => {
    // The server root (tempDir) has no index; an indexed sub-project lives
    // under it — exactly the monorepo shape. The query must resolve to the
    // sub-project's .codegraph/ and return real results. Run through the real
    // spawned server (a second-project open can't be exercised in-process under
    // vitest — see mcp-toolhandler cache notes — but a child process can).
    const svc = path.join(tempDir, 'service_a');
    fs.mkdirSync(svc);
    fs.writeFileSync(
      path.join(svc, 'auth.ts'),
      'export function validateToken(t: string): boolean { return !!t; }\n'
    );
    const cg = await CodeGraph.init(svc, { index: true });
    cg.close();

    child = spawnServer(tempDir);
    await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });

    const res = await request(child, {
      id: 1,
      method: 'tools/call',
      params: { name: 'codegraph_search', arguments: { query: 'validateToken', projectPath: svc } },
    });
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/validateToken/);
    expect(result.content[0]!.text).not.toMatch(/isn't indexed/);
  });

  it('an INDEXED workspace still gets the full playbook and the explore tool', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export function hello(): string { return "hi"; }\n');
    const cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();

    child = spawnServer(tempDir);
    const init = await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });
    const instructions = (init.result as { instructions: string }).instructions;
    expect(instructions).toMatch(/How to query/);
    expect(instructions).not.toMatch(/inactive/i);

    const list = await request(child, { id: 1, method: 'tools/list' });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    // The default surface is pared to explore alone (see DEFAULT_MCP_TOOLS) — the
    // contract under test is "indexed → tools are PRESENT", in contrast to the
    // unindexed empty list above.
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.map((t) => t.name)).toContain('codegraph_explore');
  });
});

describe('No-error policy on expected conditions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noerror-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('cross-project query to an unindexed path is SUCCESS-shaped guidance, not isError', async () => {
    const res = await new ToolHandler(null).execute('codegraph_search', {
      query: 'anything',
      projectPath: tempDir,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/isn't indexed/);
    expect(res.content[0]!.text).toMatch(/codegraph init/);
    expect(res.content[0]!.text).toMatch(/built-in tools/);
  });

  it('no-default-project (working-directory detection miss) is SUCCESS-shaped guidance', async () => {
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'anything' });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/No CodeGraph project is loaded/);
    expect(res.content[0]!.text).toMatch(/projectPath/);
  });


  it.runIf(process.platform !== 'win32')(
    'sensitive-path refusal stays a hard error (no retry encouragement)',
    async () => {
      const res = await new ToolHandler(null).execute('codegraph_search', {
        query: 'anything',
        projectPath: '/etc',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).not.toMatch(/retry the call once/);
    }
  );
});

describe('search kind filter', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-kind-'));
    fs.writeFileSync(
      path.join(tempDir, 'types.ts'),
      'export type PaymentMethod = { id: string };\nexport function pay(): void {}\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("kind: 'type' (the advertised enum value) finds type aliases", async () => {
    const res = await new ToolHandler(cg).execute('codegraph_search', {
      query: 'PaymentMethod',
      kind: 'type',
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/PaymentMethod/);
    expect(res.content[0]!.text).not.toMatch(/No results found/);
  });
});
