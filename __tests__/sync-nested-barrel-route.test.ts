/**
 * A lazy route whose module is a barrel, and whose page sits in a folder below
 * the barrel's (DigiShop.Frontend: `@/pages` is `src/pages/index.ts`, which
 * imports `./Home`, which is `src/pages/Home/index.tsx`). While the page is
 * missing the route's reference fails, and it waits under the key of the
 * module it names, `module:pages`. A file in `src/pages/Home/` gives its own
 * folder's and stem's keys, so `codegraph sync` never revisited the route when
 * the page appeared, though a fresh index links it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

type Files = Record<string, string | null>;

const ROUTER: Files = {
  'package.json': JSON.stringify({ name: 'shop', private: true, dependencies: { react: '^18', 'react-router': '^7' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  'src/router.tsx': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  {
    path: '/',
    lazy: async () => {
      const { HomePage } = await import('@/pages');
      return { Component: HomePage };
    },
  },
  {
    path: '/cart',
    lazy: async () => {
      const { CartPage } = await import('@/shop');
      return { Component: CartPage };
    },
  },
  { path: '/admin', lazy: () => import('@/admin') },
]);
`,
  // \`export … from\` into a folder below.
  'src/pages/index.ts': "export * from './home';\n",
  'src/pages/home/index.ts': "export { HomePage } from './HomePage';\n",
  // An import the barrel exports again.
  'src/shop/index.ts': "import { CartPage } from './cart';\n\nexport { CartPage };\n",
  // Two barrels below the one the route loads.
  'src/admin/index.ts': "export * from './dashboard';\n",
  'src/admin/dashboard/index.ts': "export * from './panel';\n",
  'src/admin/dashboard/panel/index.ts': "export * from './Dashboard';\n",
};

const PAGES: Files = {
  'src/pages/home/HomePage.tsx': 'export function HomePage() {\n  return null;\n}\n',
  'src/shop/cart/index.tsx': 'export function CartPage() {\n  return null;\n}\n',
  'src/admin/dashboard/panel/Dashboard.tsx': 'export function Component() {\n  return null;\n}\n',
};

const LINKED = {
  '/': ['HomePage@src/pages/home/HomePage.tsx'],
  '/cart': ['CartPage@src/shop/cart/index.tsx'],
  '/admin': ['Component@src/admin/dashboard/panel/Dashboard.tsx'],
};

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
    const file = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};
/** A project of `files`, indexed from scratch in a folder of its own. */
const indexed = async (files: Files): Promise<{ dir: string; graph: CodeGraph }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-nested-barrel-'));
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
const NONE = { '/': [], '/cart': [], '/admin': [] };

describe('sync, for a lazy route whose page sits below its barrel', () => {
  it('links each page once it appears', async () => {
    const { dir, graph } = await indexed(ROUTER);
    expect(routeLinks(graph)).toEqual(NONE);
    write(dir, PAGES);
    expect((await graph.sync()).filesAdded).toBe(3);
    expect(routeLinks(graph)).toEqual(LINKED);
    expect(routeLinks((await indexed({ ...ROUTER, ...PAGES })).graph)).toEqual(LINKED);
  }, 60_000);

  it('links each page once an edit gives it the export', async () => {
    const placeholders = Object.fromEntries(Object.keys(PAGES).map((file) => [file, 'export const placeholder = 1;\n']));
    const { dir, graph } = await indexed({ ...ROUTER, ...placeholders });
    expect(routeLinks(graph)).toEqual(NONE);
    write(dir, PAGES);
    expect((await graph.sync()).filesModified).toBe(3);
    expect(routeLinks(graph)).toEqual(LINKED);
  }, 60_000);

  it('links a page again after it is deleted and comes back', async () => {
    const { dir, graph } = await indexed({ ...ROUTER, ...PAGES });
    expect(routeLinks(graph)).toEqual(LINKED);
    write(dir, Object.fromEntries(Object.keys(PAGES).map((file) => [file, null])));
    await graph.sync();
    expect(routeLinks(graph)).toEqual(NONE);
    write(dir, PAGES);
    await graph.sync();
    expect(routeLinks(graph)).toEqual(LINKED);
  }, 60_000);
});
