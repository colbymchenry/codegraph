/**
 * A sync redraws what a route renders when the module behind it changes.
 *
 * A route that renders a value its own file declares —
 * `const Docs = lazy(() => import('./pages/Docs'))` and `<Route path="/docs"
 * element={<Docs />} />` — binds to the component that module exports, and to
 * the declaration while the module is missing or exports none (#2400). The
 * reference resolved either way, so nothing parked it for the failed-ref
 * retry, and the rebind of the names a sync adds (CG-33) only reaches it when
 * the module's component is named like the declaration. So a module added,
 * given its default export, or switched to another component after the router
 * was indexed left the route on its old answer until the router file changed.
 *
 * The other half is the JSX a component renders: `<Team />` links to the
 * `Team` a sync adds only if the sync redraws the synthesized edges, and the
 * file a component is added in decided that alone, by its own markup. A
 * component without any (`return null`, a wrapper) passed none of those
 * checks.
 *
 * Every case compares the synced graph with a fresh index of the same files
 * in a folder of its own: indexing again over an existing index skips its
 * unchanged files, so it is no stand-in for one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ReferenceResolver } from '../src/resolution';

type Files = Record<string, string | null>;

const pkg = JSON.stringify({ name: 'app', dependencies: { react: '^18', 'react-router-dom': '^6' } });
const page = (name: string, exported = 'export default') => `${exported} function ${name}() { return null; }\n`;

/** The router of the report: two pages it loads lazily into values of its own. */
const APP = `import { lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
const Team = lazy(() => import('./pages/Team'));
const Docs = lazy(() => import('./pages/Docs'));
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/team" element={<Team />} />
        <Route path="/docs" element={<Docs />} />
      </Routes>
    </BrowserRouter>
  );
}
`;

let root: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function write(dir: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, file);
    if (text === null) {
      fs.rmSync(full, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

/** Every node and edge by natural key, edge metadata included, so two indexes of the same files compare directly. */
function graphOf(graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = graph.getOutgoingEdgesFrom([...keys.keys()]).map((e) =>
    `${keys.get(e.source)} -${e.kind}-> ${keys.get(e.target) ?? e.target} ${JSON.stringify(e.metadata ?? null)} @${e.line ?? ''}:${e.column ?? ''}`);
  return [...[...keys.values()].map((k) => `node ${k}`), ...edges].sort();
}

/** What each route renders: `<target file>::<target name>`, a layout marked. */
function routeLinks(graph: CodeGraph): Record<string, string[]> {
  const links: Record<string, string[]> = {};
  for (const route of graph.getNodesByKind('route')) {
    links[route.name] = [
      ...(links[route.name] ?? []),
      ...graph.getOutgoingEdges(route.id)
        .filter((e) => e.kind !== 'contains')
        .map((e) => {
          const target = graph.getNode(e.target);
          return `${e.metadata?.layout ? 'layout ' : ''}${target?.filePath}::${target?.name}`;
        }),
    ].sort();
  }
  return links;
}

/** `<parent> -> <child>` for every JSX render edge. */
function renders(graph: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of graph.getFiles()) {
    for (const node of graph.getNodesInFile(file.path)) {
      for (const e of graph.getOutgoingEdges(node.id)) {
        if (e.metadata?.synthesizedBy !== 'jsx-render') continue;
        const child = graph.getNode(e.target);
        out.push(`${node.name} -> ${child?.filePath}::${child?.name}`);
      }
    }
  }
  return out.sort();
}

/** The graph of a fresh index of `files`, in a folder of its own. */
async function freshGraph(files: Files): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-route-fresh-'));
  try {
    write(dir, Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null)));
    const fresh = await CodeGraph.init(dir, { index: true });
    try {
      return graphOf(fresh);
    } finally {
      fresh.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Index `initial`, then write each step and sync after it — with `scoped`, a
 * sync of only the step's files, as the file watcher runs it. Returns the
 * final files.
 */
async function indexThenSync(initial: Files, ...steps: Files[]): Promise<Files> {
  return indexThenSyncWith({ scoped: false }, initial, ...steps);
}

async function indexThenSyncWith(opts: { scoped: boolean }, initial: Files, ...steps: Files[]): Promise<Files> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-route-'));
  write(root, initial);
  cg = await CodeGraph.init(root, { index: true });
  const files = { ...initial };
  for (const step of steps) {
    write(root, step);
    Object.assign(files, step);
    await cg.sync(opts.scoped ? { paths: Object.keys(step) } : {});
  }
  return files;
}

