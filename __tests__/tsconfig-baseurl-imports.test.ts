/**
 * Bare specifiers that name a project file through the importing app's own
 * tsconfig / jsconfig: a `baseUrl` with no `paths` (berry, matx) or a
 * catch-all `"*": ["./src/*"]` (mantis). CRA and Vite admin templates write
 * nearly every cross-file import this way (`import MainLayout from
 * 'layout/MainLayout'`), and each one used to be taken for an npm package:
 * the import stayed unresolved and its names linked by bare-name matching,
 * often into another app of the same repository.
 *
 * Locked in:
 *  - the importing app's own config decides (two apps, two baseUrls)
 *  - only an indexed file binds; a specifier that names none stays unresolved
 *  - a package the app's package.json declares, or a Node built-in, never
 *    binds to a same-named project folder or file, also under a root `"*"`
 *  - a route's `lazy(() => import('views/x'))` renders `views/x/index.jsx`,
 *    and the layout around it links through the same kind of import
 *  - a class extending one imported this way keeps its `extends` edge
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveImportPath } from '../src/resolution/import-resolver';
import type { AliasMap } from '../src/resolution/path-aliases';
import type { ResolutionContext } from '../src/resolution';

const ROOT = path.join(os.tmpdir(), 'cg-baseurl-stub');

function stubContext(files: string[], opts: {
  nearest?: (fromFile: string) => AliasMap | null;
  project?: AliasMap | null;
  declared?: string[];
  noPackageCheck?: boolean;
}): ResolutionContext {
  const set = new Set(files);
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (p: string) => set.has(p),
    readFile: () => null,
    getProjectRoot: () => ROOT,
    getAllFiles: () => files,
    getImportMappings: () => [],
    getNearestAliases: opts.nearest ?? (() => null),
    getProjectAliases: () => opts.project ?? null,
    ...(opts.noPackageCheck ? {} : { isDeclaredPackage: (source: string) => (opts.declared ?? []).includes(source.split('/')[0]!) }),
  } as unknown as ResolutionContext;
}

const baseUrlOnly = (dir: string): AliasMap => ({ baseUrl: path.join(ROOT, dir), declaresBaseUrl: true, patterns: [] });

describe('resolving a bare specifier through the app’s own config', () => {
  it('reads a nested app’s baseUrl, down to an index.jsx (berry)', () => {
    const files = ['vite/src/routes/MainRoutes.jsx', 'vite/src/layout/MainLayout/index.jsx', 'vite/src/views/dashboard/Default/index.jsx'];
    const ctx = stubContext(files, { nearest: (f) => (f.startsWith('vite/') ? baseUrlOnly('vite/src') : null) });
    expect(resolveImportPath('layout/MainLayout', 'vite/src/routes/MainRoutes.jsx', 'jsx', ctx)).toBe('vite/src/layout/MainLayout/index.jsx');
    // A route table resolves a lazily loaded module as TypeScript, whatever it is written in.
    expect(resolveImportPath('views/dashboard/Default', 'vite/src/routes/MainRoutes.jsx', 'typescript', ctx)).toBe('vite/src/views/dashboard/Default/index.jsx');
  });

  it('reads a catch-all "*" from the config’s directory (mantis)', () => {
    const star: AliasMap = {
      baseUrl: path.join(ROOT, 'vite'),
      declaresBaseUrl: false,
      patterns: [{ prefix: '', suffix: '', hasWildcard: true, replacements: ['./src/*'] }],
    };
    const ctx = stubContext(['vite/src/routes/LoginRoutes.jsx', 'vite/src/pages/auth/Register.jsx'], { nearest: () => star });
    expect(resolveImportPath('pages/auth/Register', 'vite/src/routes/LoginRoutes.jsx', 'jsx', ctx)).toBe('vite/src/pages/auth/Register.jsx');
  });

  it('reads the root jsconfig when no nearer config has one (matx)', () => {
    const ctx = stubContext(['src/app/routes.jsx', 'src/app/views/dashboard/Analytics.jsx'], { project: baseUrlOnly('src') });
    expect(resolveImportPath('app/views/dashboard/Analytics', 'src/app/routes.jsx', 'jsx', ctx)).toBe('src/app/views/dashboard/Analytics.jsx');
  });

  it('uses the importing app’s baseUrl, not another app’s', () => {
    const files = ['vite/src/views/Page.jsx', 'vite/src/utils/format.js', 'remix/app/routes/index.jsx', 'remix/app/utils/format.js'];
    const ctx = stubContext(files, {
      nearest: (f) => (f.startsWith('vite/') ? baseUrlOnly('vite/src') : f.startsWith('remix/') ? baseUrlOnly('remix/app') : null),
    });
    expect(resolveImportPath('utils/format', 'vite/src/views/Page.jsx', 'jsx', ctx)).toBe('vite/src/utils/format.js');
    expect(resolveImportPath('utils/format', 'remix/app/routes/index.jsx', 'jsx', ctx)).toBe('remix/app/utils/format.js');
  });

  it('never binds a declared package to a same-named project folder', () => {
    const files = ['src/hooks/useSearch.js', 'src/lodash/index.js'];
    expect(resolveImportPath('lodash', 'src/hooks/useSearch.js', 'javascript', stubContext(files, { project: baseUrlOnly('src'), declared: ['lodash'] }))).toBeNull();
    // Only the declaration keeps it out: the same folder is the project's when nothing declares `lodash`.
    expect(resolveImportPath('lodash', 'src/hooks/useSearch.js', 'javascript', stubContext(files, { project: baseUrlOnly('src') }))).toBe('src/lodash/index.js');
    // A context that cannot tell packages apart resolves nothing this way.
    expect(resolveImportPath('lodash', 'src/hooks/useSearch.js', 'javascript', stubContext(files, { project: baseUrlOnly('src'), noPackageCheck: true }))).toBeNull();
  });

  it('lets a declared package reach a declaration file the project keeps for it, never a module', () => {
    // cord-field's shape: `"*": ["./typings/*"]` holds types for untyped packages.
    const typings: AliasMap = {
      baseUrl: path.join(ROOT, 'src'),
      declaresBaseUrl: true,
      patterns: [{ prefix: '', suffix: '', hasWildcard: true, replacements: ['./typings/*'] }],
    };
    const files = ['src/scenes/Page.tsx', 'src/typings/legacy-widgets.d.ts', 'src/axios/index.ts'];
    const ctx = stubContext(files, { project: typings, declared: ['legacy-widgets', 'axios'] });
    expect(resolveImportPath('legacy-widgets', 'src/scenes/Page.tsx', 'tsx', ctx)).toBe('src/typings/legacy-widgets.d.ts');
    // `baseUrl` reads `src/axios/index.ts`, the app's own wrapper: the package stays the package.
    expect(resolveImportPath('axios', 'src/scenes/Page.tsx', 'tsx', ctx)).toBeNull();
  });

  it('leaves a specifier that names no project file unresolved', () => {
    const ctx = stubContext(['src/App.jsx'], { project: baseUrlOnly('src') });
    expect(resolveImportPath('react', 'src/App.jsx', 'jsx', ctx)).toBeNull();
    expect(resolveImportPath('virtual:pwa-register', 'src/App.jsx', 'jsx', ctx)).toBeNull();
  });

  it('binds only a file the index holds, not a folder or node_modules on disk', () => {
    // `fileExists` falls back to the disk: true for `src/assets` (a folder) and
    // for a package installed under a `"*"` target like `node_modules/*`.
    const onDisk = new Set(['src/App.jsx', 'src/assets', 'node_modules/history/index.js']);
    const indexed = new Set(['src/App.jsx']);
    const star: AliasMap = {
      baseUrl: ROOT,
      declaresBaseUrl: true,
      patterns: [{ prefix: '', suffix: '', hasWildcard: true, replacements: ['src/*', 'node_modules/*'] }],
    };
    const ctx = {
      ...stubContext([...indexed], { project: star }),
      fileExists: (p: string) => onDisk.has(p),
      isIndexedFile: (p: string) => indexed.has(p),
    } as unknown as ResolutionContext;
    expect(resolveImportPath('assets', 'src/App.jsx', 'jsx', ctx)).toBeNull();
    expect(resolveImportPath('history', 'src/App.jsx', 'jsx', ctx)).toBeNull();
  });

  it('does not read bare specifiers from a config with paths but no baseUrl', () => {
    const atOnly: AliasMap = {
      baseUrl: ROOT,
      declaresBaseUrl: false,
      patterns: [{ prefix: '@/', suffix: '', hasWildcard: true, replacements: ['./src/*'] }],
    };
    const ctx = stubContext(['src/App.jsx', 'components/Button.jsx', 'src/components/Button.jsx'], { project: atOnly });
    expect(resolveImportPath('components/Button', 'src/App.jsx', 'jsx', ctx)).toBeNull();
    expect(resolveImportPath('@/components/Button', 'src/App.jsx', 'jsx', ctx)).toBe('src/components/Button.jsx');
  });

  it('maps a rooted specifier through paths, as tsc does (bigbluebutton’s "/*": ["*"])', () => {
    const rooted: AliasMap = {
      baseUrl: path.join(ROOT, 'bigbluebutton-html5'),
      declaresBaseUrl: true,
      patterns: [{ prefix: '/', suffix: '', hasWildcard: true, replacements: ['*'] }],
    };
    const from = 'bigbluebutton-html5/imports/ui/components/button/styles.js';
    const ctx = stubContext([from, 'bigbluebutton-html5/imports/ui/components/common/icon/component.jsx'], {
      nearest: (f) => (f.startsWith('bigbluebutton-html5/') ? rooted : null),
    });
    expect(resolveImportPath('/imports/ui/components/common/icon/component', from, 'javascript', ctx))
      .toBe('bigbluebutton-html5/imports/ui/components/common/icon/component.jsx');
  });

  it('never reads a rooted specifier from baseUrl, and leaves a protocol-relative one alone', () => {
    const ctx = stubContext(['app/main.js', 'app/imports/ui/icon.js', 'app/cdn.example.com/lib.js'], { nearest: () => baseUrlOnly('app') });
    expect(resolveImportPath('/imports/ui/icon', 'app/main.js', 'javascript', ctx)).toBeNull();
    expect(resolveImportPath('//cdn.example.com/lib', 'app/main.js', 'javascript', ctx)).toBeNull();
  });
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

describe('two admin apps with their own baseUrl (berry shape)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseurl-apps-'));
    writeTree(root, {
      'package.json': JSON.stringify({ name: 'admin-templates', private: true }),
      'vite/package.json': JSON.stringify({ name: 'vite-app', dependencies: { react: '^18', 'react-router-dom': '^6', lodash: '^4' } }),
      'vite/jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src', jsx: 'react-jsx' } }),
      'vite/src/routes/index.jsx': `import { createBrowserRouter } from 'react-router-dom';
import MainRoutes from './MainRoutes';

const router = createBrowserRouter([MainRoutes]);

export default router;
`,
      'vite/src/routes/MainRoutes.jsx': `import { lazy } from 'react';

import MainLayout from 'layout/MainLayout';
import Loadable from 'ui-component/Loadable';

const DashboardDefault = Loadable(lazy(() => import('views/dashboard/Default')));

const MainRoutes = {
  path: '/',
  element: <MainLayout />,
  children: [
    {
      path: 'dashboard',
      element: <DashboardDefault />
    }
  ]
};

export default MainRoutes;
`,
      'vite/src/layout/MainLayout/index.jsx': `export default function MainLayout() {
  return <main />;
}
`,
      'vite/src/ui-component/Loadable.jsx': `export default function Loadable(Component) {
  return (props) => <Component {...props} />;
}
`,
      'vite/src/views/dashboard/Default/index.jsx': `import { formatDate } from 'utils/format';

export default function Dashboard() {
  return <section>{formatDate(new Date())}</section>;
}
`,
      'vite/src/utils/format.js': `export function formatDate(d) {
  return String(d);
}
`,
      // A one-segment specifier, and a binding named like another module.
      'vite/src/config.js': `export const DEFAULT_THEME_MODE = 'system';
export const themes = ['light', 'dark'];
`,
      'vite/src/themes/index.jsx': `export default function ThemeCustomization({ children }) {
  return children;
}
`,
      'vite/src/layout/Customization/index.jsx': `import { DEFAULT_THEME_MODE, themes } from 'config';

export default function Customization() {
  return themes.includes(DEFAULT_THEME_MODE);
}
`,
      // A folder named like a dependency, and a file named like a Node built-in.
      'vite/src/lodash/index.js': `export function debounce(fn) {
  return fn;
}
`,
      'vite/src/events.js': `export class EventEmitter {}
`,
      'vite/src/hooks/useSearch.js': `import { debounce } from 'lodash';
import { EventEmitter } from 'events';

export function useSearch() {
  return debounce(() => new EventEmitter());
}
`,
      'vite/src/components/BasePanel.js': `export default class BasePanel {}
`,
      'vite/src/components/Panel.js': `import BasePanel from 'components/BasePanel';

export class Panel extends BasePanel {}
`,
      'remix/package.json': JSON.stringify({ name: 'remix-app', dependencies: { react: '^18' } }),
      'remix/jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'app' } }),
      'remix/app/utils/format.js': `export function formatDate(d) {
  return d.toISOString();
}
`,
      'remix/app/routes/index.jsx': `import { formatDate } from 'utils/format';

export default function Index() {
  return formatDate(new Date());
}
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The files `file`'s nodes import, by path. */
  const importedFiles = (file: string): string[] =>
    cg.getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
      .filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!.filePath);

  /** What `file`'s import of `ref` (a module specifier or a binding) links to, as `kind:name@path`. */
  const importTargets = (file: string, ref: string): string[] =>
    cg.getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
      .filter((e) => e.kind === 'imports' && (e.metadata as Record<string, unknown> | undefined)?.refName === ref)
      .map((e) => `${cg.getNode(e.target)!.kind}:${cg.getNode(e.target)!.name}@${cg.getNode(e.target)!.filePath}`);

  const routeLinks = (name: string, layout: boolean): string[] => {
    const route = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!route) return [];
    return cg.getOutgoingEdges(route.id)
      .filter((e) => e.kind === 'references' && Boolean((e.metadata as Record<string, unknown> | undefined)?.layout) === layout)
      .map((e) => `${cg.getNode(e.target)!.name}@${cg.getNode(e.target)!.filePath}`);
  };

  it('links an import written from baseUrl to the file it names', () => {
    const file = 'vite/src/routes/MainRoutes.jsx';
    expect(importTargets(file, 'layout/MainLayout')).toEqual(['file:index.jsx@vite/src/layout/MainLayout/index.jsx']);
    expect(importTargets(file, 'ui-component/Loadable')).toEqual(['file:Loadable.jsx@vite/src/ui-component/Loadable.jsx']);
  });

  it('links a one-segment module, and reads a binding named like another module as the binding', () => {
    const file = 'vite/src/layout/Customization/index.jsx';
    expect(importTargets(file, 'config')).toEqual(['file:config.js@vite/src/config.js']);
    expect(importTargets(file, 'themes')).toEqual(['constant:themes@vite/src/config.js']);
    expect(importedFiles(file)).not.toContain('vite/src/themes/index.jsx');
  });

  it('calls the importing app’s own function, not the other app’s namesake', () => {
    const callees = (fn: string, file: string) => {
      const node = cg.getNodesInFile(file).find((n) => n.name === fn)!;
      return cg.getCallees(node.id).map((c) => c.node.filePath);
    };
    expect(callees('Dashboard', 'vite/src/views/dashboard/Default/index.jsx')).toContain('vite/src/utils/format.js');
    expect(callees('Dashboard', 'vite/src/views/dashboard/Default/index.jsx')).not.toContain('remix/app/utils/format.js');
    expect(callees('Index', 'remix/app/routes/index.jsx')).toContain('remix/app/utils/format.js');
    expect(callees('Index', 'remix/app/routes/index.jsx')).not.toContain('vite/src/utils/format.js');
  });

  it('renders a lazily loaded page and the layout around it', () => {
    expect(routeLinks('/dashboard', false)).toEqual(['Dashboard@vite/src/views/dashboard/Default/index.jsx']);
    expect(routeLinks('/dashboard', true)).toEqual(['MainLayout@vite/src/layout/MainLayout/index.jsx']);
  });

  it('keeps a declared package and a Node built-in out of same-named project files', () => {
    const imported = importedFiles('vite/src/hooks/useSearch.js');
    expect(imported).not.toContain('vite/src/lodash/index.js');
    expect(imported).not.toContain('vite/src/events.js');
  });

  it('keeps the extends edge of a class whose base is imported from baseUrl', () => {
    const panel = cg.getNodesInFile('vite/src/components/Panel.js').find((n) => n.name === 'Panel')!;
    const supers = cg.getOutgoingEdges(panel.id).filter((e) => e.kind === 'extends').map((e) => cg.getNode(e.target)!.filePath);
    expect(supers).toEqual(['vite/src/components/BasePanel.js']);
  });
});

