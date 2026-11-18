/**
 * Elysia (Bun) routes (#3255).
 *
 * Elysia registers routes with chained calls on an instance — `new
 * Elysia({ prefix: '/v1' }).get('/healthcheck', …).group('/users', (g) =>
 * g.get('/:id', getUser))` — and composes instances with `.use(plugin)`. No
 * resolver read any of it, so an Elysia backend had no route nodes at all and
 * `codegraph_explore` could not follow a request from its route to its handler.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { elysiaResolver } from '../src/resolution/frameworks/elysia';
import { expressResolver } from '../src/resolution/frameworks/express';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

const extract = (src: string, file = 'src/app.ts') => elysiaResolver.extract!(file, src);
const names = (src: string, file?: string) => extract(src, file).nodes.map((n) => n.name);
/** Each route with the references its handler makes: `GET /x -> references:getX calls:svc.find`. */
const wiring = (src: string, file?: string) => {
  const { nodes, references } = extract(src, file);
  return nodes.map((n) =>
    [n.name, ...references.filter((r) => r.fromNodeId === n.id).map((r) => `${r.referenceKind}:${r.referenceName}`)].join(' ')
  );
};

describe('Elysia routes within a file', () => {
  it("reads the issue's app: the instance prefix, a group, and a custom verb", () => {
    const src = `import { Elysia } from 'elysia'
import { getUser } from './users'
const handler = () => 'trace'
const app = new Elysia({ prefix: '/v1' })
  .get('/healthcheck', () => 'ok')
  .group('/users', (group) =>
    group.get('/:id', getUser)
  )
  .route('TRACE', '/trace', handler)
`;
    const { nodes } = extract(src);
    expect(nodes.map((n) => [n.name, n.qualifiedName, n.startLine])).toEqual([
      ['GET /v1/healthcheck', 'src/app.ts::GET:/v1/healthcheck', 5],
      ['GET /v1/users/:id', 'src/app.ts::GET:/v1/users/:id', 7],
      ['TRACE /v1/trace', 'src/app.ts::TRACE:/v1/trace', 9],
    ]);
    expect(wiring(src)).toEqual([
      'GET /v1/healthcheck',
      'GET /v1/users/:id references:getUser',
      'TRACE /v1/trace references:handler',
    ]);
  });

  it('nests groups, with or without a hook object, and adds nothing for a guard', () => {
    const src = `import { Elysia, t } from 'elysia'
export const users = new Elysia({ name: 'users', prefix: 'users' })
  .group('/admin', { beforeHandle: ({ set }) => isAdmin(set) }, (app) =>
    app
      .delete('/:id', ({ params }) => UserService.remove(params.id))
      .guard({ query: t.Object({ q: t.String() }) }, (app) => app.get('/search', ({ query }) => UserService.search(query.q)))
      .group('/audit', (app) => app.get('', () => Audit.list()))
  )
  .guard((app) => app.post('/invite', invite))
`;
    expect(wiring(src)).toEqual([
      'DELETE /users/admin/:id calls:UserService.remove',
      'GET /users/admin/search calls:UserService.search',
      'GET /users/admin/audit calls:Audit.list',
      'POST /users/invite references:invite',
    ]);
  });

  it("attributes an inline handler's calls to the route, in Elysia 1's and Elysia 2's argument order", () => {
    const src = `import { Elysia, t } from 'elysia'
new Elysia()
  .post('/users', async ({ body }) => {
    const user = await UserService.create(body)
    return status(201, user)
  }, { body: t.Object({ name: t.String() }) })
  .get('/stream', { detail: { summary: 'hook first' } }, async function* ({ query }) { yield Feed.read(query) })
  .patch('/users/:id', UserController.update, { beforeHandle: [auth] })
`;
    expect(wiring(src)).toEqual([
      'POST /users calls:UserService.create',
      'GET /stream calls:Feed.read',
      'PATCH /users/:id references:UserController.update',
    ]);
  });

  it('reads every verb, a static response, a wildcard and a WebSocket route', () => {
    const src = `import { Elysia, file } from 'elysia'
new Elysia()
  .get('/', file('public/index.html'))
  .head('/', 'ok')
  .options('/opts', () => null)
  .put('/a', a)
  .connect('/tunnel', tunnel)
  .all('/auth/*', ({ request }) => auth.handler(request))
  .ws('/live/:room', { message(ws, msg) { Rooms.broadcast(ws.data.params.room, msg) }, open: onOpen })
`;
    expect(wiring(src)).toEqual([
      'GET /',
      'HEAD /',
      'OPTIONS /opts',
      'PUT /a references:a',
      'CONNECT /tunnel references:tunnel',
      'ALL /auth/* calls:auth.handler',
      'WS /live/:room calls:Rooms.broadcast references:onOpen',
    ]);
  });

  it('reads functional plugins: a parameter typed Elysia, as an arrow or a function', () => {
    const src = `import type { Elysia } from 'elysia'
import * as authController from '../controllers/auth'
export const authRoutes = (app: Elysia) =>
  app.group('/auth', (app) => app.post('/signup', authController.signup).post('/login', authController.login, { body: 'auth' }))
export default function routes(app: Elysia) {
  app.get('/me', ({ user }) => Users.me(user))
  return app.group('/x', (g) => g.get('/y', y))
}
`;
    expect(wiring(src)).toEqual([
      'POST /auth/signup references:authController.signup',
      'POST /auth/login references:authController.login',
      'GET /me calls:Users.me',
      'GET /x/y references:y',
    ]);
  });

  it('reads routes registered on a name bound to an instance, and nothing that only looks like one', () => {
    const src = `import { Elysia } from 'elysia'
const app = new Elysia({ prefix: '/api' })
app.get('/a', ({ db }) => db.query('select 1').get(1))
if (dev) {
  await import('./tw').then(async ({ gen }) => {
    const css = await gen()
    app.get('/generated.css', () => css)
  })
}
const db = new Database()
db.query('x').get('/not-a-route', 2)
cache.get('/also-not', 1)
request.headers.get('authorization')
export default app
`;
    expect(wiring(src)).toEqual(['GET /api/a calls:db.query', 'GET /api/generated.css']);
  });

  it("reads a handler's calls from its code, never from the text of its strings", () => {
    const src = `import { Elysia } from 'elysia'
new Elysia().post('/jobs', ({ body }) => {
  db.query("INSERT INTO jobs (user_id, date) VALUES (?, ?)").run(body.user, now())
  warn('Only published apps (or apps with a name) are listed')
  return \`<p>\${renderRow(body)} saved (see list)</p>\`
})
`;
    expect(wiring(src)).toEqual(['POST /jobs calls:db.query calls:now calls:renderRow']);
  });

  it('reads a method an options object defines as a definition, not a call', () => {
    const src = `import { Elysia } from 'elysia'
new Elysia().post('/ask', async function* ({ body }) {
  const stream = AI.ask({ body, onToolStart() { mark() }, async onFinish({ usage }): Promise<void> { record(usage) } })
  return new Response(new ReadableStream({ start(controller) { controller.close() } }))
})
`;
    expect(wiring(src)).toEqual(['POST /ask calls:AI.ask calls:mark calls:record calls:Response calls:ReadableStream calls:controller.close']);
  });

  it("leaves out a bare call of the handler's own parameter, which is no project function", () => {
    const src = `import { Elysia } from 'elysia'
new Elysia()
  .get('/me', ({ currentUser, body }) => save(currentUser(), body))
  .ws('/live', {
    open: ({ send, close }) => { close(1000); notify() },
    message(ws, msg) { ws.send(msg); broadcast(msg) },
  })
`;
    expect(wiring(src)).toEqual(['GET /me calls:save', 'WS /live calls:notify calls:broadcast']);
  });

  it('walks an instance or a plugin written inside .use()', () => {
    const src = `import { Elysia } from 'elysia'
export const api = new Elysia({ prefix: '/api' })
  .use(new Elysia({ prefix: '/inline' }).get('/y', () => 2))
  .use((app) => app.get('/fn', () => 3))
`;
    expect(names(src)).toEqual(['GET /api/inline/y', 'GET /api/fn']);
  });

  it('skips a path or a prefix that is not a literal, and routes in comments or strings', () => {
    const src = `import { Elysia } from 'elysia'
new Elysia({ prefix: WEBROOT })
  // .get('/commented', h)
  .get(\`/tpl/\${x}\`, h)
  .get(somePath, h)
  .get('/a' + b, h)
  .get('/kept', h)
const doc = \`new Elysia().get('/in-a-string', h)\`
`;
    expect(names(src)).toEqual(['GET /kept']);
  });

  it('reads .tsx and .jsx files, as their own language', () => {
    const tsx = extract("import { Elysia } from 'elysia'\nexport const page = new Elysia().get('/', () => <Page />)\n", 'src/pages/root.tsx');
    expect(tsx.nodes.map((n) => [n.name, n.language])).toEqual([['GET /', 'tsx']]);
    expect(extract("import { Elysia } from 'elysia'\nnew Elysia().get('/j', h)\n", 'src/a.jsx').nodes.map((n) => n.language)).toEqual(['jsx']);
  });

  it('reads nothing in a file that never names Elysia', () => {
    expect(names("const app = express()\napp.get('/x', h)\nrouter.get('/y', h)\n")).toEqual([]);
  });
});

