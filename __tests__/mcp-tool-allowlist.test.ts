/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolHandler, getStaticTools } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
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

/**
 * CODEGRAPH_MCP_EXPLORE_SESSION_PARAM — whether explore's `sessionId` is DECLARED.
 *
 * A host hook's `updatedInput` reaches the server whether or not the property is
 * in the schema, so the declaration is off by default: it would buy the hook
 * path nothing while exposing a knob an agent could set by hand. It exists for a
 * host that validates arguments against the schema, or a harness passing it as
 * an explicit tool argument. The HANDLER is unaffected either way — the bucketing
 * tests in explore-session-state / explore-cross-call-dedup drive it directly and
 * never touch this flag.
 */
describe('CODEGRAPH_MCP_EXPLORE_SESSION_PARAM', () => {
  const PARAM = 'CODEGRAPH_MCP_EXPLORE_SESSION_PARAM';
  const original = process.env[PARAM];
  afterEach(() => {
    if (original === undefined) delete process.env[PARAM];
    else process.env[PARAM] = original;
  });

  const exploreProps = (defs: { name: string; inputSchema: { properties: Record<string, unknown> } }[]) =>
    defs.find((t) => t.name === 'codegraph_explore')!.inputSchema.properties;

  it('does not declare sessionId by default', () => {
    delete process.env[PARAM];
    expect(exploreProps(new ToolHandler(null).getTools())).not.toHaveProperty('sessionId');
    expect(exploreProps(getStaticTools())).not.toHaveProperty('sessionId');
  });

  it('declares it when the flag is set, on both served surfaces', () => {
    process.env[PARAM] = '1';
    for (const props of [exploreProps(new ToolHandler(null).getTools()), exploreProps(getStaticTools())]) {
      expect(props.sessionId).toEqual({
        type: 'string',
        description: 'Caller-context id, injected by the host\'s hooks — not set manually.',
      });
    }
    // The rest of the schema is untouched.
    expect(exploreProps(getStaticTools())).toHaveProperty('query');
    expect(exploreProps(getStaticTools())).toHaveProperty('maxFiles');
  });

  it('treats the OFF values and an empty setting as unset', () => {
    for (const value of ['0', 'false', 'off', 'no', 'OFF', '  ', '']) {
      process.env[PARAM] = value;
      expect(exploreProps(getStaticTools()), `value: ${JSON.stringify(value)}`).not.toHaveProperty('sessionId');
    }
  });

});
