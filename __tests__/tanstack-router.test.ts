/**
 * TanStack Router as a Screens app (`src/resolution/frameworks/tanstack-router.ts`,
 * `src/resolution/tanstack-router-synthesizer.ts`): routes declared file-based
 * (`createFileRoute('/posts/$postId')`) and code-based (`createRoute({ path,
 * getParentRoute })`), and the navigation between them — where the destination
 * is the route PATTERN rather than a filled URL, and rides under a `to` key.
 *
 * The fixture is the TanStack kitchen-sink and basic examples' shape. Mirrors
 * `react-router.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildScreens } from '../src/ui-server/api/screens';
import {
  parseTanstackRoutes,
  tanstackPath,
  tanstackNavVerb,
  tanstackDestination,
} from '../src/resolution/frameworks/tanstack-router';
import type { Node } from '../src/types';

// =============================================================================
// Paths
// =============================================================================

describe('tanstack: tanstackPath', () => {
  it.each([
    ['/', '/'],
    ['/login', '/login'],
    ['/posts/$postId', '/posts/:postId'],
    // A pathless layout is not in the URL; nor is a route group.
    ['/_auth/profile', '/profile'],
    ['/_pathlessLayout/route-a', '/route-a'],
    ['/(this-folder-is-not-in-the-url)/route-group', '/route-group'],
    // An index route's trailing slash is the address of its parent.
    ['/dashboard/', '/dashboard'],
    // A trailing `_` un-nests without changing the segment.
    ['/posts_/$postId/edit', '/posts/:postId/edit'],
    ['/files/$', '/files/:splat*'],
  ])('%s → %s', (raw, normalized) => {
    expect(tanstackPath(raw)).toBe(normalized);
  });

  it('a path that names no address is nothing', () => {
    expect(tanstackPath('posts')).toBeNull();
  });
});

// =============================================================================
// Reading the routes
// =============================================================================

describe('tanstack: parseTanstackRoutes — file-based', () => {
  it('takes the path from the literal and the component from the options', () => {
    const src =
      "import { createFileRoute } from '@tanstack/react-router'\n" +
      "export const Route = createFileRoute('/dashboard/invoices/$invoiceId')({\n" +
      '  params: { parse: (p) => ({ invoiceId: Number(p.invoiceId) }) },\n' +
      '  component: InvoiceComponent,\n' +
      '})\n';
    expect(parseTanstackRoutes(src)).toEqual([
      { path: '/dashboard/invoices/:invoiceId', component: 'InvoiceComponent', index: false, fileBased: true, line: 2 },
    ]);
  });

  it('finds a component written on a chained .update()', () => {
    const src =
      "export const Route = createFileRoute('/login')({\n" +
      '  validateSearch: z.object({ redirect: z.string().optional() }),\n' +
      '}).update({\n' +
      '  component: LoginComponent,\n' +
      '})\n';
    expect(parseTanstackRoutes(src)[0]).toMatchObject({ path: '/login', component: 'LoginComponent' });
  });

  it('marks an index route, and drops a pathless layout that is no address of its own', () => {
    expect(parseTanstackRoutes("createFileRoute('/dashboard/')({ component: X })")[0]).toMatchObject({
      path: '/dashboard',
      index: true,
    });
    expect(parseTanstackRoutes("createFileRoute('/_auth')({ component: X })")).toEqual([]);
    // …but the index INSIDE a pathless layout is the page at that layout's
    // address — `_layout/index.tsx` is a project's home page.
    expect(parseTanstackRoutes("createFileRoute('/_layout/')({ component: Home })")[0]).toMatchObject({
      path: '/',
      index: true,
    });
  });
});

describe('tanstack: parseTanstackRoutes — code-based', () => {
  const src =
    "import { createRootRoute, createRoute } from '@tanstack/react-router'\n" +
    'const rootRoute = createRootRoute({ component: RootComponent })\n' +
    'const indexRoute = createRoute({\n' +
    '  getParentRoute: () => rootRoute,\n' +
    "  path: '/',\n" +
    '  component: IndexComponent,\n' +
    '})\n' +
    'const postsLayoutRoute = createRoute({\n' +
    '  getParentRoute: () => rootRoute,\n' +
    "  path: 'posts',\n" +
    '  component: PostsLayoutComponent,\n' +
    '})\n' +
    'const postsIndexRoute = createRoute({\n' +
    '  getParentRoute: () => postsLayoutRoute,\n' +
    "  path: '/',\n" +
    '  component: PostsIndexComponent,\n' +
    '})\n' +
    'const postRoute = createRoute({\n' +
    '  getParentRoute: () => postsLayoutRoute,\n' +
    "  path: '$postId',\n" +
    '  component: PostComponent,\n' +
    '})\n' +
    'const pathlessRoute = createRoute({\n' +
    '  getParentRoute: () => rootRoute,\n' +
    "  id: 'pathless',\n" +
    '  component: PathlessComponent,\n' +
    '})\n' +
    'const routeARoute = createRoute({\n' +
    '  getParentRoute: () => pathlessRoute,\n' +
    "  path: '/route-a',\n" +
    '  component: RouteAComponent,\n' +
    '})\n';

  it('composes a path through getParentRoute, and a pathless layout adds nothing to it', () => {
    expect(parseTanstackRoutes(src).map((r) => [r.path, r.component])).toEqual([
      ['/', 'IndexComponent'],
      ['/posts', 'PostsIndexComponent'],
      ['/posts/:postId', 'PostComponent'],
      ['/route-a', 'RouteAComponent'],
    ]);
  });

  it('a layout with children is not itself a page at that address', () => {
    // `postsLayoutRoute` sits at `/posts` and wraps the index that renders there.
    const posts = parseTanstackRoutes(src).filter((r) => r.path === '/posts');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.component).toBe('PostsIndexComponent');
  });

  // A root is the root whatever it is given. Read only when it was given an
  // object, a root written any other way left every route under it with a
  // parent the file never declared, and the whole tree came out empty:
  // TanStack's kitchen-sink example, whose root takes its context's type.
  const ROOT = 'const rootRoute = createRootRoute({ component: RootComponent })\n';
  const withRoot = (root: string): string => {
    expect(src).toContain(ROOT);
    return src.replace(ROOT, root);
  };
  const expected = parseTanstackRoutes(src).map((r) => [r.path, r.component, r.index]);

  it.each([
    ['with nothing', 'const rootRoute = createRootRoute()\n'],
    ['with nothing, over two lines', 'const rootRoute = createRootRoute(\n)\n'],
    ['exported, with a type', 'export const rootRoute: AnyRoute = createRootRoute()\n'],
    ['with options in a variable', 'const rootRoute = createRootRoute(rootOptions)\n'],
    ['with type arguments', 'const rootRoute = createRootRoute<RouterContext>({ component: RootComponent })\n'],
    ["with its context's type", 'const rootRoute = createRootRouteWithContext<RouterContext>()({ component: RootComponent })\n'],
    ["with its context's type and nothing else", 'const rootRoute = createRootRouteWithContext<RouterContext>()()\n'],
    ['with a context written as an object type', 'const rootRoute = createRootRouteWithContext<{ auth: Auth }>()({\n  component: RootComponent,\n})\n'],
    [
      'with a context type that holds arrows, generics and a comparison-like default',
      'const rootRoute = createRootRouteWithContext<{\n' +
        '  auth: Auth\n' +
        '  load: (id: string) => Promise<Map<string, Array<Post>>>\n' +
        "  mode: 'a>b' | 'c<d'\n" +
        '}>()({\n' +
        '  component: RootComponent,\n' +
        '})\n',
    ],
    ['with a context that is a function type', 'const rootRoute = createRootRouteWithContext<() => RouterContext>()({ component: RootComponent })\n'],
  ])('composes the same routes under a root written %s', (_what, root) => {
    expect(parseTanstackRoutes(withRoot(root)).map((r) => [r.path, r.component, r.index])).toEqual(expected);
  });

  it('a root is never an address of its own, however it is written', () => {
    for (const root of [
      "export const Route = createRootRoute()\n",
      "export const Route = createRootRouteWithContext<RouterContext>()({ component: RootComponent })\n",
      "export const Route = createRootRouteWithContext<{ auth: Auth }>()()\n",
    ]) {
      expect(parseTanstackRoutes(`import { createRootRoute, createRootRouteWithContext } from '@tanstack/react-router'\n${root}`), root).toEqual([]);
    }
  });

  it('still composes nothing under a parent the file does not declare', () => {
    // No root here at all: it is imported from another file.
    expect(parseTanstackRoutes(withRoot("import { rootRoute } from './root'\n"))).toEqual([]);
    // The factory kept, never called: `rootRoute` is not a route.
    expect(parseTanstackRoutes(withRoot('const rootRoute = createRootRouteWithContext<RouterContext>()\n'))).toEqual([]);
    // Type arguments that never close, and a call that is none.
    expect(parseTanstackRoutes(withRoot('const rootRoute = createRootRoute<RouterContext;\n'))).toEqual([]);
    expect(parseTanstackRoutes(withRoot('const rootRoute = createRootRoute\n'))).toEqual([]);
  });

  it('a route other than the root still needs its options written out', () => {
    const viaVariable = withRoot(ROOT) + 'const extraRoute = createRoute(extraOptions)\nconst otherRoute = createRoute()\n';
    expect(parseTanstackRoutes(viaVariable).map((r) => [r.path, r.component, r.index])).toEqual(expected);
  });
});

// =============================================================================
// Destinations
// =============================================================================

describe('tanstack: destinations', () => {
  it.each([
    ['navigate', 'navigate'],
    ['redirect', 'redirect'],
    ['router.navigate', 'navigate'],
  ])('%s is a navigation', (name, verb) => {
    expect(tanstackNavVerb(name)).toBe(verb);
  });

  it.each(['push', 'replace', 'paths.push', 'goto'])('%s is not', (name) => {
    expect(tanstackNavVerb(name)).toBeNull();
  });

  it('reads the `to` key, and normalises the pattern the way a route name is', () => {
    expect(tanstackDestination("{ to: '/posts/$postId' }")?.path).toBe('/posts/:postId');
    expect(tanstackDestination("{ to: '/login', search: { redirect } }")?.path).toBe('/login');
    expect(tanstackDestination("'/posts/$postId'")?.path).toBe('/posts/:postId');
  });

  it('a navigation with no destination changes the search on the page it is on', () => {
    expect(tanstackDestination('{ search: (old) => ({ ...old, page: 2 }) }')).toBeNull();
  });
});

// =============================================================================
// The whole picture, indexed
// =============================================================================

describe('tanstack: a routed app end to end', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tanstack-'));
    write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '19', '@tanstack/react-router': '1' } }));
    write(
      'src/routes/index.tsx',
      "import { createFileRoute, Link } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/')({ component: IndexComponent })\n" +
        'function IndexComponent() {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <Link\n' +
        '        to="/posts/$postId"\n' +
        '        params={{ postId: 3 }}\n' +
        '      >\n' +
        '        A post\n' +
        '      </Link>\n' +
        '      <Link to="/login">Sign in</Link>\n' +
        '    </div>\n' +
        '  )\n' +
        '}\n'
    );
    write(
      'src/routes/posts.route.tsx',
      "import { createFileRoute, Outlet } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/posts')({ component: PostsLayout })\n" +
        'function PostsLayout() {\n  return <Outlet />\n}\n'
    );
    write(
      'src/routes/posts.index.tsx',
      "import { createFileRoute } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/posts/')({ component: PostsIndexComponent })\n" +
        'function PostsIndexComponent() {\n  return <div>Posts</div>\n}\n'
    );
    write(
      'src/routes/posts.$postId.tsx',
      "import { createFileRoute } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/posts/$postId')({ component: PostComponent })\n" +
        'function PostComponent() {\n  return <div>Post</div>\n}\n'
    );
    write(
      'src/routes/login.tsx',
      "import { createFileRoute, useNavigate } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/login')({ component: LoginComponent })\n" +
        'function LoginComponent() {\n' +
        '  const navigate = useNavigate()\n' +
        '  async function submit(creds) {\n' +
        '    const ok = await signIn(creds)\n' +
        "    if (ok) navigate({ to: '/dashboard' })\n" +
        '  }\n' +
        '  return <form onSubmit={submit} />\n' +
        '}\n'
    );
    write(
      'src/routes/_auth.tsx',
      "import { createFileRoute, redirect } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/_auth')({\n" +
        '  beforeLoad: ({ context }) => {\n' +
        "    if (context.auth.status === 'loggedOut') {\n" +
        "      throw redirect({ to: '/login' })\n" +
        '    }\n' +
        '  },\n' +
        '})\n'
    );
    write(
      'src/routes/_auth.dashboard.tsx',
      "import { createFileRoute, Link } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/_auth/dashboard')({ component: DashboardComponent })\n" +
        'function DashboardComponent() {\n' +
        '  return <Link to="/posts">All posts</Link>\n' +
        '}\n'
    );
    // The precision floor: a pattern nothing serves, and a search-only navigation.
    write(
      'src/routes/settings.tsx',
      "import { createFileRoute, useNavigate } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/settings')({ component: SettingsComponent })\n" +
        'function SettingsComponent() {\n' +
        '  const navigate = useNavigate()\n' +
        '  function nowhere() {\n' +
        "    navigate({ to: '/no-such-route' })\n" +
        '  }\n' +
        '  function filter() {\n' +
        '    navigate({ search: (old) => ({ ...old, page: 2 }) })\n' +
        '  }\n' +
        '  return <button onClick={nowhere} />\n' +
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
  const hrefs = (from: Node) =>
    navs(from)
      .map((e) => (e.metadata as Record<string, unknown>).href as string)
      .sort();

  it('names one route per address: the pathless layout is stripped, the index wins over the layout', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual([
      '/',
      '/dashboard',
      '/login',
      '/posts',
      '/posts/:postId',
      '/settings',
    ]);
    // `/posts` is the index page, not the `posts.route.tsx` layout beside it.
    const bound = cg.getOutgoingEdges(route('/posts').id).find((e) => e.kind === 'calls');
    expect(cg.getNode(bound!.target)?.name).toBe('PostsIndexComponent');
    // `_auth.dashboard.tsx` is the page at `/dashboard`.
    expect(route('/dashboard').filePath).toBe('src/routes/_auth.dashboard.tsx');
  });

  it('navigate({ to }) reaches the route the pattern names', () => {
    const submit = navs(sym('submit'));
    expect(submit).toHaveLength(1);
    expect(submit[0]!.target).toBe(route('/dashboard').id);
    expect(submit[0]!.metadata).toMatchObject({ href: '/dashboard', navMethod: 'navigate' });
  });

  it('a <Link to> names the route PATTERN, with its params beside it', () => {
    // `to="/posts/$postId"` is the route, not a filled URL.
    expect(hrefs(sym('IndexComponent'))).toEqual(['/login', '/posts/:postId']);
    const link = navs(sym('IndexComponent')).find((e) => e.target === route('/posts/:postId').id)!;
    expect(link.provenance).toBe('heuristic');
    expect(link.metadata).toMatchObject({ synthesizedBy: 'tanstack-link', href: '/posts/:postId', navMethod: 'link' });
    expect(hrefs(sym('DashboardComponent'))).toEqual(['/posts']);
  });

  it('a pattern nothing serves, and a navigation that only changes the search, are left unresolved', () => {
    expect(navs(sym('nowhere'))).toEqual([]);
    expect(navs(sym('filter'))).toEqual([]);
  });

  it('lands on the Screens tab as transitions between screens', async () => {
    const screens = await buildScreens(cg, tmpDir);
    expect(screens.routed).toBe(true);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!;
    expect(at('/posts').component?.name).toBe('PostsIndexComponent');
    const toPost = screens.links.find((l) => l.from === at('/').id && l.to === at('/posts/:postId').id)!;
    expect(toPost).toBeDefined();
    expect(toPost.sites[0]).toMatchObject({ href: '/posts/:postId' });
    const signIn = screens.links.find((l) => l.from === at('/login').id && l.to === at('/dashboard').id)!;
    expect(signIn).toBeDefined();
    expect(signIn.via.map((v) => v.name)).toEqual(['submit']);
    expect(signIn.when).toBe('ok');
    expect(screens.dropped).toBe(0);
  });
});

// =============================================================================
// A code-based tree under a root that takes its context's type
// =============================================================================

describe('tanstack: a code-based app whose root is written with its context, end to end', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tanstack-context-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '19', '@tanstack/react-router': '1' } }));
    // The shape of TanStack's kitchen-sink example.
    fs.writeFileSync(
      path.join(tmpDir, 'src/main.tsx'),
      "import { Link, Outlet, createRootRouteWithContext, createRoute, createRouter, useNavigate } from '@tanstack/react-router'\n" +
        'const rootRoute = createRootRouteWithContext<{\n' +
        '  auth: Auth\n' +
        '}>()({\n' +
        '  component: RootComponent,\n' +
        '})\n' +
        'function RootComponent() {\n  return <Outlet />\n}\n' +
        'const indexRoute = createRoute({\n' +
        '  getParentRoute: () => rootRoute,\n' +
        "  path: '/',\n" +
        '  component: IndexComponent,\n' +
        '})\n' +
        'function IndexComponent() {\n' +
        '  return <Link to="/dashboard/invoices/$invoiceId" params={{ invoiceId: 3 }}>An invoice</Link>\n' +
        '}\n' +
        'const dashboardLayoutRoute = createRoute({\n' +
        '  getParentRoute: () => rootRoute,\n' +
        "  path: 'dashboard',\n" +
        '  component: DashboardLayoutComponent,\n' +
        '})\n' +
        'function DashboardLayoutComponent() {\n  return <Outlet />\n}\n' +
        'const dashboardIndexRoute = createRoute({\n' +
        '  getParentRoute: () => dashboardLayoutRoute,\n' +
        "  path: '/',\n" +
        '  component: DashboardIndexComponent,\n' +
        '})\n' +
        'function DashboardIndexComponent() {\n  return <div>Dashboard</div>\n}\n' +
        'const invoiceRoute = createRoute({\n' +
        '  getParentRoute: () => dashboardLayoutRoute,\n' +
        "  path: 'invoices/$invoiceId',\n" +
        '  component: InvoiceComponent,\n' +
        '})\n' +
        'function InvoiceComponent() {\n' +
        '  const navigate = useNavigate()\n' +
        '  function done() {\n' +
        "    navigate({ to: '/dashboard' })\n" +
        '  }\n' +
        '  return <button onClick={done} />\n' +
        '}\n' +
        'const routeTree = rootRoute.addChildren([indexRoute, dashboardLayoutRoute.addChildren([dashboardIndexRoute, invoiceRoute])])\n' +
        'export const router = createRouter({ routeTree, context: { auth: undefined! } })\n'
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
  const sym = (name: string): Node => cg.getNodesByName(name).find((n) => n.kind === 'function')!;
  const navTargets = (from: Node): string[] =>
    cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates').map((e) => cg.getNode(e.target)!.name).sort();

  it('has the routes the tree declares, each bound to its component', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual(['/', '/dashboard', '/dashboard/invoices/:invoiceId']);
    const componentOf = (name: string): string | undefined =>
      cg.getOutgoingEdges(route(name).id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)?.name)[0];
    expect(componentOf('/')).toBe('IndexComponent');
    // The index under the layout is the page at `/dashboard`.
    expect(componentOf('/dashboard')).toBe('DashboardIndexComponent');
    expect(componentOf('/dashboard/invoices/:invoiceId')).toBe('InvoiceComponent');
  });

  it('has the navigation between them', () => {
    expect(navTargets(sym('done'))).toEqual(['/dashboard']);
    expect(navTargets(sym('IndexComponent'))).toEqual(['/dashboard/invoices/:invoiceId']);
  });
});
