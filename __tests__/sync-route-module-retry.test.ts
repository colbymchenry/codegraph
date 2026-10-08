/**
 * A sync links a route to the module it lazily loads once the module appears.
 *
 * A router names a lazily loaded page or layout by the module's path: React
 * Router's `lazy: () => import('./pages/Team')` is the reference
 * `lazy-import:./pages/Team`, Vue Router's `component: () =>
 * import('@/views/Login')` is `import:@/views/Login#Login`, and Angular's
 * `loadComponent: () => import('./home/home.component')` is
 * `import:./home/home.component#default`. Sync retries a parked failed ref by
 * its tail (#1240), and these were parked under a fragment of the path —
 * `/pages/Team`, `@/views/Login#Login`, `component#default` — that no file's
 * keys match. So a route whose module was added after the router was indexed
 * stayed unlinked until the router file changed or the project was indexed
 * again, and so did one whose module gained its component in a later edit.
 * #2392 fixed the same gap for imports, #2403 for Liquid's path references.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { moduleReferenceKeys, referenceNameTail } from '../src/db/reference-tail';

type Files = Record<string, string>;
/** Each route's links: `<edge kind>[ layout] <target file>::<target name>`. */
type Links = Record<string, string[]>;

interface Scenario {
  name: string;
  initial: Files;
  added: Files;
  expected: Links;
}

const pkg = (dependencies: Record<string, string>) => JSON.stringify({ name: 'app', dependencies });
const angularComponent = (name: string, exported = 'export') =>
  `import { Component } from '@angular/core';\n\n@Component({ selector: 'app-x', template: '' })\n${exported} class ${name} {}\n`;
const vueView = (text: string) => `<template><div>${text}</div></template>\n<script setup>\nconst ready = true\n</script>\n`;

