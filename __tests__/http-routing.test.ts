import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractHttpRoutes, httpRoutingResolver } from '../src/resolution/frameworks/http-routing';
import { expressResolver } from '../src/resolution/frameworks/express';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'javascript', 'tsx', 'jsx']);
});

const extract = (source: string) => extractHttpRoutes('server.ts', source);
const names = (source: string) =>
  extract(source)
    .nodes.map((n) => n.name)
    .sort();

describe('HTTP framework declarations', () => {
  it.each([
    [
      'Hono',
      "import { Hono as Web } from 'hono'; const api = new Web(); api.get('/users/:id', auth, handler)",
      'GET /users/:id',
    ],
    [
      'Elysia',
      "import { Elysia } from 'elysia'; new Elysia().get('/users', handler, { beforeHandle: auth })",
      'GET /users',
    ],
    [
      'Fastify',
      "import Fastify from 'fastify'; const api = Fastify(); api.get('/users', { schema: {} }, handler)",
      'GET /users',
    ],
    [
      'Hyper-Express',
      "import HyperExpress from 'hyper-express'; const api = new HyperExpress.Server(); api.get('/users', { max_body_length: 10 }, auth, handler)",
      'GET /users',
    ],
    [
      'Koa',
      "import Router from '@koa/router'; const api = new Router(); api.get('users', '/users', auth, handler)",
      'GET /users',
    ],
    [
      'H3',
      "import { H3 } from 'h3'; new H3().get('/users', handler, { meta: { tag: 'users' } })",
      'GET /users',
    ],
    [
      'Vixeny',
      "import { wrap } from 'vixeny'; wrap()().get({path:'/users', f:handler})",
      'GET /users',
    ],
    ['Bun', "Bun.serve({routes:{'/users':handler}})", 'ANY /users'],
    [
      'Effect',
      "import { HttpRouter as HTTP } from 'effect/unstable/http'; HTTP.add('GET', '/users', handler)",
      'GET /users',
    ],
  ])('%s finds its handler, not middleware or trailing options', (_framework, source, route) => {
    const result = extract(source);
    expect(result.nodes.map((n) => n.name)).toEqual([route]);
    expect(result.references).toEqual([
      expect.objectContaining({
        fromNodeId: result.nodes[0].id,
        referenceName: 'handler',
        referenceKind: 'references',
      }),
    ]);
  });

  it('supports CommonJS factory and namespace imports', () => {
    expect(names("const fastify = require('fastify')(); fastify.head('/ready', handler)")).toEqual([
      'HEAD /ready',
    ]);
    expect(names("const { Hono: Web } = require('hono'); new Web().get('/x', handler)")).toEqual([
      'GET /x',
    ]);
    expect(
      names(
        "const HyperExpress = require('hyper-express'); new HyperExpress.Router().post('/x', handler)",
      ),
    ).toEqual(['POST /x']);
    expect(
      names(
        "import * as HTTP from 'effect/unstable/http/HttpRouter'; HTTP.route('HEAD','/x',handler)",
      ),
    ).toEqual(['HEAD /x']);
  });

  it('reads literal method/path arrays and fluent chains', () => {
    expect(
      names(
        `import {Hono} from 'hono'; new Hono().on(['GET','POST'], ['/a','/b'], handler).delete('/c', handler)`,
      ),
    ).toEqual(['DELETE /c', 'GET /a', 'GET /b', 'POST /a', 'POST /b']);
    expect(
      names(
        "import Hyper from 'hyper-express'; new Hyper.Router().route('/x').get(handler).post(handler)",
      ),
    ).toEqual(['GET /x', 'POST /x']);
    expect(
      names("import {H3} from 'h3'; new H3().on('PATCH','/x',handler).all('/any',handler)"),
    ).toEqual(['ANY /any', 'PATCH /x']);
  });

  it('reads Fastify options objects, shorthand handlers, and method definitions', () => {
    const result = extract(`import Fastify from 'fastify'; const api=Fastify();
api.route({method:['GET','HEAD'],url:'/a',handler});
api.post('/b',{handler});
api.route({method:'PUT',url:'/c',handler(req,reply){ save(req); }});`);
    expect(result.nodes.map((n) => n.name)).toEqual(['GET /a', 'HEAD /a', 'POST /b', 'PUT /c']);
    expect(result.references.map((r) => r.referenceName)).toEqual([
      'handler',
      'handler',
      'handler',
      'save',
    ]);
  });

  it('reads Bun method tables, imported serve, and static responses without invented handlers', () => {
    const result = extract(`import {serve as start} from 'bun'; start({routes:{
'/x': {GET: handler, POST(req){ save(req); }},
'/health': new Response('ok'), '/files/*': {dir:'./public'}, '/fallback': false
}});`);
    expect(result.nodes.map((n) => n.name)).toEqual([
      'GET /x',
      'POST /x',
      'ANY /health',
      'ANY /files/*',
    ]);
    expect(result.references.map((r) => r.referenceName)).toEqual(['handler', 'save']);
  });

  it('finds Bun declarations assigned to a mutable server handle', () => {
    expect(
      names(`let server; beforeAll(() => { server = Bun.serve({ routes: { '/x': handler } }); });`),
    ).toEqual(['ANY /x']);
  });

  it('keeps static Elysia responses and uses the f property of Vixeny route objects', () => {
    const result = extract(`import {Elysia} from 'elysia'; import {wrap} from 'vixeny';
new Elysia().get('/text', 'ok').route('PUT','/object',{ok:true},{beforeHandle:auth});
wrap()().route({method:'PATCH',path:'/v',f:handler,resolve:{x:{f:unrelated}}});`);
    expect(result.nodes.map((n) => n.name)).toEqual(['GET /text', 'PUT /object', 'PATCH /v']);
    expect(result.references.map((r) => r.referenceName)).toEqual(['handler']);
  });

  it('attributes calls from inline handlers to their own endpoint at the actual call location', () => {
    const result = extract(`import {Hono} from 'hono'; const api=new Hono();
api.get('/a', () => {
  return load();
});
api.post('/b', function () { return save(); });`);
    expect(result.references.map((r) => [r.referenceName, r.line])).toEqual([
      ['load', 3],
      ['save', 5],
    ]);
    expect(result.references[0].fromNodeId).toBe(result.nodes[0].id);
    expect(result.references[1].fromNodeId).toBe(result.nodes[1].id);
  });

  it('composes same-file mounts without also publishing the relative child routes', () => {
    expect(
      names(`import {Hono} from 'hono'; const child=new Hono(); child.get('/x', handler);
const api=new Hono().basePath('/api'); api.route('/v1',child); api.route('/v2',child);`),
    ).toEqual(['GET /api/v1/x', 'GET /api/v2/x']);
    expect(
      names(`import Router from '@koa/router'; const child=new Router(); child.get('/x',handler);
const api=new Router({prefix:'/api'}); api.use('/v1',child.routes());`),
    ).toEqual(['GET /api/v1/x']);
    expect(
      names(`import Hyper from 'hyper-express'; const child=new Hyper.Router(); child.get('/x',handler);
const api=new Hyper.Server(); api.use('/api',child);`),
    ).toEqual(['GET /api/x']);
  });

  it('merges Hono root paths and snapshots basePath aliases when mounting', () => {
    expect(
      names(`import {Hono} from 'hono'; const child=new Hono(); child.get('/',handler);
const api=child.basePath('/v1'); api.get('/b',handler);
const root=new Hono(); root.route('/book',child); child.get('/late',handler);`),
    ).toEqual(['GET /book', 'GET /book/v1/b']);
  });

  it('applies scoped group/register prefixes and isolates callback parameters', () => {
    expect(
      names(
        `import {Elysia} from 'elysia'; new Elysia({prefix:'/api'}).group('/v1', app => app.get('/x',handler)).get('/y',handler)`,
      ),
    ).toEqual(['GET /api/v1/x', 'GET /api/y']);
    expect(
      names(
        `import Fastify from 'fastify'; const api=Fastify(); api.register(async (instance) => { instance.get('/x',handler) }, {prefix:'/api'});`,
      ),
    ).toEqual(['GET /api/x']);
    expect(
      names(
        `import {wrap} from 'vixeny'; wrap({wrap:{startsWith:'/api'}})().get({path:'/x',f:handler})`,
      ),
    ).toEqual([]);
  });

  it('does not turn comments, strings, regexes, or unrelated methods into endpoints', () => {
    expect(
      names(`import {Hono} from 'hono'; const api=new Hono();
// api.get('/comment',handler)
const text="api.get('/string',handler)";
const pattern=/api.get('regex',handler)/;
new Map().get('/map'); const unrelated={get(){}}; unrelated.get('/fake',handler);
api.get('/real',handler);`),
    ).toEqual(['GET /real']);
  });

  it('rejects shadowed constructors/receivers and mutable bindings', () => {
    expect(
      names(`import {Hono} from 'hono'; const api=new Hono();
function unrelated(api) { api.get('/fake',handler) }
function factory(Hono) { new Hono().get('/fake2',handler) }
function rest(...api) { api.get('/rest',handler) }
try {} catch (api) { api.get('/catch',handler) }
{ const api=new Map(); api.get('/fake3',handler) }
let changing=new Hono(); changing=other; changing.get('/fake4',handler);
api.get('/real',handler);`),
    ).toEqual(['GET /real']);
    expect(names(`function boot(Bun) { Bun.serve({routes:{'/fake':handler}}) }`)).toEqual([]);
  });

  it('leaves dynamic paths, prefixes, and spread options unresolved', () => {
    expect(
      names(`import {Elysia} from 'elysia'; import Fastify from 'fastify';
new Elysia({prefix:env.PREFIX}).get('/x',handler);
new Elysia().group(prefix, app=>app.get('/y',handler));
new Elysia().get('/'+id,handler);
new Elysia({...config}).get('/unknown-prefix',handler);
Fastify().register(app=>app.get('/unknown-prefix',handler), options);
Fastify().route({method:'GET',url:'/x',handler,...options});`),
    ).toEqual([]);
  });

  it('does not bind member handlers or callback-local calls to unrelated global names', () => {
    const result = extract(`import {Hono} from 'hono'; const api=new Hono();
api.get('/member', controller.handler);
api.get('/parameter', (load) => load());
api.get('/local', () => { const load=other; return load(); });`);
    expect(result.nodes).toHaveLength(3);
    expect(result.references).toEqual([]);
  });

  it('does not propagate router identity through unrelated return values or shadowed require', () => {
    expect(
      names(`import {Hono} from 'hono'; import Router from '@koa/router';
new Hono().request('/').get('/fake',handler);
new Router().routes().get('/fake',handler);
function build(require) { const api=require('fastify')(); api.get('/fake',handler); }`),
    ).toEqual([]);
  });

  it('does not reinterpret framework lookups, middleware, or unsupported methods', () => {
    expect(
      names(`import Router from '@koa/router'; import {H3} from 'h3'; import {wrap} from 'vixeny'; import {HttpRouter} from 'effect/unstable/http';
const koa=new Router(); koa.route('name'); koa.on('error',handler);
new H3().use('/middleware',handler); wrap()().patch({path:'/fake',f:handler});
HttpRouter.add('HEAD','/unsupported',handler);`),
    ).toEqual([]);
  });

  it('keeps Express extraction from duplicating foreign route calls in a mixed file', () => {
    const source =
      "import {Hono} from 'hono'; import express from 'express'; const app=new Hono(); const router=express.Router(); app.get('/hono',handler); router.get('/express',handler)";
    expect(extract(source).nodes.map((n) => n.name)).toEqual(['GET /hono']);
    expect(expressResolver.extract!('server.ts', source).nodes.map((n) => n.name)).toEqual([
      'GET /express',
    ]);
    const chain =
      "import Hyper from 'hyper-express'; const router=new Hyper.Router(); router.route('/x').get(handler)";
    expect(expressResolver.extract!('server.ts', chain).nodes).toEqual([]);
  });
});

