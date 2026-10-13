/**
 * A workspace member's import resolves to the entry its package.json declares
 * (`exports`, `main`, `module`), not only to an `index.*` at the member's root
 * (#2502). The common TypeScript monorepo layout declares
 * `"main": "./src/index.ts"` with no root index, so `import … from '@acme/core'`
 * linked nothing and its calls fell back to name matching, where a same-name
 * private function elsewhere could take the edge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** The files a file's import statements link it to (its module edges, not its calls). */
function moduleImports(graph: CodeGraph, file: string): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return [...new Set(graph.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'imports' && e.target.startsWith('file:'))
    .map((e) => e.target.slice('file:'.length)))].sort();
}

/** The files calling the function `name` defined in `file`. */
function callerFiles(graph: CodeGraph, name: string, file: string): string[] {
  const fn = graph.getNodesByKind('function').find((n) => n.name === name && n.filePath === file);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return [...new Set(graph.getCallers(fn!.id).map((c) => c.node.filePath))].sort();
}

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-entry-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** A pnpm workspace whose `@acme/core` member has the given manifest fields. */
function workspace(core: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': '{"name":"repo","private":true}',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', ...core }),
    'packages/core/src/index.ts': 'export function coreFn(): number { return 1; }\n',
    'apps/web/package.json': '{"name":"@acme/web"}',
    'apps/web/main.ts': "import { coreFn } from '@acme/core';\nexport const run = () => coreFn();\n",
    ...extra,
  };
}

describe('a workspace member import resolves to its declared entry (#2502)', () => {
  it('through `main`', async () => {
    const graph = await index(workspace({ main: './src/index.ts' }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('through `exports["."]` or a string `exports`', async () => {
    let graph = await index(workspace({ exports: { '.': './src/index.ts' } }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    graph = await index(workspace({ exports: './src/index.ts' }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('through a conditional `exports`, taking the first target that is in the project', async () => {
    // `types` and `default` name build output that isn't there; `import` names the source.
    const conditions = { types: './dist/index.d.ts', import: './src/index.ts', default: './dist/index.js' };
    let graph = await index(workspace({ exports: { '.': conditions } }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
    // Conditions straight under `exports` apply to the package itself.
    graph = await index(workspace({ exports: conditions }));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/src/index.ts']);
  }, 120_000);

  it('through a subpath export and a `./*` pattern', async () => {
    const graph = await index(workspace(
      { exports: { '.': './src/index.ts', './schema': './src/schema/index.ts', './utils/*': './src/utils/*.ts' } },
      {
        'packages/core/src/schema/index.ts': "export const caseTable = 'case';\n",
        'packages/core/src/utils/strings.ts': 'export function trim(s: string): string { return s.trim(); }\n',
        'apps/web/table.ts': "import { caseTable } from '@acme/core/schema';\nexport const tableName = () => caseTable;\n",
        'apps/web/text.ts': "import { trim } from '@acme/core/utils/strings';\nexport const clean = (s: string) => trim(s);\n",
      },
    ));
    expect(moduleImports(graph, 'apps/web/table.ts')).toEqual(['packages/core/src/schema/index.ts']);
    expect(moduleImports(graph, 'apps/web/text.ts')).toEqual(['packages/core/src/utils/strings.ts']);
  }, 120_000);

  it('so a same-name private function elsewhere no longer takes the callers', async () => {
    // The issue's repro: three consumers of `@acme/core`'s `caseStatus`, and an
    // unrelated `caseStatus` in the worker that is nearer to two of them.
    const graph = await index({
      'package.json': '{"name":"repro","private":true}',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n',
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core', type: 'module', main: './src/index.ts', exports: { '.': './src/index.ts' },
      }),
      'packages/core/src/index.ts': "export * from './status.js';\n",
      'packages/core/src/status.ts':
        "export function caseStatus(input: { open: boolean }): { value: string } {\n  return { value: input.open ? 'open' : 'closed' };\n}\n",
      'packages/db/package.json': '{"name":"@acme/db","type":"module"}',
      'packages/db/src/load.ts':
        "import { caseStatus } from '@acme/core';\nexport const loadStatus = (open: boolean) => caseStatus({ open }).value;\n",
      'apps/web/package.json': '{"name":"@acme/web","type":"module"}',
      'apps/web/lib/list.ts':
        "import { caseStatus } from '@acme/core';\nexport const listCases = (cases: { open: boolean }[]) => cases.map((c) => caseStatus(c).value);\n",
      'apps/worker/package.json': '{"name":"@acme/worker","type":"module"}',
      'apps/worker/src/run.ts':
        "import { caseStatus } from '@acme/core';\nexport const run = () => caseStatus({ open: true }).value;\n",
      'apps/worker/src/interpret.ts':
        'function caseStatus(raw: string): string { return raw.trim(); }\nexport const interpret = (raw: string) => caseStatus(raw);\n',
    });
    expect(callerFiles(graph, 'caseStatus', 'packages/core/src/status.ts'))
      .toEqual(['apps/web/lib/list.ts', 'apps/worker/src/run.ts', 'packages/db/src/load.ts']);
    expect(callerFiles(graph, 'caseStatus', 'apps/worker/src/interpret.ts'))
      .toEqual(['apps/worker/src/interpret.ts']);
  }, 120_000);

  it('and falls back to the member directory when the declared entry is not in the project', async () => {
    // `main` names build output that isn't indexed; the root `index.ts` still resolves.
    const graph = await index(workspace(
      { main: './dist/index.js', exports: { '.': { import: './dist/index.mjs', require: './dist/index.js' } } },
      { 'packages/core/index.ts': "export * from './src/index';\n" },
    ));
    expect(moduleImports(graph, 'apps/web/main.ts')).toEqual(['packages/core/index.ts']);
  }, 120_000);
});