const SCENARIOS: Scenario[] = [
  {
    name: 'React Router',
    initial: {
      'package.json': pkg({ react: '^18', 'react-router-dom': '^6' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/router.tsx': [
        "import { createBrowserRouter } from 'react-router-dom';",
        'export const router = createBrowserRouter([',
        "  { path: '/team', lazy: () => import('./pages/Team') },",
        "  { path: '/about', lazy: () => import('./pages/About.tsx') },",
        "  { path: '/docs', lazy: () => import('./pages/Docs') },",
        "  { path: '/settings', lazy: () => import('./pages/Settings') },",
        "  { path: '/billing', lazy: () => import('@/pages/Billing') },",
        "  { path: '/app', lazy: () => import('./layouts/Shell'), children: [",
        "    { path: 'inbox', lazy: () => import('./pages/Inbox') },",
        '  ] },',
        ']);',
        '',
      ].join('\n'),
    },
    added: {
      'src/pages/Team.tsx': 'export default function Team() { return null; }\n',
      'src/pages/About.tsx': 'export default function About() { return null; }\n',
      // A default export named unlike its file.
      'src/pages/Docs.tsx': 'export default function DocsPage() { return null; }\n',
      // A folder's index file.
      'src/pages/Settings/index.tsx': 'export default function Settings() { return null; }\n',
      // Through a tsconfig alias, rendering the module's `Component` export.
      'src/pages/Billing.tsx': 'export function Component() { return null; }\n',
      'src/layouts/Shell.tsx': 'export default function Shell() { return null; }\n',
      'src/pages/Inbox.tsx': 'export default function Inbox() { return null; }\n',
    },
    expected: {
      '/team': ['references src/pages/Team.tsx::Team'],
      '/about': ['references src/pages/About.tsx::About'],
      '/docs': ['references src/pages/Docs.tsx::DocsPage'],
      '/settings': ['references src/pages/Settings/index.tsx::Settings'],
      '/billing': ['references src/pages/Billing.tsx::Component'],
      '/app': ['references src/layouts/Shell.tsx::Shell'],
      '/app/inbox': ['references layout src/layouts/Shell.tsx::Shell', 'references src/pages/Inbox.tsx::Inbox'],
    },
  },
  {
    name: 'Vue Router',
    initial: {
      'package.json': pkg({ vue: '^3', 'vue-router': '^4' }),
      'src/router/index.js': [
        "import { createRouter, createWebHistory } from 'vue-router'",
        'export default createRouter({',
        '  history: createWebHistory(),',
        '  routes: [',
        "    { path: '/', component: () => import('../views/Home.vue') },",
        "    { path: '/login', component: () => import('@/views/Login') },",
        "    { path: '/admin', component: () => import('@/layout/index.vue'), children: [",
        "      { path: 'dashboard', component: () => import('@/views/dashboard/index') },",
        '    ] },',
        '  ]',
        '})',
        '',
      ].join('\n'),
    },
    added: {
      'src/views/Home.vue': vueView('home'),
      'src/views/Login.vue': vueView('login'),
      'src/layout/index.vue': vueView('<router-view />'),
      'src/views/dashboard/index.vue': vueView('dashboard'),
    },
    expected: {
      '/': ['calls src/views/Home.vue::Home'],
      '/login': ['calls src/views/Login.vue::Login'],
      '/admin': ['calls src/layout/index.vue::index'],
      '/admin/dashboard': ['calls src/views/dashboard/index.vue::index', 'references layout src/layout/index.vue::index'],
    },
  },
  {
    name: 'Angular',
    initial: {
      'package.json': pkg({ '@angular/core': '^17', '@angular/router': '^17' }),
      'src/app/app.routes.ts': [
        "import { Routes } from '@angular/router';",
        'export const routes: Routes = [',
        "  { path: '', loadComponent: () => import('./home/home.component').then((m) => m.HomeComponent) },",
        "  { path: 'about', loadComponent: () => import('./about/about.component') },",
        "  { path: 'admin', loadComponent: () => import('./admin/shell.component').then((m) => m.ShellComponent), children: [",
        "      { path: 'users', loadComponent: () => import('./admin/users.component').then((m) => m.UsersComponent) },",
        '  ] },',
        '];',
        '',
      ].join('\n'),
    },
    added: {
      'src/app/home/home.component.ts': angularComponent('HomeComponent'),
      'src/app/about/about.component.ts': angularComponent('AboutComponent', 'export default'),
      'src/app/admin/shell.component.ts': angularComponent('ShellComponent'),
      'src/app/admin/users.component.ts': angularComponent('UsersComponent'),
    },
    expected: {
      '/': ['references src/app/home/home.component.ts::HomeComponent'],
      '/about': ['references src/app/about/about.component.ts::AboutComponent'],
      '/admin': ['references src/app/admin/shell.component.ts::ShellComponent'],
      '/admin/users': ['references layout src/app/admin/shell.component.ts::ShellComponent', 'references src/app/admin/users.component.ts::UsersComponent'],
    },
  },
  {
    // Ghostfolio's markets page: the child loads the class its layout
    // renders, so the child's route and layout references make one edge, and
    // the reference resolved first names it — in a full index, the one
    // written first.
    name: 'Angular, a child loading its layout\'s class',
    initial: {
      'package.json': pkg({ '@angular/core': '^17', '@angular/router': '^17' }),
      'src/app/app.routes.ts': [
        "import { Routes } from '@angular/router';",
        "import { MarketsComponent } from './markets/markets.component';",
        'export const routes: Routes = [',
        "  { path: 'markets', component: MarketsComponent, children: [",
        "      { path: '', loadComponent: () => import('./markets/markets.component').then((m) => m.MarketsComponent) },",
        '  ] },',
        '];',
        '',
      ].join('\n'),
    },
    added: { 'src/app/markets/markets.component.ts': angularComponent('MarketsComponent') },
    expected: { '/markets': ['references src/app/markets/markets.component.ts::MarketsComponent'] },
  },
];

/**
 * The module is there from the start, but only a later edit gives it the
 * component the route renders: React's default export, a component a Vue
 * route loads from a script, Angular's class.
 */
const EDITED: Scenario[] = [
  {
    name: 'React Router',
    initial: {
      'package.json': pkg({ react: '^18', 'react-router-dom': '^6' }),
      'src/router.tsx': "import { createBrowserRouter } from 'react-router-dom';\nexport const router = createBrowserRouter([{ path: '/team', lazy: () => import('./pages/Team') }]);\n",
      'src/pages/Team.tsx': 'export const placeholder = 1;\n',
    },
    added: { 'src/pages/Team.tsx': 'export default function Team() { return null; }\n' },
    expected: { '/team': ['references src/pages/Team.tsx::Team'] },
  },
  {
    name: 'Vue Router',
    initial: {
      'package.json': pkg({ vue: '^3', 'vue-router': '^4' }),
      'src/router/index.js': "import { createRouter, createWebHistory } from 'vue-router'\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '/', component: () => import('../views/Home.js') }] })\n",
      'src/views/Home.js': 'export const placeholder = 1\n',
    },
    added: { 'src/views/Home.js': 'export default function Home() { return null }\n' },
    expected: { '/': ['calls src/views/Home.js::Home'] },
  },
  {
    name: 'Angular',
    initial: {
      'package.json': pkg({ '@angular/core': '^17', '@angular/router': '^17' }),
      'src/app/app.routes.ts': "import { Routes } from '@angular/router';\nexport const routes: Routes = [{ path: '', loadComponent: () => import('./home/home.component').then((m) => m.HomeComponent) }];\n",
      'src/app/home/home.component.ts': 'export const placeholder = 1;\n',
    },
    added: { 'src/app/home/home.component.ts': angularComponent('HomeComponent') },
    expected: { '/': ['references src/app/home/home.component.ts::HomeComponent'] },
  },
];

let root: string | undefined;
let cg: CodeGraph | undefined;
let db: DatabaseConnection | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  db?.close();
  db = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function write(dir: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

function routeLinks(graph: CodeGraph): Links {
  const links: Links = {};
  for (const route of graph.getNodesByKind('route')) {
    links[route.name] = graph
      .getOutgoingEdges(route.id)
      .filter((edge) => edge.kind !== 'contains')
      .map((edge) => {
        const target = graph.getNode(edge.target);
        return `${edge.kind}${edge.metadata?.layout ? ' layout' : ''} ${target?.filePath}::${target?.name}`;
      })
      .sort();
  }
  return links;
}

const unlinked = (expected: Links): Links => Object.fromEntries(Object.keys(expected).map((route) => [route, []]));

/** The route links of a fresh index of `files`, in a folder of its own: indexing again over an index skips its unchanged files. */
async function freshRouteLinks(files: Files): Promise<Links> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-fresh-'));
  try {
    write(dir, files);
    const fresh = await CodeGraph.init(dir, { index: true });
    try {
      return routeLinks(fresh);
    } finally {
      fresh.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('sync links a route to the module it lazily loads', () => {
  it.each(SCENARIOS)('when the module is added after the router: $name', async (s) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-'));
    write(root, s.initial);
    cg = await CodeGraph.init(root, { index: true });
    expect(routeLinks(cg)).toEqual(unlinked(s.expected));

    write(root, s.added);
    expect((await cg.sync()).filesAdded).toBe(Object.keys(s.added).length);
    // The router did not change: only the retry of its parked references links it.
    expect(routeLinks(cg)).toEqual(s.expected);
    expect(cg.getPendingReferenceCount()).toBe(0);
    expect(await freshRouteLinks({ ...s.initial, ...s.added })).toEqual(s.expected);
  }, 60_000);

  // The component a route renders is the module's, so an edit that gives the
  // module one is what the route waited for.
  it.each(EDITED)('when an edit gives the module its component: $name', async (s) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-'));
    write(root, s.initial);
    cg = await CodeGraph.init(root, { index: true });
    expect(routeLinks(cg)).toEqual(unlinked(s.expected));

    write(root, s.added);
    expect((await cg.sync()).filesModified).toBe(1);
    expect(routeLinks(cg)).toEqual(s.expected);
    expect(cg.getPendingReferenceCount()).toBe(0);
    expect(await freshRouteLinks({ ...s.initial, ...s.added })).toEqual(s.expected);
  }, 60_000);

  it('when a deleted module comes back', async () => {
    const [react] = SCENARIOS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-'));
    write(root, { ...react!.initial, ...react!.added });
    cg = await CodeGraph.init(root, { index: true });
    expect(routeLinks(cg)['/team']).toEqual(['references src/pages/Team.tsx::Team']);

    fs.rmSync(path.join(root, 'src/pages/Team.tsx'));
    expect((await cg.sync()).filesRemoved).toBe(1);
    expect(routeLinks(cg)['/team']).toEqual([]);
    expect(cg.getPendingReferenceCount()).toBe(0);

    write(root, { 'src/pages/Team.tsx': react!.added['src/pages/Team.tsx']! });
    expect((await cg.sync()).filesAdded).toBe(1);
    expect(routeLinks(cg)).toEqual(react!.expected);
  }, 60_000);

  it('in an index whose references an older version parked', async () => {
    const [react] = SCENARIOS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-'));
    write(root, react!.initial);
    cg = await CodeGraph.init(root, { index: true });
    cg.close();
    cg = undefined;

    // What a version before 14 left: the tail cut at the path's last dot or colon.
    db = DatabaseConnection.open(getDatabasePath(root));
    const refs = db.getDb().prepare("SELECT id, reference_name AS name FROM unresolved_refs WHERE reference_name LIKE '%lazy-import:%'").all() as Array<{ id: number; name: string }>;
    expect(refs).toHaveLength(8);
    for (const ref of refs) {
      const legacy = ref.name.slice(Math.max(ref.name.lastIndexOf('.'), ref.name.lastIndexOf(':')) + 1);
      db.getDb().prepare('UPDATE unresolved_refs SET name_tail = ? WHERE id = ?').run(legacy, ref.id);
    }
    db.getDb().exec(`DELETE FROM schema_versions WHERE version >= 14;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (13, 0, 'legacy fixture');`);
    db.close();
    db = undefined;

    cg = await CodeGraph.open(root);
    write(root, react!.added);
    await cg.sync();
    expect(routeLinks(cg)).toEqual(react!.expected);
    expect(cg.getPendingReferenceCount()).toBe(0);
  }, 60_000);
});

describe('referenceNameTail', () => {
  it('parks a route\'s reference to a module under the stem of its path, behind module:', () => {
    // React Router: a lazy route, and the lazy layout route around another.
    expect(referenceNameTail('lazy-import:./pages/Team', 'references')).toBe('module:Team');
    expect(referenceNameTail('lazy-import:./routes/about.tsx', 'references')).toBe('module:about');
    expect(referenceNameTail('lazy-import:@/pages/Billing', 'references')).toBe('module:Billing');
    expect(referenceNameTail('lazy-import:./pages/Settings/', 'references')).toBe('module:Settings');
    expect(referenceNameTail('layout:lazy-import:./layouts/Shell', 'references')).toBe('module:Shell');
    // Vue Router: the component a route renders is a call, its layout a reference;
    // vben's `#/` alias puts a `#` in the path.
    expect(referenceNameTail('import:@/views/Login#Login', 'calls')).toBe('module:Login');
    expect(referenceNameTail('import:../views/Home.vue#Home', 'calls')).toBe('module:Home');
    expect(referenceNameTail('import:#/views/dashboard/analytics/index.vue#index', 'calls')).toBe('module:index');
    expect(referenceNameTail('layout:import:@/layout/index.vue#index', 'references')).toBe('module:index');
    // Angular: a member the import names, or the module's default.
    expect(referenceNameTail('import:./home/home.component#HomeComponent', 'references')).toBe('module:home');
    expect(referenceNameTail('import:./about/about.component#default', 'references')).toBe('module:about');
    expect(referenceNameTail('layout:import:./admin/shell.component#ShellComponent', 'references')).toBe('module:shell');
  });

  it('keeps the tail of a reference that names no module', () => {
    // A layout named by its component, a module path of dots only, an import
    // name with no member, and an import itself.
    expect(referenceNameTail('layout:MainLayout', 'references')).toBe('MainLayout');
    expect(referenceNameTail('lazy-import:..', 'references')).not.toMatch(/^module:/);
    expect(referenceNameTail('import:./x', 'calls')).toBe('/x');
    expect(referenceNameTail('./pages/Team', 'imports')).toBe('Team');
    // The same names as another kind of reference are not a route's.
    expect(referenceNameTail('import:./home.component#HomeComponent', 'imports')).toBe('home');
    expect(referenceNameTail('lazy-import:./pages/Team', 'type_of')).toBe('/pages/Team');
  });
});

describe('moduleReferenceKeys', () => {
  it('gives a file the keys a module reference it could satisfy waits under', () => {
    expect(moduleReferenceKeys('src/pages/Team.tsx')).toEqual(['module:pages', 'module:Team.tsx', 'module:Team']);
    expect(moduleReferenceKeys('src/pages/Settings/index.tsx')).toEqual(['module:Settings', 'module:index.tsx', 'module:index']);
    expect(moduleReferenceKeys('src/app/home/home.component.ts')).toEqual(['module:home', 'module:home.component.ts']);
  });
});

describe('schema v14', () => {
  function fixture(): QueryBuilder {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-module-'));
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({ id: 'r', kind: 'route', name: '/team', qualifiedName: 'src/router.tsx::route:/team', filePath: 'src/router.tsx',
      language: 'tsx', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 });
    for (const [referenceName, referenceKind, status, tail] of [
      ['lazy-import:./pages/Team', 'references', 'failed', '/pages/Team'],
      ['layout:lazy-import:./layouts/Shell', 'references', 'failed', '/layouts/Shell'],
      ['lazy-import:./pages/About.tsx', 'references', 'failed', 'About.tsx'],
      ['import:@/views/Login#Login', 'calls', 'failed', '@/views/Login#Login'],
      ['layout:import:@/layout/index.vue#index', 'references', 'failed', 'vue#index'],
      ['import:./home/home.component#HomeComponent', 'references', 'failed', 'component#HomeComponent'],
      // Only a failed row is looked up by its tail.
      ['lazy-import:./pages/Docs', 'references', 'pending', ''],
      ['layout:MainLayout', 'references', 'failed', 'MainLayout'],
      ['snippets/price.liquid', 'references', 'failed', 'price.liquid'],
      ['./pages/Team', 'imports', 'failed', 'Team'],
      ['Team', 'calls', 'failed', 'Team'],
    ] as const) {
      queries.insertUnresolvedRef({ fromNodeId: 'r', referenceName, referenceKind, line: 1, column: 0, filePath: 'src/router.tsx', language: 'tsx' });
      db.getDb().prepare('UPDATE unresolved_refs SET status = ?, name_tail = ? WHERE reference_name = ?').run(status, tail, referenceName);
    }
    return queries;
  }

  const tails = () => db!.getDb().prepare('SELECT reference_name AS name, name_tail AS tail FROM unresolved_refs ORDER BY id').all();

  it('rewrites the tail of a module reference parked by an older version, and replays cleanly', () => {
    fixture();
    db!.getDb().exec(`DELETE FROM schema_versions WHERE version >= 14;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (13, 0, 'legacy fixture');`);
    db!.close();
    db = DatabaseConnection.open(path.join(root!, 'test.db'));
    expect(getCurrentVersion(db.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    const migrated = tails();
    expect(migrated).toEqual([
      { name: 'lazy-import:./pages/Team', tail: 'module:Team' },
      { name: 'layout:lazy-import:./layouts/Shell', tail: 'module:Shell' },
      { name: 'lazy-import:./pages/About.tsx', tail: 'module:About' },
      { name: 'import:@/views/Login#Login', tail: 'module:Login' },
      { name: 'layout:import:@/layout/index.vue#index', tail: 'module:index' },
      { name: 'import:./home/home.component#HomeComponent', tail: 'module:home' },
      { name: 'lazy-import:./pages/Docs', tail: '' },
      { name: 'layout:MainLayout', tail: 'MainLayout' },
      { name: 'snippets/price.liquid', tail: 'price.liquid' },
      { name: './pages/Team', tail: 'Team' },
      { name: 'Team', tail: 'Team' },
    ]);

    // A module reference waits for a file that could be the module, not for
    // a symbol: `Team` is the tail of the import and the call, not of the route.
    const queries = new QueryBuilder(db.getDb());
    const retried = (names: string[]) => queries.getRetryableFailedReferences(names).map((ref) => ref.referenceName).sort();
    expect(retried(moduleReferenceKeys('src/pages/Team.tsx'))).toEqual(['lazy-import:./pages/Team']);
    expect(retried(moduleReferenceKeys('src/app/home/home.component.ts'))).toEqual(['import:./home/home.component#HomeComponent']);
    expect(retried(['Team', 'home', 'index'])).toEqual(['./pages/Team', 'Team']);

    db.getDb().exec('DELETE FROM schema_versions WHERE version >= 14');
    runMigrations(db.getDb(), 13);
    expect(tails()).toEqual(migrated);
  });

  it('reads only the references its prefixes name, not every failed one', () => {
    fixture();
    const prepare = vi.spyOn(db!.getDb(), 'prepare');
    db!.getDb().exec('DELETE FROM schema_versions WHERE version >= 14');
    runMigrations(db!.getDb(), 13);
    const select = prepare.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes("GLOB 'lazy-import:*'"));
    prepare.mockRestore();
    const plan = db!.getDb().prepare(`EXPLAIN QUERY PLAN ${select}`).all().map((row) => (row as { detail: string }).detail).join('; ');
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_unresolved_name/);
    expect(plan).not.toMatch(/idx_unresolved_status|SCAN unresolved_refs/);
  });
});
