import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import {
  ToolHandler,
  __setLoadCodeGraphForTests,
  type ToolResult,
} from '../src/mcp/tools';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { IndexVersionWarningState } from '../src/mcp/index-version-warning';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcTransport,
} from '../src/mcp/transport';

type MetadataWriter = {
  queries: { setMetadata(key: string, value: string): void };
};

function resultText(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function stampStale(cg: CodeGraph, version = '0.1.0'): void {
  const writer = cg as unknown as MetadataWriter;
  writer.queries.setMetadata('indexed_with_version', version);
  writer.queries.setMetadata(
    'indexed_with_extraction_version',
    String(EXTRACTION_VERSION - 1),
  );
}

function fakeTransport(): JsonRpcTransport & {
  deliver(message: JsonRpcRequest): Promise<void>;
  results: unknown[];
} {
  let handler: ((message: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
  const results: unknown[] = [];
  return {
    start(next) { handler = next; },
    stop() { /* nothing to tear down */ },
    send() { /* unused */ },
    notify() { /* unused */ },
    async request() { return {}; },
    sendResult(_id, result) { results.push(result); },
    sendError() { /* unused */ },
    results,
    async deliver(message) { await handler?.(message); },
  };
}

function searchCall(id: number): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'codegraph_search', arguments: { query: 'alpha' } },
  };
}

