/**
 * Next.js as a Screens app (`src/resolution/frameworks/nextjs.ts`,
 * `src/resolution/next-router-synthesizer.ts`): pages from files, route
 * handlers as endpoints, navigation from `<Link>`, `router.push`, `redirect`
 * and `NextResponse.redirect`, and the Screens / Steps pictures they make.
 * Mirrors `expo-router.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildScreens } from '../src/ui-server/api/screens';
import { buildSteps } from '../src/ui-server/api/steps';
import { nextjsResolver, nextRouteForFile, nextNavVerb } from '../src/resolution/frameworks/nextjs';
import type { Node } from '../src/types';

// =============================================================================
// Route paths from file names
// =============================================================================

describe('nextjs: nextRouteForFile', () => {
  it.each([
    ['app/page.tsx', 'page', '/', ''],
    ['src/app/users/page.tsx', 'page', '/users', ''],
    ['apps/web/app/(marketing)/about/page.tsx', 'page', '/about', 'apps/web/'],
    ['app/blog/[slug]/page.tsx', 'page', '/blog/:slug', ''],
    ['app/docs/[...all]/page.tsx', 'page', '/docs/:all*', ''],
    ['app/docs/[[...all]]/page.jsx', 'page', '/docs/:all*', ''],
    ['app/api/users/route.ts', 'handler', '/api/users', ''],
    ['app/api/users/[id]/route.ts', 'handler', '/api/users/:id', ''],
    ['pages/index.tsx', 'page', '/', ''],
    ['pages/about.tsx', 'page', '/about', ''],
    ['src/pages/blog/[slug].tsx', 'page', '/blog/:slug', ''],
    ['pages/api/users.ts', 'api', '/api/users', ''],
    ['apps/web/pages/api/users/[id].ts', 'api', '/api/users/:id', 'apps/web/'],
  ])('%s → %s %s (root %s)', (file, kind, route, root) => {
    expect(nextRouteForFile(file)).toEqual({ kind, path: route, root });
  });

  it.each([
    'app/layout.tsx',
    'app/loading.tsx',
    'app/users/error.tsx',
    'app/@modal/photo/page.tsx',
    'app/(.)photo/[id]/page.tsx',
    'pages/_app.tsx',
    'pages/_document.tsx',
    'src/pages/vite.config.ts',
    'apps/nextjs-pages/next.config.mjs',
    'app/users/__tests__/page.tsx',
    'src/components/button.tsx',
  ])('%s is not a route', (file) => {
    expect(nextRouteForFile(file)).toBeNull();
  });
});

describe('nextjs: extract', () => {
  it('a page is a route named by its path, calling its default export', () => {
    const { nodes, references } = nextjsResolver.extract!('app/users/page.tsx', "export default function UsersPage() {\n  return null\n}\n");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'route', name: '/users', language: 'tsx' });
    expect(references).toEqual([expect.objectContaining({ fromNodeId: nodes[0]!.id, referenceName: 'UsersPage', referenceKind: 'calls', line: 1 })]);
  });

  it('a route handler file is one endpoint per exported method, each naming its function', () => {
    const src = "import { NextResponse } from 'next/server'\nexport async function GET() {\n  return NextResponse.json([])\n}\nexport const POST = async (req) => {\n  return NextResponse.json({}, { status: 201 })\n}\n";
    const { nodes, references } = nextjsResolver.extract!('app/api/users/route.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /api/users', 'POST /api/users']);
    expect(nodes.map((n) => n.startLine)).toEqual([2, 5]);
    expect(references.map((r) => [r.referenceName, r.referenceKind])).toEqual([
      ['GET', 'references'],
      ['POST', 'references'],
    ]);
  });

  it('a Pages Router API file is ANY on its path, bound to the default export', () => {
    const { nodes, references } = nextjsResolver.extract!('pages/api/users.ts', 'export default async function handler(req, res) {\n  res.status(200).json([])\n}\n');
    expect(nodes.map((n) => n.name)).toEqual(['ANY /api/users']);
    expect(references[0]).toMatchObject({ referenceName: 'handler', referenceKind: 'references' });
  });

  it('emits nothing for a layout or a component file', () => {
    expect(nextjsResolver.extract!('app/layout.tsx', 'export default function L() {}').nodes).toHaveLength(0);
    expect(nextjsResolver.extract!('components/nav.tsx', 'export default function Nav() {}').nodes).toHaveLength(0);
  });

  it('claims the navigation calls and names their verb', () => {
    expect(nextNavVerb('router.push')).toBe('push');
    expect(nextNavVerb('router.replace')).toBe('replace');
    expect(nextNavVerb('redirect')).toBe('redirect');
    expect(nextNavVerb('permanentRedirect')).toBe('permanentRedirect');
    expect(nextNavVerb('NextResponse.redirect')).toBe('response.redirect');
    expect(nextNavVerb('router.back')).toBeNull();
    expect(nextNavVerb('fetch')).toBeNull();
    expect(nextjsResolver.claimsReference!('redirect')).toBe(true);
    expect(nextjsResolver.claimsReference!('Redirect')).toBe(false);
  });
});

// =============================================================================
// End to end: a small App Router site
// =============================================================================

describe('nextjs: end to end', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function write(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nextjs-'));
    write('package.json', JSON.stringify({ name: 'site', dependencies: { next: '15', react: '19', '@prisma/client': '5' } }));
    write('lib/db.ts', "import { PrismaClient } from '@prisma/client'\nexport const prisma = new PrismaClient()\n");
    write('app/layout.tsx', 'export default function RootLayout({ children }) {\n  return children\n}\n');
    write(
      'app/page.tsx',
      "import Link from 'next/link'\n" +
        'export default function Home() {\n' +
        '  return (\n' +
        '    <main>\n' +
        '      <Link href="/users">Users</Link>\n' +
        '      <a href="/login">Log in</a>\n' +
        '      <a href="https://example.com">Elsewhere</a>\n' +
        '    </main>\n' +
        '  )\n' +
        '}\n'
    );
    write('app/login/page.tsx', 'export default function LoginPage() {\n  return null\n}\n');
    write(
      'app/users/page.tsx',
      "import { NewUserForm } from '../../components/new-user-form'\n" +
        "import { prisma } from '../../lib/db'\n" +
        'export default async function UsersPage() {\n' +
        '  const users = await prisma.user.findMany()\n' +
        '  return <NewUserForm count={users.length} />\n' +
        '}\n'
    );
    write('app/users/[id]/page.tsx', 'export default function UserPage({ params }) {\n  return <a href="/users">Back</a>\n}\n');
    write(
      'components/new-user-form.tsx',
      "'use client'\n" +
        "import { useCallback, useState } from 'react'\n" +
        "import { useRouter } from 'next/navigation'\n" +
        "import { createUserAction } from '../app/actions'\n" +
        'export function NewUserForm({ count }) {\n' +
        "  const [email, setEmail] = useState('')\n" +
        '  const router = useRouter()\n' +
        '  const handleSubmit = useCallback(async (e) => {\n' +
        '    e.preventDefault()\n' +
        '    const user = await createUserAction({ email })\n' +
        '    if (user.ok) router.push(`/users/${user.id}`)\n' +
        '  }, [email])\n' +
        '  return <form onSubmit={handleSubmit}><input value={email} onChange={(e) => setEmail(e.target.value)} /></form>\n' +
        '}\n'
    );
    write(
      'app/actions.ts',
      "'use server'\n" +
        "import { redirect } from 'next/navigation'\n" +
        "import { prisma } from '../lib/db'\n" +
        'export async function createUserAction(data) {\n' +
        '  const user = await prisma.user.create({ data })\n' +
        "  if (!user.verified) redirect('/users')\n" +
        '  return { ok: true, id: user.id }\n' +
        '}\n'
    );
    write(
      'app/api/users/route.ts',
      "import { NextResponse } from 'next/server'\n" +
        "import { prisma } from '../../../lib/db'\n" +
        'export async function GET() {\n' +
        '  return NextResponse.json(await prisma.user.findMany())\n' +
        '}\n' +
        'export async function POST(req) {\n' +
        '  const data = await req.json()\n' +
        '  const user = await prisma.user.create({ data })\n' +
        '  return NextResponse.json(user, { status: 201 })\n' +
        '}\n'
    );
    write(
      'middleware.ts',
      "import { NextResponse } from 'next/server'\n" +
        'export function middleware(req) {\n' +
        "  if (!req.cookies.get('session')) {\n" +
        "    return NextResponse.redirect(new URL('/login', req.url))\n" +
        '  }\n' +
        '  return NextResponse.next()\n' +
        '}\n'
    );
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (name: string): Node => {
    const r = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
    return r;
  };
  const sym = (name: string): Node => {
    const n = cg.getNodesByName(name).find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import');
    if (!n) throw new Error(`no symbol ${name}`);
    return n;
  };
  const navs = (from: Node) => cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates');

  it('names every page and endpoint, and binds a page to its component and an endpoint to its function', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual(['/', '/login', '/users', '/users/:id', 'GET /api/users', 'POST /api/users']);
    const home = cg.getOutgoingEdges(route('/').id).find((e) => e.kind === 'calls');
    expect(cg.getNode(home!.target)?.name).toBe('Home');
    const post = cg.getOutgoingEdges(route('POST /api/users').id).find((e) => e.kind === 'references');
    expect(cg.getNode(post!.target)).toMatchObject({ name: 'POST', kind: 'function', filePath: 'app/api/users/route.ts' });
  });

  it('a <Link href> and an internal <a href> navigate from the component that renders them; an external one does not', () => {
    const fromHome = navs(sym('Home'));
    const byHref = new Map(fromHome.map((e) => [(e.metadata as Record<string, unknown>).href, e]));
    expect([...byHref.keys()].sort()).toEqual(['/login', '/users']);
    const users = byHref.get('/users')!;
    expect(users.target).toBe(route('/users').id);
    expect(users.provenance).toBe('heuristic');
    expect(users.metadata).toEqual({ synthesizedBy: 'next-link', href: '/users', navMethod: 'link', registeredAt: 'app/page.tsx:5' });
    expect((byHref.get('/login')!.metadata as Record<string, unknown>).navMethod).toBe('a');
    expect(navs(sym('UserPage')).map((e) => cg.getNode(e.target)?.name)).toEqual(['/users']);
  });

  it('router.push with a template hole reaches the [id] page; redirect() and NextResponse.redirect(new URL(…)) reach theirs', () => {
    const push = navs(sym('handleSubmit'));
    expect(push).toHaveLength(1);
    expect(push[0]!.target).toBe(route('/users/:id').id);
    expect(push[0]!.metadata).toMatchObject({ href: '/users/${…}', navMethod: 'push', refKind: 'calls' });
    const redirect = navs(sym('createUserAction'));
    expect(redirect).toHaveLength(1);
    expect(redirect[0]!.target).toBe(route('/users').id);
    expect(redirect[0]!.metadata).toMatchObject({ href: '/users', navMethod: 'redirect' });
    const guard = navs(sym('middleware'));
    expect(guard).toHaveLength(1);
    expect(guard[0]!.target).toBe(route('/login').id);
    expect(guard[0]!.metadata).toMatchObject({ href: '/login', navMethod: 'response.redirect' });
  });

  it('lands on the Screens tab: the entry page, its links, and the form’s push attributed back to its page with the condition', async () => {
    const screens = await buildScreens(cg, tmpDir);
    expect(screens.routed).toBe(true);
    const home = screens.screens.find((s) => s.path === '/')!;
    expect(screens.entry).toBe(home.id);
    expect(home.component?.name).toBe('Home');
    const users = screens.screens.find((s) => s.path === '/users')!;
    const user = screens.screens.find((s) => s.path === '/users/:id')!;
    const link = screens.links.find((l) => l.from === home.id && l.to === users.id)!;
    expect(link.via).toEqual([]);
    expect(link.synthesized).toBe(true);
    // Markup, not a return value: the destination is written right there, so
    // the site keeps its own verb rather than reading as a helper's return.
    expect(link.sites[0]).toMatchObject({ href: '/users', method: 'link' });
    const push = screens.links.find((l) => l.from === users.id && l.to === user.id)!;
    expect(push).toBeDefined();
    expect(push.via.map((v) => v.name)).toEqual(['NewUserForm', 'handleSubmit']);
    expect(push.when).toBe('user.ok');
    expect(push.sites[0]).toMatchObject({ href: '/users/${…}', method: 'push' });
    // The middleware's redirect starts from no page: an origin.
    expect(screens.origins.map((o) => o.node.name)).toContain('middleware');
    expect(screens.dropped).toBe(0);
  });

  it('an endpoint is not a screen — the Screens tab is pages, Entry points is every route', async () => {
    const screens = await buildScreens(cg, tmpDir);
    // `GET /api/users` and `POST /api/users` are routes, and they are on the
    // Entry points list — but a request is not somewhere a user can be.
    expect(screens.screens.map((s) => s.path).sort()).toEqual(['/', '/login', '/users', '/users/:id']);
    expect(cg.getNodesByKind('route').some((r) => r.name === 'POST /api/users')).toBe(true);
  });

  it('a page’s Steps picture fires from its load, crosses to the server action, and draws the pages it leads to as boundaries', async () => {
    const p = await buildSteps(cg, tmpDir, new URLSearchParams({ anchor: route('/users').id }));
    expect(p.project).toBe('web');
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.kind).toBe('screen');
    expect(anchor.sub).toBe('UsersPage');
    expect(anchor.trigger).toEqual({ kind: 'load', name: 'GET', of: '/users', in: 'page.tsx' });
    const loadRead = p.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'database' && s.effect.by.name === 'UsersPage')!;
    expect(loadRead.label).toBe('prisma.user.findMany()');
    const handler = p.steps.find((s) => s.kind === 'trigger' && s.node?.name === 'handleSubmit')!;
    expect(handler.trigger).toMatchObject({ kind: 'prop', name: 'onSubmit', of: 'form' });
    const action = p.steps.find((s) => s.node?.name === 'createUserAction')!;
    expect(action.kind).toBe('bridge');
    const toAction = p.links.find((l) => l.to === action.id)!;
    expect(toAction.label).toContain('server action');
    const write = p.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'database' && s.effect.by.name === 'createUserAction')!;
    expect(write.label).toBe('prisma.user.create({ data })');
    const detail = p.steps.find((s) => s.kind === 'screen' && s.screen?.path === '/users/:id')!;
    expect(detail.cut).toBe('screen');
    const toDetail = p.links.find((l) => l.to === detail.id)!;
    expect(toDetail.kind).toBe('navigates');
    expect(toDetail.when).toBe('user.ok');
    expect(toDetail.sites[0]!.text).toBe('push /users/${…}');
    const back = p.links.find((l) => l.from === action.id && l.to === anchor.id)!;
    expect(back.sites[0]).toMatchObject({ text: 'redirect /users', when: '!user.verified' });
  });

  it('an endpoint anchors as any server route does', async () => {
    const p = await buildSteps(cg, tmpDir, new URLSearchParams({ anchor: route('POST /api/users').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('POST');
    expect(anchor.trigger).toEqual({ kind: 'request', name: 'POST', of: '/api/users', in: 'route.ts' });
    const db = p.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'database')!;
    expect(db.effect).toMatchObject({ model: 'user', access: 'write', by: { name: 'POST' } });
    const res = p.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'response')!;
    expect(res.label).toBe('201');
  });
});
