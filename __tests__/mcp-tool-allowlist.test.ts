/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('exposes the full tool surface when unset', () => {
    delete process.env[ENV];
    const all = listed();
    expect(all).toContain('codegraph_explore');
    expect(all).toContain('codegraph_context');
    expect(all).toContain('codegraph_trace');
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[ENV] = 'trace,search,node';
    expect(listed()).toEqual(['codegraph_node', 'codegraph_search', 'codegraph_trace']);
  });

  it('accepts fully-qualified codegraph_ names and ignores whitespace', () => {
    process.env[ENV] = ' codegraph_trace , search ';
    expect(listed()).toEqual(['codegraph_search', 'codegraph_trace']);
  });

  it('treats an empty/whitespace value as unset (full surface)', () => {
    process.env[ENV] = '   ';
    expect(listed().length).toBeGreaterThanOrEqual(10);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'trace';
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