describe('HTTP routes through indexing and resolution', () => {
  let cg: CodeGraph | undefined;
  let dir: string | undefined;
  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each([
    ['hono', "import {Hono} from 'hono'; new Hono().get('/x',handler);"],
    ['fastify', "import Fastify from 'fastify'; const app=Fastify(); app.get('/x',handler);"],
    ['elysia', "import {Elysia} from 'elysia'; new Elysia().get('/x',handler);"],
    ['hyper-express', "import Hyper from 'hyper-express'; new Hyper.Server().get('/x',handler);"],
    ['@koa/router', "import Router from '@koa/router'; new Router().get('/x',handler);"],
    ['h3', "import {H3} from 'h3'; new H3().get('/x',handler);"],
    ['vixeny', "import {wrap} from 'vixeny'; wrap()().get({path:'/x',f:handler});"],
    [
      'effect',
      "import {HttpRouter} from 'effect/unstable/http'; HttpRouter.add('GET','/x',handler);",
    ],
    ['@types/bun', "Bun.serve({routes:{'/x':{GET:handler}}});"],
  ])('%s emits exactly one route and resolves its imported handler', async (pkg, source) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-http-route-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { [pkg]: '*' } }),
    );
    fs.writeFileSync(path.join(dir, 'handler.ts'), 'export function handler() { return 1; }');
    fs.writeFileSync(path.join(dir, 'server.ts'), "import {handler} from './handler';\n" + source);
    cg = await CodeGraph.init(dir, { index: true });
    const routes = cg.getNodesByKind('route');
    expect(routes.map((n) => n.name)).toEqual(['GET /x']);
    const handler = cg.getNodesByKind('function').find((n) => n.name === 'handler');
    expect(handler).toBeDefined();
    expect(cg.getOutgoingEdges(routes[0].id)).toContainEqual(
      expect.objectContaining({ target: handler!.id, kind: 'references' }),
    );
  });

  it('detects a standalone Bun server without a dependency manifest', () => {
    expect(
      httpRoutingResolver.detect({
        getAllFiles: () => ['server.ts'],
        fileExists: () => false,
        readFile: (f: string) => (f === 'server.ts' ? "Bun.serve({routes:{'/':handler}})" : null),
      } as any),
    ).toBe(true);
  });
});