describe('Express and Elysia in one project', () => {
  it("leaves an Elysia file's routes to the Elysia resolver", () => {
    const elysia = "import { Elysia } from 'elysia'\nexport const users = new Elysia().group('/users', (app) => app.get('/:id', getUser))\n";
    expect(expressResolver.extract!('src/users.ts', elysia).nodes).toEqual([]);
    expect(names(elysia, 'src/users.ts')).toEqual(['GET /users/:id']);
    // An Express file reads as it always did.
    const express = "import express from 'express'\nconst app = express()\napp.get('/x', getX)\n";
    expect(expressResolver.extract!('src/server.ts', express).nodes.map((n) => n.name)).toEqual(['GET /x']);
  });
});

describe('Elysia detection', () => {
  const context = (manifest: Record<string, unknown> | null): ResolutionContext =>
    ({
      getAllFiles: () => ['src/index.ts'],
      fileExists: (p: string) => p === 'package.json' && manifest !== null,
      readFile: (p: string) => (p === 'package.json' && manifest ? JSON.stringify(manifest) : null),
    }) as unknown as ResolutionContext;

  it('is detected from a package.json that depends on elysia, and only then', () => {
    expect(elysiaResolver.detect(context({ dependencies: { elysia: '^1.4.0' } }))).toBe(true);
    expect(elysiaResolver.detect(context({ dependencies: { express: '^4.0.0', '@elysiajs/eden': '^1.0.0' } }))).toBe(false);
    expect(elysiaResolver.detect(context(null))).toBe(false);
  });
});

