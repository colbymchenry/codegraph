/**
 * A data-router `lazy` loader that picks the export a route renders (luci-go's
 * milo/ui): `lazy: async () => { const { TestTab } = await import('…/tabs');
 * return { Component: TestTab }; }`. The route renders `TestTab`, which the
 * `tabs` barrel forwards; before, the route was linked to the module's default
 * export, else its `Component` export, and a barrel of tabs has neither.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-lazy-member-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ui', private: true, dependencies: { react: '^18', 'react-router': '^7' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'src/router.tsx': `import { createBrowserRouter, Route, createRoutesFromElements } from 'react-router';
import { AgeGate, PrivateRoute, RequireAuth } from './guards';
import { SettingsPage } from './pages/settings';

export const router = createBrowserRouter([
  {
    path: '/invocations/:id',
    lazy: async () => {
      const { InvocationPage } = await import('@/invocation_page');
      return { Component: InvocationPage };
    },
    children: [
      {
        path: 'tests',
        lazy: async () => {
          const { TestTab } = await import(
            '@/invocation_page/tabs'
          );
          return { Component: TestTab };
        },
      },
      {
        path: 'details',
        lazy: async () => {
          const { DetailsTab } = await import('@/invocation_page/tabs');
          return { Component: DetailsTab };
        },
      },
    ],
  },
  {
    path: '/login',
    lazy: async () => {
      const { default: Component } = await import(/* webpackChunkName: "login" */ './pages/login');
      return { Component };
    },
  },
  { path: '/reports', lazy: () => import('./pages/reports').then((m) => ({ Component: m.ReportList })) },
  { path: '/reports/:id', lazy: async () => ({ Component: (await import('./pages/reports')).ReportPage }) },
  {
    path: '/profile',
    lazy: async () => {
      const page = await import('./pages/profile');
      return { Component: page.ProfilePage };
    },
  },
  {
    path: '/projects',
    async lazy() {
      const { ProjectsPage } = await import('./pages/projects');
      return { Component: ProjectsPage };
    },
  },
  {
    path: '/team',
    lazy: async () => {
      const { teamLoader } = await import('./loaders/team');
      const { TeamPage } = await import('./pages/team');
      return { loader: teamLoader, Component: TeamPage };
    },
  },
  {
    path: '/shows/:id',
    lazy: {
      loader: async () => (await import('./shows/loader')).loader,
      Component: async () => (await import('./shows/show')).Show,
    },
  },
  {
    path: '/admin',
    lazy: async () => {
      const { AdminPage } = await import('./pages/admin');
      return {
        element: (
          <RequireAuth>
            <AdminPage />
          </RequireAuth>
        ),
      };
    },
  },
  {
    path: '/fireworks',
    lazy: async () => {
      const { default: FireworksPage } = await import('./pages/fireworks');
      return { element: <AgeGate minAge={18}><FireworksPage /></AgeGate> };
    },
  },
  {
    path: '/favorites',
    async lazy() {
      let { Favorites } = await import('./pages/favorites');
      return { Component: () => <PrivateRoute redirectTo="/" component={<Favorites />} /> };
    },
  },
  {
    path: '/feed',
    lazy: async () => {
      const [{ Feed }] = await Promise.all([import('./pages/feed'), loadMessages()]);
      return { Component: Feed };
    },
  },
  {
    path: '/settings',
    lazy: async () => {
      const { settingsLoader } = await import('./loaders/settings');
      return { loader: settingsLoader, Component: SettingsPage };
    },
  },
  {
    path: '/logout',
    lazy: async () => {
      const { loader } = await import('./pages/logout');
      return { loader };
    },
  },
  {
    path: '/missing',
    lazy: async () => {
      const { Missing } = await import('./pages/reports');
      return { Component: Missing };
    },
  },
  {
    path: '/named-only',
    lazy: async () => {
      const { default: Component } = await import('./pages/named_only');
      return { Component };
    },
  },
]);

export const jsxRoutes = createRoutesFromElements(
  <Route path="/help" lazy={async () => { const { HelpPage } = await import('./pages/help'); return { Component: HelpPage }; }} />
);

async function loadMessages() {
  return {};
}
`,
    'src/guards.tsx': `export function RequireAuth({ children }: { children: unknown }) {
  return children;
}

export function AgeGate({ children }: { children: unknown; minAge: number }) {
  return children;
}

export function PrivateRoute({ component }: { component: unknown; redirectTo: string }) {
  return component;
}
`,
    'src/pages/fireworks.tsx': `export default function FireworksPage() {
  return null;
}
`,
    'src/pages/favorites.tsx': `export function Favorites() {
  return null;
}
`,
    'src/invocation_page/index.ts': `export * from './invocation_page';
`,
    'src/invocation_page/invocation_page.tsx': `export function InvocationPage() {
  return null;
}
`,
    // A barrel of tabs: no default export and no \`Component\`.
    'src/invocation_page/tabs/index.ts': `export * from './test_tab';
