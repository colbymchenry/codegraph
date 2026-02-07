/**
 * MCP tool disambiguation tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('MCP ToolHandler', () => {
  let testDir: string;
  let cg: CodeGraph;
  let tools: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-test-'));

    fs.mkdirSync(path.join(testDir, 'src', 'session'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'cli', 'cmd', 'tui', 'routes', 'session'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testDir, 'src', 'sdk', 'js', 'src', 'v2', 'gen'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'web'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'backend', 'routers'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'src', 'frontend', 'components'), { recursive: true });

    fs.writeFileSync(
      path.join(testDir, 'src', 'session', 'prompt.ts'),
      `
export function start(): void {}

export function loop(): void {
  start();
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'mcp', 'oauth.ts'),
      `
export function start(): void {}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'cli', 'cmd', 'tui', 'routes', 'session', 'index.tsx'),
      `
export function Session() {
  return null;
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'web', 'session.ts'),
      `
export function Session() {
  return 1;
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'sdk', 'js', 'src', 'v2', 'gen', 'session.gen.ts'),
      `
export function Session() {
  return 'sdk';
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'backend', 'routers', 'auth.ts'),
      `
export function getAuthEndpoint() {
  return '/api/auth';
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'frontend', 'components', 'auth.ts'),
      `
export function renderAuthWidget() {
  return 'auth-widget';
}
`
    );

    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [],
      },
    });

    await cg.indexAll();
    await cg.resolveReferences();
    tools = new ToolHandler(cg, 'test-version');
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns ambiguity details for duplicate symbol names', async () => {
    const result = await tools.execute('node', { symbol: 'Session' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Ambiguous symbol "Session"');
    expect(text).toContain('pathHint');
    expect(text).toContain('src/cli/cmd/tui/routes/session/index.tsx');
    expect(text).toContain('src/web/session.ts');
    expect(text).toContain('Suggested retries:');
    expect(text).toContain('node(symbol="Session"');
  });

  it('disambiguates node lookup with pathHint', async () => {
    const result = await tools.execute('node', {
      symbol: 'Session',
      kind: 'function',
      pathHint: 'cli/cmd/tui',
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('src/cli/cmd/tui/routes/session/index.tsx');
    expect(text).toContain('## Session (function)');
  });

  it('disambiguates callers lookup with pathHint', async () => {
    const ambiguous = await tools.execute('callers', { symbol: 'start' });
    const ambiguousText = ambiguous.content[0]?.text ?? '';
    expect(ambiguousText).toContain('Ambiguous symbol "start"');

    const resolved = await tools.execute('callers', {
      symbol: 'start',
      kind: 'function',
      pathHint: 'src/session',
    });
    const resolvedText = resolved.content[0]?.text ?? '';

    expect(resolvedText).toContain('Callers of start');
    expect(resolvedText).toContain('loop');
  });

  it('supports codegraph_search path and language filters', async () => {
    const result = await tools.execute('search', {
      query: 'Session',
      includeFiles: true,
      pathHint: 'cli/cmd/tui',
      language: 'tsx',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('src/cli/cmd/tui/routes/session/index.tsx');
    expect(text).not.toContain('src/web/session.ts');
  });

  it('applies context auto-scoping defaults when filters are omitted', async () => {
    const result = await tools.execute('context', {
      task: 'trace how tui session routes submit prompts',
      maxNodes: 10,
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Auto-scope applied');
    expect(text).toContain('pathHint=');
  });

  it('auto-scope path inference avoids generated sdk paths for app-flow tasks', async () => {
    const result = await tools.execute('context', {
      task: 'trace tui session route flow and updates',
      maxNodes: 10,
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Auto-scope applied');
    expect(text).toMatch(/pathHint=.*(session|cli|tui|routes)/i);
    expect(text).not.toMatch(/pathHint=.*sdk\/js\/src\/v2\/gen/i);
  });

  it('finds high-quality app symbols for broad search without explicit pathHint', async () => {
    const result = await tools.execute('search', {
      query: 'tui session',
      kind: 'function',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('src/cli/cmd/tui/routes/session/index.tsx');
  });

  it('auto-scopes broad search queries when kind/language are omitted', async () => {
    const result = await tools.execute('search', {
      query: 'trace tui session route flow',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Auto-scoped search');
    expect(text).toContain('src/cli/cmd/tui/routes/session/index.tsx');
  });

  it('keeps discovery-oriented context broad by default', async () => {
    const result = await tools.execute('context', {
      task: 'give me a high level architecture overview and entry points',
      maxNodes: 10,
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Auto-scope applied');
  });

  it('keeps discovery-oriented search broad by default', async () => {
    const result = await tools.execute('search', {
      query: 'session overview',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Auto-scoped search');
    expect(text).toContain('session');
  });

  it('returns retry hints when search has no results', async () => {
    const result = await tools.execute('search', {
      query: 'definitely_missing_symbol_xyz',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('No results found');
    expect(text).toContain('Suggested retries:');
    expect(text).toContain('search(');
    expect(text).toContain('context(');
  });

  it('provides API-focused retry guidance when search intent is api', async () => {
    const result = await tools.execute('search', {
      query: 'GET /definitely/missing',
      intent: 'api',
      limit: 10,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('No results found');
    expect(text).toContain('kind="route"');
    expect(text).toContain('intent="api"');
  });

  it('returns retry hints when symbol lookup fails', async () => {
    const result = await tools.execute('node', {
      symbol: 'definitely_missing_symbol_xyz',
      kind: 'function',
      pathHint: 'src/session',
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('not found');
    expect(text).toContain('Suggested retries:');
    expect(text).toContain('search(');
  });

  it('accepts legacy codegraph_* tool names as aliases', async () => {
    const result = await tools.execute('codegraph_search', {
      query: 'Session',
      limit: 5,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Session');
  });

  it('includes version in status output', async () => {
    const result = await tools.execute('status', {});
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('## CodeGraph Status');
    expect(text).toContain('**Version:** test-version');
  });

  it('supports importing SCIP semantic data', async () => {
    const scipPath = path.join(testDir, 'index.scip.json');
    fs.writeFileSync(scipPath, JSON.stringify({ documents: [] }), 'utf-8');

    const result = await tools.execute('import_scip', { path: scipPath });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('## SCIP Import Complete');
    expect(text).toContain('Imported edges: 0');
  });

  it('applies api intent defaults for context queries', async () => {
    const result = await tools.execute('context', {
      task: 'map api endpoints and handlers',
      intent: 'api',
      maxNodes: 10,
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Auto-scope applied');
    expect(text).toContain('intent=api');
  });

  it('prefers backend route path hints for api intent', async () => {
    const result = await tools.execute('context', {
      task: 'map auth api endpoints and handlers',
      intent: 'api',
      maxNodes: 10,
      includeCode: false,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Auto-scope applied');
    expect(text).toMatch(/pathHint=.*(backend\/routers|server\/routes|api|routes)/i);
    expect(text).not.toMatch(/pathHint=.*frontend\/components/i);
  });
});
