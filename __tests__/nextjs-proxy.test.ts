/**
 * Next.js proxy (`proxy.ts`, `middleware.ts` before Next 16): each route its
 * `config.matcher` accepts runs it first, so a route links to what runs in it
 * and a flow or an impact can cross a boundary no import spans.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { compileMatcher, matcherCovers, nextProxyDir, readProxyMatcher } from '../src/resolution/frameworks/next-proxy';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import { routeRoots } from '../src/ui-server/api/route-roots';
import { buildScreens } from '../src/ui-server/api/screens';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import type { Edge, Node } from '../src/types';

const covers = (source: string, route: string, file = 'app/x/page.tsx'): boolean | null => {
  const regex = compileMatcher(source);
  return regex === null ? null : matcherCovers(regex, route, file);
};

describe('a matcher entry', () => {
  it.each([
    ['/about', '/about', true],
    ['/about', '/about/team', false],
    ['/about', '/blog/about', false],
    ['/', '/', true],
    ['/', '/about', false],
    ['/about/:rest', '/about', false],
    ['/about/:rest', '/about/team', true],
    ['/about/:rest', '/about/team/lead', false],
    ['/about/:rest*', '/about', true],
    ['/about/:rest*', '/about/team/lead', true],
    ['/about/:rest*', '/aboutus', false],
    ['/about/:rest+', '/about', false],
    ['/about/:rest+', '/about/team/lead', true],
    ['/about/:rest?', '/about', true],
    ['/about/:rest?', '/about/team', true],
    ['/about/:rest?', '/about/team/lead', false],
    ['/:rest*', '/', true],
    ['/:rest*', '/a/b/c', true],
    ['/:locale/about', '/en/about', true],
    ['/blog/:slug', '/blog/:id', true],
    ['/api/:rest*', '/api/projects/:id', true],
  ])('%s against %s: %s', (source, route, expected) => {
    expect(covers(source, route)).toBe(expected);
  });

  it('reads the forms a regular expression takes in real apps', () => {
    // The negative lookahead of the Next docs.
    const starter = '/((?!api|_next/static|_next/image|favicon.ico).*)';
    expect(covers(starter, '/')).toBe(true);
    expect(covers(starter, '/dashboard/:id')).toBe(true);
    expect(covers(starter, '/api/users')).toBe(false);
    expect(covers(starter, '/apikeys')).toBe(false); // a prefix, as the regex reads it

    // Clerk's: everything but Next's own files and files with an extension.
    const clerk = '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)';
    expect(covers(clerk, '/dashboard')).toBe(true);
    expect(covers(clerk, '/feed.xml')).toBe(false);
    expect(covers('/(api|trpc)(.*)', '/api/users')).toBe(true);
    expect(covers('/(api|trpc)(.*)', '/trpc')).toBe(true);
    expect(covers('/(api|trpc)(.*)', '/users')).toBe(false);

    expect(covers('/((?!.*\\..*|_next).*)', '/pricing')).toBe(true);
    expect(covers('/((?!_next|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)', '/pricing')).toBe(true);
    expect(covers('/((?!api/|_next/|_static|_vercel|[\\w-]+\\.\\w+).*)', '/api/users')).toBe(false);
    expect(covers('/((?!api/|_next/|_static|_vercel|[\\w-]+\\.\\w+).*)', '/app')).toBe(true);
    expect(covers('/((?!api(?:/|$)|_next).*)', '/api')).toBe(false);
    expect(covers('/((?!api(?:/|$)|_next).*)', '/apikeys')).toBe(true);
    expect(covers('/((?!sitemap.xml$).*)', '/sitemap.xml')).toBe(false);
    expect(covers('/((?!_next).+)', '/')).toBe(false);
    expect(covers('/((?!_next).+)', '/x')).toBe(true);
    expect(covers('/dashboard(.*)', '/dashboard')).toBe(true);
    expect(covers('/dashboard(.*)', '/dashboard/settings')).toBe(true);
    expect(covers('/about/(.*)', '/about/team')).toBe(true);
    expect(covers('/:locale(en|fr)/about', '/en/about')).toBe(true);
    expect(covers('/:locale(en|fr)/about', '/de/about')).toBe(false);
  });

  it('never lets a literal stand in for a route parameter: a static page beside it would own that address', () => {
    expect(covers('/blog/featured', '/blog/:slug', 'app/blog/[slug]/page.tsx')).toBe(false);
    expect(covers('/docs/intro', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(false);
  });

  it('tells a required catch-all from an optional one by the file', () => {
    expect(covers('/docs', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(false);
    expect(covers('/docs', '/docs/:all*', 'app/docs/[[...all]]/page.tsx')).toBe(true);
    expect(covers('/docs/:p', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(true);
  });

  it('does not take an unescaped dot for a file extension: that pattern takes every path, and the proxy skips them', () => {
    // Written '/((?!.*\..*|_next).*)' in a JavaScript string, it reaches Next like this.
    expect(compileMatcher('/((?!.*..*|_next).*)')).toBeNull();
  });

  it.each([
    '/about/:rest(\\d+)',
    '/feed-(\\d+)',
    '/api/*',
    'about',
    '/((?!\\d+).*)',
    '/(a+)+',
    '/(.*)(.*)(.*)',
    '/:a*/:b*/:c*',
    `/${'a'.repeat(3000)}`,
  ])('%s is not read: no link, never a guess', (source) => {
    expect(compileMatcher(source)).toBeNull();
  });

  it('holds up against a pattern written to hang a regular expression', () => {
    const started = Date.now();
    const sources = ['/(a|a)(a|a)(a|a)(a|a)', '/((?!(a+)+$).*)', `/${'(.*)'.repeat(40)}`, '/(.*)(.*)x', '/:a*/:b*x'];
    for (const source of sources) {
      const regex = compileMatcher(source);
      if (regex) matcherCovers(regex, `/${'a/'.repeat(2000)}a`, 'app/x/page.tsx');
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('reading config.matcher', () => {
  const read = (src: string): string[] | 'all' => {
    const out = readProxyMatcher(src);
    return out === 'all' ? out : out.map((e) => e.source);
  };

  it('is every path with no config, or a config with no matcher', () => {
    expect(read('export function proxy() {}\n')).toBe('all');
    expect(read("export const config = { runtime: 'nodejs' }\n")).toBe('all');
  });

  it('reads a string, and an array of strings and { source } objects', () => {
    expect(read("export const config = { matcher: '/about/:rest*' }\n")).toEqual(['/about/:rest*']);
    expect(read(
      'export const config: MiddlewareConfig = {\n' +
      '  matcher: [\n' +
      "    '/dashboard/:rest*',\n" +
      "    { source: '/api/:rest*', missing: [{ type: 'header', key: 'x-internal' }] },\n" +
      '    `/account`,\n' +
      '  ],\n' +
      '}\n'
    )).toEqual(['/dashboard/:rest*', '/api/:rest*', '/account']);
  });

  it('unescapes the string the way the matcher sees it', () => {
    expect(read("export const config = { matcher: ['/((?!.*\\\\..*|_next).*)'] }\n")).toEqual(['/((?!.*\\..*|_next).*)']);
  });

  it('reads as nothing what Next could not read either', () => {
    expect(read("const extra = '/x'\nexport const config = { matcher: ['/kept', extra] }\n")).toEqual([]);
    expect(read("export const config = { matcher: ['/kept', ...more] }\n")).toEqual([]);
    expect(read("export const config = { matcher: ['/kept', { source: `/u/${id}` }] }\n")).toEqual([]);
    expect(read('export const config = { matcher: PROTECTED }\n')).toEqual([]);
    expect(read('const matcher = ["/a"]\nexport const config = { matcher }\n')).toEqual([]);
    expect(read('export const config = makeConfig()\n')).toEqual([]);
  });

  it('skips a matcher in a comment', () => {
    const src = "// export const config = { matcher: '/old' }\nexport const config = {\n  /* '/older' */ matcher: '/new',\n}\n";
    expect(read(stripCommentsForRegex(src, 'typescript'))).toEqual(['/new']);
  });

  it('says where each entry is written', () => {
    const src = "export const config = {\n  matcher: ['/a', '/b'],\n}\n";
    const out = readProxyMatcher(src) as { index: number }[];
    expect(out.map((e) => src.slice(e.index, e.index + 4))).toEqual(["'/a'", "'/b'"]);
  });
});

describe('where Next loads the proxy from', () => {
  it.each([
    ['', ['app/page.tsx'], ''],
    ['', ['src/app/page.tsx'], 'src/'],
    ['apps/web/', ['apps/web/src/app/dashboard/page.tsx'], 'apps/web/src/'],
    ['', ['pages/index.tsx', 'src/app/page.tsx'], ''],
  ])('an app at "%s" with %j: "%s"', (root, files, dir) => {
    expect(nextProxyDir(root, files)).toBe(dir);
  });
});

describe('a route and the proxy that runs before it', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  afterAll(() => {
    for (const cg of graphs) cg.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(dir: string, rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  async function project(files: Record<string, string>): Promise<{ cg: CodeGraph; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-next-proxy-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    await cg.indexAll();
    return { cg, dir };
  }

  const page = (name: string): string => `export default function ${name}() {\n  return null\n}\n`;
  const manifest = (next: string): string => JSON.stringify({ name: 'web', dependencies: { next, react: '19.0.0' } });
  const meta = (e: Edge): Record<string, unknown> => (e.metadata ?? {}) as Record<string, unknown>;
  const proxyEdges = (cg: CodeGraph): Edge[] =>
    cg.getNodesByKind('route').flatMap((r) => cg.getOutgoingEdges(r.id).filter((e) => meta(e).synthesizedBy === 'next-proxy'));
  const routesRunning = (cg: CodeGraph, target: Node): Record<string, unknown> =>
    Object.fromEntries(
      proxyEdges(cg).filter((e) => e.target === target.id).map((e) => [cg.getNode(e.source)!.name, meta(e).matcher ?? null])
    );
  const fn = (cg: CodeGraph, name: string, filePath: string): Node => {
    const node = cg.getNodesByName(name).find((n) => n.filePath === filePath && n.kind === 'function');
    if (!node) throw new Error(`no function ${name} in ${filePath}`);
    return node;
  };

  it('links the routes the matcher accepts, under src/, and only from the proxy Next loads', async () => {
    const { cg } = await project({
      'package.json': manifest('^16.2.1'),
      'src/app/page.tsx': page('Home'),
      'src/app/login/page.tsx': page('Login'),
      'src/app/dashboard/page.tsx': page('Dashboard'),
      'src/app/dashboard/settings/page.tsx': page('Settings'),
      'src/app/blog/[slug]/page.tsx': page('Post'),
      'src/app/docs/[[...all]]/page.tsx': page('Docs'),
      'src/app/api/projects/[id]/route.ts':
        'export async function GET() {\n  return Response.json({})\n}\nexport async function POST() {\n  return Response.json({})\n}\n',
      'src/lib/session.ts': 'export function readSession(cookie) {\n  return cookie ?? null\n}\n',
      'src/proxy.ts':
        "import { NextResponse } from 'next/server'\n" +
        "import { readSession } from './lib/session'\n" +
        '\n' +
        'export function proxy(request) {\n' +
        "  if (!readSession(request.cookies.get('session'))) return NextResponse.redirect(new URL('/login', request.url))\n" +
        '  return NextResponse.next()\n' +
        '}\n' +
        '\n' +
        'export const config = {\n' +
        '  matcher: [\n' +
        "    '/dashboard/:rest*',\n" +
        "    { source: '/api/:rest+', missing: [{ type: 'header', key: 'x-internal' }] },\n" +
        "    '/docs',\n" +
        '  ],\n' +
        '}\n',
      // Not where Next loads a proxy for an app under src/.
      'proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/lib/proxy.ts': 'export function proxy(target) {\n  return fetch(target)\n}\n',
    });
    const proxy = fn(cg, 'proxy', 'src/proxy.ts');

    expect(routesRunning(cg, proxy)).toEqual({
      '/dashboard': '/dashboard/:rest*',
      '/dashboard/settings': '/dashboard/:rest*',
      '/docs/:all*': '/docs',
      'GET /api/projects/:id': '/api/:rest+',
      'POST /api/projects/:id': '/api/:rest+',
    });
    expect(proxyEdges(cg).every((e) => e.target === proxy.id)).toBe(true);

    const edge = proxyEdges(cg).find((e) => cg.getNode(e.source)!.name === '/dashboard')!;
    expect(edge.kind).toBe('calls');
    expect(edge.provenance).toBe('heuristic');
    expect(edge.metadata).toEqual({ synthesizedBy: 'next-proxy', matcher: '/dashboard/:rest*', registeredAt: 'src/proxy.ts:11' });
  });

  it('makes the routes the proxy\'s callers, its impact, and a flow from a route reach what the proxy calls', async () => {
    const { cg } = await project({
      'package.json': manifest('15.5.0'),
      'app/dashboard/page.tsx': page('Dashboard'),
      'app/about/page.tsx': page('About'),
      'app/page.tsx': "import Link from 'next/link'\nexport default function Home() {\n  return <Link href=\"/dashboard\">Dashboard</Link>\n}\n",
      'lib/session.ts': 'export function readSession(cookie) {\n  return cookie ?? null\n}\n',
      'middleware.ts':
        "import { readSession } from './lib/session'\n" +
        'export function middleware(request) {\n  return readSession(request)\n}\n' +
        "export const config = { matcher: '/dashboard/:rest*' }\n",
    });
    const middleware = fn(cg, 'middleware', 'middleware.ts');
    expect(cg.getCallers(middleware.id).map((c) => c.node.name)).toEqual(['/dashboard']);
    expect([...cg.getImpactRadius(fn(cg, 'readSession', 'lib/session.ts').id, 2).nodes.values()].map((n) => n.name)).toContain('/dashboard');

    // Nothing names a route in a query: a flow crosses one, from the link that goes there.
    const flow = resolveNamedSymbolFlow(cg, 'Home readSession');
    expect(flow.chains[0]?.steps.map((step) => step.node.name)).toEqual(['Home', '/dashboard', 'middleware', 'readSession']);
  });

  it('leaves where the route\'s code starts alone, even for a proxy named like a component', async () => {
    const { cg } = await project({
      'package.json': manifest('15.5.0'),
      'app/page.tsx': page('Home'),
      'app/about/route.ts': 'export async function GET() {\n  return new Response(null)\n}\n',
      'middleware.ts': 'export default function Gate(request) {\n  return undefined\n}\n',
    });
    const routes = cg.getNodesByKind('route');
    expect(proxyEdges(cg)).toHaveLength(2);
    const roots = routeRoots(cg, routes);
    expect(routes.map((r) => roots.get(r.id)?.node.name).sort()).toEqual(['GET', 'Home']);
  });

  it('keeps a redirect the proxy makes on Screens, however many routes it runs before', async () => {
    // More routes than the walk back from a navigation will take callers of one node.
    const pages = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`app/p${i}/page.tsx`, page(`P${i}`)]));
    const { cg, dir } = await project({
      'package.json': manifest('15.5.0'),
      ...pages,
      'app/login/page.tsx': page('Login'),
      'lib/gate.ts':
        "import { NextResponse } from 'next/server'\n" +
        "export function gate(request) {\n  return NextResponse.redirect(new URL('/login', request.url))\n}\n",
      'middleware.ts':
        "import { gate } from './lib/gate'\n" +
        'export function middleware(request) {\n  return gate(request)\n}\n' +
        "export const config = { matcher: '/((?!api|_next).*)' }\n",
    });
    expect(proxyEdges(cg)).toHaveLength(33);
    const screens = await buildScreens(cg, dir);
    expect(screens.dropped).toBe(0);
    expect(screens.origins.map((o) => o.node.name)).toEqual(['gate']);
    expect(screens.links.filter((l) => l.fromOrigin)).toHaveLength(1);
  });

  it('takes the default export for the entry in each way it is written, and a proxy.ts beside middleware is an ordinary module', async () => {
    const { cg } = await project({
      'package.json': manifest('15.5.0'),
      'app/page.tsx': page('Home'),
      'app/account/page.tsx': page('Account'),
      'app/account/[id]/page.tsx': page('AccountDetail'),
      'pages/api/health.ts': 'export default function handler(req, res) {\n  res.status(200).end()\n}\n',
      'middleware.ts':
        'function guard(request) {\n  return undefined\n}\n' +
        'export default guard\n' +
        "export const config = { matcher: '/account/:id?' }\n",
      'proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
    });
    expect(routesRunning(cg, fn(cg, 'guard', 'middleware.ts'))).toEqual({ '/account': '/account/:id?', '/account/:id': '/account/:id?' });
    expect(proxyEdges(cg)).toHaveLength(2);
    expect(cg.getImpactRadius(fn(cg, 'proxy', 'proxy.ts').id, 3).nodes.size).toBe(1);
  });

  it('links a wrapped default export through the file, where the wrapper\'s calls are recorded', async () => {
    const { cg } = await project({
      'package.json': manifest('15.5.0'),
      'app/dashboard/page.tsx': page('Dashboard'),
      'app/page.tsx': "import Link from 'next/link'\nexport default function Home() {\n  return <Link href=\"/dashboard\">Dashboard</Link>\n}\n",
      'lib/session.ts': 'export function isProtected(request) {\n  return !!request\n}\n',
      'middleware.ts':
        "import { clerkMiddleware } from '@clerk/nextjs/server'\n" +
        "import { isProtected } from './lib/session'\n" +
        'export default clerkMiddleware(async (auth, req) => {\n  if (isProtected(req)) await auth.protect()\n})\n' +
        "export const config = { matcher: ['/((?!_next|[^?]*\\\\.(?:html?|css)).*)', '/(api|trpc)(.*)'] }\n",
    });
    expect(proxyEdges(cg)).toHaveLength(2);
    const edge = proxyEdges(cg).find((e) => cg.getNode(e.source)!.name === '/dashboard');
    const target = cg.getNode(edge!.target)!;
    expect(target.kind).toBe('file');
    expect(target.filePath).toBe('middleware.ts');
    expect(meta(edge!).registeredAt).toBe('middleware.ts:6');
    expect(cg.getCallees(target.id).map((c) => c.node.name)).toContain('isProtected');

    const flow = resolveNamedSymbolFlow(cg, 'Home isProtected');
    expect(flow.chains[0]?.steps.map((step) => step.node.name)).toEqual(['Home', '/dashboard', 'middleware.ts', 'isProtected']);
  });

  it('runs a proxy with no matcher on every route, pages and endpoints alike', async () => {
    const { cg } = await project({
      'package.json': manifest('16.0.0'),
      'app/page.tsx': page('Home'),
      'app/users/[id]/page.tsx': page('User'),
      'app/api/users/route.ts': 'export async function GET() {\n  return Response.json([])\n}\n',
      'proxy.ts': 'export const proxy = (request) => {\n  return undefined\n}\n',
    });
    expect(routesRunning(cg, fn(cg, 'proxy', 'proxy.ts'))).toEqual({ '/': null, '/users/:id': null, 'GET /api/users': null });
    expect(proxyEdges(cg)[0]!.metadata).toEqual({ synthesizedBy: 'next-proxy', registeredAt: 'proxy.ts:1' });
  });

  it('links nothing, not every route, for a matcher it can\'t read', async () => {
    const unknown = await project({
      'package.json': manifest('16.0.0'),
      'app/page.tsx': page('Home'),
      'proxy.ts': "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: ['/(\\\\d+)'] }\n",
    });
    expect(proxyEdges(unknown.cg)).toEqual([]);
    const variable = await project({
      'package.json': manifest('16.0.0'),
      'app/page.tsx': page('Home'),
      'proxy.ts': "const PROTECTED = ['/']\nexport function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: PROTECTED }\n",
    });
    expect(proxyEdges(variable.cg)).toEqual([]);
  });

  it('takes no proxy.ts outside a Next app, or in an app pinned before Next 16', async () => {
    const tool = await project({
      'package.json': JSON.stringify({ name: 'tool', dependencies: { commander: '14' } }),
      'src/mcp/proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/app/page.tsx': page('Home'),
    });
    expect(proxyEdges(tool.cg)).toEqual([]);

    const pinned = await project({
      'package.json': manifest('~15.3.0'),
      'src/app/page.tsx': page('Home'),
      'src/proxy.ts': 'export function proxy(target) {\n  return fetch(target)\n}\n',
    });
    expect(pinned.cg.getNodesByKind('route').map((r) => r.name)).toEqual(['/']);
    expect(proxyEdges(pinned.cg)).toEqual([]);
  });

  it('keeps each app of a monorepo to its own proxy', async () => {
    const { cg } = await project({
      'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['apps/*'] }),
      'apps/shop/package.json': manifest('16.1.0'),
      'apps/shop/app/account/page.tsx': page('ShopAccount'),
      'apps/shop/proxy.ts': "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/account' }\n",
      'apps/blog/package.json': manifest('16.1.0'),
      'apps/blog/app/account/page.tsx': page('BlogAccount'),
    });
    const edges = proxyEdges(cg);
    expect(edges.map((e) => cg.getNode(e.source)!.filePath)).toEqual(['apps/shop/app/account/page.tsx']);
    expect(cg.getNode(edges[0]!.target)!.filePath).toBe('apps/shop/proxy.ts');
  });

  it('follows a sync: an edited matcher, a new route under it, and the proxy going away', async () => {
    const { cg, dir } = await project({
      'package.json': manifest('16.0.0'),
      'app/page.tsx': page('Home'),
      'app/admin/page.tsx': page('Admin'),
      'proxy.ts': "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/nowhere' }\n",
    });
    const names = (): string[] => proxyEdges(cg).map((e) => cg.getNode(e.source)!.name).sort();
    expect(names()).toEqual([]);

    write(dir, 'proxy.ts', "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/admin/:rest*' }\n");
    await cg.sync();
    expect(names()).toEqual(['/admin']);

    write(dir, 'app/admin/api/route.ts', 'export async function DELETE() {\n  return new Response(null)\n}\n');
    await cg.sync();
    expect(names()).toEqual(['/admin', 'DELETE /admin/api']);

    fs.rmSync(path.join(dir, 'proxy.ts'));
    await cg.sync();
    expect(names()).toEqual([]);
  });
});
