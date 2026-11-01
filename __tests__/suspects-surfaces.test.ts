import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { getStaticTools, ToolHandler, tools } from '../src/mcp/tools';
import { findSuspects, suspectsToJson } from '../src/graph/suspects';
import { parseSuspectCount } from '../src/graph/suspects-options';

const envName = 'CODEGRAPH_MCP_TOOLS';

describe('suspect reports through CLI and MCP', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env[envName];
    process.env[envName] = 'explore,suspects';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspect-surfaces-'));
    fs.writeFileSync(path.join(root, 'caller.ts'), 'export function run() { helper(); }\n');
    fs.writeFileSync(path.join(root, 'helper.ts'), 'export function helper() {}\n');
    cg = await CodeGraph.init(root, { index: true });
    handler = new ToolHandler(cg);
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env[envName];
    else process.env[envName] = saved;
  });

  it('defines a read-only opt-in tool without changing the default listing', () => {
    const tool = tools.find(t => t.name === 'codegraph_suspects');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.properties).toHaveProperty('maxEdgesPerTarget');
    expect(getStaticTools().map(t => t.name)).toContain('codegraph_suspects');
    delete process.env[envName];
    try { expect(getStaticTools().map(t => t.name)).toEqual(['codegraph_explore']); }
    finally { process.env[envName] = 'explore,suspects'; }
  });

  it('executes the MCP dispatcher and agrees with the read-only core JSON', async () => {
    const result = await handler.execute('codegraph_suspects', { format: 'json', limit: 'all' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(suspectsToJson(findSuspects(root)));
  });

  it('retains counts when the sample cap is zero and accepts null defaults', async () => {
    const result = await handler.execute('codegraph_suspects', { format: 'json', limit: null, maxEdgesPerTarget: 0 });
    const report = JSON.parse(result.content[0].text);
    expect(report.suspects.length).toBeGreaterThan(0);
    expect(report.suspects.every((s: { edges: unknown[]; edgeCount: number }) => s.edges.length === 0 && s.edgeCount > 0)).toBe(true);
  });

  it.each([
    [{ limit: 0 }, 'limit must'],
    [{ limit: '1e2' }, 'limit must'],
    [{ maxEdgesPerTarget: -1 }, 'maxEdgesPerTarget must'],
    [{ format: 'yaml' }, 'format must'],
  ])('returns success-shaped argument guidance for %j', async (args, message) => {
    const result = await handler.execute('codegraph_suspects', args);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(message);
  });

  it('supports bounded counts without unsafe numeric conversion', () => {
    expect(parseSuspectCount(' ALL ', true, 1)).toBeUndefined();
    expect(parseSuspectCount('0', false, 0)).toBe(0);
    expect(() => parseSuspectCount('9007199254740992', true, 1)).toThrow();
  });

  // Real child invocations prove commander registration and isolate all global state.
  it('CLI JSON agrees with MCP and validates its own options', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspect-cli-home-'));
    const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
    try {
      const result = spawnSync(process.execPath, [cli, 'suspects', '-p', root, '--json', '--limit', 'all'], { env, encoding: 'utf8', timeout: 20000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(suspectsToJson(findSuspects(root)));
      const bad = spawnSync(process.execPath, [cli, 'suspects', '-p', root, '--edges', '-1'], { env, encoding: 'utf8', timeout: 20000 });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain('--edges must');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
