/**
 * Regression test for #1192: the `codegraph serve --mcp --tools=<list>` CLI
 * flag mirrors `CODEGRAPH_MCP_TOOLS` for MCP clients (OpenCode, Antigravity
 * IDE, …) that don't forward the `env` block from the MCP server config to
 * the spawned process. Without the flag, the user sees only the default
 * `codegraph_explore` regardless of what they set in the config.
 *
 * The flag works by setting `process.env.CODEGRAPH_MCP_TOOLS` BEFORE
 * `MCPServer` construction, so it propagates to:
 *   1. the proxy's static ListTools (runLocalHandshakeProxy → getStaticTools)
 *   2. the detached daemon via the spawn's `env: { ...process.env }`
 *   3. the direct-mode `ToolHandler.getTools()` (this suite tests this path)
 *
 * We exercise the in-process direct path with `CODEGRAPH_NO_DAEMON=1` because
 * the env-var reading logic is shared across all three (#1, #2, #3 above all
 * read `process.env.CODEGRAPH_MCP_TOOLS` at call time). The CLI plumbing is
 * exercised end-to-end: argv → commander parse → action → env var → filter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(
  cwd: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp', ...extraArgs], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Pin direct mode: avoids leaking a detached daemon if the test bails out,
    // and isolates the env-var read to one process (the launcher's).
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', ...extraEnv },
  }) as ChildProcessWithoutNullStreams;
}

function sendRequest(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(msg + '\n');
}

interface StreamEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

function tagStreams(child: ChildProcessWithoutNullStreams): StreamEvent[] {
  const events: StreamEvent[] = [];
  let seq = 0;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stdout', text: line });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stderr', text: line });
    }
  });
  return events;
}

async function waitForResponse(
  events: StreamEvent[],
  id: number,
  timeoutMs: number,
): Promise<{ result?: { tools?: Array<{ name: string }> }; error?: unknown }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const e of events) {
      if (e.stream !== 'stdout') continue;
      try {
        const parsed = JSON.parse(e.text);
        if (parsed && parsed.id === id) return parsed;
      } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for id=${id}. Events: ${JSON.stringify(events)}`);
}

describe('`codegraph serve --mcp --tools=<list>` (issue #1192)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-tools-flag-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes ONLY the default surface (explore) when --tools is omitted', async () => {
    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 5000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 5000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_explore']);
  }, 15000);

  it('--tools=<list> exposes the requested tools (#1192)', async () => {
    child = spawnServer(tempDir, ['--tools=explore,search,node']);
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 5000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 5000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_explore', 'codegraph_node', 'codegraph_search']);
  }, 15000);

  it('--tools accepts a single tool (regression of the default surface)', async () => {
    child = spawnServer(tempDir, ['--tools=callers']);
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 5000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 5000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_callers']);
  }, 15000);

  it('--tools= with empty value falls back to the default surface', async () => {
    // An empty --tools is treated the same as "not set" — the env var is
    // never assigned, so the default (explore-only) applies. Matches the
    // existing whitespace-only env-var behavior in toolAllowlist().
    child = spawnServer(tempDir, ['--tools=']);
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 5000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 5000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_explore']);
  }, 15000);

  it('--tools wins when both the flag and a pre-set CODEGRAPH_MCP_TOOLS are present', async () => {
    // If a user accidentally set the env var in their shell AND added the
    // --tools flag, the flag wins. This guards the documented behavior in
    // the flag's help text ("Overrides CODEGRAPH_MCP_TOOLS").
    child = spawnServer(
      tempDir,
      ['--tools=explore,impact'],
      { CODEGRAPH_MCP_TOOLS: 'explore,callers,callees' },
    );
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 5000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 5000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_explore', 'codegraph_impact']);
  }, 15000);

  it('the proxy path also honors --tools (env var set in the launcher process)', async () => {
    // The proxy path is what an MCP host actually talks to when daemon sharing
    // is on. The launcher process is the one that parses --tools and sets
    // process.env.CODEGRAPH_MCP_TOOLS; runLocalHandshakeProxy → getStaticTools
    // reads the same env var at call time. We do NOT use CODEGRAPH_NO_DAEMON
    // here — the proxy intercepts tools/list before the daemon is involved.
    // Seed a real .codegraph so the daemon machinery engages (otherwise
    // resolveDaemonRoot returns null and the server falls back to direct).
    const { CodeGraph } = await import('../src');
    const cg = await CodeGraph.init(tempDir);
    cg.close();

    const child2 = spawn(process.execPath, [BIN, 'serve', '--mcp', '--tools=explore,files'], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Don't disable the daemon — we want the proxy path.
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;
    child = child2;
    const events = tagStreams(child);
    sendRequest(child, 0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${tempDir}`,
    });
    await waitForResponse(events, 0, 10000);

    sendRequest(child, 1, 'tools/list', {});
    const reply = await waitForResponse(events, 1, 10000);
    const names = (reply.result!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['codegraph_explore', 'codegraph_files']);
  }, 25000);
});
