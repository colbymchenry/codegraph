/**
 * `GET /api/entrypoints` and the panel it draws (CG-54).
 *
 * Two indexed projects over two real loopback servers, because the two answers
 * this endpoint has to get right are opposites:
 *
 * - **A routed service.** `__tests__/fixtures/payroll-go` is a Go HTTP service
 *   whose four routes are registered in one router file and served from
 *   another, which is exactly the shape that makes "group routes by file"
 *   ambiguous — and the reason the payload carries the registration site as
 *   well as the handler. It is also the issue's acceptance case: the routes
 *   appear with their handlers, and the route's own handler reaches the store
 *   as a flow.
 * - **A library.** A TypeScript project with no routes at all, where the panel
 *   must fall back to the files that run something and the tests that exercise
 *   them, and must NOT draw an empty Routes box: "this isn't a web app" is an
 *   answer, not a failure.
 *
 * The grouping itself is pure and lives in `ui/src/lib/entry-model.ts`; it is
 * driven here from the real payload so a wire change that the pure tests would
 * happily keep passing still fails somewhere.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { resetEntryPointsCache } from '../src/ui-server/api/entrypoints';
import { splitRouteName } from '../src/ui-server/api/routes';
import { isTestFile, isTestPath } from '../src/search/query-utils';
import { buildEntryPanel, frameworkPhrase } from '../ui/src/lib/entry-model';
import type { WireEntryPoints } from '../ui/src/lib/api';

const FIXTURE_GO = path.join(__dirname, 'fixtures', 'payroll-go');

interface Instance {
  dir: string;
  root: string;
  cg: CodeGraph;
  api: GraphApi;
  server: UiServerHandle;
}

function request(port: number, requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${port}` },
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

async function getJson(instance: Instance, requestPath: string, expected = 200): Promise<any> {
  const res = await request(instance.server.port, requestPath);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(expected);
  return JSON.parse(res.body);
}

async function serve(root: string, dir: string, cg: CodeGraph): Promise<Instance> {
  const api = createGraphApi({ projectRoot: root });
  const server = await startUiServer({ projectRoot: root, port: 0, api: api.handler });
  return { dir, root, cg, api, server };
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

async function stop(instance: Instance | undefined): Promise<void> {
  if (!instance) return;
  await instance.server.close();
  instance.api.close();
  instance.cg.destroy();
  fs.rmSync(instance.dir, { recursive: true, force: true });
}

/* ======================================================================== */
/* A routed Go service — the issue's acceptance case                        */
/* ======================================================================== */

