/**
 * A lazily loaded route module that is a barrel (luci-go's milo/ui):
 * `lazy: () => import('@/test_verdict/pages/invocation_page')` loads
 * `invocation_page/index.ts`, whose `export * from './invocation_page'`
 * forwards the `Component` that `invocation_page.tsx` declares. The route
 * renders that component; before, the barrel was read for an export of its
 * own, found none, and the route linked nothing. (The fixture's folder is
 * `builds/`: a `build/` folder is skipped as build output.)
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-lazy-barrel-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ui', private: true, dependencies: { react: '^18', 'react-router': '^7' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'src/router.tsx': `import { lazy } from 'react';
import { createBrowserRouter } from 'react-router';

const Settings = lazy(() => import('@/settings'));

export const router = createBrowserRouter([
  {
    path: '/builds/:id',
    lazy: () => import('@/builds/build_page'),
    children: [{ path: 'overview', lazy: () => import('@/builds/build_page/overview_tab') }],
  },
  { path: '/builders', lazy: () => import('@/builds/pages') },
  { path: '/fleet', lazy: () => import('@/fleet/home_page') },
  { path: '/login', lazy: () => import('@/auth/login_page') },
  { path: '/graph', lazy: () => import('@/chronicle/graph_view') },
  { path: '/settings', element: <Settings /> },
  { path: '/redirect', lazy: () => import('@/core/redirection_loader') },
  { path: '/clash', lazy: () => import('@/clash') },
  { path: '/loop', lazy: () => import('@/loop/a') },
  { path: '/no-default', lazy: () => import('@/legacy') },
]);
`,
    // `export *` forwards the `Component` its module declares.
    'src/builds/build_page/index.ts': `export * from './build_page';
`,
    'src/builds/build_page/build_page.tsx': `export const BuildPage = () => null;

export function Component() {
  return <BuildPage />;
}
`,
    'src/builds/build_page/overview_tab/index.ts': `export * from './overview_tab';
`,
    'src/builds/build_page/overview_tab/overview_tab.tsx': `export function Component() {
  return null;
}
`,
    // A barrel of barrels.
    'src/builds/pages/index.ts': `export * from './builder_list_page';
`,
    'src/builds/pages/builder_list_page/index.ts': `export * from './builder_list_page';
`,
    'src/builds/pages/builder_list_page/builder_list_page.tsx': `export function BuilderListPage() {
  return null;
}

export const Component = BuilderListPage;
`,
    // A named re-export, renamed to the name React Router reads.
    'src/fleet/home_page/index.ts': `export { HomePage as Component } from './home_page';
`,
    'src/fleet/home_page/home_page.tsx': `export function HomePage() {
  return null;
}
`,
    // The default export, forwarded.
    'src/auth/login_page/index.ts': `export { default } from './login_page';
`,
    'src/auth/login_page/login_page.tsx': `export default function LoginPage() {
  return null;
}
`,
    // An export clause in the module itself.
    'src/chronicle/graph_view.tsx': `function GraphView() {
  return null;
}

export { GraphView as Component };
`,
    // `React.lazy` reads the default export, through a barrel too.
    'src/settings/index.ts': `export { default } from './settings_page';
`,
    'src/settings/settings_page.tsx': `export default function SettingsPage() {
  return null;
}
`,
    // A module that only redirects renders nothing.
    'src/core/redirection_loader.ts': `export function redirectionLoader() {
  return null;
}

export const loader = redirectionLoader;
`,
    // Two modules forward a `Component` through `export *`: JavaScript exports neither.
    'src/clash/index.ts': `export * from './first';
export * from './second';
`,
    'src/clash/first.tsx': `export function Component() {
  return null;
}
`,
    'src/clash/second.tsx': `export function Component() {
  return null;
}
`,
    // Barrels that forward each other.
    'src/loop/a.ts': `export * from './b';
`,
    'src/loop/b.ts': `export * from './a';
`,
    // `export *` forwards every name but the default.
    'src/legacy/index.ts': `export * from './legacy_page';
`,
    'src/legacy/legacy_page.tsx': `export default function LegacyPage() {
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

describe('a lazy route module that is a barrel', () => {
  it('renders the Component an `export *` barrel forwards', () => {
    expect(renders('/builds/:id')).toEqual(['Component@src/builds/build_page/build_page.tsx']);
    expect(renders('/builds/:id/overview')).toEqual(['Component@src/builds/build_page/overview_tab/overview_tab.tsx']);
  });

  it('follows a barrel that forwards another barrel', () => {
    expect(renders('/builders')).toEqual(['Component@src/builds/pages/builder_list_page/builder_list_page.tsx']);
  });

  it('renders inside the layout a barrel forwards', () => {
    expect(bindings('/builds/:id/overview', true)).toEqual(['Component@src/builds/build_page/build_page.tsx']);
  });

  it('follows a named re-export to what it renames', () => {
    expect(renders('/fleet')).toEqual(['HomePage@src/fleet/home_page/home_page.tsx']);
    expect(renders('/login')).toEqual(['LoginPage@src/auth/login_page/login_page.tsx']);
  });

  it('reads an export clause in the module itself', () => {
    expect(renders('/graph')).toEqual(['GraphView@src/chronicle/graph_view.tsx']);
  });

  it('follows the barrel a React.lazy value loads', () => {
    expect(renders('/settings')).toEqual(['SettingsPage@src/settings/settings_page.tsx']);
  });

  it('links nothing a barrel does not forward', () => {
    // A loader-only module, a name two `export *` modules both forward, a
    // cycle, and a default export behind `export *`.
    expect(renders('/redirect')).toEqual([]);
    expect(renders('/clash')).toEqual([]);
    expect(renders('/loop')).toEqual([]);
    expect(renders('/no-default')).toEqual([]);
  });
});
