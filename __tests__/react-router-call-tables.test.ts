/**
 * A route table handed to React Router through a local that holds a call's
 * result: Medusa's admin dashboard writes
 *
 *   const routes = getRouteMap({ settingsRoutes: this.settingsRoutes, coreRoutes: this.coreRoutes })
 *   const router = createBrowserRouter(routes, { basename })
 *
 * inside a class's `render()`, and `getRouteMap`, imported from its own
 * module, returns the literal table. The table is what the function returns.
 * Before, the local was read only for a literal, so none of Medusa's routes
 * existed. The tables spread in from the function's parameters (`...coreRoutes`)
 * are the caller's to fill (Medusa's come from plugins), so they stay unread.
 *
 * Which `routes` a use reads is the one in scope there: another function's
 * `const routes = getMenu()` is that function's own, and a menu is no table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function indexProject(files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-call-tables-'));
  writeFiles(root, files);
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

/** `path -> Component` for what each route renders, `path ~> Layout` for each layout around it, under `dir`. */
function routeBindings(cg: CodeGraph, dir: string): string[] {
  return cg.getNodesByKind('route').filter((r) => r.filePath.startsWith(dir)).flatMap((r) => cg.getOutgoingEdges(r.id)
    .filter((e) => e.kind === 'references')
    .map((e) => `${r.name} ${(e.metadata as Record<string, unknown> | undefined)?.layout ? '~>' : '->'} ${cg.getNode(e.target)?.name}`))
    .sort();
}

const routeNames = (cg: CodeGraph, dir: string): string[] =>
  cg.getNodesByKind('route').filter((r) => r.filePath.startsWith(dir)).map((r) => r.name).sort();

/** A component that renders the routes inside it. */
const layout = (name: string): string =>
  `import { Outlet } from 'react-router-dom';\n\nexport const ${name} = () => {\n  return <Outlet />;\n};\n`;

/** A route module the way Medusa writes one: a barrel that hands React Router its page as `Component`. */
const routeModule = (dir: string, name: string, file: string): Record<string, string> => ({
  [`${dir}/index.ts`]: `export { ${name} as Component } from './${file}';\n`,
  [`${dir}/${file}.tsx`]: `export const ${name} = () => {\n  return <div>${name}</div>;\n};\n`,
});

const MEDUSA_APP = `import { createBrowserRouter, RouteObject, RouterProvider } from 'react-router-dom';
import { getRouteMap } from './routes/get-route.map';

export class DashboardApp {
  private coreRoutes: RouteObject[];
  private settingsRoutes: RouteObject[];

  constructor({ plugins }: { plugins: { routes: RouteObject[] }[] }) {
    this.coreRoutes = plugins.flatMap((p) => p.routes);
    this.settingsRoutes = [];
  }

  render() {
    const routes = getRouteMap({
      settingsRoutes: this.settingsRoutes,
      coreRoutes: this.coreRoutes,
    });

    const router = createBrowserRouter(routes, {
      basename: '/app',
    });

    return <RouterProvider router={router} />;
  }
}
`;

const routeMap = (extra = ''): string => `import { RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '../../components/protected-route';
import { MainLayout } from '../../components/main-layout';
import { SettingsLayout } from '../../components/settings-layout';
import { PublicLayout } from '../../components/public-layout';

export function getRouteMap({
  settingsRoutes,
  coreRoutes,
}: {
  settingsRoutes: RouteObject[]
  coreRoutes: RouteObject[]
}) {
  return [
    {
      element: <ProtectedRoute />,
      children: [
        {
          element: <MainLayout />,
          children: [
            {
              path: '/',
              lazy: () => import('../../routes/home'),
            },
            {
              path: '/products',
              children: [
                {
                  path: '',
                  lazy: () => import('../../routes/products/product-list'),
                  children: [
                    {
                      path: 'create',
                      lazy: () =>
                        import('../../routes/products/product-create'),
                    },
                  ],
                },
              ],
            },${extra}
            ...coreRoutes,
          ],
        },
        {
          element: <SettingsLayout />,
          children: [
            {
              path: '/settings',
              lazy: () => import('../../routes/settings'),
            },
            ...settingsRoutes.flatMap((r) => r?.children || []),
          ],
        },
      ],
    },
    {
      element: <PublicLayout />,
      children: [
        {
          path: '/login',
          lazy: () => import('../../routes/login'),
        },
      ],
    },
  ];
}
`;

const ORDERS = `
            {
              path: '/orders',
              lazy: () => import('../../routes/orders'),
            },`;

