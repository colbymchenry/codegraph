/**
 * Source string index tests
 *
 * Exact code-like string literals should be queryable even when the string is
 * not a symbol name in the caller repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('source string index', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-source-strings-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'client.ts'),
      `export async function sendPayload(payload: unknown): Promise<Response> {
  return fetch('/live-scoring/append-event', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function saveRecord(createItem: (collection: string) => Promise<unknown>): Promise<unknown> {
  return createItem('game_matches');
}

export function genericText(): string {
  return 'plain sentence that should not be indexed';
}

export function dynamicRoute(id: string): string {
  return \`/live-scoring/\${id}\`;
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'bridge.ts'),
      `export function postBridgeEvent(postMessage: (event: string) => void): void {
  postMessage('unity.score.updated');
}
`
    );

    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['**/*.ts'],
        exclude: [],
      },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('indexes exact code-like string literals with file line and enclosing symbol', () => {
    const routeHits = cg.searchSourceStrings('/live-scoring/append-event');

    expect(routeHits).toHaveLength(1);
    expect(routeHits[0]).toMatchObject({
      literal: '/live-scoring/append-event',
      filePath: 'src/client.ts',
      line: 2,
      nodeName: 'sendPayload',
      nodeKind: 'function',
    });

    const collectionHits = cg.searchSourceStrings('game_matches');
    expect(collectionHits).toHaveLength(1);
    expect(collectionHits[0]).toMatchObject({
      literal: 'game_matches',
      filePath: 'src/client.ts',
      line: 9,
      nodeName: 'saveRecord',
      nodeKind: 'function',
    });
  });

  it('does not index plain prose strings', () => {
    expect(cg.searchSourceStrings('plain sentence that should not be indexed')).toHaveLength(0);
  });

  it('does not index dynamic template strings as exact literals', () => {
    expect(cg.searchSourceStrings('/live-scoring/${id}')).toHaveLength(0);
  });

  it('supports FTS term lookup without weakening exact literal lookup', () => {
    const ftsHits = cg.searchSourceStrings('live scoring append');
    expect(ftsHits[0]).toMatchObject({
      literal: '/live-scoring/append-event',
      nodeName: 'sendPayload',
    });

    expect(cg.searchSourceStrings('/live-scoring/append')).toHaveLength(0);
  });

  it('uses source-string hits as search and context entry points', async () => {
    const searchHits = cg.searchNodes('/live-scoring/append-event', { limit: 5 });
    expect(searchHits[0]?.node.name).toBe('sendPayload');
    expect(searchHits[0]?.sourceString).toMatchObject({
      literal: '/live-scoring/append-event',
      line: 2,
    });

    const context = await cg.findRelevantContext('game_matches', {
      searchLimit: 3,
      traversalDepth: 0,
    });
    const rootNames = context.roots.map((id) => context.nodes.get(id)?.name);
    expect(rootNames).toContain('saveRecord');
  });

  it('surfaces exact source-string sites through the MCP search and explore paths', async () => {
    const handler = new ToolHandler(cg);

    const search = await handler.execute('codegraph_search', {
      query: '/live-scoring/append-event',
      limit: 5,
    });
    expect(search.content[0]?.text).toContain('sendPayload');
    expect(search.content[0]?.text).toContain('source string `/live-scoring/append-event` at src/client.ts:2');

    const explore = await handler.execute('codegraph_explore', {
      query: 'unity.score.updated',
      maxFiles: 3,
    });
    expect(explore.content[0]?.text).toContain('postBridgeEvent');
    expect(explore.content[0]?.text).toContain("postMessage('unity.score.updated')");
  });

  it('replaces source-string rows when files change during sync', async () => {
    const clientPath = path.join(testDir, 'src', 'client.ts');
    fs.writeFileSync(
      clientPath,
      `export async function sendPayload(payload: unknown): Promise<Response> {
  return fetch('/live-scoring/v2/append-event', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
`
    );

    await cg.sync();

    expect(cg.searchSourceStrings('/live-scoring/append-event')).toHaveLength(0);
    const replacementHits = cg.searchSourceStrings('/live-scoring/v2/append-event');
    expect(replacementHits).toHaveLength(1);
    expect(replacementHits[0]).toMatchObject({
      filePath: 'src/client.ts',
      line: 2,
      nodeName: 'sendPayload',
    });
  });

  it('clears source-string rows with the graph data', () => {
    expect(cg.searchSourceStrings('/live-scoring/append-event')).toHaveLength(1);

    cg.clear();

    expect(cg.searchSourceStrings('/live-scoring/append-event')).toHaveLength(0);
    expect(cg.searchNodes('/live-scoring/append-event')).toHaveLength(0);
  });
});