export * from './details_tab';
`,
    'src/invocation_page/tabs/test_tab.tsx': `export function TestTab() {
  return null;
}
`,
    'src/invocation_page/tabs/details_tab.tsx': `export function DetailsTab() {
  return null;
}
`,
    'src/pages/login.tsx': `export default function LoginPage() {
  return null;
}
`,
    // A default export the loaders do not pick.
    'src/pages/reports.tsx': `export function ReportList() {
  return null;
}

export function ReportPage() {
  return null;
}

export default function ReportsHome() {
  return null;
}
`,
    'src/pages/profile.tsx': `export function ProfilePage() {
  return null;
}

export default function ProfileCard() {
  return null;
}
`,
    'src/pages/projects.tsx': `export function ProjectsPage() {
  return null;
}
`,
    'src/loaders/team.ts': `export async function teamLoader() {
  return null;
}
`,
    'src/pages/team.tsx': `export function TeamPage() {
  return null;
}
`,
    'src/shows/loader.ts': `export async function loader() {
  return null;
}
`,
    'src/shows/show.tsx': `export function Show() {
  return null;
}
`,
    'src/pages/admin.tsx': `export function AdminPage() {
  return null;
}
`,
    'src/pages/feed.tsx': `export function Feed() {
  return null;
}
`,
    'src/loaders/settings.ts': `export async function settingsLoader() {
  return null;
}
`,
    'src/pages/settings.tsx': `export function SettingsPage() {
  return null;
}
`,
    // A page module whose default export the loader does not hand over.
    'src/pages/logout.tsx': `export async function loader() {
  return null;
}