describe('MCP index extraction-version warning (#1852)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const extraGraphs: CodeGraph[] = [];
  const extraRoots: string[] = [];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-version-'));
    fs.writeFileSync(path.join(root, 'alpha.ts'), 'export function alpha() { return 1; }\n');
    cg = await CodeGraph.init(root, { index: false });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(() => {
    __setLoadCodeGraphForTests(null);
    try { handler.closeAll(); } catch { /* best effort */ }
    for (const graph of extraGraphs) {
      try { graph.close(); } catch { /* best effort */ }
    }
    try { cg.close(); } catch { /* best effort */ }
    for (const dir of extraRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('warns once on the first successful response for a stale project', async () => {
    stampStale(cg);
    const state = new IndexVersionWarningState();

    const first = await handler.execute(
      'codegraph_search',
      { query: 'alpha' },
      undefined,
      state,
    );
    const second = await handler.execute(
      'codegraph_search',
      { query: 'alpha' },
      undefined,
      state,
    );

    expect(resultText(first)).toMatch(/index predates the running extraction engine/i);
    expect(resultText(first)).toContain('CodeGraph v0.1.0');
    expect(resultText(first)).toContain(`extraction ${EXTRACTION_VERSION - 1}`);
    expect(resultText(first)).toContain(`extraction ${EXTRACTION_VERSION}`);
    expect(resultText(first)).toContain('codegraph index');
    expect(resultText(second)).not.toMatch(/index predates the running extraction engine/i);
  });

  it('does not consume the warning on an error response', async () => {
    stampStale(cg);
    const state = new IndexVersionWarningState();

    const invalid = await handler.execute(
      'codegraph_search',
      { query: '' },
      undefined,
      state,
    );
    expect(invalid.isError).toBe(true);
    expect(resultText(invalid)).not.toMatch(/index predates/i);

    const successful = await handler.execute(
      'codegraph_search',
      { query: 'alpha' },
      undefined,
      state,
    );
    expect(resultText(successful)).toMatch(/index predates the running extraction engine/i);
  });

  it('does not warn for a current or never-indexed project', async () => {
    const current = await handler.execute(
      'codegraph_search',
      { query: 'alpha' },
      undefined,
      new IndexVersionWarningState(),
    );
    expect(resultText(current)).not.toMatch(/index predates/i);

    const currentStatus = await handler.execute(
      'codegraph_status',
      {},
      undefined,
      new IndexVersionWarningState(),
    );
    expect(resultText(currentStatus)).toContain(
      `**Index built with:** CodeGraph v`,
    );
    expect(resultText(currentStatus)).toContain(
      `**Running CodeGraph:** v`,
    );
    expect(resultText(currentStatus)).toContain(
      `**Re-index recommended:** no`,
    );

    const uninitializedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-uninitialized-'));
    extraRoots.push(uninitializedRoot);
    fs.writeFileSync(path.join(uninitializedRoot, 'pending.ts'), 'export const pending = true;\n');
    const uninitialized = await CodeGraph.init(uninitializedRoot, { index: false });
    extraGraphs.push(uninitialized);
    expect(uninitialized.isIndexStale()).toBe(false);

    const uninitializedResult = await new ToolHandler(uninitialized).execute(
      'codegraph_search',
      { query: 'pending' },
      undefined,
      new IndexVersionWarningState(),
    );
    expect(resultText(uninitializedResult)).not.toMatch(/index predates/i);

    const uninitializedStatus = await new ToolHandler(uninitialized).execute(
      'codegraph_status',
      {},
      undefined,
      new IndexVersionWarningState(),
    );
    expect(resultText(uninitializedStatus)).toContain('**Index built with:** not indexed yet');
    expect(resultText(uninitializedStatus)).toContain('**Re-index recommended:** no');
  });

  it('tracks explicit projectPath projects independently by resolved root', async () => {
    stampStale(cg, '0.1.0');
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-version-other-'));
    extraRoots.push(otherRoot);
    fs.mkdirSync(path.join(otherRoot, 'src'));
    fs.writeFileSync(path.join(otherRoot, 'src', 'bravo.ts'), 'export function bravo() { return 2; }\n');
    const other = await CodeGraph.init(otherRoot, { index: false });
    extraGraphs.push(other);
    await other.indexAll();
    stampStale(other, '0.2.0');

    const state = new IndexVersionWarningState();
    const defaultFirst = await handler.execute(
      'codegraph_search',
      { query: 'alpha' },
      undefined,
      state,
    );
    const otherFirst = await handler.execute(
      'codegraph_search',
      { query: 'bravo', projectPath: otherRoot },
      undefined,
      state,
    );
    const otherAlias = await handler.execute(
      'codegraph_search',
      { query: 'bravo', projectPath: path.join(otherRoot, 'src') },
      undefined,
      state,
    );

    expect(resultText(defaultFirst)).toContain('CodeGraph v0.1.0');
    expect(resultText(otherFirst)).toContain('CodeGraph v0.2.0');
    expect(resultText(otherAlias)).not.toMatch(/index predates/i);
  });

  it('always reports build and running versions in status', async () => {
    stampStale(cg, '0.1.0');
    const state = new IndexVersionWarningState();

    const first = await handler.execute('codegraph_status', {}, undefined, state);
    const second = await handler.execute('codegraph_status', {}, undefined, state);

    expect(resultText(first)).toMatch(/index predates the running extraction engine/i);
    for (const result of [first, second]) {
      const text = resultText(result);
      expect(text).toContain(`**Index built with:** CodeGraph v0.1.0 (extraction ${EXTRACTION_VERSION - 1})`);
      expect(text).toMatch(new RegExp(`\\*\\*Running CodeGraph:\\*\\* v.+ \\(extraction ${EXTRACTION_VERSION}\\)`));
      expect(text).toContain('**Re-index recommended:** yes — run `codegraph index`');
    }
    expect(resultText(second)).not.toMatch(/index predates the running extraction engine/i);
  });

  it('keeps warnings independent for daemon clients sharing one engine', async () => {
    stampStale(cg);
    const engine = {
      ensureInitialized: async () => { /* already initialized */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => root,
      retryInitializeSync: () => { /* already initialized */ },
      getToolHandler: () => handler,
    } as unknown as MCPEngine;
    const transportA = fakeTransport();
    const transportB = fakeTransport();
    const sessionA = new MCPSession(transportA, engine);
    const sessionB = new MCPSession(transportB, engine);
    sessionA.start();
    sessionB.start();

    await transportA.deliver(searchCall(1));
    await transportA.deliver(searchCall(2));
    await transportB.deliver(searchCall(3));

    expect(resultText(transportA.results[0] as ToolResult)).toMatch(/index predates/i);
    expect(resultText(transportA.results[1] as ToolResult)).not.toMatch(/index predates/i);
    expect(resultText(transportB.results[0] as ToolResult)).toMatch(/index predates/i);
  });
});
