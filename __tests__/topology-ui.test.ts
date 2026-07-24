import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, startTopologyServer, TopologyServer } from '../src';

describe('repository topology UI service', () => {
  let tempDir: string | undefined;
  let graph: CodeGraph | undefined;
  let server: TopologyServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    graph?.close();
    graph = undefined;
    if (tempDir) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 50,
      });
    }
    tempDir = undefined;
  });

  async function createProject(): Promise<void> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-topology-ui-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.ts'),
      [
        'export class TopologyService {',
        '  render(): string { return "ready"; }',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'docs', 'architecture.md'),
      [
        '# Repository Topology',
        'The UI displays `TopologyService` beside this document.',
        'Read the [source](../src/service.ts).',
      ].join('\n')
    );
    graph = CodeGraph.initSync(tempDir);
    const result = await graph.indexAll();
    expect(result.success).toBe(true);
    server = await startTopologyServer(graph, { port: 0, nodeLimit: 100 });
  }

  it('serves bundled assets and a read-only protocol contract', async () => {
    await createProject();

    const page = await fetch(server!.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const pageBody = await page.text();
    expect(pageBody).toContain('CodeGraph topology');
    expect(pageBody).toContain('Repository distribution');
    expect(pageBody).toContain('data-testid="group-distribution"');

    const script = await fetch(`${server!.url}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const scriptBody = await script.text();
    expect(scriptBody).toContain('/api/graph');
    expect(scriptBody).toContain('function semanticRole');
    expect(scriptBody).toContain('function splitTreemap');

    const contract = await fetch(`${server!.url}/api/contract`).then((response) =>
      response.json()
    );
    expect(contract.readOnly).toBe(true);
    expect(contract.nodeKinds).toContain('section');
    expect(contract.edgeKinds).toContain('references');
  });

  it('returns exact persisted nodes and induced edges in a bounded snapshot', async () => {
    await createProject();

    const response = await fetch(`${server!.url}/api/graph?limit=100`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    const ids = new Set<string>(payload.nodes.map((node: { id: string }) => node.id));
    expect(payload.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'TopologyService' }),
        expect.objectContaining({ kind: 'section', name: 'Repository Topology' }),
      ])
    );
    expect(payload.edges.length).toBeGreaterThan(0);
    for (const edge of payload.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
      expect(graph!.getOutgoingEdges(edge.source)).toContainEqual(edge);
    }
    expect(payload.stats.nodeCount).toBeGreaterThanOrEqual(payload.nodes.length);
    expect(payload.truncated).toBe(false);
  });

  it('searches the full graph and inspects persisted incoming and outgoing relationships', async () => {
    await createProject();

    const searchResponse = await fetch(
      `${server!.url}/api/search?q=${encodeURIComponent('TopologyService')}`
    );
    expect(searchResponse.status).toBe(200);
    const searchPayload = await searchResponse.json();
    const service = searchPayload.results.find(
      (result: { node: { name: string } }) => result.node.name === 'TopologyService'
    )?.node;
    expect(service).toBeDefined();

    const nodeResponse = await fetch(
      `${server!.url}/api/node?id=${encodeURIComponent(service.id)}`
    );
    expect(nodeResponse.status).toBe(200);
    const nodePayload = await nodeResponse.json();
    expect(nodePayload.node.id).toBe(service.id);
    expect(nodePayload.totalIncoming + nodePayload.totalOutgoing).toBeGreaterThan(0);
    expect(nodePayload.neighbors.length).toBeGreaterThan(0);
  });

  it('validates filters and rejects mutation requests', async () => {
    await createProject();

    const invalidKind = await fetch(`${server!.url}/api/graph?kinds=not-a-kind`);
    expect(invalidKind.status).toBe(400);
    expect(await invalidKind.json()).toEqual({ error: 'Unknown node kind' });

    const mutation = await fetch(`${server!.url}/api/stats`, { method: 'POST' });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('allow')).toBe('GET, HEAD');
  });
});