export default function LogoutPage() {
  return null;
}
`,
    // No default export: \`{ default: Component }\` is undefined.
    'src/pages/named_only.tsx': `export function Component() {
  return null;
}
`,
    'src/pages/help.tsx': `export function HelpPage() {
  return null;
}
`,
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

describe('a data-router lazy loader that picks the export it renders', () => {
  it('renders the export it destructures, through a barrel', () => {
    expect(renders('/invocations/:id/tests')).toEqual(['TestTab@src/invocation_page/tabs/test_tab.tsx']);
    expect(renders('/invocations/:id/details')).toEqual(['DetailsTab@src/invocation_page/tabs/details_tab.tsx']);
  });

  it('renders inside the layout its parent route picks', () => {
    expect(renders('/invocations/:id')).toEqual(['InvocationPage@src/invocation_page/invocation_page.tsx']);
    expect(bindings('/invocations/:id/tests', true)).toEqual(['InvocationPage@src/invocation_page/invocation_page.tsx']);
  });

  it('renders the default export `{ default: Component }` picks', () => {
    expect(renders('/login')).toEqual(['LoginPage@src/pages/login.tsx']);
  });

  it('renders the export a `.then` callback, an `(await import(…)).X` or a module binding picks, not the default', () => {
    expect(renders('/reports')).toEqual(['ReportList@src/pages/reports.tsx']);
    expect(renders('/reports/:id')).toEqual(['ReportPage@src/pages/reports.tsx']);
    expect(renders('/profile')).toEqual(['ProfilePage@src/pages/profile.tsx']);
  });

  it('reads a loader written as a method', () => {
    expect(renders('/projects')).toEqual(['ProjectsPage@src/pages/projects.tsx']);
  });

  it('reads the import the component comes from, not the first one', () => {
    expect(renders('/team')).toEqual(['TeamPage@src/pages/team.tsx']);
    expect(renders('/feed')).toEqual(['Feed@src/pages/feed.tsx']);
  });

  it("reads React Router 7's object of lazy properties", () => {
    expect(renders('/shows/:id')).toEqual(['Show@src/shows/show.tsx']);
  });

  it('renders the page an `element` shows inside its guard', () => {
    expect(renders('/admin')).toEqual(['AdminPage@src/pages/admin.tsx']);
  });

  it('renders the one export the loader imports, past a guard of the route file', () => {
    expect(renders('/fireworks')).toEqual(['FireworksPage@src/pages/fireworks.tsx']);
    expect(renders('/favorites')).toEqual(['Favorites@src/pages/favorites.tsx']);
  });

  it("renders a component of the route's own file the loader returns", () => {
    expect(renders('/settings')).toEqual(['SettingsPage@src/pages/settings.tsx']);
  });

  it('reads a `<Route lazy>` the same way', () => {
    expect(renders('/help')).toEqual(['HelpPage@src/pages/help.tsx']);
  });

  it('links nothing a loader does not hand over', () => {
    // A loader that returns only a `loader` renders nothing: the route is no page.
    expect(cg.getNodesByKind('route').map((r) => r.name)).not.toContain('/logout');
    // A picked export the module lacks is not its default, nor its `Component`.
    expect(renders('/missing')).toEqual([]);
    expect(renders('/named-only')).toEqual([]);
  });
});

describe('a lazy route in a project that also has Vue Router', () => {
  let vueRoot = '';
  let graph: CodeGraph;
  beforeAll(async () => {
    vueRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-lazy-member-vue-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'mixed', private: true, dependencies: { react: '^18', 'react-router': '^7', vue: '^3', 'vue-router': '^4' } }),
      'react/router.tsx': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  { path: '/react-login', lazy: async () => { const { LoginView } = await import('./LoginView'); return { Component: LoginView }; } },
]);
`,
      'react/LoginView.tsx': `export function LoginView() {
  return null;
}
`,
      // Vue Router names this route's component `import:./views/Login#Login`,
      // the form a React route's picked export is named in too.
      'vue/router.ts': `import { createRouter, createWebHistory } from 'vue-router';

export default createRouter({
  history: createWebHistory(),
  routes: [{ path: '/vue-login', component: () => import('./views/Login') }],
});
`,
      'vue/views/Login.ts': `import { h } from 'vue';

export function Login() {
  return h('div');
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(vueRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(vueRoot, rel), content);
    }
    graph = await CodeGraph.init(vueRoot, { index: true });
  }, 60_000);
  afterAll(() => {
    graph?.close();
    if (vueRoot) fs.rmSync(vueRoot, { recursive: true, force: true });
  });

  /** Each route's outgoing edges to what it renders, with the framework that resolved them. */
  const linked = (routeName: string): string[] => {
    const route = graph.getNodesByKind('route').find((r) => r.name === routeName);
    if (!route) return [`no route ${routeName}`];
    return graph.getOutgoingEdges(route.id)
      .filter((e) => e.kind === 'references' || e.kind === 'calls')
      .map((e) => `${graph.getNode(e.target)!.filePath} by ${String((e.metadata as Record<string, unknown> | undefined)?.framework)}`);
  };

  it("leaves Vue Router's lazy component references to Vue Router", () => {
    expect(linked('/react-login')).toEqual(['react/LoginView.tsx by react']);
    expect(linked('/vue-login')).toEqual(['vue/views/Login.ts by vue-router']);
  });
});

describe('sync, for a lazy route that picks an export', () => {
  type Files = Record<string, string>;
  const ROUTER: Files = {
    'package.json': JSON.stringify({ name: 'ui', private: true, dependencies: { react: '^18', 'react-router': '^7' } }),
    'src/router.tsx': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  {
    path: '/reports',
    lazy: async () => {
      const { ReportList } = await import('./reports');
      return { Component: ReportList };
    },
  },
]);
`,
  };
  const PAGE: Files = {
    'src/reports/index.ts': `export * from './report_list';
`,
    'src/reports/report_list.tsx': `export function ReportList() {
  return null;
}
`,
  };
  const LINKED = { '/reports': ['ReportList@src/reports/report_list.tsx'] };

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-lazy-member-sync-'));
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

  it('links the picked export once its module appears', async () => {
    const { dir, graph } = await indexed(ROUTER);
    expect(routeLinks(graph)).toEqual({ '/reports': [] });
    write(dir, PAGE);
    expect((await graph.sync()).filesAdded).toBe(2);
    expect(routeLinks(graph)).toEqual(LINKED);
    expect(routeLinks((await indexed({ ...ROUTER, ...PAGE })).graph)).toEqual(LINKED);
  }, 60_000);

  it('follows a picked default export that moves to another component', async () => {
    const files: Files = {
      'package.json': ROUTER['package.json']!,
      'src/router.tsx': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  {
    path: '/login',
    lazy: async () => {
      const { default: Component } = await import('./pages/login');
      return { Component };
    },
  },
]);
`,
      'src/pages/login.tsx': 'export default function LoginPage() {\n  return null;\n}\n',
    };
    const { dir, graph } = await indexed(files);
    expect(routeLinks(graph)).toEqual({ '/login': ['LoginPage@src/pages/login.tsx'] });
    // The old component stays, so the route's edge would follow it through the re-index.
    const edit = { 'src/pages/login.tsx': 'export function LoginPage() {\n  return null;\n}\n\nexport default function SignIn() {\n  return null;\n}\n' };
    write(dir, edit);
    await graph.sync();
    expect(routeLinks(graph)).toEqual({ '/login': ['SignIn@src/pages/login.tsx'] });
    expect(routeLinks((await indexed({ ...files, ...edit })).graph)).toEqual({ '/login': ['SignIn@src/pages/login.tsx'] });
  }, 60_000);

  it('links the picked export once an edit adds it', async () => {
    const { dir, graph } = await indexed({ ...ROUTER, ...PAGE, 'src/reports/report_list.tsx': 'export const placeholder = 1;\n' });
    expect(routeLinks(graph)).toEqual({ '/reports': [] });
    write(dir, { 'src/reports/report_list.tsx': PAGE['src/reports/report_list.tsx']! });
    expect((await graph.sync()).filesModified).toBe(1);
    expect(routeLinks(graph)).toEqual(LINKED);
  }, 60_000);
});