describe('entry points on a routed service', () => {
  let go: Instance;
  let payload: WireEntryPoints;

  beforeAll(async () => {
    resetEntryPointsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-entry-go-'));
    fs.cpSync(FIXTURE_GO, dir, { recursive: true });
    // A stray index in the checked-in tree would be copied in and reused.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });

    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    go = await serve(dir, dir, cg);
    payload = (await getJson(go, '/api/entrypoints')) as WireEntryPoints;
  }, 120_000);

  afterAll(async () => {
    await stop(go);
  });

  it('names the framework the route list came from', () => {
    expect(payload.frameworks).toContain('go');
    expect(frameworkPhrase(payload.frameworks)).toContain('go');
  });

  it('lists every route with the symbol that serves it', () => {
    expect(payload.routes.routed).toBe(true);
    expect(payload.routes.routeCount).toBe(4);

    const rows = payload.routes.items.items;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.url)).toEqual(
      expect.arrayContaining([
        'POST /v1/payroll/cycles/{cycleID}/run',
        'GET /v1/payroll/cycles/{cycleID}',
        'GET /v1/payroll/cycles/{cycleID}/payslips',
        'GET /healthz',
      ])
    );

    const run = rows.find((r) => r.url.startsWith('POST '));
    expect(run).toBeDefined();
    expect(run?.method).toBe('POST');
    expect(run?.path).toBe('/v1/payroll/cycles/{cycleID}/run');
    expect(run?.handler).toBe('RunCycle');
    expect(run?.file).toBe('internal/transport/httpapi/payroll_handler.go');
    // A row has to be navigable, or it is a label.
    expect(run?.handlerId).toBeTruthy();
    expect(rows.every((r) => r.handlerId)).toBe(true);
  });

  it('carries where each URL is registered, which is not where it is served', () => {
    const rows = payload.routes.items.items;
    // Every route is registered by NewRouter; three of the four are served
    // from a different file. Without the registration site there is nothing
    // to group four routes under.
    expect(new Set(rows.map((r) => r.routeFile))).toEqual(
      new Set(['internal/transport/httpapi/router.go'])
    );
    expect(new Set(rows.map((r) => r.file)).size).toBe(2);
    expect(rows.every((r) => r.routeLine > 0)).toBe(true);
  });

  it('groups the panel by the router file, with the handler in the meta line', () => {
    const panel = buildEntryPanel(payload);
    const routes = panel.sections.find((s) => s.id === 'routes');
    expect(routes).toBeDefined();
    expect(routes?.groups).toHaveLength(1);
    expect(routes?.groups[0]?.path).toBe('internal/transport/httpapi/router.go');
    expect(routes?.groups[0]?.rows).toHaveLength(4);
    // The framework rides in the section header, beside the count.
    expect(routes?.meta).toContain('go');

    const run = routes?.groups[0]?.rows.find((r) => r.method === 'POST');
    expect(run?.name).toBe('/v1/payroll/cycles/{cycleID}/run');
    expect(run?.meta).toBe('RunCycle · payroll_handler.go:34');
    expect(run?.target).toEqual({
      type: 'symbol',
      id: expect.any(String),
      name: 'RunCycle',
      kind: 'method',
    });
    // A route names a callable symbol, so it can start a flow.
    expect(run?.flowFrom).toBe('RunCycle');
  });

  it('draws the flow from a route handler down to the store', async () => {
    // The issue's "route -> insertNode-style flow": the POST handler reaching
    // the row that lands in the database.
    const flow = await getJson(go, '/api/flow?from=RunCycle&to=Upsert');
    expect(flow.flows.length).toBeGreaterThan(0);
    const hops = flow.flows[0].hops.map((h: any) => h.node.name);
    expect(hops[0]).toBe('RunCycle');
    expect(hops[hops.length - 1]).toBe('Upsert');
    expect(hops).toContain('runPayrollCycleAll');
    // Every hop after the first carries the edge that got there.
    expect(flow.flows[0].hops.slice(1).every((h: any) => h.edge)).toBe(true);
  });

  it('answers a second time from the cache', async () => {
    const again = await getJson(go, '/api/entrypoints');
    expect(again.timing.cached).toBe(true);
    expect(again.routes.items.items).toEqual(payload.routes.items.items);
  });

  it('refuses a route window it cannot answer truthfully', async () => {
    // Under three rows the engine's own "is this routed" test cannot run, so
    // the parameter is floored rather than silently answering "not routed".
    const body = await getJson(go, '/api/entrypoints?routes=2', 400);
    expect(body.error).toMatch(/routes/);
  });
});

/* ======================================================================== */
/* A library — no routes, and no empty Routes box                           */
/* ======================================================================== */

