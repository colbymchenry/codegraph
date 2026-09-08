/**
 * The `codegraph ui` read-only JSON API (CG-42).
 *
 * Everything runs against a real indexed fixture project over a real loopback
 * server — no mocks — because the properties worth pinning are the ones that
 * only exist end to end: the drift verdict comes from hashing bytes on disk
 * against what the index stored, the refusals come from the same chokepoint the
 * static server uses, and the caps only matter once a symbol really does have
 * hundreds of callers.
 *
 * The fixture is built to produce each of those: a call chain three deep, a
 * test file that reaches it, a type used only as a type, an import that cannot
 * resolve, and one deliberately hot function with 500 callers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;
let viewerDir: string;

/**
 * One request against a live server, with the loopback `Host` the boundary
 * wants. Written with `http.request` rather than `fetch` so the `Host` header
 * is ours to set — undici treats it as forbidden.
 */
function requestOn(port: number, requestPath: string, method = 'GET'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: { Host: `127.0.0.1:${port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** The same, against the main fixture's server. */
function request(requestPath: string, method = 'GET'): Promise<Response> {
  return requestOn(server.port, requestPath, method);
}

/**
 * Payloads are read as `any` on purpose: these tests assert the JSON contract
 * the viewer sees over the wire, so typing them against the server's own
 * interfaces would only prove the server agrees with itself.
 */
async function getJson(requestPath: string): Promise<any> {
  const res = await request(requestPath);
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  return JSON.parse(res.body);
}

async function getStatusAndJson(requestPath: string): Promise<{ status: number; body: any }> {
  const res = await request(requestPath);
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  return { status: res.status, body: JSON.parse(res.body) };
}

/** Find a symbol in the fixture by name, through the API itself. */
async function idOf(name: string, kind?: string): Promise<string> {
  const search = await getJson(`/api/search?q=${encodeURIComponent(name)}`);
  const hit = search.results.items.find(
    (r: any) => r.name === name && (kind === undefined || r.kind === kind)
  );
  expect(hit, `no ${kind ?? 'symbol'} named ${name} in the fixture`).toBeTruthy();
  return hit.id as string;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-api-'));
  projectRoot = path.join(tempDir, 'project');
  const srcDir = path.join(projectRoot, 'src');
  const testsDir = path.join(projectRoot, '__tests__');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, 'types.ts'),
    `export interface Config {
  ttlMs: number;
  label: string;
}

export type CacheKey = string;
`
  );

  fs.writeFileSync(
    path.join(srcDir, 'cache.ts'),
    `import { Config, CacheKey } from './types';

export class Cache {
  private store = new Map<string, string>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  read(key: CacheKey): string | undefined {
    return this.store.get(key);
  }

  write(key: CacheKey, value: string): void {
    this.store.set(key, value);
  }
}
`
  );

  fs.writeFileSync(
    path.join(srcDir, 'service.ts'),
    `import { Cache } from './cache';
import { Config } from './types';
// Not in the index: a package that was never installed here.
import { serialize } from 'some-external-package';

export class Service {
  private cache: Cache;

  constructor(config: Config) {
    this.cache = new Cache(config);
  }

  load(key: string): string {
    const hit = this.cache.read(key);
    if (hit !== undefined) return hit;
    const fresh = serialize(key);
    this.cache.write(key, fresh);
    return fresh;
  }
}
`
  );

  fs.writeFileSync(
    path.join(srcDir, 'handler.ts'),
    `import { Service } from './service';

export function handleRequest(service: Service, key: string): string {
  return service.load(key);
}
`
  );

  // Module-level statements: the engine records them as edges out of the FILE
  // node, which is the only reason `/api/entrypoints` can see an executable
  // root at all. Nothing else in the fixture runs anything on the way down.
  fs.writeFileSync(
    path.join(srcDir, 'main.ts'),
    `import { Service } from './service';
import { handleRequest } from './handler';

const service = new Service({ ttlMs: 5, label: 'main' });
const first = handleRequest(service, 'boot');
const second = service.load('warm');

export const started = [first, second];
`
  );

  // 500 callers into one function: the N+1 and capping behaviour only shows up
  // at this scale, and the fixture keeps CI honest without needing the engine's
  // own index to be present.
  const callers = Array.from(
    { length: 500 },
    (_, i) => `export function caller${i}(): number {\n  return hot(${i});\n}`
  ).join('\n\n');
  fs.writeFileSync(
    path.join(srcDir, 'hot.ts'),
    `export function hot(n: number): number {
  return n * 2;
}

${callers}
`
  );

  // CRLF on purpose: tree-sitter numbers rows by `\n`, so a CRLF file must come
  // back with the same line numbers the graph recorded — and without the stray
  // `\r` rendering at the end of every line. This is what a Windows checkout
  // with core.autocrlf looks like, and it is decided by bytes, not by the OS.
  fs.writeFileSync(
    path.join(srcDir, 'crlf.ts'),
    ['export function windowsStyle(n: number): number {', '  return n + 1;', '}', ''].join('\r\n')
  );

  fs.writeFileSync(
    path.join(testsDir, 'service.test.ts'),
    `import { Service } from '../src/service';

export function testLoadsThroughCache(): void {
  const service = new Service({ ttlMs: 1, label: 'x' });
  service.load('k');
}

// Module level, on purpose: a test file that RUNS something must still be
// excluded from the entry points.
testLoadsThroughCache();
`
  );

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', '__tests__/**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
  // Hand the index over: the API opens its own read-only connection, which is
  // also what happens in production (the CLI never shares an instance).
  cg.close();

  viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  api?.close();
  await server?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api', () => {
  it('lists the endpoints it answers', async () => {
    const body = await getJson('/api');
    // Not a blanket claim any more (CG-60): saved trails are the one thing
    // this server writes, and it names it rather than implying there is none.
    expect(body.readOnly).toBe(false);
    expect(body.writes).toEqual(['POST /api/trails', 'DELETE /api/trails/<id>']);
    const paths = body.endpoints.map((e: any) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/stats',
        '/api/search',
        '/api/node/<id>',
        '/api/source',
        '/api/file/<path>',
        '/api/routes',
      ])
    );
  });

  it('404s an unknown endpoint as JSON, never as the app shell', async () => {
    const { status, body } = await getStatusAndJson('/api/nope');
    expect(status).toBe(404);
    expect(body.code).toBe('not-found');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await request('/api/stats', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(res.body).toBe('');
  });
});

describe('GET /api/stats', () => {
  it('reports the project, the index state and the graph counts', async () => {
    const body = await getJson('/api/stats');

    expect(body.project.root).toBe(projectRoot);
    expect(body.project.name).toBe('project');

    expect(body.index.state).toBe('complete');
    expect(body.index.stale).toBe(false);
    expect(typeof body.index.lastIndexedAt).toBe('number');
    expect(body.index.backend).toBe('node-sqlite');
    expect(typeof body.index.extractionVersion).toBe('number');

    expect(body.graph.nodes).toBeGreaterThan(0);
    expect(body.graph.edges).toBeGreaterThan(0);
    expect(body.graph.files).toBeGreaterThanOrEqual(6);
    expect(body.graph.nodesByKind.class).toBeGreaterThanOrEqual(2);
    expect(body.graph.filesByLanguage.typescript).toBeGreaterThanOrEqual(6);

    // The thresholds travel with the data so the viewer's copy cannot drift.
    expect(body.thresholds).toEqual({ hub: 40, uncertainBelow: 0.6 });
  });

  it('reports a blast-radius scale the widest symbol in the index reaches', async () => {
    const body = await getJson('/api/stats');
    const scale = body.blastScale;

    // `hot` is called by 500 distinct functions and nothing else in the fixture
    // comes close, so the exact maximum is knowable here.
    expect(scale.maxDirect).toBe(500);
    // Its radius is at least its own callers; the sample is capped, so the
    // count is a floor and the flag says so rather than claiming exhaustive.
    expect(scale.maxWithinHops).toBeGreaterThanOrEqual(500);
    expect(scale.hops).toBe(3);
    expect(scale.sampled).toBeGreaterThan(0);
    expect(scale.sampled).toBeLessThanOrEqual(24);
    expect(scale.estimated).toBe(true);
  });

  it('serves the scale from cache — the second call does not re-traverse', async () => {
    const first = await getJson('/api/stats');
    const started = Date.now();
    const second = await getJson('/api/stats');
    expect(second.blastScale).toEqual(first.blastScale);
    // 24 depth-3 traversals over a 500-caller graph are not free; a cached
    // answer is. The margin is wide because this is a smoke test for the
    // memo existing at all, not a benchmark.
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe('GET /api/search', () => {
  it('ranks exact over prefix over substring, and groups by kind', async () => {
    const body = await getJson('/api/search?q=Cache');

    const first = body.results.items[0];
    expect(first.name).toBe('Cache');
    expect(first.kind).toBe('class');
    expect(first.matchKind).toBe('exact');

    const ranks = body.results.items.map((r: any) => r.matchKind);
    const order = ['exact', 'prefix', 'substring', 'qualified', 'file', 'related'];
    const asNumbers = ranks.map((r: string) => order.indexOf(r));
    expect(asNumbers).toEqual([...asNumbers].sort((a, b) => a - b));

    // Flattening the groups reproduces the flat ranking, so the palette can use
    // either without them disagreeing.
    const flattened = body.groups.flatMap((g: any) => g.items.map((i: any) => i.id));
    expect(new Set(flattened)).toEqual(new Set(body.results.items.map((r: any) => r.id)));
    for (const group of body.groups) expect(group.count).toBe(group.items.length);
  });

  it('returns a signature and a file:line for every result', async () => {
    const body = await getJson('/api/search?q=handleRequest');
    const hit = body.results.items.find((r: any) => r.name === 'handleRequest');
    expect(hit.file).toBe('src/handler.ts');
    expect(hit.line).toBeGreaterThan(0);
    expect(hit.endLine).toBeGreaterThanOrEqual(hit.line);
    expect(hit.signature).toContain('service');
    expect(hit.qualifiedName).toBeTruthy();
    expect(hit.language).toBe('typescript');
  });

  it('finds a mid-name match FTS tokens cannot', async () => {
    const body = await getJson('/api/search?q=quest');
    const names = body.results.items.map((r: any) => r.name);
    expect(names).toContain('handleRequest');
    const hit = body.results.items.find((r: any) => r.name === 'handleRequest');
    expect(hit.matchKind).toBe('substring');
  });

  it('honours the kind: filter grammar', async () => {
    const body = await getJson('/api/search?q=' + encodeURIComponent('kind:class Cache'));
    expect(body.filters.kinds).toEqual(['class']);
    expect(body.results.items.every((r: any) => r.kind === 'class')).toBe(true);
  });

  it('marks test files so the palette can rank them down', async () => {
    const body = await getJson('/api/search?q=testLoadsThroughCache');
    const hit = body.results.items.find((r: any) => r.name === 'testLoadsThroughCache');
    expect(hit.test).toBe(true);
  });

  it('answers an empty search box with nothing, and a missing q with 400', async () => {
    const empty = await getStatusAndJson('/api/search?q=');
    expect(empty.status).toBe(200);
    expect(empty.body.results.total).toBe(0);
    expect(empty.body.groups).toEqual([]);

    const missing = await getStatusAndJson('/api/search');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('bad-request');
  });

  it('returns an empty result set for a name nothing has', async () => {
    const body = await getJson('/api/search?q=zzznotasymbolanywhere');
    expect(body.results.total).toBe(0);
  });
});

describe('GET /api/node/<id>', () => {
  it('returns the symbol, its ancestors and its members in source order', async () => {
    const body = await getJson(`/api/node/${await idOf('Cache', 'class')}`);

    expect(body.node.name).toBe('Cache');
    expect(body.node.kind).toBe('class');
    expect(body.node.file).toBe('src/cache.ts');
    expect(body.node.lines).toBe(body.node.endLine - body.node.line + 1);
    expect(body.node.exported).toBe(true);

    // Outermost first: the file, then anything between it and the symbol.
    expect(body.ancestors[0].kind).toBe('file');
    expect(body.ancestors[0].file).toBe('src/cache.ts');

    const members = body.members.items.map((m: any) => m.name);
    expect(members).toEqual(expect.arrayContaining(['read', 'write', 'store', 'config']));
    const lines = body.members.items.map((m: any) => m.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    for (const member of body.members.items) {
      expect(member.parentId).toBe(body.node.id);
      expect(member.depth).toBe(1);
    }
    expect(body.members.total).toBe(body.members.shown);
  });

  it('gives every member its own fan-in and fan-out — the outline is the body', async () => {
    const body = await getJson(`/api/node/${await idOf('Cache', 'class')}`);
    const byName = new Map(body.members.items.map((m: any) => [m.name, m]));

    for (const member of body.members.items) {
      expect(typeof member.fanIn).toBe('number');
      expect(typeof member.fanOut).toBe('number');
      expect(member.fanIn).toBeGreaterThanOrEqual(0);
      expect(member.fanOut).toBeGreaterThanOrEqual(0);
    }

    // `Service.load` calls both, and `Cache` contains them: at least the
    // containment edge plus one call each. Without these numbers a 700-line
    // class's outline cannot say which member carries weight.
    expect((byName.get('read') as any).fanIn).toBeGreaterThanOrEqual(2);
    expect((byName.get('write') as any).fanIn).toBeGreaterThanOrEqual(2);
    // The class itself calls nothing — its methods do, which is exactly why
    // the per-member counts have to come from the members.
    expect(body.counts.callees).toBe(0);
    expect(body.members.items.some((m: any) => m.fanOut > 0)).toBe(true);
  });

  it('nests a file outline one level deeper, so a class shows its methods', async () => {
    const body = await getJson(`/api/node/${await idOf('cache.ts', 'file')}`);
    const byDepth = new Map<number, string[]>();
    for (const member of body.members.items) {
      byDepth.set(member.depth, [...(byDepth.get(member.depth) ?? []), member.name]);
    }
    expect(byDepth.get(1)).toContain('Cache');
    expect(byDepth.get(2)).toEqual(expect.arrayContaining(['read', 'write']));
  });

  it('groups incoming edges by the calling symbol, with their call sites', async () => {
    const readId = await idOf('read', 'method');
    const body = await getJson(`/api/node/${readId}`);

    const fromLoad = body.incoming.items.find((r: any) => r.node.name === 'load');
    expect(fromLoad, 'Service.load should call Cache.read').toBeTruthy();
    expect(fromLoad.node.file).toBe('src/service.ts');
    expect(fromLoad.edgeKinds).toContain('calls');
    expect(fromLoad.edgeCount).toBeGreaterThanOrEqual(1);
    expect(fromLoad.lines.length).toBeGreaterThanOrEqual(1);
    expect(fromLoad.lines).toEqual([...fromLoad.lines].sort((a: number, b: number) => a - b));
    expect(typeof fromLoad.fanIn).toBe('number');
    expect(fromLoad.hub).toBe(false);
  });

  it('carries every edge attribute the viewer draws with', async () => {
    const body = await getJson(`/api/node/${await idOf('read', 'method')}`);
    const relation = body.incoming.items.find((r: any) => r.node.name === 'load');
    const edge = relation.edges[0];

    expect(edge.kind).toBe('calls');
    expect(typeof edge.line).toBe('number');
    expect(typeof edge.col).toBe('number');
    expect(typeof edge.confidence).toBe('number');
    expect(typeof edge.resolvedBy).toBe('string');
    // Confidence decides the uncertain fold; the group agrees with its edges.
    expect(relation.confidence).toBe(
      Math.max(...relation.edges.map((e: any) => e.confidence ?? -1))
    );
    expect(relation.uncertain).toBe(relation.confidence < 0.6);
    expect(relation.synthesized).toBe(false);
  });

  it('groups outgoing edges by the called symbol, ordered by call site', async () => {
    const body = await getJson(`/api/node/${await idOf('load', 'method')}`);
    const names = body.outgoing.items.map((r: any) => r.node.name);
    expect(names).toEqual(expect.arrayContaining(['read', 'write']));

    const firstLines = body.outgoing.items
      .map((r: any) => r.lines[0])
      .filter((l: number | undefined) => l !== undefined);
    expect(firstLines).toEqual([...firstLines].sort((a, b) => a - b));
  });

  it('splits type references out of the callee rail', async () => {
    // Type edges attach to the MEMBER that names the type, not to its class:
    // `Service`'s constructor is where `Config` and `new Cache(...)` both live,
    // which makes it the one place both halves of the split are visible.
    const service = await getJson(`/api/node/${await idOf('Service', 'class')}`);
    const ctor = service.members.items.find((m: any) => m.name === 'constructor');
    const body = await getJson(`/api/node/${ctor.id}`);

    const typeNames = body.typesUsed.map((t: any) => t.node.name);
    expect(typeNames).toContain('Config');
    expect(body.typesUsed.every((t: any) => t.edgeKinds.includes('references'))).toBe(true);

    // A type reference is not also a callee row...
    expect(body.outgoing.items.map((r: any) => r.node.name)).not.toContain('Config');
    // ...but a class reached by any other edge kind still is: `new Cache(...)`
    // is an `instantiates` edge, and moving it would hide a real dependency.
    const instantiated = body.outgoing.items.find((r: any) => r.node.name === 'Cache');
    expect(instantiated).toBeTruthy();
    expect(instantiated.edgeKinds).toContain('instantiates');
  });

  it('summarizes which tests reach the symbol', async () => {
    const reached = await getJson(`/api/node/${await idOf('load', 'method')}`);
    expect(reached.tests.reached).toBe(true);
    expect(reached.tests.hops).toBe(1);
    expect(reached.tests.files).toContain('__tests__/service.test.ts');
    expect(reached.tests.fileCount).toBeGreaterThanOrEqual(1);
    expect(reached.tests.files.length).toBeLessThanOrEqual(6);
    expect(reached.tests.exhaustive).toBe(true);

    const unreached = await getJson(`/api/node/${await idOf('hot', 'function')}`);
    expect(unreached.tests.reached).toBe(false);
    expect(unreached.tests.hops).toBeNull();
    expect(unreached.tests.files).toEqual([]);
  });

  it('counts the calls that leave the index instead of hiding them', async () => {
    const body = await getJson(`/api/node/${await idOf('load', 'method')}`);
    expect(body.outsideIndex.total).toBeGreaterThan(0);
    const names = body.outsideIndex.samples.map((s: any) => s.name);
    expect(names).toContain('serialize');
    for (const sample of body.outsideIndex.samples) {
      expect(typeof sample.line).toBe('number');
      expect(typeof sample.kind).toBe('string');
    }
  });

  it('summarizes the blast radius at three hops', async () => {
    const body = await getJson(`/api/node/${await idOf('read', 'method')}`);
    expect(body.blast.hops).toBe(3);
    expect(body.blast.direct).toBe(body.counts.callers);
    // load → handleRequest / the test both sit inside three hops of Cache.read.
    expect(body.blast.withinHops).toBeGreaterThan(body.blast.direct);
    expect(body.blast.files).toBeGreaterThanOrEqual(2);
    expect(body.blast.testFiles).toBeGreaterThanOrEqual(1);
    expect(body.blast.routes).toBe(0);
    expect(body.blast.topFiles[0].symbols).toBeGreaterThanOrEqual(1);
  });

  it('keeps every count equal to the list it labels', async () => {
    const body = await getJson(`/api/node/${await idOf('read', 'method')}`);
    expect(body.counts.callers).toBe(body.incoming.total);
    expect(body.counts.callees).toBe(body.outgoing.total);
    expect(body.counts.typesUsed).toBe(body.typesUsed.length);
    expect(body.counts.members).toBe(body.members.total);
    expect(body.blast.direct).toBe(body.counts.callers);
  });

  it('reports fan-in, fan-out and the hub flag', async () => {
    const quiet = await getJson(`/api/node/${await idOf('write', 'method')}`);
    expect(quiet.counts.hub).toBe(false);
    expect(quiet.counts.callers).toBeLessThan(40);
    expect(quiet.counts.fanIn).toBeGreaterThanOrEqual(quiet.counts.callers);

    const hot = await getJson(`/api/node/${await idOf('hot', 'function')}`);
    expect(hot.counts.hub).toBe(true);
    expect(hot.counts.callers).toBeGreaterThanOrEqual(500);
  });

  it('flags nothing as drifted while the fixture is untouched', async () => {
    const body = await getJson(`/api/node/${await idOf('read', 'method')}`);
    expect(body.drift).toBe(false);
  });

  it('404s an id that names nothing, and 400s an empty one', async () => {
    const missing = await getStatusAndJson('/api/node/method:notarealid');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');
    expect(missing.body.hint).toBeTruthy();

    const empty = await getStatusAndJson('/api/node/');
    expect(empty.status).toBe(400);
  });
});

describe('GET /api/node/<id> — the type hierarchy block', () => {
  it('is null for a function, so the block costs a plain symbol nothing', async () => {
    const body = await getJson(`/api/node/${await idOf('hot', 'function')}`);
    expect(body.hierarchy).toBeNull();
  });

  it('is null for a class with nothing above or below it', async () => {
    const body = await getJson(`/api/node/${await idOf('Cache', 'class')}`);
    expect(body.hierarchy).toBeNull();
  });
});

describe('GET /api/node/<id> — the busiest symbol', () => {
  it('caps the caller list, keeps the true total, and stays fast', async () => {
    const hotId = await idOf('hot', 'function');
    await request(`/api/node/${hotId}`); // warm the connection and the caches

    const started = performance.now();
    const res = await request(`/api/node/${hotId}`);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.incoming.total).toBeGreaterThanOrEqual(500);
    expect(body.incoming.shown).toBe(300);
    expect(body.incoming.truncated).toBe(true);
    expect(body.incoming.items).toHaveLength(300);
    // Grouped: one row per calling symbol, each carrying its own call sites.
    expect(new Set(body.incoming.items.map((r: any) => r.node.id)).size).toBe(300);
    expect(body.counts.callers).toBeGreaterThanOrEqual(500);
    expect(body.blast.direct).toBe(body.counts.callers);

    // 500 callers resolved one query at a time would be nowhere near this.
    expect(elapsed).toBeLessThan(100);
  });
});

describe('GET /api/source', () => {
  it('returns the requested slice with the index line numbering', async () => {
    const body = await getJson('/api/source?file=src/cache.ts&from=1&to=3');
    expect(body.drift).toBe(false);
    expect(body.file).toBe('src/cache.ts');
    expect(body.language).toBe('typescript');
    expect(body.from).toBe(1);
    expect(body.to).toBe(3);
    expect(body.lines).toHaveLength(3);
    expect(body.lines[0]).toContain("import { Config, CacheKey } from './types'");
    expect(body.totalLines).toBeGreaterThan(3);
    expect(body.truncated).toBe(false);
  });

  it('serves the whole file when no range is given', async () => {
    const body = await getJson('/api/source?file=src/handler.ts');
    expect(body.from).toBe(1);
    expect(body.to).toBe(body.totalLines);
    expect(body.lines).toHaveLength(body.totalLines);
  });

  it('slices exactly the lines a symbol claims', async () => {
    const node = await getJson(`/api/node/${await idOf('handleRequest', 'function')}`);
    const body = await getJson(
      `/api/source?file=${node.node.file}&from=${node.node.line}&to=${node.node.endLine}`
    );
    expect(body.lines[0]).toContain('handleRequest');
    expect(body.lines).toHaveLength(node.node.lines);
  });

  it('carries the classified source beside the lines, one entry per line', async () => {
    const body = await getJson('/api/source?file=src/cache.ts&from=1&to=3');
    // Highlighting rides with the slice rather than behind its own endpoint:
    // the two are only ever wanted together, and a second round-trip would let
    // the code block paint unhighlighted source and then reflow it.
    expect(body.highlight).toBeTruthy();
    expect(body.highlight.classes).toEqual([
      'other',
      'ident',
      'comment',
      'string',
      'keyword',
      'number',
      'type',
      'def',
    ]);
    expect(body.highlight.lines).toHaveLength(body.lines.length);
    // Every line's tokens reproduce that line exactly — the code block renders
    // these, not the raw string.
    for (let i = 0; i < body.lines.length; i++) {
      const rebuilt = body.highlight.lines[i].map(([, text]: [number, string]) => text).join('');
      expect(rebuilt).toBe(body.lines[i]);
    }
  });

  it('refuses to slice a file that changed on disk after the last sync', async () => {
    const target = path.join(projectRoot, 'src', 'handler.ts');
    const original = fs.readFileSync(target);
    try {
      fs.writeFileSync(target, Buffer.concat([Buffer.from('// a new first line\n'), original]));

      const body = await getJson('/api/source?file=src/handler.ts&from=1&to=3');
      expect(body.drift).toBe(true);
      // The whole point: no slice, rather than a slice of the wrong lines.
      expect(body.lines).toBeUndefined();
      // And nothing to render it with either — a highlight with no source is
      // just a second way to draw the wrong lines.
      expect(body.highlight).toBeUndefined();
      expect(body.reason).toContain('changed on disk after the last index sync');

      // And every screen that renders indexed line ranges is told.
      const node = await getJson(`/api/node/${await idOf('handleRequest', 'function')}`);
      expect(node.drift).toBe(true);
      const file = await getJson('/api/file/src/handler.ts');
      expect(file.drift).toBe(true);
    } finally {
      fs.writeFileSync(target, original);
    }
  });

  it('does not call an identical rewrite drift', async () => {
    const target = path.join(projectRoot, 'src', 'handler.ts');
    const original = fs.readFileSync(target);
    // Same bytes, new mtime — what a checkout or a formatter no-op looks like.
    fs.writeFileSync(target, original);

    const body = await getJson('/api/source?file=src/handler.ts&from=1&to=2');
    expect(body.drift).toBe(false);
    expect(body.lines).toHaveLength(2);
  });

  it('keeps a CRLF file on the index line numbering, without the stray carriage returns', async () => {
    const node = await getJson(`/api/node/${await idOf('windowsStyle', 'function')}`);
    expect(node.node.file).toBe('src/crlf.ts');

    const body = await getJson('/api/source?file=src/crlf.ts');
    expect(body.drift).toBe(false);
    expect(body.totalLines).toBe(3);
    expect(body.lines).toEqual([
      'export function windowsStyle(n: number): number {',
      '  return n + 1;',
      '}',
    ]);
    expect(body.lines.some((l: string) => l.includes('\r'))).toBe(false);

    // The symbol's indexed range still names its own body.
    const slice = await getJson(
      `/api/source?file=src/crlf.ts&from=${node.node.line}&to=${node.node.endLine}`
    );
    expect(slice.lines[0]).toContain('windowsStyle');
  });

  it('refuses a path that escapes the project', async () => {
    const traversal = await getStatusAndJson(
      '/api/source?file=' + encodeURIComponent('../../../etc/passwd')
    );
    expect(traversal.status).toBe(403);
    expect(traversal.body.code).toBe('refused');

    const absolute = await getStatusAndJson(
      '/api/source?file=' + encodeURIComponent('/etc/passwd')
    );
    expect(absolute.status).toBe(403);
    expect(absolute.body.code).toBe('refused');
    expect(absolute.body.error).toContain('absolute');
  });

  it('refuses a NUL byte in the path', async () => {
    const { status, body } = await getStatusAndJson(
      '/api/source?file=' + encodeURIComponent('src/cache.ts\u0000.png')
    );
    expect(status).toBe(403);
    expect(body.code).toBe('refused');
  });

  it('404s a file that exists but is not indexed', async () => {
    fs.writeFileSync(path.join(projectRoot, 'notes.md'), '# not indexed\n');
    const { status, body } = await getStatusAndJson('/api/source?file=notes.md');
    expect(status).toBe(404);
    expect(body.code).toBe('not-found');
    expect(body.hint).toContain('index');
  });

  it('rejects a range that names nothing', async () => {
    const past = await getStatusAndJson('/api/source?file=src/handler.ts&from=99999');
    expect(past.status).toBe(400);
    expect(past.body.error).toContain('past the end');

    const backwards = await getStatusAndJson('/api/source?file=src/handler.ts&from=10&to=4');
    expect(backwards.status).toBe(400);

    const nonNumeric = await getStatusAndJson('/api/source?file=src/handler.ts&from=abc');
    expect(nonNumeric.status).toBe(400);
  });
});

describe('GET /api/file/<path>', () => {
  it('returns the file record and its outline in source order', async () => {
    const body = await getJson('/api/file/src/cache.ts');

    expect(body.file.path).toBe('src/cache.ts');
    expect(body.file.language).toBe('typescript');
    expect(body.file.size).toBeGreaterThan(0);
    expect(body.file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.file.generated).toBe(false);
    expect(body.file.test).toBe(false);
    expect(body.file.id).toMatch(/^file:/);
    expect(body.drift).toBe(false);

    const lines = body.outline.items.map((o: any) => o.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));

    const cacheRow = body.outline.items.find((o: any) => o.name === 'Cache');
    expect(cacheRow.depth).toBe(0);
    expect(cacheRow.parentId).toBeNull();

    const readRow = body.outline.items.find((o: any) => o.name === 'read');
    expect(readRow.depth).toBe(1);
    expect(readRow.parentId).toBe(cacheRow.id);
    expect(readRow.fanIn).toBeGreaterThanOrEqual(1);
    expect(typeof readRow.fanOut).toBe('number');

    // The file node is the subject, not a row; imports have their own rail.
    expect(body.outline.items.some((o: any) => o.kind === 'file')).toBe(false);
    expect(body.outline.items.some((o: any) => o.kind === 'import')).toBe(false);
  });

  it('maps imports and imported-by to files', async () => {
    const body = await getJson('/api/file/src/cache.ts');

    const importedByFiles = body.importedBy.items.map((r: any) => r.file);
    expect(importedByFiles).toContain('src/service.ts');

    const importFiles = body.imports.items.map((r: any) => r.file);
    expect(importFiles).toContain('src/types.ts');

    // Never itself: same-file `imports` edges (the import declarations) are dropped.
    expect(importFiles).not.toContain('src/cache.ts');
    expect(importedByFiles).not.toContain('src/cache.ts');

    const typesRow = body.imports.items.find((r: any) => r.file === 'src/types.ts');
    expect(typesRow.symbolCount).toBeGreaterThanOrEqual(1);
    expect(typesRow.symbols[0].name).toBeTruthy();
    expect(typesRow.symbols[0].id).toBeTruthy();
    expect(typesRow.test).toBe(false);
  });

  it('names the imports that never resolved rather than dropping them', async () => {
    const body = await getJson('/api/file/src/service.ts');
    const names = body.unresolvedImports.map((u: any) => u.name);
    expect(names).toContain('some-external-package');
  });

  it('reports the wider cross-file relationship too', async () => {
    const body = await getJson('/api/file/src/cache.ts');
    expect(body.dependents).toContain('src/service.ts');
    expect(body.dependencies).toContain('src/types.ts');
  });

  it('says whether the file runs anything at its top level', async () => {
    // `src/main.ts` instantiates a Service and calls two functions outside
    // every definition — code no outline row can show, because it belongs to
    // no symbol. `src/cache.ts` only defines things.
    const main = await getJson('/api/file/src/main.ts');
    expect(main.topLevel.calls).toBeGreaterThanOrEqual(2);

    const cache = await getJson('/api/file/src/cache.ts');
    expect(cache.topLevel.calls).toBe(0);
  });

  it('404s a file that is not in the index and refuses one outside the project', async () => {
    const missing = await getStatusAndJson('/api/file/src/nope.ts');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');

    const outside = await getStatusAndJson(
      '/api/file/' + encodeURIComponent('/etc/passwd')
    );
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('refused');
  });
});

describe('GET /api/routes', () => {
  it('says plainly that this project is not a routed app', async () => {
    const body = await getJson('/api/routes');
    expect(body.routed).toBe(false);
    expect(body.entries).toEqual([]);
    expect(body.routeCount).toBe(0);
    expect(body.shown).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it('refuses a limit the manifest cannot answer truthfully', async () => {
    // Below three, the engine's manifest reports every routed project as
    // unrouted — a wrong answer, so the parameter is refused instead.
    for (const limit of ['0', '2', '-1', 'abc']) {
      const { status, body } = await getStatusAndJson(`/api/routes?limit=${limit}`);
      expect(status, `limit=${limit}`).toBe(400);
      expect(body.code).toBe('bad-request');
    }
  });

  describe('a project that IS routed', () => {
    let routedApi: GraphApi;
    let routedServer: UiServerHandle;

    beforeAll(async () => {
      const routedRoot = path.join(tempDir, 'routed');
      fs.mkdirSync(path.join(routedRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(routedRoot, 'src', 'routes.ts'),
        `import express from 'express';

const app = express();

export function listUsers(req: any, res: any): void { res.json([]); }
export function getUser(req: any, res: any): void { res.json({}); }
export function createUser(req: any, res: any): void { res.json({}); }
export function deleteUser(req: any, res: any): void { res.json({}); }

app.get('/users', listUsers);
app.get('/users/:id', getUser);
app.post('/users', createUser);
app.delete('/users/:id', deleteUser);

export default app;
`
      );
      const routedCg = CodeGraph.initSync(routedRoot, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await routedCg.indexAll();
      routedCg.resolveReferences();
      routedCg.close();

      routedApi = createGraphApi({ projectRoot: routedRoot });
      routedServer = await startUiServer({
        projectRoot: routedRoot,
        viewerDir,
        port: 0,
        api: routedApi.handler,
      });
    }, 120_000);

    afterAll(async () => {
      routedApi?.close();
      await routedServer?.close();
    });

    it('maps each URL to its handler, with a node id to navigate to', async () => {
      const res = await requestOn(routedServer.port, '/api/routes');
      const body = JSON.parse(res.body);

      expect(body.routed).toBe(true);
      expect(body.routeCount).toBe(4);
      expect(body.shown).toBe(4);
      expect(body.truncated).toBe(false);
      expect(body.topHandlerFile).toBe('src/routes.ts');
      expect(body.topHandlerFileCount).toBe(4);

      const urls = body.entries.map((e: any) => e.url);
      expect(urls).toEqual(
        expect.arrayContaining(['GET /users', 'GET /users/:id', 'POST /users', 'DELETE /users/:id'])
      );

      const listUsers = body.entries.find((e: any) => e.url === 'GET /users');
      expect(listUsers.handler).toBe('listUsers');
      expect(listUsers.handlerKind).toBe('function');
      expect(listUsers.file).toBe('src/routes.ts');
      expect(listUsers.line).toBeGreaterThan(0);

      // The manifest carries no ids of its own; resolving them is what makes a
      // route row clickable, so it has to actually resolve.
      expect(listUsers.handlerId).toBeTruthy();
      const handler = JSON.parse(
        (await requestOn(routedServer.port, `/api/node/${listUsers.handlerId}`)).body
      );
      expect(handler.node.name).toBe('listUsers');
    });

    it('offers its routes as entry points, ahead of anything derived', async () => {
      const res = await requestOn(routedServer.port, '/api/entrypoints');
      const body = JSON.parse(res.body);

      expect(body.routes.routed).toBe(true);
      expect(body.routes.routeCount).toBe(4);
      const urls = body.routes.items.items.map((e: any) => e.url);
      expect(urls).toEqual(
        expect.arrayContaining(['GET /users', 'GET /users/:id', 'POST /users', 'DELETE /users/:id'])
      );
      // A route row has to be navigable, or it is a label.
      expect(body.routes.items.items.every((e: any) => e.handlerId)).toBe(true);
    });

    it('honours the limit and says when it cut the list', async () => {
      const res = await requestOn(routedServer.port, '/api/routes?limit=3');
      const body = JSON.parse(res.body);
      expect(body.routed).toBe(true);
      expect(body.entries).toHaveLength(3);
      expect(body.shown).toBe(3);
      expect(body.truncated).toBe(true);
      // The headline count is the whole graph's, not the page's.
      expect(body.routeCount).toBe(4);
    });
  });
});

/**
 * The acceptance bar from the issue, against the engine's OWN index rather than
 * a fixture: `LRUCache.get` in `src/resolution/lru-cache.ts`, 500+ callers.
 *
 * `.codegraph/` is gitignored, so this only runs on a machine that has indexed
 * this repository. The fixture test above covers the same properties in CI; this
 * one is the check against the real, messy graph the number came from.
 */
describe.runIf(CodeGraph.isInitialized(path.resolve(__dirname, '..')))(
  "the engine's own busiest symbol",
  () => {
    const repoRoot = path.resolve(__dirname, '..');
    let repoApi: GraphApi;
    let repoServer: UiServerHandle;

    beforeAll(async () => {
      repoApi = createGraphApi({ projectRoot: repoRoot });
      repoServer = await startUiServer({
        projectRoot: repoRoot,
        viewerDir,
        port: 0,
        api: repoApi.handler,
      });
    });

    afterAll(async () => {
      repoApi?.close();
      await repoServer?.close();
    });

    const repoGet = (requestPath: string): Promise<Response> =>
      requestOn(repoServer.port, requestPath);

    it('answers in under 100 ms with grouped, capped lists and correct counts', async () => {
      const search = JSON.parse(
        (await repoGet('/api/search?q=' + encodeURIComponent('LRUCache.get'))).body
      );
      const hit = search.results.items.find(
        (r: any) => r.name === 'get' && r.file.endsWith('src/resolution/lru-cache.ts')
      );
      expect(hit, 'LRUCache.get should be in the engine\'s own index').toBeTruthy();

      await repoGet(`/api/node/${hit.id}`); // warm

      const started = performance.now();
      const res = await repoGet(`/api/node/${hit.id}`);
      const elapsed = performance.now() - started;

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.counts.fanIn).toBeGreaterThanOrEqual(500);
      expect(body.counts.hub).toBe(true);
      // Grouped by calling symbol, so the row count is the distinct-caller
      // count, never the edge count.
      expect(body.incoming.items).toHaveLength(body.incoming.shown);
      expect(body.incoming.shown).toBeLessThanOrEqual(300);
      expect(body.incoming.shown).toBe(Math.min(300, body.incoming.total));
      expect(body.incoming.truncated).toBe(body.incoming.total > 300);
      expect(new Set(body.incoming.items.map((r: any) => r.node.id)).size).toBe(
        body.incoming.shown
      );
      const edgesInRows = body.incoming.items.reduce(
        (sum: number, r: any) => sum + r.edgeCount,
        0
      );
      expect(edgesInRows).toBeLessThanOrEqual(body.counts.fanIn);
      expect(body.blast.direct).toBe(body.counts.callers);
      expect(body.tests.reached).toBe(true);

      expect(elapsed).toBeLessThan(100);
    });
  }
);

describe('GET /api/entrypoints', () => {
  it('finds the file that runs something, and reports what it reaches', async () => {
    const body = await getJson('/api/entrypoints');

    const files = body.files.items.map((f: any) => f.file);
    expect(files).toContain('src/main.ts');

    const main = body.files.items.find((f: any) => f.file === 'src/main.ts');
    expect(main.kind).toBe('file');
    expect(main.id).toMatch(/^file:/);
    // `new Service(...)`, `handleRequest(...)` and `service.load(...)` all sit
    // at module level.
    expect(main.calls).toBeGreaterThanOrEqual(2);
    // It imports from service.ts and handler.ts, so it wires files together.
    expect(main.reaches).toBeGreaterThanOrEqual(2);
    expect(typeof main.dependents).toBe('number');
  });

  it('leaves test files out — "where do I start" never means a test', async () => {
    const body = await getJson('/api/entrypoints');

    for (const file of body.files.items) expect(file.test).toBe(false);
    // The fixture's test file calls its own helper at module level, so it IS a
    // candidate by the raw graph signal and is excluded deliberately.
    expect(body.files.items.map((f: any) => f.file)).not.toContain(
      '__tests__/service.test.ts'
    );
    for (const hub of body.hubs.items) expect(hub.test).toBe(false);
  });

  it('ranks the most depended-on symbols as hubs, with their dependent counts', async () => {
    const body = await getJson('/api/entrypoints');

    const hot = body.hubs.items.find((h: any) => h.name === 'hot');
    expect(hot, 'the 500-caller function should top the hubs').toBeTruthy();
    expect(hot.dependents).toBe(500);
    expect(body.hubs.items[0].name).toBe('hot');

    const counts = body.hubs.items.map((h: any) => h.dependents);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
    // A file or a bare import is structure, not somewhere to start reading.
    for (const hub of body.hubs.items) {
      expect(['file', 'import', 'export', 'parameter']).not.toContain(hub.kind);
    }
  });

  it('says a project without routes is not routed rather than failing', async () => {
    const body = await getJson('/api/entrypoints');
    expect(body.routes.routed).toBe(false);
    expect(body.routes.items.items).toEqual([]);
    expect(body.routes.routeCount).toBe(0);
  });

  it('honours limit, and keeps every list within it', async () => {
    const body = await getJson('/api/entrypoints?limit=1');
    expect(body.files.items.length).toBeLessThanOrEqual(1);
    expect(body.hubs.items.length).toBe(1);
    expect(body.hubs.total).toBeGreaterThanOrEqual(body.hubs.items.length);

    const bad = await getStatusAndJson('/api/entrypoints?limit=0');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('bad-request');
  });
});

describe('GET /api/nodes', () => {
  it('answers a batch of ids in the order asked, and says which are missing', async () => {
    const cacheId = await idOf('Cache', 'class');
    const loadId = await idOf('load', 'method');
    const body = await getJson(
      `/api/nodes?id=${encodeURIComponent(loadId)}&id=${encodeURIComponent(cacheId)}&id=method%3Anot-a-real-id`
    );

    expect(body.items.map((n: any) => n.id)).toEqual([loadId, cacheId]);
    expect(body.items[0].name).toBe('load');
    expect(body.items[1].name).toBe('Cache');
    expect(body.missing).toEqual(['method:not-a-real-id']);
    // The REF shape, not the Symbol view payload: a trail redraws six names,
    // not six rail sets.
    expect(body.items[0].incoming).toBeUndefined();
    expect(body.items[0].file).toBe('src/service.ts');
  });

  it('de-duplicates ids rather than answering twice', async () => {
    const cacheId = await idOf('Cache', 'class');
    const encoded = encodeURIComponent(cacheId);
    const body = await getJson(`/api/nodes?id=${encoded}&id=${encoded}`);
    expect(body.items).toHaveLength(1);
  });

  it('refuses an empty or oversized request with guidance', async () => {
    const none = await getStatusAndJson('/api/nodes');
    expect(none.status).toBe(400);
    expect(none.body.hint).toContain('id=');

    const ids = Array.from({ length: 61 }, (_, i) => `id=method%3A${i}`).join('&');
    const many = await getStatusAndJson(`/api/nodes?${ids}`);
    expect(many.status).toBe(400);
    expect(many.body.error).toContain('Too many ids');
  });
});

describe('an index that is not there', () => {
  it('answers with the same guidance the CLI prints, not a stack trace', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-noindex-'));
    const detached = createGraphApi({ projectRoot: emptyRoot });
    const detachedServer = await startUiServer({
      projectRoot: emptyRoot,
      viewerDir,
      port: 0,
      api: detached.handler,
    });
    try {
      const res = await requestOn(detachedServer.port, '/api/stats');

      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('no-index');
      expect(body.error).toContain('No CodeGraph index found');
      expect(body.hint).toContain('codegraph init');
      expect(body.error).not.toContain('    at ');
    } finally {
      detached.close();
      await detachedServer.close();
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
