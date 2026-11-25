/**
 * A lazily loaded module that passes on a page it imports
 * (Arshia76/DigiShop.Frontend): `src/layout/index.ts` does `import {
 * UserLayout } from './UserLayout'; export { UserLayout }`, so
 * `lazy: async () => { const { UserLayout } = await import('@/layout');
 * return { Component: UserLayout }; }` renders `UserLayout`. The barrel
 * declares no `UserLayout` of its own, and before, its export clause was read
 * as naming one, so the route linked nothing.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const PKG = JSON.stringify({ name: 'shop', private: true, dependencies: { react: '^18', 'react-router': '^7', '@mui/material': '^6' } });
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-barrel-imports-'));
  const files: Record<string, string> = {
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/router.tsx': `import { lazy } from 'react';
import { createBrowserRouter } from 'react-router';

const Help = lazy(() => import('@/help'));

export const router = createBrowserRouter([
  {
    path: '/',
    lazy: async () => {
      const { UserLayout } = await import('@/layout');
      return { Component: UserLayout };
    },
    children: [
      {
        index: true,
        lazy: async () => {
          const { HomePage } = await import('@/pages');
          return { Component: HomePage };
        },
      },
      { path: 'login', lazy: () => import('@/auth/login') },
      { path: 'settings', lazy: () => import('@/settings') },
      { path: 'help', element: <Help /> },
      {
        path: 'tabs',
        lazy: async () => {
          const { Tabs } = await import('@/tabs');
          return { Component: Tabs };
        },
      },
      {
        path: 'button',
        lazy: async () => {
          const { Button } = await import('@/ui');
          return { Component: Button };
        },
      },
      { path: 'account', lazy: () => import('@/account') },
    ],
  },
  {
    path: '/admin',
    lazy: async () => {
      const { AdminLayout } = await import('@/layout');
      return { Component: AdminLayout };
    },
  },
]);
`,
    // DigiShop's barrel: imports, then one export clause, no semicolons.
    'src/layout/index.ts': `import { AdminLayout } from './AdminLayout'
import { UserLayout } from './UserLayout'

export { AdminLayout, UserLayout }
`,
    'src/layout/AdminLayout.tsx': 'export function AdminLayout() {\n  return null;\n}\n',
    'src/layout/UserLayout.tsx': 'export const UserLayout = () => null;\n',
    // A barrel that imports from another barrel.
    'src/pages/index.ts': "import { HomePage } from './home';\n\nexport { HomePage };\n",
    'src/pages/home/index.ts': "export * from './HomePage';\n",
    'src/pages/home/HomePage.tsx': 'export function HomePage() {\n  return null;\n}\n',
    // The default export is an imported binding.
    'src/auth/login/index.ts': "import Login from './Login';\n\nexport default Login;\n",
    'src/auth/login/Login.tsx': 'export default function Login() {\n  return null;\n}\n',
    // Renamed to the name React Router reads.
    'src/settings/index.ts': "import { SettingsPage } from './SettingsPage';\n\nexport { SettingsPage as Component };\n",
    'src/settings/SettingsPage.tsx': 'export function SettingsPage() {\n  return null;\n}\n',
    // `React.lazy` reads the default, here an imported binding renamed to it.
    'src/help/index.ts': "import HelpPage from './HelpPage';\n\nexport { HelpPage as default };\n",
    'src/help/HelpPage.tsx': 'export default function HelpPage() {\n  return null;\n}\n',
    // A namespace object is no component.
    'src/tabs/index.ts': "import * as Tabs from './tabs';\n\nexport { Tabs };\n",
    'src/tabs/tabs.tsx': 'export function First() {\n  return null;\n}\n',
    // A package's component is not the project's to link.
    'src/ui/index.ts': "import { Button } from '@mui/material';\n\nexport { Button };\n",
    // The default export is a call: no binding the module imports is the page.
    'src/account/index.ts': "import withAuth from '@/hoc/withAuth';\nimport { AccountPage } from './AccountPage';\n\nexport default withAuth(AccountPage);\n",
    'src/account/AccountPage.tsx': 'export function AccountPage() {\n  return null;\n}\n',
    'src/hoc/withAuth.ts': 'export default function withAuth(Component: unknown) {\n  return Component;\n}\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** What a route's `references` edges reach, as `name@file`: what it renders, or the layouts around it. */