const MEDUSA: Record<string, string> = {
  'admin/package.json': JSON.stringify({ name: 'dashboard', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
  'admin/src/dashboard-app/dashboard-app.tsx': MEDUSA_APP,
  'admin/src/dashboard-app/routes/get-route.map.tsx': routeMap(),
  'admin/src/components/protected-route.tsx': layout('ProtectedRoute'),
  'admin/src/components/main-layout.tsx': layout('MainLayout'),
  'admin/src/components/settings-layout.tsx': layout('SettingsLayout'),
  'admin/src/components/public-layout.tsx': layout('PublicLayout'),
  ...routeModule('admin/src/routes/home', 'Home', 'home'),
  ...routeModule('admin/src/routes/products/product-list', 'ProductList', 'product-list'),
  ...routeModule('admin/src/routes/products/product-create', 'ProductCreate', 'product-create'),
  ...routeModule('admin/src/routes/settings', 'Settings', 'settings'),
  ...routeModule('admin/src/routes/login', 'Login', 'login'),
  ...routeModule('admin/src/routes/orders', 'Orders', 'orders'),
};

const MEDUSA_BINDINGS = [
  '/ -> Home',
  '/ ~> MainLayout',
  '/ ~> ProtectedRoute',
  '/login -> Login',
  '/login ~> PublicLayout',
  // The `''` route under `/products` is the page there, and the layout its
  // `create` child renders inside.
  '/products -> ProductList',
  '/products ~> MainLayout',
  '/products ~> ProtectedRoute',
  '/products/create -> ProductCreate',
  '/products/create ~> MainLayout',
  '/products/create ~> ProductList',
  '/products/create ~> ProtectedRoute',
  '/settings -> Settings',
  '/settings ~> ProtectedRoute',
  '/settings ~> SettingsLayout',
];

/**
 * Apps whose routers are handed a call's result in other ways, and the
 * shapes around them that are no route table.
 */
const SHAPES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shapes', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
  'src/icons.jsx': `export function HelpIcon() {\n  return <svg />;\n}\nexport function BillingIcon() {\n  return <svg />;\n}\n`,
  'src/pages.jsx': ['Home', 'Account', 'Dashboard', 'Landing', 'TodoList', 'Reports']
    .map((p) => `export function ${p}() {\n  return <div>${p}</div>;\n}\n`).join(''),
  // A menu: a `{ path, element }` list that nothing hands the router.
  'src/menu.jsx': `import { BillingIcon, HelpIcon } from './icons';

export function getMenu() {
  return [
    { path: '/help', element: <HelpIcon /> },
    { path: '/billing', element: <BillingIcon /> },
  ];
}
`,

  // Two functions with a `routes` each: the router is handed App's own.
  'src/scoped/routes.jsx': `import { Account, Home } from '../pages';

export const getRoutes = (user) => [
  { path: '/', element: <Home /> },
  { path: '/account', element: <Account /> },
];
`,
  'src/scoped/App.jsx': `import { Link, useRoutes } from 'react-router-dom';
import { getMenu } from '../menu';
import { getRoutes } from './routes';

function Sidebar() {
  const routes = getMenu();
  return <nav>{routes.map((r) => <Link key={r.path} to={r.path}>{r.path}</Link>)}</nav>;
}

export default function App({ user }) {
  const routes = getRoutes(user);
  const element = useRoutes(routes);
  return <div><Sidebar />{element}</div>;
}
`,

  // The router is handed the import; another function's local of that name is its own.
  'src/shadow/routes.jsx': `import { Landing } from '../pages';

const routes = [{ path: '/landing', element: <Landing /> }];

export default routes;
`,
  'src/shadow/App.jsx': `import { useRoutes } from 'react-router-dom';
import routes from './routes';
import { getMenu } from '../menu';

function Sidebar() {
  const routes = getMenu();
  return <ul>{routes.map((r) => <li key={r.path}>{r.path}</li>)}</ul>;
}

export default function App() {
  return useRoutes(routes);
}
`,

  // An exported table that is a call's result, past a function's own local of that name.
  'src/exported/routes.jsx': `import { Dashboard } from '../pages';
import { getMenu } from '../menu';

export function menuSize() {
  const routes = getMenu();
  return routes.length;
}

const makeRoutes = () => [{ path: '/dashboard', element: <Dashboard /> }];

export const routes = makeRoutes();
`,
  'src/exported/App.jsx': `import { useRoutes } from 'react-router-dom';
import { routes } from './routes';

export default function App() {
  return useRoutes(routes);
}
`,

  // A default export that is a call's result.
  'src/default/build.jsx': `import { Reports } from '../pages';

export function buildRoutes() {
  return [{ path: '/reports', element: <Reports /> }];
}
`,
  'src/default/routes.js': `import { buildRoutes } from './build';

export default buildRoutes();
`,
  'src/default/App.jsx': `import { useRoutes } from 'react-router-dom';
import routes from './routes';

export default function App() {
  return useRoutes(routes);
}
`,

  // A table an async function returns, awaited before the router gets it.
  'src/awaited/load.jsx': `import { Account } from '../pages';

export async function loadRoutes() {
  return [{ path: '/me', element: <Account /> }];
}
`,
  'src/awaited/boot.jsx': `import { createBrowserRouter } from 'react-router-dom';
import { loadRoutes } from './load';

export async function boot() {
  const routes = await loadRoutes();
  return createBrowserRouter(routes);
}
`,

  // A router file that builds its table in a function of its own: its route
  // objects were read when it was extracted; the table it names is new here.
  'src/features/todo/routes.jsx': `import { TodoList } from '../../pages';

export const todoRoutes = [{ path: '/todos', element: <TodoList /> }];
`,
  'src/local/main.jsx': `import { createBrowserRouter } from 'react-router-dom';
import { todoRoutes } from '../features/todo/routes';
import { Home } from '../pages';

function buildRoutes() {
  return [{ path: '/home', element: <Home /> }, ...todoRoutes];
}

const routes = buildRoutes();

export const router = createBrowserRouter(routes);
`,

  // A function that makes its table from data returns no literal to read.
  'src/computed/App.jsx': `import { useRoutes } from 'react-router-dom';
import { pageList } from './pages';

function buildRoutes(pages) {
  return pages.map((p) => ({ path: p.path, element: p.element }));
}

export default function App() {
  const routes = buildRoutes(pageList);
  return useRoutes(routes);
}
`,
  'src/computed/pages.jsx': `import { HelpIcon } from '../icons';

export const pageList = [{ path: '/computed', element: <HelpIcon /> }];
`,
};

describe("react-router: a table a function returns, handed over through a local (Medusa's admin dashboard)", () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject(MEDUSA));
  }, 60_000);
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the table getRouteMap returns, each lazy route bound to the page its module hands React Router', () => {
    expect(routeBindings(cg, 'admin/')).toEqual(MEDUSA_BINDINGS);
  });

  it('keeps the routes in the file that writes them', () => {
    const home = cg.getNodesByKind('route').find((r) => r.name === '/')!;
    expect(home.filePath).toBe('admin/src/dashboard-app/routes/get-route.map.tsx');
    expect(home.startLine).toBe(22);
  });

  it('follows an edit to the table, and drops the routes when the router is handed something else', async () => {
    writeFiles(root, { 'admin/src/dashboard-app/routes/get-route.map.tsx': routeMap(ORDERS) });
    await cg.sync();
    expect(routeBindings(cg, 'admin/')).toEqual(
      [...MEDUSA_BINDINGS, '/orders -> Orders', '/orders ~> MainLayout', '/orders ~> ProtectedRoute'].sort());

    writeFiles(root, { 'admin/src/dashboard-app/dashboard-app.tsx': MEDUSA_APP.replace(/getRouteMap\(\{[\s\S]*?\}\);/, '[];') });
    await cg.sync();
    expect(routeNames(cg, 'admin/')).toEqual([]);

    writeFiles(root, { 'admin/src/dashboard-app/dashboard-app.tsx': MEDUSA_APP });
    await cg.sync();
    expect(routeNames(cg, 'admin/')).toEqual(['/', '/login', '/orders', '/products', '/products/create', '/settings']);
  }, 60_000);
});

