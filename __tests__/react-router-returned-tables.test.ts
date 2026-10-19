/**
 * What a route-building function returns, when the router is handed its
 * result: every `return` of its own, never one in a function written inside
 * it. Before, the first `return [` anywhere in the body was the table: the
 * empty array an early guard (`if (!user) return [];`) or a `.forEach`
 * callback hands back (devanshthakker15/BANKFORM1's `generateRoutes`), so
 * the real table was never read; a menu a helper inside returns could be read
 * instead; and only the first of two branches' tables. A function that
 * returns another's result (`return buildRoutes()`) was not followed, and
 * neither was a table behind `useMemo` (`useMemo(() => getRoutes(user),
 * [user])`, `useMemo(getRoutes, [])`), which hooks-based routers write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const pages = ['Home', 'Login', 'Orders', 'OrderDetail', 'Admin', 'Account', 'Reports', 'Help', 'Faq', 'Settings', 'Dashboard', 'Landing', 'NotFound'];

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'apps', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
  'src/pages.jsx': pages.map((p) => `export function ${p}() {\n  return <div>${p}</div>;\n}\n`).join(''),

  // BANKFORM1: dynamic routes built in a callback whose `return []` comes first.
  'src/permissions/routes.jsx': `import { Home, Login, NotFound, Orders, OrderDetail } from '../pages';

export const generateRoutes = (permissions) => {
  const dynamicRoutes = [];
  permissions.forEach((currentPerm) => {
    if (!currentPerm.module) return [];
    dynamicRoutes.push({ path: \`/\${currentPerm.module}\`, element: <Orders /> });
  });
  return [
    { path: '/login', element: <Login /> },
    {
      path: '/',
      children: [{ path: '/', element: <Home /> }, { path: '/orders/:id', element: <OrderDetail /> }, ...dynamicRoutes],
    },
    { path: '*', element: <NotFound /> },
  ];
};
`,
  'src/permissions/App.jsx': `import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { generateRoutes } from './routes';

export default function App({ permissions }) {
  const dynamicRoutes = generateRoutes(permissions);
  const router = createBrowserRouter(dynamicRoutes);
  return <RouterProvider router={router} />;
}
`,

  // An early guard, and two branches that each return a table.
  'src/guarded/routes.jsx': `import { Account, Admin, Dashboard, Landing } from '../pages';

export function getRoutes(user) {
  if (!user) return [];
  if (user.isAdmin) {
    return [{ path: '/admin', element: <Admin /> }];
  }
  return [
    { path: '/dashboard', element: <Dashboard /> },
    { path: '/account', element: <Account /> },
  ];
}

export const publicRoutes = (ready) => (ready ? [] : [{ path: '/welcome', element: <Landing /> }]);

// Parameters with calls and arrows of their own in them.
export const meRoutes = (user = currentUser(), onLeave = () => null) => [{ path: '/me', element: <Account /> }];

function currentUser() {
  return null;
}
`,
  'src/guarded/App.jsx': `import { useRoutes } from 'react-router-dom';
import { getRoutes } from './routes';

export default function App({ user }) {
  return useRoutes(getRoutes(user));
}
`,

  'src/guarded/Me.jsx': `import { useRoutes } from 'react-router-dom';
import { meRoutes } from './routes';

export default function Me() {
  return useRoutes(meRoutes());
}
`,

  // A table behind useMemo, written both ways.
  'src/memo/routes.jsx': `import { Reports, Settings } from '../pages';

export const getRoutes = (user) => [{ path: '/reports', element: <Reports /> }];

export default function settingsRoutes() {
  return [{ path: '/settings', element: <Settings /> }];
}
`,
  'src/memo/App.jsx': `import { useMemo } from 'react';
import { useRoutes } from 'react-router-dom';
import { getRoutes } from './routes';

export default function App({ user }) {
  const routes = useMemo(() => getRoutes(user), [user]);
  return useRoutes(routes);
}
`,
  'src/memo/Settings.jsx': `import { useMemo } from 'react';
import { useRoutes } from 'react-router-dom';
import settingsRoutes from './routes';

export default function SettingsApp() {
  const routes = useMemo(settingsRoutes, []);
  return useRoutes(routes);
}
`,

  // A function that returns another's table; functions written inside a
  // builder return their own lists, which are no routes.
  'src/nested/build.jsx': `import { Faq, Help, Home } from '../pages';

export function buildRoutes() {
  const note = <p>Don't panic</p>;
  const menu = () => {
    return [{ path: '/help', element: <Help /> }];
  };
  function faqRoutes() {
    return [{ path: '/faq', element: <Faq /> }];
  }
  return [{ path: '/', element: <Home />, handle: { note, links: menu() }, loader() { return [faqRoutes()]; } }];
}
`,
  'src/nested/routes.jsx': `import { buildRoutes } from './build';

export function appRoutes() {
  return buildRoutes();
}
`,
  // Read straight from the builder too: before, the menu inside was the table.
  'src/nested/Direct.jsx': `import { useRoutes } from 'react-router-dom';
import { buildRoutes } from './build';

export default function Direct() {
  return useRoutes(buildRoutes());
}
`,
  'src/nested/App.jsx': `import { useRoutes } from 'react-router-dom';
import { appRoutes } from './routes';

export default function App() {
  return useRoutes(appRoutes());
}
`,
};

/** `path -> Component` for every route whose node sits under `dir`. */
function routeBindings(cg: CodeGraph, dir: string): string[] {
  return cg.getNodesByKind('route').filter((r) => r.filePath.startsWith(dir)).flatMap((r) => cg.getOutgoingEdges(r.id)
    .filter((e) => e.kind === 'references')
    .map((e) => `${r.name} ${(e.metadata as Record<string, unknown> | undefined)?.layout ? '~>' : '->'} ${cg.getNode(e.target)?.name}`))
    .sort();
}

describe('react-router: the tables a route-building function returns', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-returns-'));
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

  it("reads the function's own table, past the `return []` of a callback inside it", () => {
    expect(routeBindings(cg, 'src/permissions/')).toEqual([
      '/ -> Home',
      '/login -> Login',
      '/orders/:id -> OrderDetail',
      '/* -> NotFound',
    ].sort());
  });

  it('reads every table the function returns, past an early `return []`', () => {
    expect(routeBindings(cg, 'src/guarded/')).toEqual([
      '/account -> Account',
      '/admin -> Admin',
      '/dashboard -> Dashboard',
      '/me -> Account',
    ]);
  });

  it('reads the table behind useMemo, a callback or a function handed over', () => {
    expect(routeBindings(cg, 'src/memo/')).toEqual(['/reports -> Reports', '/settings -> Settings']);
  });

  it('follows a function that returns another function\'s table, and reads no list a function inside it returns', () => {
    expect(routeBindings(cg, 'src/nested/')).toEqual(['/ -> Home']);
    const all = cg.getNodesByKind('route').map((r) => r.name);
    for (const p of ['/help', '/faq', '/welcome']) expect(all).not.toContain(p);
  });
});
