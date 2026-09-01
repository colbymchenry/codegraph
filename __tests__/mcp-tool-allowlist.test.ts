/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolHandler } from '../src/mcp/tools';
import type CodeGraph from '../src';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const REQUIRE_PROJECT_PATH_ENV = 'CODEGRAPH_MCP_REQUIRE_PROJECT_PATH';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const original = process.env[ENV];
  const originalRequireProjectPath = process.env[REQUIRE_PROJECT_PATH_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
    if (originalRequireProjectPath === undefined) delete process.env[REQUIRE_PROJECT_PATH_ENV];
    else process.env[REQUIRE_PROJECT_PATH_ENV] = originalRequireProjectPath;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('exposes ONLY codegraph_explore by default when unset', () => {
    delete process.env[ENV];
    // The default set (see DEFAULT_MCP_TOOLS) is pared to explore alone — the one
    // tool that earns its place (verbatim source grouped by file).
    // node/search/callers/callees/impact/files/status stay defined and executable
    // but unlisted; CODEGRAPH_MCP_TOOLS re-enables them.
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('re-enables an unlisted tool via the allowlist (impact)', () => {
    process.env[ENV] = 'explore,impact';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_impact']);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[ENV] = 'explore,search,node';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_node', 'codegraph_search']);
  });

  it('accepts fully-qualified codegraph_ names and ignores whitespace', () => {
    process.env[ENV] = ' codegraph_explore , search ';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_search']);
  });

  it('treats an empty/whitespace value as unset (default surface)', () => {
    process.env[ENV] = '   ';
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'node';
    const res = await new ToolHandler(null).execute('codegraph_explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No CodeGraph attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
  });
});

describe('CODEGRAPH_MCP_REQUIRE_PROJECT_PATH', () => {
  const original = process.env[REQUIRE_PROJECT_PATH_ENV];
  const cgStub = {
    getStats: () => ({ fileCount: 10 }),
  } as unknown as CodeGraph;

  afterEach(() => {
    if (original === undefined) delete process.env[REQUIRE_PROJECT_PATH_ENV];
    else process.env[REQUIRE_PROJECT_PATH_ENV] = original;
    delete process.env[ENV];
  });

  it('marks projectPath required in exposed tool schemas', () => {
    process.env[REQUIRE_PROJECT_PATH_ENV] = 'true';
    const explore = new ToolHandler(null).getTools().find((tool) => tool.name === 'codegraph_explore');
    expect(explore?.inputSchema.required).toContain('query');
    expect(explore?.inputSchema.required).toContain('projectPath');
  });

  it('marks projectPath required even when a default project exists', () => {
    process.env[REQUIRE_PROJECT_PATH_ENV] = 'true';
    const explore = new ToolHandler(cgStub).getTools().find((tool) => tool.name === 'codegraph_explore');
    expect(explore?.inputSchema.required).toContain('query');
    expect(explore?.inputSchema.required).toContain('projectPath');
  });

  it('rejects tool calls that omit projectPath when required', async () => {
    process.env[REQUIRE_PROJECT_PATH_ENV] = 'true';
    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'alpha' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/projectPath is required/);
  });

  it('keeps normal validation after projectPath is provided', async () => {
    process.env[REQUIRE_PROJECT_PATH_ENV] = 'true';
    const res = await new ToolHandler(null).execute('codegraph_explore', {
      query: 'alpha',
      projectPath: '/tmp/project',
    });
    expect(res.content[0].text).not.toMatch(/projectPath is required/);
  });
});