describe('react-router: the other ways a call hands the router its table, and what stays no table', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject(SHAPES));
  }, 60_000);
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the table of the `routes` in the router's own scope, never another function's menu", () => {
    expect(routeBindings(cg, 'src/scoped/')).toEqual(['/ -> Home', '/account -> Account']);
  });

  it('reads the imported table a use names, past a same-named local in another function', () => {
    expect(routeBindings(cg, 'src/shadow/')).toEqual(['/landing -> Landing']);
  });

  it('reads an exported table that a call makes, as a named or a default export', () => {
    expect(routeBindings(cg, 'src/exported/')).toEqual(['/dashboard -> Dashboard']);
    expect(routeBindings(cg, 'src/default/')).toEqual(['/reports -> Reports']);
  });

  it('reads the table an awaited call returns', () => {
    expect(routeBindings(cg, 'src/awaited/')).toEqual(['/me -> Account']);
  });

  it('reads the tables a router file names inside the table its own function returns', () => {
    expect(routeBindings(cg, 'src/features/')).toEqual(['/todos -> TodoList']);
    expect(routeBindings(cg, 'src/local/')).toEqual(['/home -> Home']);
  });

  it('makes no route of a menu, nor of a table a function computes from data', () => {
    const all = cg.getNodesByKind('route').map((r) => r.name);
    for (const p of ['/help', '/billing', '/computed']) expect(all).not.toContain(p);
  });
});
