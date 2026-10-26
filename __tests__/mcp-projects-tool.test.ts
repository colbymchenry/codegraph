/**
 * `codegraph_projects` — the discovery tool behind issue #769.
 *
 * A CodeGraph index lives inside its project, so an agent that starts outside
 * one (a gateway server, a monorepo root) has no way to learn which projects
 * exist. This tool is deliberately project-free: it answers with NO default
 * project loaded, which is exactly the case that makes it worth calling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler, getStaticTools } from '../src/mcp/tools';
import { PROJECTS_REGISTRY_ENV, registerProject } from '../src/project-registry';

const MCP_ENV = 'CODEGRAPH_MCP_TOOLS';

describe('codegraph_projects MCP tool', () => {
  let tempDir: string;
  let registryPath: string;
  let projectA: string;
  let projectB: string;
  let cg: CodeGraph | null = null;
  const originalRegistry = process.env[PROJECTS_REGISTRY_ENV];
  const originalTools = process.env[MCP_ENV];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-projects-'));
    registryPath = path.join(tempDir, 'home', '.codegraph', 'projects.json');
    process.env[PROJECTS_REGISTRY_ENV] = registryPath;
    delete process.env[MCP_ENV];

    projectA = path.join(tempDir, 'alpha');
    projectB = path.join(tempDir, 'beta');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    fs.writeFileSync(
      path.join(projectA, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    fs.writeFileSync(path.join(projectB, 'auth.ts'), 'export function validateToken(t: string): boolean { return !!t; }\n');
  });

  afterEach(() => {
    try {
      cg?.close();
    } catch {
      /* already closed */
    }
    cg = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalRegistry === undefined) delete process.env[PROJECTS_REGISTRY_ENV];
    else process.env[PROJECTS_REGISTRY_ENV] = originalRegistry;
    if (originalTools === undefined) delete process.env[MCP_ENV];
    else process.env[MCP_ENV] = originalTools;
  });

  const textOf = (res: { content: Array<{ text: string }> }) => res.content[0]!.text;

  it('is on the default surface (static proxy and live handler)', () => {
    expect(getStaticTools().map((t) => t.name)).toContain('codegraph_projects');
    expect(new ToolHandler(null).getTools().map((t) => t.name)).toContain('codegraph_projects');
  });

  it('stays listed on a tiny project (size gating only trims query tools)', async () => {
    cg = await CodeGraph.init(projectA, { index: true });
    const names = new ToolHandler(cg).getTools().map((t) => t.name);
    expect(names).toContain('codegraph_projects');
    expect(names).toContain('codegraph_explore');
  });

  it('lists an indexed project with stats, timestamp and up-to-date status', async () => {
    cg = await CodeGraph.init(projectA, { index: true });
    cg.close();
    cg = null;
    registerProject(projectA);

    const res = await new ToolHandler(null).execute('codegraph_projects', {});

    expect(res.isError).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain('**CodeGraph Projects** — 1 registered');
    expect(text).toContain(`Registry: ${path.resolve(registryPath)}`);
    expect(text).toContain(path.resolve(projectA));
    expect(text).toMatch(/Status: up to date/);
    expect(text).toMatch(/Last indexed: \d{4}-\d{2}-\d{2}T/);
    expect(text).toMatch(/Files: [\d,]+, nodes: [\d,]+, edges: [\d,]+/);
    expect(text).toContain('Pass any of these paths as `projectPath`');
  });

  it('surfaces pending changes as out of date', async () => {
    cg = await CodeGraph.init(projectA, { index: true });
    cg.close();
    cg = null;
    fs.writeFileSync(
      path.join(projectA, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 10; }\n'
    );
    registerProject(projectA);

    const text = textOf(await new ToolHandler(null).execute('codegraph_projects', {}));
    expect(text).toMatch(/Status: out of date — 1 modified/);
  });

  it('reports a registry entry whose index was deleted as not indexed', async () => {
    registerProject(projectB);

    const text = textOf(await new ToolHandler(null).execute('codegraph_projects', {}));
    expect(text).toContain(path.resolve(projectB));
    expect(text).toMatch(/Status: not indexed/);
  });

  it('guides the agent when no project is registered', async () => {
    const res = await new ToolHandler(null).execute('codegraph_projects', {});

    expect(res.isError).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain('**CodeGraph Projects** — 0 registered');
    expect(text).toContain('No CodeGraph projects are registered on this machine yet.');
    expect(text).toMatch(/codegraph init/);
  });

  it('warns about a corrupt registry without failing the call', async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{ broken');

    const res = await new ToolHandler(null).execute('codegraph_projects', {});

    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain('The registry is not valid JSON');
    expect(textOf(res)).toContain('No CodeGraph projects are registered');
  });

  it('reuses the default project instance instead of opening a second connection', async () => {
    cg = await CodeGraph.init(projectA, { index: true });
    registerProject(projectA);

    const openSpy = vi.spyOn(CodeGraph, 'openSync');
    try {
      const text = textOf(await new ToolHandler(cg).execute('codegraph_projects', {}));
      expect(text).toMatch(/Status: up to date/);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }

    // The session's instance is still the caller's to use.
    expect(() => cg!.getStats()).not.toThrow();
  });
});