describe('sync redraws a route that renders a same-file lazy value when its module changes', () => {
  it.each([false, true])('when the modules are added after the router (scoped=%s)', async (scoped) => {
    const files = await indexThenSyncWith(
      { scoped },
      { 'package.json': pkg, 'src/App.tsx': APP },
      { 'src/pages/Team.tsx': page('Team'), 'src/pages/Docs.tsx': page('DocsPage') }
    );
    expect(routeLinks(cg!)).toEqual({
      '/team': ['src/pages/Team.tsx::Team'],
      // The page's component is named unlike the declaration, so only the
      // module it loads leads to it.
      '/docs': ['src/pages/Docs.tsx::DocsPage'],
    });
    expect(renders(cg!)).toEqual(['App -> src/pages/Team.tsx::Team']);
    expect(cg!.getPendingReferenceCount()).toBe(0);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when an edit gives the module its default export', async () => {
    const files = await indexThenSync(
      { 'package.json': pkg, 'src/App.tsx': APP, 'src/pages/Team.tsx': page('Team'), 'src/pages/Docs.tsx': page('DocsPage', 'export') },
      // No name appears or goes: only the export changes.
      { 'src/pages/Docs.tsx': `${page('DocsPage', 'export')}export default DocsPage;\n` }
    );
    expect(routeLinks(cg!)['/docs']).toEqual(['src/pages/Docs.tsx::DocsPage']);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when the module’s default export moves to another component', async () => {
    const files = await indexThenSync(
      { 'package.json': pkg, 'src/App.tsx': APP, 'src/pages/Team.tsx': page('Team'), 'src/pages/Docs.tsx': page('DocsPage') },
      // The old component stays, so the route's edge follows it through the re-index.
      { 'src/pages/Docs.tsx': `${page('DocsPage', 'export')}${page('Documentation')}` }
    );
    expect(routeLinks(cg!)['/docs']).toEqual(['src/pages/Docs.tsx::Documentation']);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when deleted modules come back', async () => {
    const pages = { 'src/pages/Team.tsx': page('Team'), 'src/pages/Docs.tsx': page('DocsPage') };
    const files = await indexThenSync(
      { 'package.json': pkg, 'src/App.tsx': APP, ...pages },
      { 'src/pages/Team.tsx': null, 'src/pages/Docs.tsx': null }
    );
    // While they are gone, each route is the declaration it renders.
    expect(routeLinks(cg!)).toEqual({ '/team': ['src/App.tsx::Team'], '/docs': ['src/App.tsx::Docs'] });
    expect(graphOf(cg!)).toEqual(await freshGraph(files));

    write(root!, pages);
    await cg!.sync();
    expect(routeLinks(cg!)).toEqual({ '/team': ['src/pages/Team.tsx::Team'], '/docs': ['src/pages/Docs.tsx::DocsPage'] });
    expect(graphOf(cg!)).toEqual(await freshGraph({ ...files, ...pages }));
  }, 60_000);

  it('in a route table another file hands the router (codedthemes’ admin templates)', async () => {
    const files = await indexThenSync(
      {
        'package.json': JSON.stringify({ name: 'berry', dependencies: { react: '^18', 'react-router-dom': '^7' } }),
        'src/routes/index.jsx': "import { createBrowserRouter } from 'react-router-dom';\nimport MainRoutes from './MainRoutes';\n\nconst router = createBrowserRouter([MainRoutes]);\n\nexport default router;\n",
        'src/routes/MainRoutes.jsx': `import { lazy } from 'react';
import MainLayout from '../layout/MainLayout';
import Loadable from '../ui-component/Loadable';

const DashboardDefault = Loadable(lazy(() => import('../views/dashboard/Default')));

const MainRoutes = {
  path: '/',
  element: <MainLayout />,
  children: [{ path: 'dashboard/default', element: <DashboardDefault /> }]
};

export default MainRoutes;
`,
        'src/layout/MainLayout.jsx': 'export default function MainLayout() {\n  return <main />;\n}\n',
        'src/ui-component/Loadable.jsx': 'export default function Loadable(Component) {\n  return (props) => <Component {...props} />;\n}\n',
      },
      { 'src/views/dashboard/Default.jsx': page('DashboardDefaultPage') }
    );
    expect(routeLinks(cg!)['/dashboard/default']).toEqual([
      'layout src/layout/MainLayout.jsx::MainLayout',
      'src/views/dashboard/Default.jsx::DashboardDefaultPage',
    ]);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('for a data router’s lazy route whose module switches its default export', async () => {
    const files = await indexThenSync(
      {
        'package.json': pkg,
        'src/router.tsx': "import { createBrowserRouter } from 'react-router-dom';\nexport const router = createBrowserRouter([{ path: '/docs', lazy: () => import('./pages/Docs') }]);\n",
        'src/pages/Docs.tsx': page('DocsPage'),
      },
      { 'src/pages/Docs.tsx': `${page('DocsPage', 'export')}${page('Documentation')}` }
    );
    expect(routeLinks(cg!)['/docs']).toEqual(['src/pages/Docs.tsx::Documentation']);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('and re-opens nothing for a module no route loads', async () => {
    await indexThenSync({ 'package.json': pkg, 'src/App.tsx': APP, 'src/pages/Team.tsx': page('Team'), 'src/pages/Docs.tsx': page('DocsPage') });
    const reopen = vi.spyOn(ReferenceResolver.prototype, 'reopenRouteModuleReaders');
    write(root!, { 'src/util.ts': 'export function slug(s: string) { return s.toLowerCase(); }\n' });
    await cg!.sync();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen.mock.results[0]!.value).toBe(0);

    // The router's own edit resolves its references itself.
    write(root!, { 'src/App.tsx': APP.replace('/docs', '/documentation'), 'src/pages/Docs.tsx': page('Documentation') });
    await cg!.sync();
    expect(reopen.mock.results[1]!.value).toBe(0);
    expect(routeLinks(cg!)['/documentation']).toEqual(['src/pages/Docs.tsx::Documentation']);
  }, 60_000);
});

describe('sync draws the JSX edges to a component it adds', () => {
  it('when another file imports and renders it', async () => {
    const files = await indexThenSync(
      { 'package.json': pkg, 'src/Shell.tsx': "import Team from './Team';\nexport function Shell() {\n  return <main><Team /></main>;\n}\n" },
      // A component without markup of its own.
      { 'src/Team.tsx': page('Team') }
    );
    expect(renders(cg!)).toEqual(['Shell -> src/Team.tsx::Team']);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when another file renders it by name alone', async () => {
    const files = await indexThenSync(
      { 'package.json': pkg, 'src/Shell.tsx': 'export function Shell() {\n  return <main><Badge /></main>;\n}\n' },
      { 'src/Badge.tsx': 'export const Badge = () => null;\n' }
    );
    expect(renders(cg!)).toEqual(['Shell -> src/Badge.tsx::Badge']);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('but leaves them alone for a new name no tag can render', async () => {
    await indexThenSync({
      'package.json': pkg,
      'src/Shell.tsx': "import Team from './Team';\nexport function Shell() {\n  return <main><Team /></main>;\n}\n",
      'src/Team.tsx': page('Team'),
      'src/limits.ts': 'export function clamp(n: number) { return Math.min(n, 3); }\n',
    });
    const phases: string[] = [];
    // A value and a lowercase function: neither is a component.
    write(root!, { 'src/limits.ts': 'export const Limits = { max: 3 };\nexport function clamp(n: number) { return Math.min(n, Limits.max); }\nexport function floor(n: number) { return n; }\n' });
    await cg!.sync({ onProgress: (p) => phases.push(p.phase) });
    expect(phases).not.toContain('linking');
    expect(renders(cg!)).toEqual(['Shell -> src/Team.tsx::Team']);
  }, 60_000);
});