const bindings = (routeName: string, layout: boolean): string[] => {
  const route = cg.getNodesByKind('route').find((r) => r.name === routeName);
  if (!route) return [`no route ${routeName}`];
  return cg.getOutgoingEdges(route.id)
    .filter((e) => e.kind === 'references' && Boolean((e.metadata as Record<string, unknown> | undefined)?.layout) === layout)
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.name}@${n.filePath}`);
};
const renders = (routeName: string): string[] => bindings(routeName, false);

describe('a lazily loaded module that passes on a page it imports', () => {
  it('renders the page an export clause of imports passes on', () => {
    expect(renders('/admin')).toEqual(['AdminLayout@src/layout/AdminLayout.tsx']);
    expect(bindings('/login', true)).toEqual(['UserLayout@src/layout/UserLayout.tsx']);
  });

  it('follows the import to another barrel', () => {
    expect(renders('/')).toEqual(['HomePage@src/pages/home/HomePage.tsx']);
  });

  it('follows a default export that is an imported binding', () => {
    expect(renders('/login')).toEqual(['Login@src/auth/login/Login.tsx']);
  });

  it('follows an imported page the module renames to Component', () => {
    expect(renders('/settings')).toEqual(['SettingsPage@src/settings/SettingsPage.tsx']);
  });

  it('follows the default a React.lazy value loads', () => {
    expect(renders('/help')).toEqual(['HelpPage@src/help/HelpPage.tsx']);
  });

  it('links nothing for a namespace or a package it passes on', () => {
    expect(renders('/tabs')).toEqual([]);
    expect(renders('/button')).toEqual([]);
  });

  it('links no wrapper a default export calls', () => {
    expect(renders('/account')).toEqual([]);
  });
});

describe('sync, for a module that passes on a page it imports', () => {
  type Files = Record<string, string>;
  const ROUTER: Files = {
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/router.tsx': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  { path: '/login', lazy: () => import('@/auth/login') },
]);
`,
    'src/auth/login/index.ts': "import Login from './Login';\n\nexport default Login;\n",
  };
  const PAGE: Files = { 'src/auth/login/Login.tsx': 'export default function Login() {\n  return null;\n}\n' };

  let dirs: string[] = [];
  let graphs: CodeGraph[] = [];
  afterEach(() => {
    for (const graph of graphs) graph.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    graphs = [];
    dirs = [];
  });

  const write = (dir: string, files: Files): void => {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  };
  /** A project of `files`, indexed from scratch in a folder of its own. */
  const indexed = async (files: Files): Promise<{ dir: string; graph: CodeGraph }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-barrel-imports-sync-'));
    dirs.push(dir);
    write(dir, files);
    const graph = await CodeGraph.init(dir, { index: true });
    graphs.push(graph);
    return { dir, graph };
  };
  /** Each route's `references` edges, as `name@file`. */
  const routeLinks = (graph: CodeGraph): Record<string, string[]> => Object.fromEntries(
    graph.getNodesByKind('route').map((route) => [route.name, graph.getOutgoingEdges(route.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)!)
      .map((n) => `${n.name}@${n.filePath}`)
      .sort()])
  );

  it('links the page once the module it imports appears', async () => {
    const { dir, graph } = await indexed(ROUTER);
    expect(routeLinks(graph)).toEqual({ '/login': [] });
    write(dir, PAGE);
    expect((await graph.sync()).filesAdded).toBe(1);
    expect(routeLinks(graph)).toEqual({ '/login': ['Login@src/auth/login/Login.tsx'] });
    expect(routeLinks((await indexed({ ...ROUTER, ...PAGE })).graph)).toEqual({ '/login': ['Login@src/auth/login/Login.tsx'] });
  }, 60_000);

  it('follows the imported page when its default export moves to another component', async () => {
    const { dir, graph } = await indexed({ ...ROUTER, ...PAGE });
    expect(routeLinks(graph)).toEqual({ '/login': ['Login@src/auth/login/Login.tsx'] });
    // The old component stays, so the route's edge would follow it through the re-index.
    const edit = { 'src/auth/login/Login.tsx': 'export function Login() {\n  return null;\n}\n\nexport default function SignIn() {\n  return null;\n}\n' };
    write(dir, edit);
    await graph.sync();
    expect(routeLinks(graph)).toEqual({ '/login': ['SignIn@src/auth/login/Login.tsx'] });
    expect(routeLinks((await indexed({ ...ROUTER, ...edit })).graph)).toEqual({ '/login': ['SignIn@src/auth/login/Login.tsx'] });
  }, 60_000);
});
