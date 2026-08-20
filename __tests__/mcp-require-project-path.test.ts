/**
 * No-default-project → projectPath is `required` in the tool schema (issue #993).
 *
 * When the MCP server has no default project to fall back to — a gateway server
 * started outside any repo, or a monorepo root whose `.codegraph/` indexes live
 * only in sub-projects — every tool call MUST carry an explicit `projectPath`.
 * `ToolHandler.getTools()` reflects that by marking `projectPath` required in the
 * exposed schemas, a high-salience nudge that gets the agent to pass it on the
 * first call instead of omitting it (the reported behavior). When a default
 * project IS open, projectPath stays optional: a bare call falls back to it.
 *
 * The change is schema-only — the runtime stays exactly as before: a missing
 * projectPath with no default still returns SUCCESS-shaped guidance (never
 * `isError`), and a missing projectPath WITH a default still falls back to it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, tools } from '../src/mcp/tools';
import { CodeGraph } from '../src';

const ENV = 'CODEGRAPH_MCP_TOOLS';

const exploreOf = (defs: { name: string; inputSchema: { required?: string[] } }[]) =>
  defs.find((t) => t.name === 'codegraph_explore')!;

describe('No-default-project requires projectPath in the schema (#993)', () => {
  const originalAllowlist = process.env[ENV];
  afterEach(() => {
    if (originalAllowlist === undefined) delete process.env[ENV];
    else process.env[ENV] = originalAllowlist;
  });

  it('marks projectPath required on codegraph_explore when no default project is loaded', () => {
    const explore = exploreOf(new ToolHandler(null).getTools());
    expect(explore.inputSchema.required).toContain('projectPath');
    // The tool's own required arg is preserved, not replaced.
    expect(explore.inputSchema.required).toContain('query');
  });

  it('requires projectPath on EVERY exposed tool, incl. ones with no prior required list', () => {
    // status has no `required` array of its own → it should gain ['projectPath'].
    process.env[ENV] = 'explore,node,status';
    const got = new ToolHandler(null).getTools();
    expect(got.map((t) => t.name).sort()).toEqual([
      'codegraph_explore',
      'codegraph_node',
      'codegraph_status',
    ]);
    for (const t of got) {
      expect(t.inputSchema.required ?? []).toContain('projectPath');
    }
  });

  it('does NOT mutate the shared module-level tools array (purity)', () => {
    // Marking required must clone — otherwise a no-default session would corrupt
    // the schema every later default-project session reuses.
    new ToolHandler(null).getTools();
    expect(exploreOf(tools).inputSchema.required).toEqual(['query']);
  });

  it('a missing projectPath with no default is still SUCCESS-shaped guidance, not isError', async () => {
    // Schema-only change: the runtime backstop is unchanged. A client that
    // ignores `required` still gets the nudge, never a session-souring isError.
    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'anything' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/No CodeGraph project is loaded/);
    expect(res.content[0]!.text).toMatch(/projectPath/);
  });
});

describe('A default project keeps projectPath OPTIONAL (#993)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reqpath-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves projectPath optional when a default project is loaded', () => {
    const explore = exploreOf(new ToolHandler(cg).getTools());
    expect(explore.inputSchema.required).toEqual(['query']);
    expect(explore.inputSchema.required).not.toContain('projectPath');
  });

  it('a bare call (no projectPath) still falls back to the default project', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'processPayment' });
    expect(res.isError).toBeUndefined();
    // Resolved against the default project — not the no-default guidance.
    expect(res.content[0]!.text).not.toMatch(/No CodeGraph project is loaded/);
    expect(res.content[0]!.text).toMatch(/processPayment/);
  });
});
