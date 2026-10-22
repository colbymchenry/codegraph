/**
 * Next.js proxy (`proxy.ts`, `middleware.ts` before Next 16): the routes its
 * `config.matcher` covers are linked to the proxy function, so the impact of a
 * change to the proxy reaches every route it runs before
 * (`src/resolution/frameworks/nextjs.ts`, `src/resolution/next-router-synthesizer.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { nextMatcherCovers, nextProxyDir, readProxyMatcher } from '../src/resolution/frameworks/nextjs';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import type { Edge, Node } from '../src/types';

// =============================================================================
// The matcher
// =============================================================================

describe('nextjs proxy: nextMatcherCovers', () => {
  it.each([
    ['/about', '/about', true],
    ['/about', '/about/team', false],
    ['/about', '/blog/about', false],
    ['/', '/', true],
    ['/', '/about', false],
    ['/about/:path', '/about', false],
    ['/about/:path', '/about/team', true],
    ['/about/:path', '/about/team/lead', false],
    ['/about/:path*', '/about', true],
    ['/about/:path*', '/about/team/lead', true],
    ['/about/:path*', '/aboutus', false],
    ['/about/:path+', '/about', false],
    ['/about/:path+', '/about/team/lead', true],
    ['/about/:path?', '/about', true],
    ['/about/:path?', '/about/team', true],
    ['/about/:path?', '/about/team/lead', false],
    ['/:path*', '/', true],
    ['/:locale/about', '/en/about', true],
    ['/blog/:slug', '/blog/:id', true],
    ['/api/:path*', '/api/projects/:id', true],
  ])('%s against %s → %s', (source, route, covered) => {
    expect(nextMatcherCovers(source, route, 'app/x/page.tsx')).toBe(covered);
  });

  it('a matcher literal never stands in for a route parameter — a static page beside it would own that address', () => {
    expect(nextMatcherCovers('/blog/featured', '/blog/:slug', 'app/blog/[slug]/page.tsx')).toBe(false);
    expect(nextMatcherCovers('/docs/intro', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(false);
  });

  it('a required catch-all serves one segment or more; an optional one serves its own directory too', () => {
    expect(nextMatcherCovers('/docs', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(false);
    expect(nextMatcherCovers('/docs', '/docs/:all*', 'app/docs/[[...all]]/page.tsx')).toBe(true);
    expect(nextMatcherCovers('/docs/:p', '/docs/:all*', 'app/docs/[...all]/page.tsx')).toBe(true);
  });

  it.each([
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
    '/about/(.*)',
    '/about/:path(\\d+)',
    '/feed-:id',
    '/api/*',
    '/about/',
    'about',
  ])('%s is not read: null, never a guess', (source) => {
    expect(nextMatcherCovers(source, '/about', 'app/about/page.tsx')).toBeNull();
  });
});

describe('nextjs proxy: readProxyMatcher', () => {
  const read = (src: string) => {
    const out = readProxyMatcher(src);
    return out === 'all' ? out : out.map((e) => e.source);
  };

  it('no config, or a config without a matcher, is every path', () => {
    expect(read('export function proxy() {}\n')).toBe('all');
    expect(read("export const config = { regions: ['iad1'] }\n")).toBe('all');
  });

  it('reads a string, an array, and { source } objects in one', () => {
    expect(read("export const config = { matcher: '/about/:path*' }\n")).toEqual(['/about/:path*']);
    expect(
      read(
        'export const config: ProxyConfig = {\n' +
          '  matcher: [\n' +
          "    '/dashboard/:path*',\n" +
          "    { source: '/api/:path*', has: [{ type: 'header', key: 'authorization' }] },\n" +
          '    `/account`,\n' +
          '  ],\n' +
          '}\n'
      )
    ).toEqual(['/dashboard/:path*', '/api/:path*', '/account']);
  });

  it('a matcher Next cannot read statically — a variable, a spread, a template with holes — reads as nothing', () => {
    expect(read("const extra = '/x'\nexport const config = { matcher: ['/kept', extra] }\n")).toEqual([]);
    expect(read("export const config = { matcher: ['/kept', ...more] }\n")).toEqual([]);
    expect(read("export const config = { matcher: ['/kept', { source: `/u/${id}` }] }\n")).toEqual([]);
    expect(read('export const config = { matcher: PROTECTED }\n')).toEqual([]);
    expect(read('const matcher = ["/a"]\nexport const config = { matcher }\n')).toEqual([]);
  });

  it('ignores a matcher in a comment', () => {
    const src = "// export const config = { matcher: '/old' }\nexport const config = {\n  /* '/older' */ matcher: '/new',\n}\n";
    expect(read(stripCommentsForRegex(src, 'typescript'))).toEqual(['/new']);
  });

  it('points each entry at where it is written', () => {
    const src = "export const config = {\n  matcher: ['/a', '/b'],\n}\n";
    const out = readProxyMatcher(src);
    expect(out).not.toBe('all');
    expect((out as { index: number }[]).map((e) => src.slice(e.index, e.index + 4))).toEqual(["'/a'", "'/b'"]);
  });
});

