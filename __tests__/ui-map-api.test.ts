/**
 * `GET /api/map` — the module aggregation behind the Map (CG-49).
 *
 * Against a real indexed fixture over a real loopback server, like the rest of
 * the viewer's API suite. The fixture is shaped to produce exactly the things
 * the endpoint has to get right and that a synthetic payload cannot prove:
 *
 * - a façade (`src/index.ts`) that must stay its own box rather than being
 *   folded in with the loose type declarations beside it,
 * - real `imports` edges, so the `declared` subset is not always equal to the
 *   raw count and the layering has something trustworthy to rest on,
 * - a two-file import cycle, so the file-level cycle report has a component to
 *   find,
 * - a test directory, so the `test` flag and the root default can be checked.
 *
 * The pure layout — layering, cycle-breaking, ports — is tested without a
 * server in `ui-map-model.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { moduleIdFor, normalizeRoot, pickDefaultRoot, resetMapCache } from '../src/ui-server/api/map';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;

function request(requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${server.port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            type: res.headers['content-type'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getMap(query = ''): Promise<any> {
  const res = await request(`/api/map${query}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(200);
  return JSON.parse(res.body);
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-map-'));
  projectRoot = path.join(tempDir, 'project');

  write(projectRoot, 'src/types.ts', `export interface Row {\n  id: string;\n}\n`);

  write(
    projectRoot,
    'src/db/schema.ts',
    `export const TABLES = ['rows'];\n`
  );
  // db -> core, the LIGHT direction of the mutual pair below.
  write(
    projectRoot,
    'src/db/store.ts',
    `import { Row } from '../types';
import { normalise } from '../core/util';

export class Store {
  rows: Row[] = [];
  put(row: Row): void {
    this.rows.push(normalise(row));
  }
}
`
  );

  // util <-> store is a deliberate two-file import cycle: it gives the file
  // cycle report a component to find and the module graph a mutual pair.
  write(
    projectRoot,
    'src/core/util.ts',
    `import { Row } from '../types';
import { Store } from '../db/store';

export function normalise(row: Row): Row {
  return { id: row.id.trim() };
}

export function count(store: Store): number {
  return store.rows.length;
}
`
  );

  // Two directory levels under `src`, so depth=2 has something real to split.
  write(
    projectRoot,
    'src/core/passes/trim.ts',
    `import { Row } from '../../types';

export function trim(row: Row): Row {
  return { id: row.id.slice(0, 8) };
}
`
  );
  // core -> db, several times over: the HEAVY direction.
  write(
    projectRoot,
    'src/core/engine.ts',
    `import { Store } from '../db/store';
import { TABLES } from '../db/schema';
import { trim } from './passes/trim';
import { Row } from '../types';

export class Engine {
  store = new Store();
  boot(): string[] {
    return TABLES;
  }
  add(row: Row): void {
    this.store.put(trim(row));
    this.store.put(row);
  }
}
`
  );

  write(
    projectRoot,
    'src/api/handler.ts',
    `import { Engine } from '../core/engine';
import { Row } from '../types';

export function handle(engine: Engine, row: Row): void {
  engine.add(row);
}
`
  );
  write(
    projectRoot,
    'src/api/routes.ts',
    `import { Engine } from '../core/engine';
import { handle } from './handler';

export function route(engine: Engine): void {
  handle(engine, { id: 'x' });
}
`
  );

  write(
    projectRoot,
    'src/index.ts',
    `import { Engine } from './core/engine';
import { route } from './api/routes';

export function start(): void {
  route(new Engine());
}
`
  );

  write(
    projectRoot,
    '__tests__/engine.test.ts',
    `import { Engine } from '../src/core/engine';

export function testBoot(): string[] {
  return new Engine().boot();
}
`
  );

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', '__tests__/**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
  cg.close();

  const viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  resetMapCache();
  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  api?.close();
  await server?.close();
  resetMapCache();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('moduleIdFor', () => {
  it('names a module after the first `depth` segments under the root', () => {
    expect(moduleIdFor('src/core/engine.ts', 'src', 1)).toEqual({ id: 'src/core', facade: false });
    expect(moduleIdFor('src/a/b/c.ts', 'src', 2)).toEqual({ id: 'src/a/b', facade: false });
    expect(moduleIdFor('a/b/c.ts', '', 1)).toEqual({ id: 'a', facade: false });
  });

  it('keeps a façade as its own box and buckets the other loose files', () => {
    expect(moduleIdFor('src/index.ts', 'src', 1)).toEqual({ id: 'src/index.ts', facade: true });
    expect(moduleIdFor('src/lib.rs', 'src', 1)?.facade).toBe(true);
    expect(moduleIdFor('pkg/__init__.py', 'pkg', 1)?.facade).toBe(true);
    expect(moduleIdFor('src/types.ts', 'src', 1)).toEqual({
      id: 'src/(root files)',
      facade: false,
    });
    expect(moduleIdFor('types.ts', '', 1)).toEqual({ id: '(root files)', facade: false });
  });

  it('buckets a loose file into the directory it is actually in, not the top one', () => {
    // Two segments at depth 2 is a loose file inside `src/a`, so it belongs to
    // that directory's bucket. Folding it into `src/(root files)` would claim a
    // file lives somewhere it does not.
    expect(moduleIdFor('src/a/loose.ts', 'src', 2)).toEqual({
      id: 'src/a/(root files)',
      facade: false,
    });
  });

  it('returns null for a file outside the root', () => {
    expect(moduleIdFor('__tests__/x.test.ts', 'src', 1)).toBeNull();
    // A sibling whose name merely starts with the root is not under it.
    expect(moduleIdFor('srcx/y.ts', 'src', 1)).toBeNull();
  });
});

describe('normalizeRoot', () => {
  it('treats `src`, `src/` and `./src` as one root', () => {
    expect(normalizeRoot('src')).toBe('src');
    expect(normalizeRoot('src/')).toBe('src');
    expect(normalizeRoot('./src')).toBe('src');
    expect(normalizeRoot('src\\')).toBe('src');
  });

  it('treats the repository root as the empty string however it is written', () => {
    expect(normalizeRoot('')).toBe('');
    expect(normalizeRoot('.')).toBe('');
    expect(normalizeRoot('/')).toBe('');
    expect(normalizeRoot(undefined)).toBe('');
  });
});

describe('pickDefaultRoot', () => {
  it('picks the directory holding a clear majority of the non-test symbols', () => {
    expect(
      pickDefaultRoot([
        { path: 'src/a.ts', symbols: 80, test: false },
        { path: 'scripts/b.ts', symbols: 5, test: false },
        { path: '__tests__/c.ts', symbols: 900, test: true },
      ])
    ).toBe('src');
  });

  it('falls back to the repository root when no directory dominates', () => {
    expect(
      pickDefaultRoot([
        { path: 'a/one.ts', symbols: 10, test: false },
        { path: 'b/two.ts', symbols: 10, test: false },
        { path: 'c/three.ts', symbols: 10, test: false },
      ])
    ).toBe('');
    expect(pickDefaultRoot([{ path: 'flat.ts', symbols: 4, test: false }])).toBe('');
  });
});

describe('GET /api/map', () => {
  it('is listed by the API index', async () => {
    const res = await request('/api');
    const body = JSON.parse(res.body);
    expect(body.endpoints.map((e: any) => e.path)).toContain('/api/map');
  });

  it('opens on the source directory and keeps the façade its own box', async () => {
    const map = await getMap();
    expect(map.root).toBe('src');
    expect(map.depth).toBe(1);

    const ids = map.modules.map((m: any) => m.id);
    expect(ids).toEqual(['src/(root files)', 'src/api', 'src/core', 'src/db', 'src/index.ts']);
    expect(map.modules.find((m: any) => m.id === 'src/core').files).toBe(3);

    const facade = map.modules.find((m: any) => m.id === 'src/index.ts');
    expect(facade.facade).toBe(true);
    expect(facade.files).toBe(1);
    expect(facade.symbols).toBeGreaterThan(0);
    // Nothing under `src` is a test, so the default root already excludes them.
    expect(map.modules.every((m: any) => m.test === false)).toBe(true);
  });

  it('offers every top-level directory as a root, plus the repository itself', async () => {
    const map = await getMap();
    expect(map.roots[0]).toEqual({ root: '', label: 'whole repository', files: map.index.files });
    expect(map.roots.map((r: any) => r.root)).toEqual(
      expect.arrayContaining(['', 'src', '__tests__'])
    );
  });

  it('counts cross-module edges only, with a declared subset and named pairs', async () => {
    const map = await getMap();
    const link = map.links.find((l: any) => l.source === 'src/api' && l.target === 'src/core');
    expect(link).toBeTruthy();
    expect(link.count).toBeGreaterThan(0);
    // Every kind's count has to add up to the link's own count, or the tooltip
    // and the stroke width are describing two different things.
    expect(link.byKind.reduce((sum: number, k: any) => sum + k.count, 0)).toBe(link.count);
    // `import { Engine }` is a declared dependency; it must survive as one.
    expect(link.declared).toBeGreaterThan(0);
    expect(link.declared).toBeLessThanOrEqual(link.count);
    expect(link.topPairs.length).toBeGreaterThan(0);
    expect(link.topPairs.length).toBeLessThanOrEqual(4);
    expect(link.topPairs.every((p: any) => p.declared <= p.count)).toBe(true);

    // No module ever links to itself: same-module edges are not dependencies.
    expect(map.links.every((l: any) => l.source !== l.target)).toBe(true);
  });

  it('keeps the heavier direction of a mutual pair heavier', async () => {
    const map = await getMap();
    const coreToDb = map.links.find((l: any) => l.source === 'src/core' && l.target === 'src/db');
    const dbToCore = map.links.find((l: any) => l.source === 'src/db' && l.target === 'src/core');
    expect(coreToDb).toBeTruthy();
    expect(dbToCore).toBeTruthy();
    expect(coreToDb.count).toBeGreaterThan(dbToCore.count);
  });

  it('reports the file-level cycle the fixture contains', async () => {
    const map = await getMap();
    expect(map.cycles.total).toBeGreaterThanOrEqual(1);
    const knot = map.cycles.items.find((c: any) =>
      c.files.includes('src/core/util.ts') && c.files.includes('src/db/store.ts')
    );
    expect(knot, JSON.stringify(map.cycles)).toBeTruthy();
    expect(knot.size).toBe(knot.files.length);
    expect(knot.modules).toEqual(expect.arrayContaining(['src/core', 'src/db']));
    expect(map.cycles.shown).toBe(map.cycles.items.length);
  });

  it('lists each module\'s files, capped, with the true total beside them', async () => {
    const map = await getMap();
    for (const module of map.modules) {
      expect(module.fileList.total).toBe(module.files);
      expect(module.fileList.shown).toBe(module.fileList.items.length);
      expect(module.fileList.truncated).toBe(module.fileList.shown < module.fileList.total);
      expect(module.fileList.items).toEqual([...module.fileList.items].sort());
    }
    // A module's files are everything BELOW it, not just the files directly in
    // it: `src/core` at depth 1 owns `src/core/passes/trim.ts` too, and the
    // panel's list has to match the count on the box.
    const core = map.modules.find((m: any) => m.id === 'src/core');
    expect(core.fileList.items).toEqual([
      'src/core/engine.ts',
      'src/core/passes/trim.ts',
      'src/core/util.ts',
    ]);
  });

  it('says how many references the confidence floor excluded', async () => {
    const map = await getMap();
    expect(map.excluded.confidenceBelow).toBe(0.6);
    expect(map.excluded.uncertainEdges).toBeGreaterThanOrEqual(0);
  });

  it('answers the whole repository, where the tests are a test module', async () => {
    const map = await getMap('?root=&depth=1');
    expect(map.root).toBe('');
    const ids = map.modules.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['src', '__tests__']));
    expect(map.modules.find((m: any) => m.id === '__tests__').test).toBe(true);
    expect(map.modules.find((m: any) => m.id === 'src').test).toBe(false);
    expect(map.links.some((l: any) => l.source === '__tests__' && l.target === 'src')).toBe(true);
  });

  it('splits deeper when asked, and `src/` is the same root as `src`', async () => {
    const deep = await getMap('?root=src&depth=2');
    const ids = deep.modules.map((m: any) => m.id);
    // A directory two levels down becomes its own box; a file loose one level
    // down joins that level's bucket rather than being promoted to a module.
    expect(ids).toContain('src/core/passes');
    expect(ids).toContain('src/core/(root files)');
    expect(ids).toContain('src/api/(root files)');
    expect(ids).not.toContain('src/core');

    const slashed = await getMap('?root=src%2F&depth=2');
    expect(slashed.modules).toEqual(deep.modules);
  });

  it('rejects an out-of-range depth as JSON, not as a crash', async () => {
    const res = await request('/api/map?depth=9');
    expect(res.status).toBe(400);
    expect(res.type).toBe('application/json; charset=utf-8');
    const body = JSON.parse(res.body);
    expect(body.code).toBe('bad-request');
    expect(body.error).toContain('depth');
  });

  it('serves the second identical request from the cache, byte for byte', async () => {
    // Other cases in this file have already warmed `src` at depth 1; the point
    // here is the first-then-second transition, so start from a cold cache.
    resetMapCache();
    const first = await getMap('?root=src&depth=1');
    const second = await getMap('?root=src&depth=1');
    expect(first.timing.cached).toBe(false);
    expect(second.timing.cached).toBe(true);
    // Everything except the timing stamp must be identical — a map that is not
    // reproducible between two reloads is not a map of anything.
    const strip = (m: any) => JSON.stringify({ ...m, timing: undefined });
    expect(strip(second)).toBe(strip(first));
  });

  it('does not let one root\'s answer be served for another', async () => {
    const src = await getMap('?root=src&depth=1');
    const all = await getMap('?root=&depth=1');
    expect(all.root).toBe('');
    expect(all.modules.map((m: any) => m.id)).not.toEqual(src.modules.map((m: any) => m.id));
  });
});