describe('entry points on a project with no routes', () => {
  let lib: Instance;
  let payload: WireEntryPoints;

  beforeAll(async () => {
    resetEntryPointsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-entry-lib-'));
    const root = path.join(dir, 'project');
    fs.mkdirSync(root, { recursive: true });

    write(
      root,
      'src/store.ts',
      `export function insertNode(name: string): string {
  return name.trim();
}

export function readNode(name: string): string {
  return insertNode(name);
}
`
    );
    // Module-level statements: the only reason an executable root is visible.
    write(
      root,
      'src/main.ts',
      `import { insertNode, readNode } from './store';

const first = insertNode('boot');
const second = readNode('warm');

export const started = [first, second];
`
    );
    write(
      root,
      '__tests__/store.test.ts',
      `import { insertNode } from '../src/store';

export function exercisesTheStore(): string {
  return insertNode('x');
}

exercisesTheStore();
`
    );
    // A fixture is not a test, even though the ranking treats it as one.
    write(root, '__tests__/fixtures/sample.ts', `export const sample = 1;\n`);

    const cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts', '__tests__/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    cg.resolveReferences();
    lib = await serve(root, dir, cg);
    payload = (await getJson(lib, '/api/entrypoints')) as WireEntryPoints;
  }, 120_000);

  afterAll(async () => {
    await stop(lib);
  });

  it('says it is not a routed app instead of drawing an empty list', () => {
    expect(payload.routes.routed).toBe(false);
    expect(payload.routes.items.items).toEqual([]);
    expect(payload.routes.items.total).toBe(0);

    const panel = buildEntryPanel(payload);
    // No Routes heading at all — an empty box under a heading reads as a
    // failure, and this is the ordinary shape of a library.
    expect(panel.sections.map((s) => s.id)).not.toContain('routes');
    // …and the panel is not empty: it fell back to what does exist.
    expect(panel.empty).toBeNull();
    expect(panel.sections.length).toBeGreaterThan(0);
  });

  it('falls back to the file that runs something at module level', () => {
    const files = payload.files.items.map((f) => f.file);
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('__tests__/store.test.ts');

    const main = payload.files.items.find((f) => f.file === 'src/main.ts');
    expect(main?.calls).toBeGreaterThan(0);
    expect(main?.reaches).toBeGreaterThan(0);

    const panel = buildEntryPanel(payload);
    const section = panel.sections.find((s) => s.id === 'files');
    expect(section?.title).toBe('Top-level files with calls');
    expect(section?.groups[0]?.path).toBe('src');
    // A file has no name the path finder can look up, so no flow chip.
    expect(section?.groups[0]?.rows.every((r) => r.flowFrom === null)).toBe(true);
    expect(section?.groups[0]?.rows[0]?.target).toEqual({ type: 'file', path: 'src/main.ts' });
  });

  it('lists the tests by what they exercise', () => {
    const tests = payload.tests.items.map((t) => t.file);
    expect(tests).toContain('__tests__/store.test.ts');
    // A fixture reaches nothing and is not a test; either reason keeps it out.
    expect(tests).not.toContain('__tests__/fixtures/sample.ts');

    const suite = payload.tests.items.find((t) => t.file === '__tests__/store.test.ts');
    expect(suite?.reaches).toBeGreaterThan(0);
    expect(suite?.refs).toBeGreaterThanOrEqual(suite?.reaches ?? 0);

    const panel = buildEntryPanel(payload);
    const section = panel.sections.find((s) => s.id === 'tests');
    expect(section?.title).toBe('Tests');
    expect(section?.groups[0]?.rows[0]?.meta).toMatch(/^exercises \d+ files? · \d+ references?$/);
  });

  it('counts the tests exactly, and the derived lists as a floor', () => {
    // Every count equals a list in the same payload, or is labelled a floor.
    expect(payload.tests.total).toBe(payload.tests.items.length);
    expect(payload.files.total).toBeGreaterThanOrEqual(payload.files.items.length);
    expect(payload.hubs.total).toBeGreaterThanOrEqual(payload.hubs.items.length);

    const panel = buildEntryPanel(payload);
    expect(panel.sections.find((s) => s.id === 'tests')?.floor).toBe(false);
    expect(panel.sections.find((s) => s.id === 'files')?.floor).toBe(true);
  });
});

/* ======================================================================== */
/* The narrow test predicate                                                */
/* ======================================================================== */

describe('what counts as a test', () => {
  it('keeps the suites and drops the examples', () => {
    for (const suite of [
      'foo_test.go',
      'src/foo.test.ts',
      'src/__tests__/foo.ts',
      'test/foo.rb',
      'src/FooTest.java',
      'app/src/jvmTest/Bar.kt',
    ]) {
      expect(isTestPath(suite), suite).toBe(true);
      expect(isTestFile(suite), suite).toBe(true);
    }

    // Examples, benchmarks and fixtures are still off-target for RANKING —
    // nothing about this change moves that — but they are not tests, and a
    // heading that says "Tests" must not gather them.
    for (const other of ['examples/demo.ts', 'benchmarks/run.ts', 'fixtures/a.ts']) {
      expect(isTestFile(other), other).toBe(true);
      expect(isTestPath(other), other).toBe(false);
    }
  });
});

/* ======================================================================== */
/* Route names                                                              */
/* ======================================================================== */

describe('splitting a route name', () => {
  it('takes the verb off when there is one', () => {
    expect(splitRouteName('POST /v1/users')).toEqual({ method: 'POST', path: '/v1/users' });
    expect(splitRouteName('ANY /healthz')).toEqual({ method: 'ANY', path: '/healthz' });
  });

  it('leaves a file-routed page whole', () => {
    // A verb column invented out of the first path segment would be a lie, and
    // the URL would lose its head.
    expect(splitRouteName('/blog/[slug]')).toEqual({ method: null, path: '/blog/[slug]' });
    expect(splitRouteName('user.created handler')).toEqual({
      method: null,
      path: 'user.created handler',
    });
  });
});
