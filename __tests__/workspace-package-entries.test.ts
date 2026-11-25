/**
 * Issues #2456 and #2502: a package of the repository is imported by its name,
 * and that import has to land on the file the package's manifest names.
 *
 * - #2502: a pnpm (or npm/yarn/bun) workspace member that declares its entry
 *   with `main` / `module` / `types` or an `exports` map, like
 *   `"main": "./src/index.ts"`, had no `index.*` at its root, so
 *   `import { caseStatus } from '@acme/core'` failed and its calls fell back to
 *   name matching: a same-named private function nearer the caller took them.
 * - #2456: a sibling package an npm `file:` dependency points at, with no root
 *   `workspaces`, was not known as a package at all.
 *
 * A declared entry that names build output the index does not hold (`dist/`)
 * is read as the source it is built from when the mapping is clear
 * (`dist/index.js` → `src/index.ts`), and otherwise links nothing new.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function write(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-entries-'));
  roots.push(root);
  write(root, files);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** The files `file`'s import statements link it to. */
function moduleImports(graph: CodeGraph, file: string): string[] {
  const out = new Set<string>();
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'imports') continue;
      const target = graph.getNode(e.target)!;
      if (target.kind === 'file') out.add(target.filePath);
    }
  }
  return [...out].sort();
}

/** `name@file` of every call `file` makes. */
function callsFrom(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      out.push(`${target.name}@${target.filePath}`);
    }
  }
  return out.sort();
}

/** A pnpm workspace whose `@acme/core` member has the given manifest. */
function pnpm(core: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'repo', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', ...core }),
    'packages/core/src/index.ts': 'export function coreFn(): number { return 1; }\n',
    'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/core': 'workspace:*' } }),
    'apps/web/main.ts': "import { coreFn } from '@acme/core';\nexport const run = () => coreFn();\n",
    ...extra,
  };
}