describe('Elysia routes across files', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const project = (files: Record<string, string>): string => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-elysia-'));
    const all: Record<string, string> = { 'package.json': JSON.stringify({ dependencies: { elysia: '^1.4.0' } }), ...files };
    for (const [rel, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
  };

  const SERVICE = `export class UserService {
  static findById(id: string) { return load(id) }
}
export function load(id: string) { return { id } }
export function createUser(body: unknown) { return body }
`;
  const USERS = `import { Elysia } from 'elysia'
import { UserService, createUser } from './service'
export const users = new Elysia({ prefix: '/users' })
  .get('/:id', ({ params }) => UserService.findById(params.id))
  .post('/', createUser)
`;

  it('puts a plugin under the prefix of the .use() that mounts it, and links the handlers', async () => {
    const dir = project({
      'src/service.ts': SERVICE,
      'src/users.ts': USERS,
      'src/health.ts': "import type { Elysia } from 'elysia'\nexport default (app: Elysia) => app.get('/health', () => 'ok')\n",
      'src/routes/index.ts': "export { users as userRoutes } from '../users'\n",
      'src/index.ts': `import { Elysia } from 'elysia'
import { userRoutes } from './routes'
import health from './health'
export const app = new Elysia({ prefix: '/v1' })
  .get('/healthcheck', () => 'ok')
  .group('/api', (app) => app.use(userRoutes))
  .use(health)
  .use(import('./lazy'))
`,
      'src/lazy.ts': "import { Elysia } from 'elysia'\nexport default new Elysia({ prefix: '/lazy' }).get('/x', () => 1)\n",
      'src/client.ts': 'export async function loadUser(id: string) {\n  return fetch(`/v1/api/users/${id}`)\n}\n',
    });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const routes = cg.getNodesByKind('route');
      expect(routes.map((n) => n.name).sort()).toEqual([
        'GET /v1/api/users/:id',
        'GET /v1/health',
        'GET /v1/healthcheck',
        'GET /v1/lazy/x',
        'POST /v1/api/users',
      ]);
      const route = (name: string): Node => routes.find((n) => n.name === name)!;
      // The in-file path stays in the qualified name, so the pass can run again.
      expect(route('GET /v1/api/users/:id').qualifiedName).toBe('src/users.ts::GET:/users/:id');

      const out = (name: string) =>
        cg.getOutgoingEdges(route(name).id).map((e) => `${e.kind}:${cg.getNode(e.target)?.name}`);
      expect(out('GET /v1/api/users/:id')).toContain('calls:findById');
      expect(out('POST /v1/api/users')).toContain('references:createUser');

      // A client's literal fetch reaches the route, and through it the service:
      // codegraph_explore's Flow crosses the route end to end.
      const loadUser = cg.getNodesByKind('function').find((n) => n.name === 'loadUser')!;
      const hop = cg.getOutgoingEdges(loadUser.id).find((e) => e.target === route('GET /v1/api/users/:id').id);
      expect((hop?.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe('http-client');
      const explored = await new ToolHandler(cg).execute('codegraph_explore', { query: 'loadUser findById load' });
      const text = explored.content?.[0]?.text ?? '';
      const flow = text.slice(text.indexOf('**Flow (call path among the symbols you queried)**'));
      expect(flow).toMatch(/^\*\*Flow[^\n]*\n\n1\. loadUser [^\n]*\n[^\n]*HTTP GET[^\n]*\n2\. GET \/v1\/api\/users\/:id [^\n]*\n\s+↓ calls\n3\. findById [^\n]*\n\s+↓ calls\n4\. load /);
    } finally {
      cg.close();
    }
  });

  it("mounts a plugin named as a group's callback, or listed in an array", async () => {
    const dir = project({
      'src/service.ts': SERVICE,
      'src/users.ts': USERS,
      'src/admin.ts': "import type { Elysia } from 'elysia'\nexport const adminRoutes = (app: Elysia) => app.delete('/cache', () => 1)\n",
      'src/index.ts': `import { Elysia } from 'elysia'
import { users } from './users'
import { adminRoutes } from './admin'
new Elysia().group('/admin', adminRoutes).group('/v2', (app) => app.use([cors(), users]))
`,
    });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getNodesByKind('route').map((n) => n.name).sort()).toEqual(['DELETE /admin/cache', 'GET /v2/users/:id', 'POST /v2/users']);
    } finally {
      cg.close();
    }
  });

  it('leaves an instance mounted at two different prefixes at its in-file path', async () => {
    const dir = project({
      'src/service.ts': SERVICE,
      'src/users.ts': USERS,
      'src/index.ts': `import { Elysia } from 'elysia'
import { users } from './users'
new Elysia().group('/a', (app) => app.use(users)).group('/b', (app) => app.use(users))
`,
    });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getNodesByKind('route').map((n) => n.name).sort()).toEqual(['GET /users/:id', 'POST /users']);
    } finally {
      cg.close();
    }
  });

  it("follows a module a binding imports lazily, and leaves a test suite's own app out", async () => {
    const dir = project({
      'src/service.ts': SERVICE,
      'src/users.ts': USERS.replace('export const users =', 'export default'),
      'src/index.ts': `import { Elysia } from 'elysia'
const users = enabled ? (await import('./users')).default : null
export const api = new Elysia({ prefix: '/api' })
if (users) api.use(users)
`,
      'test/users.test.ts': `import { Elysia } from 'elysia'
const route = await import('../src/users')
const app = new Elysia().use(route.default)
`,
    });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getNodesByKind('route').map((n) => n.name).sort()).toEqual(['GET /api/users/:id', 'POST /api/users']);
    } finally {
      cg.close();
    }
  });

  it('is idempotent across syncs, follows a changed mount, and undoes a removed one', async () => {
    const index = 'src/index.ts';
    const mounted = (prefix: string) =>
      `import { Elysia } from 'elysia'\nimport { users } from './users'\nnew Elysia().group('${prefix}', (app) => app.use(users))\n`;
    const dir = project({ 'src/service.ts': SERVICE, 'src/users.ts': USERS, [index]: mounted('/api') });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const routeNames = () => cg.getNodesByKind('route').map((n) => n.name).sort();
      expect(routeNames()).toEqual(['GET /api/users/:id', 'POST /api/users']);
      fs.appendFileSync(path.join(dir, 'src/service.ts'), '// touched\n');
      await cg.sync();
      expect(routeNames()).toEqual(['GET /api/users/:id', 'POST /api/users']);
      fs.writeFileSync(path.join(dir, index), mounted('/v2'));
      await cg.sync();
      expect(routeNames()).toEqual(['GET /v2/users/:id', 'POST /v2/users']);
      fs.writeFileSync(path.join(dir, index), "import { Elysia } from 'elysia'\nnew Elysia().get('/', () => 'ok')\n");
      await cg.sync();
      expect(routeNames()).toEqual(['GET /', 'GET /users/:id', 'POST /users']);
    } finally {
      cg.close();
    }
  });
});