describe('nextjs proxy: nextProxyDir', () => {
  it.each([
    ['', ['app/page.tsx'], ''],
    ['', ['src/app/page.tsx'], 'src/'],
    ['apps/web/', ['apps/web/src/app/dashboard/page.tsx'], 'apps/web/src/'],
    ['', ['pages/index.tsx', 'src/app/page.tsx'], ''],
  ])('an app at "%s" with %j loads its proxy from "%s"', (root, files, dir) => {
    expect(nextProxyDir(root, files)).toBe(dir);
  });
});

// =============================================================================
// End to end
// =============================================================================

describe('nextjs proxy: end to end', () => {
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
  const fn = (cg: CodeGraph, name: string, filePath: string): Node => {
    const node = cg.getNodesByName(name).find((n) => n.filePath === filePath && n.kind === 'function');
    if (!node) throw new Error(`no function ${name} in ${filePath}`);
    return node;
  };
  const proxyEdges = (cg: CodeGraph): Edge[] =>
    cg.getNodesByKind('route').flatMap((r) => cg.getOutgoingEdges(r.id).filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'next-proxy'));
  /** Route name → the matcher entry that linked it (null: no matcher), for every route wrapped by `target`. */
  const gated = (cg: CodeGraph, target: Node): Record<string, unknown> =>
    Object.fromEntries(
      proxyEdges(cg)
        .filter((e) => e.target === target.id)
        .map((e) => [cg.getNode(e.source)!.name, (e.metadata as Record<string, unknown>).matcher ?? null])
    );

  it('Next 16: src/proxy.ts wraps the routes its matcher covers, and its impact reaches them', async () => {
    const { cg } = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '^16.2.1', react: '19.2.4' } }),
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
        "    '/dashboard/:path*',\n" +
        "    { source: '/api/:path+', missing: [{ type: 'header', key: 'x-internal' }] },\n" +
        "    '/((?!_next/static|favicon.ico).*)',\n" +
        "    '/docs',\n" +
        '  ],\n' +
        '}\n',
      // Not where Next loads a proxy for an app under src/: the root, and a nested module.
      'proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/lib/proxy.ts': 'export function proxy(target) {\n  return fetch(target)\n}\n',
    });
    const proxy = fn(cg, 'proxy', 'src/proxy.ts');

    expect(gated(cg, proxy)).toEqual({
      '/dashboard': '/dashboard/:path*',
      '/dashboard/settings': '/dashboard/:path*',
      '/docs/:all*': '/docs',
      'GET /api/projects/:id': '/api/:path+',
      'POST /api/projects/:id': '/api/:path+',
    });
    expect(proxyEdges(cg).every((e) => e.target === proxy.id)).toBe(true);

    const edge = proxyEdges(cg).find((e) => cg.getNode(e.source)!.name === '/dashboard')!;
    expect(edge.kind).toBe('decorates');
    expect(edge.provenance).toBe('heuristic');
    expect(edge.metadata).toEqual({ synthesizedBy: 'next-proxy', matcher: '/dashboard/:path*', registeredAt: 'src/proxy.ts:11' });

    // What `codegraph impact proxy` reports: the routes the proxy runs before.
    const impact = [...cg.getImpactRadius(proxy.id, 1).nodes.values()].map((n) => n.name).sort();
    expect(impact).toEqual(['/dashboard', '/dashboard/settings', '/docs/:all*', 'GET /api/projects/:id', 'POST /api/projects/:id', 'proxy']);
    expect(cg.getImpactRadius(fn(cg, 'proxy', 'proxy.ts').id, 3).nodes.size).toBe(1);
    expect(cg.getImpactRadius(fn(cg, 'proxy', 'src/lib/proxy.ts').id, 3).nodes.size).toBe(1);
  });

  it('Next 15: middleware.ts with a default export; a proxy.ts beside it is an ordinary module', async () => {
    const { cg } = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '15.5.0' } }),
      'app/page.tsx': page('Home'),
      'app/about/page.tsx': page('About'),
      'app/account/page.tsx': page('Account'),
      'app/account/[id]/page.tsx': page('AccountDetail'),
      'pages/api/health.ts': 'export default function handler(req, res) {\n  res.status(200).end()\n}\n',
      'middleware.ts':
        "import { NextResponse } from 'next/server'\n" +
        'function guard(request) {\n' +
        '  return NextResponse.next()\n' +
        '}\n' +
        'export default guard\n' +
        "export const config = { matcher: '/account/:id?' }\n",
      'proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
    });
    const guard = fn(cg, 'guard', 'middleware.ts');
    expect(gated(cg, guard)).toEqual({ '/account': '/account/:id?', '/account/:id': '/account/:id?' });
    expect(proxyEdges(cg)).toHaveLength(2);
    expect(cg.getImpactRadius(fn(cg, 'proxy', 'proxy.ts').id, 3).nodes.size).toBe(1);
  });

  it('without a matcher the proxy runs on every route, pages and endpoints alike', async () => {
    const { cg } = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '16.0.0' } }),
      'app/page.tsx': page('Home'),
      'app/users/[id]/page.tsx': page('User'),
      'app/api/users/route.ts': 'export async function GET() {\n  return Response.json([])\n}\n',
      'proxy.ts': 'export const proxy = (request) => {\n  return undefined\n}\n',
    });
    const proxy = fn(cg, 'proxy', 'proxy.ts');
    expect(gated(cg, proxy)).toEqual({ '/': null, '/users/:id': null, 'GET /api/users': null });
    expect(proxyEdges(cg)[0]!.metadata).toEqual({ synthesizedBy: 'next-proxy', registeredAt: 'proxy.ts:1' });
  });

  it('a matcher it cannot read links nothing rather than every route', async () => {
    const regex = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '16.0.0' } }),
      'app/page.tsx': page('Home'),
      'app/dashboard/page.tsx': page('Dashboard'),
      'proxy.ts':
        'export function proxy(request) {\n  return undefined\n}\n' +
        "export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] }\n",
    });
    expect(proxyEdges(regex.cg)).toEqual([]);
    const variable = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '16.0.0' } }),
      'app/page.tsx': page('Home'),
      'proxy.ts': "const PROTECTED = ['/']\nexport function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: PROTECTED }\n",
    });
    expect(proxyEdges(variable.cg)).toEqual([]);
  });

  it('a proxy.ts is not a Next entry outside a Next app, or in an app pinned before Next 16', async () => {
    const tool = await project({
      'package.json': JSON.stringify({ name: 'tool', dependencies: { commander: '14' } }),
      'src/mcp/proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/proxy.ts': 'export function proxy(request) {\n  return request\n}\n',
      'src/app/page.tsx': page('Home'),
    });
    expect(proxyEdges(tool.cg)).toEqual([]);
    expect(tool.cg.getImpactRadius(fn(tool.cg, 'proxy', 'src/proxy.ts').id, 3).nodes.size).toBe(1);

    const legacy = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '~15.3.0' } }),
      'src/app/page.tsx': page('Home'),
      'src/proxy.ts': 'export function proxy(target) {\n  return fetch(target)\n}\n',
    });
    expect(legacy.cg.getNodesByKind('route').map((r) => r.name)).toEqual(['/']);
    expect(proxyEdges(legacy.cg)).toEqual([]);
  });

  it('in a monorepo each app runs only its own proxy', async () => {
    const { cg } = await project({
      'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['apps/*'] }),
      'apps/shop/package.json': JSON.stringify({ name: 'shop', dependencies: { next: '16.1.0' } }),
      'apps/shop/app/account/page.tsx': page('ShopAccount'),
      'apps/shop/proxy.ts': "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/account' }\n",
      'apps/blog/package.json': JSON.stringify({ name: 'blog', dependencies: { next: '16.1.0' } }),
      'apps/blog/app/account/page.tsx': page('BlogAccount'),
    });
    const edges = proxyEdges(cg);
    expect(edges.map((e) => cg.getNode(e.source)!.filePath)).toEqual(['apps/shop/app/account/page.tsx']);
    expect(cg.getNode(edges[0]!.target)!.filePath).toBe('apps/shop/proxy.ts');
  });

  it('a sync follows a matcher edit and a route added under it', async () => {
    const { cg, dir } = await project({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '16.0.0' } }),
      'app/page.tsx': page('Home'),
      'app/admin/page.tsx': page('Admin'),
      'proxy.ts': "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/nowhere' }\n",
    });
    const names = (): string[] => proxyEdges(cg).map((e) => cg.getNode(e.source)!.name).sort();
    expect(names()).toEqual([]);

    write(dir, 'proxy.ts', "export function proxy(request) {\n  return undefined\n}\nexport const config = { matcher: '/admin/:path*' }\n");
    await cg.sync();
    expect(names()).toEqual(['/admin']);

    write(dir, 'app/admin/api/route.ts', 'export async function DELETE() {\n  return new Response(null)\n}\n');
    await cg.sync();
    expect(names()).toEqual(['/admin', 'DELETE /admin/api']);
  });
});