describe('a workspace member imported by name lands on the entry its manifest declares (#2502)', () => {
  it.each([
    ['main', { main: './src/index.ts' }],
    ['module', { module: './src/index.ts' }],
    ['types', { types: './src/index.ts' }],
    ['a string `exports`', { exports: './src/index.ts' }],
    ['`exports["."]`', { exports: { '.': './src/index.ts' } }],
    ['conditions straight under `exports`', { exports: { types: './dist/index.d.ts', import: './src/index.ts' } }],
  ])('through %s', async (_label, manifest) => {
    const graph = await index(pnpm(manifest));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    expect(callsFrom(graph, 'apps/web/main.ts')).toContain('coreFn@packages/core/src/index.ts');
  }, 120_000);

  it('through conditions, nested ones included, whichever the index holds', async () => {
    // `types` and `require` name build output; the source sits under `import` → `default`.
    const exports = {
      '.': {
        types: './dist/index.d.ts',
        import: { types: './dist/index.d.mts', default: './src/index.ts' },
        require: './dist/index.cjs',
      },
    };
    const graph = await index(pnpm({ exports }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it("through the condition its importers resolve by, read as its source, before a custom condition's source", async () => {
    // @wdio/logger's layout: `import` names build output, `browserSource` a browser-only source file.
    const exports = {
      '.': {
        browserSource: './src/browser.ts',
        browser: './build/browser.js',
        types: './build/index.d.ts',
        import: './build/index.js',
        require: './build/index.cjs',
      },
    };
    const graph = await index(pnpm({ exports }, {
      'packages/core/src/browser.ts': 'export function coreFn(): number { return 5; }\n',
    }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('through the implementation a condition names before a declaration file', async () => {
    const graph = await index(pnpm({ exports: { '.': { types: './src/index.d.ts', import: './src/index.ts' } } }, {
      'packages/core/src/index.d.ts': 'export declare function coreFn(): number;\n',
    }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('never through build output that is on disk but not indexed', async () => {
    // A local build left `dist/` behind; `.gitignore` keeps it out of the index.
    const graph = await index(pnpm({ main: './dist/index.js' }, {
      '.gitignore': 'dist/\n',
      'packages/core/dist/index.js': 'exports.coreFn = function () { return 1; };\n',
    }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('through a subpath export and a `./*` pattern', async () => {
    const graph = await index(pnpm(
      { exports: { '.': './src/index.ts', './utils': './src/utils.ts', './schema/*': { import: './src/schema/*.ts' } } },
      {
        'packages/core/src/utils.ts': 'export function trim(s: string): string { return s.trim(); }\n',
        'packages/core/src/schema/case.ts': "export const caseTable = 'case';\n",
        'apps/web/text.ts': "import { trim } from '@acme/core/utils';\nexport const clean = (s: string) => trim(s);\n",
        'apps/web/table.ts': "import { caseTable } from '@acme/core/schema/case';\nexport const tableName = () => caseTable;\n",
      },
    ));
    expect(moduleImports(graph, 'apps/web/text.ts')).toEqual(['packages/core/src/utils.ts']);
    expect(callsFrom(graph, 'apps/web/text.ts')).toContain('trim@packages/core/src/utils.ts');
    expect(moduleImports(graph, 'apps/web/table.ts')).toEqual(['packages/core/src/schema/case.ts']);
  }, 120_000);

  it('through build output the index lacks, read as the source it is built from', async () => {
    const graph = await index(pnpm({
      main: './dist/cjs/index.cjs',
      types: './dist/types/index.d.ts',
      exports: { '.': { import: './dist/esm/index.mjs', require: './dist/cjs/index.cjs' }, './utils': './dist/utils.js' },
    }, {
      'packages/core/src/utils.ts': 'export function trim(s: string): string { return s.trim(); }\n',
      'apps/web/text.ts': "import { trim } from '@acme/core/utils';\nexport const clean = (s: string) => trim(s);\n",
    }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    expect(moduleImports(graph, 'apps/web/text.ts')).toEqual(['packages/core/src/utils.ts']);
  }, 120_000);

  it('through a path into its build output, read as the source it is built from', async () => {
    // memfs's layout: `import { … } from '@jsonjoy.com/fs-node-utils/lib/types/misc'` is
    // `lib/types/misc.js`, built from `src/types/misc.ts`. A local build on disk changes nothing.
    const graph = await index(pnpm({ main: './lib/index.js' }, {
      '.gitignore': 'lib/\n',
      'packages/core/lib/strings.js': 'exports.trim = function (s) { return s; };\n',
      'packages/core/src/strings.ts': 'export function trim(s: string): string { return s.trim(); }\n',
      'packages/core/src/types/misc.ts': 'export type Encoding = string;\n',
      'apps/web/text.ts':
        "import { trim } from '@acme/core/lib/strings';\nimport type { Encoding } from '@acme/core/lib/types/misc';\nexport const clean = (s: string, e: Encoding) => trim(s) + e;\n",
    }));
    expect(moduleImports(graph, 'apps/web/text.ts')).toEqual(['packages/core/src/strings.ts', 'packages/core/src/types/misc.ts']);
    expect(callsFrom(graph, 'apps/web/text.ts')).toEqual(['trim@packages/core/src/strings.ts']);
  }, 120_000);

  it('through the source tree a build folder mirrors before the folder read as a build format', async () => {
    // Vite's layout: `dist/node/index.js` is built from `src/node/index.ts`, not `src/index.ts`.
    const graph = await index(pnpm({ main: './dist/node/index.js', types: './dist/node/index.d.ts' }, {
      'packages/core/src/node/index.ts': 'export function coreFn(): number { return 3; }\n',
    }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/node/index.ts']);
    expect(callsFrom(graph, 'apps/web/main.ts')).toContain('coreFn@packages/core/src/node/index.ts');
  }, 120_000);

  it("through `exports` first, then the root's `main`-style fields when `exports` leads to no indexed file", async () => {
    // `exports` read as its source beats a root `index.js` that `main` names…
    const first = await index(pnpm({ exports: { '.': './dist/index.mjs' }, main: './index.js' }, {
      'packages/core/index.js': "module.exports = require('./dist/index.cjs');\n",
    }));
    expect(moduleImports(first, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    // …and `source` is read when `exports` names build output with no clear source.
    const then = await index(pnpm({ exports: { '.': './dist/acme-core.mjs' }, source: './src/main.ts' }, {
      'packages/core/src/main.ts': 'export function coreFn(): number { return 4; }\n',
    }));
    expect(moduleImports(then, 'apps/web/main.ts')).toEqual(['packages/core/src/main.ts']);
  }, 120_000);

  it('and links nothing new when build output has no clear source', async () => {
    // `dist/bundle.js` has no `src/bundle.*`: no guess at another file.
    const graph = await index(pnpm({ main: './dist/bundle.js' }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual([]);
  }, 120_000);

  it("so a same-named private function no longer takes the package's callers (the issue's repro)", async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'repro', private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n',
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core', type: 'module', main: './src/index.ts', exports: { '.': './src/index.ts' },
      }),
      'packages/core/src/index.ts': "export * from './status.js';\n",
      'packages/core/src/status.ts':
        "export function caseStatus(input: { open: boolean }): { value: string } {\n  return { value: input.open ? 'open' : 'closed' };\n}\n",
      'packages/db/package.json': JSON.stringify({ name: '@acme/db', type: 'module' }),
      'packages/db/src/load.ts':
        "import { caseStatus } from '@acme/core';\nexport const loadStatus = (open: boolean) => caseStatus({ open }).value;\n",
      'apps/web/package.json': JSON.stringify({ name: '@acme/web', type: 'module' }),
      'apps/web/lib/list.ts':
        "import { caseStatus } from '@acme/core';\nexport const listCases = (cases: { open: boolean }[]) => cases.map((c) => caseStatus(c).value);\n",
      'apps/worker/package.json': JSON.stringify({ name: '@acme/worker', type: 'module' }),
      'apps/worker/src/run.ts':
        "import { caseStatus } from '@acme/core';\nexport const run = () => caseStatus({ open: true }).value;\n",
      'apps/worker/src/interpret.ts':
        'function caseStatus(raw: string): string { return raw.trim(); }\nexport const interpret = (raw: string) => caseStatus(raw);\n',
    });
    for (const file of ['packages/db/src/load.ts', 'apps/web/lib/list.ts', 'apps/worker/src/run.ts']) {
      expect(callsFrom(graph, file)).toContain('caseStatus@packages/core/src/status.ts');
      expect(callsFrom(graph, file)).not.toContain('caseStatus@apps/worker/src/interpret.ts');
    }
  }, 120_000);
});

describe('a package an npm `file:` dependency points at is imported by its name (#2456)', () => {
  /** The issue's layout: no root manifest, `acme-api` depends on `file:../common`. */
  const fileDep = (spec: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'packages/common/package.json': JSON.stringify({ name: 'acme-shared', version: '1.0.0' }),
    'packages/common/utils.ts':
      "export function formatLabel(name: string): string { return name.trim(); }\nexport function isAdmin(role: string): boolean { return role === 'admin'; }\n",
    'packages/api/package.json': JSON.stringify({ name: 'acme-api', dependencies: { 'acme-shared': spec } }),
    'packages/api/src/handler.ts':
      "import { formatLabel, isAdmin } from 'acme-shared/utils';\nexport function handleRequest(name: string, role: string): string {\n  return isAdmin(role) ? formatLabel(name) : 'forbidden';\n}\n",
    ...extra,
  });

  it.each(['file:../common', 'link:../common'])('with %s and no root `workspaces`', async (spec) => {
    const graph = await index(fileDep(spec, {
      // A same-named function nearer the caller, which name matching would pick.
      'packages/api/src/format.ts': "export function formatLabel(name: string): string { return '!' + name; }\n",
    }));
    expect(moduleImports(graph, 'packages/api/src/handler.ts')).toEqual(['packages/common/utils.ts']);
    expect(callsFrom(graph, 'packages/api/src/handler.ts')).toEqual([
      'formatLabel@packages/common/utils.ts', 'isAdmin@packages/common/utils.ts',
    ]);
  }, 120_000);

  it('for every file when the root manifest declares it', async () => {
    // An Expo app's local native module, as `link:` from the root package.json.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/native': 'link:./modules/native' } }),
      'modules/native/package.json': JSON.stringify({ name: '@acme/native', main: './src/index.ts' }),
      'modules/native/src/index.ts': 'export function share(text: string): string { return text; }\n',
      'src/screens/Share.ts': "import { share } from '@acme/native';\nexport const onShare = () => share('hi');\n",
    });
    expect(moduleImports(graph, 'src/screens/Share.ts')).toEqual(['modules/native/src/index.ts']);
    expect(callsFrom(graph, 'src/screens/Share.ts')).toEqual(['share@modules/native/src/index.ts']);
  }, 120_000);

  it("only for the files under the manifest that declares it", async () => {
    // A test fixture's `left-pad` stub is the fixture's; the app's `left-pad` stays the npm package.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'left-pad': '^1.3.0' } }),
      'src/pad.ts': "import leftPad from 'left-pad';\nexport const pad = (s: string) => leftPad(s, 4);\n",
      'test/fixture/package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': 'file:../stub-left-pad' } }),
      'test/fixture/use.ts': "import leftPad from 'left-pad';\nexport const use = () => leftPad('x', 2);\n",
      'test/stub-left-pad/package.json': JSON.stringify({ name: 'left-pad', main: 'index.ts' }),
      'test/stub-left-pad/index.ts': 'export default function leftPad(s: string, n: number): string { return s.padStart(n); }\n',
    });
    expect(moduleImports(graph, 'test/fixture/use.ts')).toEqual(['test/stub-left-pad/index.ts']);
    expect(moduleImports(graph, 'src/pad.ts')).toEqual([]);
    expect(callsFrom(graph, 'src/pad.ts')).toEqual([]);
  }, 120_000);

  it("through the target's own `exports`", async () => {
    const graph = await index({
      'packages/common/package.json': JSON.stringify({ name: 'acme-shared', exports: { './utils': './src/utils.ts' } }),
      'packages/common/src/utils.ts': 'export function formatLabel(name: string): string { return name; }\n',
      'packages/api/package.json': JSON.stringify({ name: 'acme-api', dependencies: { 'acme-shared': 'file:../common' } }),
      'packages/api/handler.ts': "import { formatLabel } from 'acme-shared/utils';\nexport const h = (n: string) => formatLabel(n);\n",
    });
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual(['packages/common/src/utils.ts']);
  }, 120_000);
});

describe('sync follows a manifest edit (#2456, #2502)', () => {
  it("re-links importers when a member's `main` or `exports` changes, as a fresh index would", async () => {
    const files = pnpm({ main: './dist/bundle.js' }, {
      'packages/core/src/next.ts': 'export function coreFn(): number { return 2; }\n',
    });
    const graph = await index(files);
    const root = roots[roots.length - 1]!;
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual([]);

    write(root, { 'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: './src/index.ts' }) });
    await graph.sync();
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);

    write(root, { 'packages/core/package.json': JSON.stringify({ name: '@acme/core', exports: { '.': { import: './src/next.ts' } } }) });
    await graph.sync();
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/next.ts']);
    expect(callsFrom(graph, 'apps/web/main.ts')).toContain('coreFn@packages/core/src/next.ts');
  }, 120_000);

  it('re-links importers when a `file:` dependency appears', async () => {
    const graph = await index({
      'packages/common/package.json': JSON.stringify({ name: 'acme-shared' }),
      'packages/common/utils.ts': 'export function formatLabel(name: string): string { return name; }\n',
      'packages/api/package.json': JSON.stringify({ name: 'acme-api' }),
      'packages/api/handler.ts': "import { formatLabel } from 'acme-shared/utils';\nexport const h = (n: string) => formatLabel(n);\n",
    });
    const root = roots[roots.length - 1]!;
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual([]);
    write(root, { 'packages/api/package.json': JSON.stringify({ name: 'acme-api', dependencies: { 'acme-shared': 'file:../common' } }) });
    await graph.sync();
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual(['packages/common/utils.ts']);
  }, 120_000);
});

describe('sync follows the entry a manifest declares when its file appears (#2502)', () => {
  it.each([
    ['an `exports` entry', { exports: { '.': './src/index.ts' } }],
    ['the source of a `main` in `dist/`', { main: './dist/index.js' }],
  ])("re-links importers that fell back to the package's root index, through %s", async (_label, manifest) => {
    const files = pnpm(manifest, {
      'packages/core/index.ts': "export function caseStatus(open: boolean): string { return 'root'; }\n",
      'packages/core/src/status.ts': "export function caseStatus(open: boolean): string { return open ? 'open' : 'closed'; }\n",
      'apps/web/main.ts': "import { caseStatus } from '@acme/core';\nexport const run = () => caseStatus(true);\n",
    });
    delete files['packages/core/src/index.ts'];
    const graph = await index(files);
    const root = roots[roots.length - 1]!;
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/index.ts']);
    expect(callsFrom(graph, 'apps/web/main.ts')).toEqual(['caseStatus@packages/core/index.ts']);

    // The barrel names no `caseStatus` of its own: only the import leads the call there.
    write(root, { 'packages/core/src/index.ts': "export * from './status';\n" });
    await graph.sync();
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    expect(callsFrom(graph, 'apps/web/main.ts')).toEqual(['caseStatus@packages/core/src/status.ts']);
  }, 120_000);
});
