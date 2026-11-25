/**
 * `import { default as X } from './x'` is the module's default import, spelled
 * as a named one. The import mapping recorded it as a named import of an
 * export called `default`, which no module declares, so a call, a route or a
 * JSX attribute naming `X` never resolved through the import. It fell through
 * to matching the name alone, which can bind another file's `X`, and binds
 * nothing (or a stranger) when the default export has a name of its own.
 * bulletproof-react's router imports its app shell this way:
 * `import { default as AppRoot, ErrorBoundary as AppRootErrorBoundary } from
 * './routes/app/root'`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings } from '../src/resolution/import-resolver';
import type { Edge } from '../src/types';

const mappings = (source: string, language: Parameters<typeof extractImportMappings>[2] = 'tsx') =>
  extractImportMappings('src/a.tsx', source, language).map(
    (m) => `${m.localName}<${m.exportedName}${m.isDefault ? ' default' : ''}${m.isNamespace ? ' ns' : ''}`
  );

describe('`{ default as X }` maps to the default import', () => {
  it('beside a named import, across lines, with a trailing comma', () => {
    expect(mappings(`import {\n  default as AppRoot,\n  ErrorBoundary as AppRootErrorBoundary,\n} from './routes/app/root';\n`)).toEqual([
      'AppRoot<default default',
      'AppRootErrorBoundary<ErrorBoundary',
    ]);
  });

  it('alone, type-only, and next to a default binding', () => {
    expect(mappings(`import { default as Settings } from './settings';\n`)).toEqual(['Settings<default default']);
    expect(mappings(`import type { default as Config } from './config';\n`)).toEqual(['Config<default default']);
    expect(mappings(`import { type default as Config } from './config';\n`)).toEqual(['Config<default default']);
    expect(mappings(`import Main, { default as Again, helper } from './main';\n`)).toEqual([
      'Main<default default',
      'Again<default default',
      'helper<helper',
    ]);
  });

  it('only for the export named exactly `default`', () => {
    expect(mappings(`import { defaults as d, defaultTheme as theme } from './theme';\n`)).toEqual([
      'd<defaults',
      'theme<defaultTheme',
    ]);
  });

  it('in a Svelte or Vue script block too', () => {
    const sfc = `<script>\n  import { default as Card } from './Card.svelte';\n</script>\n\n<Card />\n`;
    expect(mappings(sfc, 'svelte')).toEqual(['Card<default default']);
    expect(mappings(sfc, 'vue')).toEqual(['Card<default default']);
  });
});

describe('a symbol imported as `{ default as X }`', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-default-as-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18', 'react-router': '^7' } }),
      // bulletproof-react's shape: the default export is a const declared
      // above it, beside a named ErrorBoundary.
      'src/app/routes/app/root.tsx': `import { Outlet } from 'react-router';

export const ErrorBoundary = () => {
  return <div>Something went wrong!</div>;
};

const AppRoot = () => {
  return (
    <main>
      <Outlet />
    </main>
  );
};

export default AppRoot;
`,
      // A default export imported under a name that is not its own.
      'src/app/routes/app/settings.tsx': `export default function SettingsRoute() {
  return <section>settings</section>;
}
`,
      'src/components/card.tsx': `import { memo } from 'react';

const Card = memo(() => <div className="card" />);

export default Card;
`,
      'src/components/layout.tsx': `export function Layout({ sidebar, children }: { sidebar: unknown; children: unknown }) {
  return <div>{children}</div>;
}
`,
      // Other symbols with the importing file's local names. Matching by name
      // alone can only choose between these and the real targets.
      'src/app/legacy.tsx': `export function AppRoot() {
  return <div>legacy shell</div>;
}

export function Settings() {
  return <div>legacy settings</div>;
}
`,
      'src/app/router.tsx': `import { createBrowserRouter } from 'react-router';

import {
  default as AppRoot,
  ErrorBoundary as AppRootErrorBoundary,
} from './routes/app/root';
import { default as Settings } from './routes/app/settings';

export const createAppRouter = () =>
  createBrowserRouter([
    {
      path: '/app',
      element: <AppRoot />,
      ErrorBoundary: AppRootErrorBoundary,
      children: [{ path: 'settings', Component: Settings }],
    },
  ]);

export function renderShell() {
  return AppRoot();
}
`,
      'src/app/AppRoutes.tsx': `import { Routes, Route } from 'react-router';

import { Layout } from '../components/layout';
import { default as Settings } from './routes/app/settings';
import { default as Tile } from '../components/card';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/preferences" element={<Settings />} />
    </Routes>
  );
}

export function Gallery() {
  return (
    <Layout sidebar={Settings}>
      <Tile />
    </Layout>
  );
}
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

  const node = (file: string, name: string) => {
    const found = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import');
    expect(found, `${file}: ${name}`).toBeDefined();
    return found!;
  };
  /** The edges into `target`, as `kind source-name resolvedBy`. */
  const into = (target: { id: string }, kinds: Edge['kind'][]) =>
    cg
      .getIncomingEdges(target.id)
      .filter((e) => kinds.includes(e.kind))
      .map((e) => {
        const meta = (e.metadata ?? {}) as { resolvedBy?: string; synthesizedBy?: string };
        return `${e.kind} ${cg.getNode(e.source)!.name} ${meta.resolvedBy ?? meta.synthesizedBy}`;
      })
      .sort();
  const route = (name: string) => {
    const found = cg.getNodesByKind('route').find((r) => r.name === name);
    expect(found, `route ${name}`).toBeDefined();
    return found!;
  };
  const renders = (name: string) =>
    cg
      .getOutgoingEdges(route(name).id)
      .filter((e) => e.kind === 'references')
      .map((e) => {
        const target = cg.getNode(e.target)!;
        return `${target.filePath}:${target.name} ${(e.metadata as { resolvedBy?: string }).resolvedBy}`;
      })
      .sort();

  it('a call reaches the module’s default export through the import', () => {
    expect(into(node('src/app/routes/app/root.tsx', 'AppRoot'), ['calls'])).toEqual([
      'calls createAppRouter jsx-render',
      'calls renderShell import',
    ]);
    expect(into(node('src/app/legacy.tsx', 'AppRoot'), ['calls', 'references'])).toEqual([]);
  });

  it('a data router’s `element` and `Component` render the default exports', () => {
    expect(renders('/app')).toEqual(['src/app/routes/app/root.tsx:AppRoot import']);
    // A child route renders inside its parent's element, its layout.
    expect(renders('/app/settings')).toEqual([
      'src/app/routes/app/root.tsx:AppRoot framework',
      'src/app/routes/app/settings.tsx:SettingsRoute import',
    ]);
  });

  it('a JSX route and a JSX attribute name the default export', () => {
    expect(renders('/preferences')).toEqual(['src/app/routes/app/settings.tsx:SettingsRoute import']);
    // The router's `Component: Settings` is a function reference as well.
    expect(into(node('src/app/routes/app/settings.tsx', 'SettingsRoute'), ['references'])).toEqual([
      'references /app/settings import',
      'references /preferences import',
      'references Gallery import',
      'references createAppRouter import',
    ]);
    expect(into(node('src/app/legacy.tsx', 'Settings'), ['references'])).toEqual([]);
  });

  it('a JSX tag renders the default-exported component it was imported as', () => {
    expect(into(node('src/components/card.tsx', 'Card'), ['calls'])).toEqual(['calls Gallery jsx-render']);
  });

  it('the named import beside it is unchanged', () => {
    expect(into(node('src/app/routes/app/root.tsx', 'ErrorBoundary'), ['references'])).toEqual([
      'references createAppRouter import',
    ]);
  });

  it('the import binding links the module, as a default import’s does', () => {
    const file = cg.getNodesInFile('src/app/router.tsx').find((n) => n.kind === 'file')!;
    const bindings = cg
      .getOutgoingEdges(file.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => {
        const meta = e.metadata as { refName?: string; resolvedBy?: string };
        const target = cg.getNode(e.target)!;
        return `${meta.refName} → ${target.kind} ${target.filePath} ${meta.resolvedBy}`;
      })
      .filter((s) => !s.startsWith('.'))
      .sort();
    expect(bindings).toEqual([
      'AppRoot → file src/app/routes/app/root.tsx import',
      'AppRootErrorBoundary → function src/app/routes/app/root.tsx import',
      'Settings → file src/app/routes/app/settings.tsx import',
    ]);
  });
});
