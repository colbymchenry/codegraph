/**
 * A data router's nested, lazy, constant-named routes (bulletproof-react):
 * - a child's `path` is relative to its parent's — `discussions` under `/app`
 *   is `/app/discussions`;
 * - `lazy: () => import('./routes/x')` renders the module's default export;
 * - `path: paths.app.root.path` reads the constant object where it is
 *   declared — here through a monorepo app's own tsconfig `@/*` alias, which
 *   now resolves from the tsconfig nearest the importing file;
 * - `element: (<ProtectedRoute><AppRoot /></ProtectedRoute>)` renders AppRoot.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-nested-'));
  const app = (rel: string) => `apps/web/${rel}`;
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'mono', private: true }),
    [app('package.json')]: JSON.stringify({ name: 'web', dependencies: { react: '^18', 'react-router': '^7' } }),
    [app('tsconfig.json')]: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    [app('src/config/paths.ts')]: `export const paths = {
  home: { path: '/', getHref: () => '/' },
  app: {
    root: { path: '/app', getHref: () => '/app' },
    discussions: { path: 'discussions', getHref: () => '/app/discussions' },
  },
} as const;
`,
    [app('src/app/router.tsx')]: `import { createBrowserRouter } from 'react-router';
import { paths } from '@/config/paths';
import { ProtectedRoute } from '@/lib/auth';
import AppRoot from './routes/app/root';

export const router = createBrowserRouter([
  { path: paths.home.path, lazy: () => import('./routes/landing') },
  {
    path: paths.app.root.path,
    element: (
      <ProtectedRoute>
        <AppRoot />
      </ProtectedRoute>
    ),
    children: [
      { path: paths.app.discussions.path, lazy: () => import('./routes/app/discussions') },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);
`,
    [app('src/lib/auth.tsx')]: `export function ProtectedRoute({ children }: { children: unknown }) { return children; }
`,
    [app('src/app/routes/landing.tsx')]: `const LandingRoute = () => null;
export default LandingRoute;
`,
    [app('src/app/routes/app/root.tsx')]: `export default function AppRoot() { return null; }
`,
    [app('src/app/routes/app/discussions.tsx')]: `export default function DiscussionsRoute() { return null; }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const bindings = (routeName: string, layout: boolean): string[] => {
  const route = cg.getNodesByKind('route').find((r) => r.name === routeName);
  if (!route) return [];
  return cg.getOutgoingEdges(route.id)
    .filter((e) => e.kind === 'references' && Boolean((e.metadata as Record<string, unknown> | undefined)?.layout) === layout)
    .map((e) => cg.getNode(e.target)!.name);
};
const renders = (routeName: string): string[] => bindings(routeName, false);

describe('nested, lazy and constant React Router routes', () => {
  it('compose their paths and render their modules', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name).sort();
    expect(names).toEqual(['/', '/app', '/app/discussions', '/app/settings']);
    expect(renders('/')).toEqual(['LandingRoute']);
    expect(renders('/app')).toEqual(['AppRoot']);
    expect(renders('/app/discussions')).toEqual(['DiscussionsRoute']);
  });

  it('a child route renders inside its parent’s component, the layout around it', () => {
    expect(bindings('/app/discussions', true)).toEqual(['AppRoot']);
    expect(bindings('/', true)).toEqual([]);
  });

  it('resolves an app’s own tsconfig alias', () => {
    const router = cg.getNodesInFile('apps/web/src/app/router.tsx').map((n) => n.id);
    const imported = cg.getOutgoingEdgesFrom(router).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)!.filePath);
    expect(imported).toContain('apps/web/src/config/paths.ts');
    expect(imported).toContain('apps/web/src/lib/auth.tsx');
  });
});