describe('a root catch-all "*" beside a folder named like a dependency', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseurl-star-'));
    writeTree(root, {
      'package.json': JSON.stringify({ name: 'star-app', dependencies: { axios: '^1', react: '^18' } }),
      'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { '*': ['./src/*'] } } }),
      // The app's own configured client, in a folder named after the package it wraps.
      'src/axios/index.js': `import axios from 'axios';

const instance = axios.create({ baseURL: '/api' });

export default instance;
`,
      'src/components/Button.jsx': `export default function Button() {
  return <button />;
}
`,
      'src/App.jsx': `import axios from 'axios';
import Button from 'components/Button';

export default function App() {
  axios.get('/users');
  return <Button />;
}
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('resolves the project’s own module and leaves the dependency alone', () => {
    const ids = cg.getNodesInFile('src/App.jsx').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).toContain('src/components/Button.jsx');
    expect(targets).not.toContain('src/axios/index.js');
  });
});

/** What a sync must link once a module imported from `baseUrl` appears after its importers. */
const SYNC_IMPORTERS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'late-app', dependencies: { react: '^18' } }),
  'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
  // Bindings their modules never declare by that name: a default import, an
  // aliased import, a member of a named import, and a one-segment module.
  'src/call.js': "import runIt from 'handlers/run';\nexport function go() { return runIt(); }\n",
  'src/draw.js': "import { Widget as W } from 'widgets/Widget';\nexport function paint() { return new W(); }\n",
  'src/read.js': "import { store } from 'state/store';\nexport function read(k) { return store.get(k); }\n",
  'src/use-config.js': "import config from 'config';\nexport const port = config.port;\n",
};
const SYNC_MODULES: Record<string, string> = {
  'src/handlers/run.js': 'export default function handle() { return 1; }\n',
  'src/widgets/Widget.js': 'export class Widget {}\n',
  'src/state/store.js': 'export const store = { get(k) { return k; } };\n',
  'src/config.js': 'const config = { port: 3000 };\nexport default config;\n',
};
// The same, written from the app's root (bigbluebutton's `"/*": ["*"]`).
const ROOTED_IMPORTERS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'late-rooted-app', dependencies: { react: '^18' } }),
  'html5/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '/*': ['*'] } } }),
  'html5/imports/call.js': "import runIt from '/imports/handlers/run';\nexport function go() { return runIt(); }\n",
  'html5/imports/draw.js': "import { Widget as W } from '/imports/widgets/Widget';\nexport function paint() { return new W(); }\n",
};
const ROOTED_MODULES: Record<string, string> = {
  'html5/imports/handlers/run.js': 'export default function handle() { return 1; }\n',
  'html5/imports/widgets/Widget.js': 'export class Widget {}\n',
};

describe('a sync links an import read from baseUrl once its module appears', () => {
  const roots: string[] = [];
  const graphs: CodeGraph[] = [];

  afterAll(() => {
    for (const graph of graphs) graph.close();
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const indexed = async (files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseurl-sync-'));
    roots.push(root);
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);
    return { root, cg };
  };

  /** Every edge by its ends' natural keys, where it is written and how it resolved. */
  const edgesOf = (cg: CodeGraph): string[] => {
    const keys = new Map(
      cg.getFiles()
        .flatMap((file) => cg.getNodesInFile(file.path))
        .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
    );
    return cg.getOutgoingEdgesFrom([...keys.keys()])
      .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`)
      .sort();
  };

  it('matches a fresh index of the same files', async () => {
    const { root, cg } = await indexed(SYNC_IMPORTERS);
    writeTree(root, SYNC_MODULES);
    const result = await cg.sync();
    expect(result.filesAdded).toBe(Object.keys(SYNC_MODULES).length);
    expect(result.filesModified).toBe(0);

    const fresh = await indexed({ ...SYNC_IMPORTERS, ...SYNC_MODULES });
    const freshEdges = edgesOf(fresh.cg);
    // The fresh index links every binding through its module.
    expect(freshEdges.some((e) => e.startsWith('calls function src/call.js:go') && e.includes('-> function src/handlers/run.js:handle'))).toBe(true);
    expect(freshEdges.some((e) => e.startsWith('instantiates function src/draw.js:paint') && e.includes('-> class src/widgets/Widget.js:Widget'))).toBe(true);
    expect(freshEdges.some((e) => e.includes('src/use-config.js') && e.includes('-> file src/config.js'))).toBe(true);
    expect(edgesOf(cg)).toEqual(freshEdges);
  }, 120_000);

  it('matches a fresh index for rooted imports the app maps through paths', async () => {
    const { root, cg } = await indexed(ROOTED_IMPORTERS);
    writeTree(root, ROOTED_MODULES);
    const result = await cg.sync();
    expect(result.filesAdded).toBe(Object.keys(ROOTED_MODULES).length);

    const fresh = await indexed({ ...ROOTED_IMPORTERS, ...ROOTED_MODULES });
    const freshEdges = edgesOf(fresh.cg);
    expect(freshEdges.some((e) => e.startsWith('calls function html5/imports/call.js:go') && e.includes('-> function html5/imports/handlers/run.js:handle'))).toBe(true);
    expect(freshEdges.some((e) => e.startsWith('instantiates function html5/imports/draw.js:paint') && e.includes('-> class html5/imports/widgets/Widget.js:Widget'))).toBe(true);
    expect(edgesOf(cg)).toEqual(freshEdges);
  }, 120_000);

  it('matches a fresh index when an edit gives the module what its importers import', async () => {
    const stubs = Object.fromEntries(Object.keys(SYNC_MODULES).map((file) => [file, 'export const placeholder = 1;\n']));
    const { root, cg } = await indexed({ ...SYNC_IMPORTERS, ...stubs });
    writeTree(root, SYNC_MODULES);
    const result = await cg.sync();
    expect(result.filesModified).toBe(Object.keys(SYNC_MODULES).length);
    expect(result.filesAdded).toBe(0);

    const fresh = await indexed({ ...SYNC_IMPORTERS, ...SYNC_MODULES });
    expect(edgesOf(cg)).toEqual(edgesOf(fresh.cg));
  }, 120_000);
});

describe('rooted imports an app maps through its own tsconfig paths (bigbluebutton shape)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rooted-paths-'));
    writeTree(root, {
      'package.json': JSON.stringify({ name: 'bigbluebutton', private: true }),
      'bigbluebutton-html5/package.json': JSON.stringify({ name: 'bbb-html5', dependencies: { react: '^18', 'styled-components': '^5' } }),
      // JSONC, a block comment beside a "/*" pattern, as bigbluebutton writes it.
      'bigbluebutton-html5/tsconfig.json': `{
  "compilerOptions": {
    /* Module Resolution Options */
    "baseUrl": ".",
    "paths": {
      /* Support absolute /imports/* with a leading '/' */
      "/*": ["*"]
    }
  }
}
`,
      'bigbluebutton-html5/imports/ui/components/common/icon/component.jsx': `const Icon = ({ iconName }) => <i className={iconName} />;
export default Icon;
`,
      'bigbluebutton-html5/imports/utils/format.js': `export function formatTime(time) {
  return String(time);
}
`,
      // A namesake that a name match takes.
      'bigbluebutton-html5/imports/ui/components/audio/styles.js': `import styled from 'styled-components';
const Icon = styled.i\`\`;
export default { Icon };
`,
      'bigbluebutton-html5/imports/ui/components/timer/component.jsx': `import Icon from '/imports/ui/components/common/icon/component';
import { formatTime } from '/imports/utils/format';
export default function Timer({ time }) {
  return <Icon iconName={formatTime(time)} />;
}
`,
      'bigbluebutton-html5/imports/ui/components/button/styles.js': `import styled from 'styled-components';
import Icon from '/imports/ui/components/common/icon/component';
const ButtonIcon = styled(Icon)\`\`;
export default { ButtonIcon };
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const ICON = 'bigbluebutton-html5/imports/ui/components/common/icon/component.jsx';
  const TIMER = 'bigbluebutton-html5/imports/ui/components/timer/component.jsx';

  /** `kind` edges out of `file`'s nodes, as `name -> name@path`. */
  const edgesOut = (file: string, kind: string): string[] =>
    cg.getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
      .filter((e) => e.kind === kind)
      .map((e) => `${cg.getNode(e.source)!.name} -> ${cg.getNode(e.target)!.name}@${cg.getNode(e.target)!.filePath}`);

  it('links the module a rooted import names', () => {
    expect(edgesOut(TIMER, 'imports')).toContain(`component.jsx -> component.jsx@${ICON}`);
    expect(edgesOut(TIMER, 'imports')).toContain('component.jsx -> format.js@bigbluebutton-html5/imports/utils/format.js');
  });

  it('renders and calls what the rooted import binds, not a namesake', () => {
    const calls = edgesOut(TIMER, 'calls');
    expect(calls).toContain(`Timer -> Icon@${ICON}`);
    expect(calls).not.toContain('Timer -> Icon@bigbluebutton-html5/imports/ui/components/audio/styles.js');
    expect(calls).toContain('Timer -> formatTime@bigbluebutton-html5/imports/utils/format.js');
  });

  it('links a styled wrapper of a rooted import to the component it wraps', () => {
    expect(edgesOut('bigbluebutton-html5/imports/ui/components/button/styles.js', 'calls')).toContain(`ButtonIcon -> Icon@${ICON}`);
  });
});
