/**
 * A React Router route that renders `<Outlet />` renders the routes inside it
 * and nothing of its own: a route object with no element does exactly that,
 * so `element: <Outlet />`, `Component: Outlet` and a `lazy` loader that hands
 * back `{ Component: Outlet }` (Medusa's `:id` routes, which import their page
 * module only for its `loader` and breadcrumb) are no page and no layout. JSX
 * routes already read `element={<Outlet />}` this way.
 *
 * Before, a route object's `<Outlet />` was its component: every route inside
 * it got a `layout:Outlet` reference, which links nothing (the Medusa and
 * Mercur dashboards each had 81 such failed refs). And a loader returning
 * `{ Component: Outlet }` read as "can't tell", so the route fell back to the
 * module the loader imports: its page became the layout of every route
 * inside, a detail page drawn around its own sibling routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const page = (name: string, extra = ''): string =>
  `${extra}export function Component() {\n  return <div>${name}</div>;\n}\n`;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'admin', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
  'src/Shell.tsx': `import { Outlet } from 'react-router-dom';\n\nexport function Shell() {\n  return <main><Outlet /></main>;\n}\n`,
  'src/router.tsx': `import { createBrowserRouter, Outlet } from 'react-router-dom';
import { Shell } from './Shell';

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      {
        path: '/regions',
        element: <Outlet />,
        children: [
          { path: '', lazy: () => import('./pages/region-list') },
          { path: 'create', lazy: () => import('./pages/region-create') },
        ],
      },
      {
        path: '/products',
        Component: Outlet,
        children: [{ index: true, lazy: () => import('./pages/product-list') }],
      },
      {
        path: '/products/:id',
        lazy: async () => {
          const { loader } = await import('./pages/product-detail');
          return { Component: Outlet, loader };
        },
        children: [
          { path: '', lazy: () => import('./pages/product-detail') },
          { path: 'variants/:variant_id', lazy: () => import('./pages/variant-detail') },
        ],
      },
      {
        path: '/orders',
        lazy: async () => {
          const { loader } = await import('./pages/order-list');
          return { element: <Outlet />, loader };
        },
        children: [
          { index: true, lazy: () => import('./pages/order-list') },
          { path: 'new', lazy: () => import('./pages/order-create') },
        ],
      },
      // Addresses the shell draws itself: routes of their own, with no page.
      { path: '/approvals', element: <Outlet /> },
      { path: '/agents/:agentId', Component: Outlet },
    ],
  },
]);
`,
  // React Router's error-boundaries example: a `path: ''` route that renders an
  // <Outlet /> only to hold an errorElement, at its parent's address.
  'src/errors/router.tsx': `import { createBrowserRouter, Outlet } from 'react-router-dom';
import { Layout, Project, RootErrorBoundary } from './routes';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      {
        path: '',
        element: <Outlet />,
        errorElement: <RootErrorBoundary />,
        children: [{ path: 'projects/:projectId', element: <Project /> }],
      },
    ],
  },
]);
`,
  'src/errors/routes.tsx': `import { Outlet } from 'react-router-dom';

export function Layout() {
  return <div><Outlet /></div>;
}

export function Project() {
  return <div>Project</div>;
}

export function RootErrorBoundary() {
  return <div>Error</div>;
}
`,
  'src/Nav.tsx': `import { useNavigate } from 'react-router-dom';

export function Nav() {
  const navigate = useNavigate();
  const openApprovals = () => navigate('/approvals');
  const openAgent = (id: string) => navigate(\`/agents/\${id}\`);
  return <nav><button onClick={openApprovals} /><button onClick={() => openAgent('a')} /></nav>;
}
`,
  'src/pages/region-list.tsx': page('RegionList'),
  'src/pages/region-create.tsx': page('RegionCreate'),
  'src/pages/product-list.tsx': page('ProductList'),
  'src/pages/product-detail.tsx': page('ProductDetail', 'export async function loader() {\n  return null;\n}\n\n'),
  'src/pages/variant-detail.tsx': page('VariantDetail'),
  'src/pages/order-list.tsx': page('OrderList', 'export async function loader() {\n  return null;\n}\n\n'),
  'src/pages/order-create.tsx': page('OrderCreate'),
};

/** `path -> page` for what each route renders, `path ~> layout` for each layout around it; a page is named by its file. */
function routeBindings(cg: CodeGraph): string[] {
  return cg.getNodesByKind('route').flatMap((r) => cg.getOutgoingEdges(r.id)
    .filter((e) => e.kind === 'references')
    .map((e) => {
      const target = cg.getNode(e.target)!;
      const name = target.name === 'Component' ? path.basename(target.filePath, '.tsx') : target.name;
      return `${r.name} ${(e.metadata as Record<string, unknown> | undefined)?.layout ? '~>' : '->'} ${name}`;
    }))
    .sort();
}

describe('react-router: a route that renders <Outlet /> renders nothing of its own', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-outlet-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('binds each address to its page, inside the layouts that render something', () => {
    expect(routeBindings(cg)).toEqual([
      // The `path: ''` <Outlet /> route groups its children at `/`, where Layout stays the page.
      '/ -> Layout',
      // A route that renders only <Outlet /> is still an address: no page, its layouts kept.
      '/agents/:agentId ~> Shell',
      '/approvals ~> Shell',
      '/orders -> order-list',
      '/orders ~> Shell',
      '/orders/new -> order-create',
      '/orders/new ~> Shell',
      '/products -> product-list',
      '/products ~> Shell',
      '/products/:id -> product-detail',
      '/products/:id ~> Shell',
      // Not inside product-detail: its route hands React Router `Component: Outlet`.
      '/products/:id/variants/:variant_id -> variant-detail',
      '/products/:id/variants/:variant_id ~> Shell',
      '/projects/:projectId -> Project',
      '/projects/:projectId ~> Layout',
      '/regions -> region-list',
      '/regions ~> Shell',
      '/regions/create -> region-create',
      '/regions/create ~> Shell',
    ]);
  });

  it('keeps an address no route inside claims, and the navigation that leads there', () => {
    const routes = cg.getNodesByKind('route').map((r) => r.name).sort();
    // `/products/:id`, `/regions` and `/orders` stay single routes: the page inside claims each
    // address. So does `/`: the `path: ''` <Outlet /> route under Layout is no route of its own.
    expect(routes).toEqual([
      '/', '/agents/:agentId', '/approvals', '/orders', '/orders/new', '/products', '/products/:id',
      '/products/:id/variants/:variant_id', '/projects/:projectId', '/regions', '/regions/create',
    ]);
    const navigations = cg.getNodesByKind('route').flatMap((r) => cg.getIncomingEdges(r.id)
      .filter((e) => e.kind === 'navigates')
      .map((e) => `${cg.getNode(e.source)?.name} -> ${r.name}`))
      .sort();
    expect(navigations).toEqual(['openAgent -> /agents/:agentId', 'openApprovals -> /approvals']);
  });

  it('leaves no route reference to Outlet behind', () => {
    const db = (cg as any).db.db;
    const refs = db.prepare(
      "SELECT reference_name AS name FROM unresolved_refs WHERE from_node_id LIKE 'route:%' AND reference_name IN ('Outlet', 'layout:Outlet')"
    ).all() as Array<{ name: string }>;
    expect(refs).toEqual([]);
  });
});
