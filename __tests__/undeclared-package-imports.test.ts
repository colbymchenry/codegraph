/**
 * A JS/TS name imported from a package the manifest doesn't list (#3271), but
 * that the project has installed — hoisted to a parent `node_modules` in a
 * monorepo, or pulled in by another package — is the package's. It must not
 * link to an unrelated project export of the same name that the file never
 * imports. An undeclared specifier with no install evidence may be an alias
 * the resolver doesn't read (a bundler's `ui`, an import map's `helpers`) or
 * a sibling package, and keeps linking as before.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** Index `files` (relative to the temp dir) as a project rooted at `projectDir`. */
async function index(files: Record<string, string>, projectDir = ''): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
  write(tempDir, files);
  cg = await CodeGraph.init(path.join(tempDir, projectDir), { index: true });
  return cg;
}

/** `kind file:name` for every calls/imports edge out of `file`. */
function edgesFrom(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls' && e.kind !== 'imports') continue;
      const t = graph.getNode(e.target)!;
      out.push(`${e.kind} ${t.filePath}:${t.name}`);
    }
  }
  return out.sort();
}

/** An installed package's files under `node_modules` (never indexed). */
function installed(name: string, dir = ''): Record<string, string> {
  const base = path.posix.join(dir, 'node_modules', name);
  return {
    [`${base}/package.json`]: JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }),
    [`${base}/index.d.ts`]: 'export declare function useForm(): number;\n',
  };
}

const DECOY = 'export function useForm() { return 42; }\n';
const MAIN = "import { useForm } from 'react-hook-form';\nexport function entry() {\n  return useForm();\n}\n";

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a name imported from an installed package the manifest does not list', () => {
  it('links to no project export when there is no package.json', async () => {
    const graph = await index({ ...installed('react-hook-form'), 'main.ts': MAIN, 'decoy.ts': DECOY });
    expect(edgesFrom(graph, 'main.ts')).toEqual([]);
  });

  it('links to no project export when a monorepo hoists it to the root node_modules', async () => {
    const graph = await index({
      ...installed('react-hook-form'),
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { react: '18.0.0' } }),
      'packages/app/src/main.ts': MAIN,
      'packages/app/src/decoy.ts': DECOY,
    });
    expect(edgesFrom(graph, 'packages/app/src/main.ts')).toEqual([]);
  });

  it('links to no project export when a subdirectory indexed on its own installs into its parent', async () => {
    const graph = await index({ ...installed('react-hook-form'), 'app/main.ts': MAIN, 'app/decoy.ts': DECOY }, 'app');
    expect(edgesFrom(graph, 'main.ts')).toEqual([]);
  });

  it('links to no project export through a renamed import', async () => {
    const graph = await index({
      ...installed('react-hook-form'),
      'main.ts': "import { useForm as form } from 'react-hook-form';\nexport function entry() {\n  return form();\n}\n",
      'decoy.ts': 'export function form() { return 42; }\n',
    });
    expect(edgesFrom(graph, 'main.ts')).toEqual([]);
  });

  it('links to no project export from a scoped, dotted or subpath import whose name a project path shares', async () => {
    const graph = await index({
      ...installed('@tanstack/react-query'),
      ...installed('chart.js'),
      ...installed('firebase'),
      'src/main.ts':
        "import { useQuery } from '@tanstack/react-query';\nimport { Chart } from 'chart.js';\nimport { getAuth } from 'firebase/auth';\n" +
        'export function entry() {\n  return useQuery() + Chart() + getAuth();\n}\n',
      'src/hooks.ts': 'export function useQuery() { return 1; }\n',
      'src/components/Chart.ts': 'export function Chart() { return 2; }\n',
      'src/auth/session.ts': 'export function getAuth() { return 3; }\n',
    });
    expect(edgesFrom(graph, 'src/main.ts')).toEqual([]);
  });

  it('links to no project export from a legacy capitalized package name', async () => {
    const graph = await index({
      ...installed('JSONStream'),
      'main.ts': "import { parse } from 'JSONStream';\nexport function entry() {\n  return parse();\n}\n",
      'decoy.ts': 'export function parse() { return 42; }\n',
    });
    expect(edgesFrom(graph, 'main.ts')).toEqual([]);
  });

  it('links to no project export when the project is opened through a link out of the monorepo that hoists it', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, { ...installed('react-hook-form', 'mono'), 'mono/apps/app/main.ts': MAIN, 'mono/apps/app/decoy.ts': DECOY });
    fs.mkdirSync(path.join(tempDir, 'elsewhere'));
    fs.symlinkSync(path.join(tempDir, 'mono/apps/app'), path.join(tempDir, 'elsewhere/app'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'elsewhere/app'), { index: true });
    expect(edgesFrom(cg, 'main.ts')).toEqual([]);
  });

  it("links to no project export when pnpm's store holds it", async () => {
    // pnpm: node_modules/<name> links into node_modules/.pnpm/<name>@<v>/node_modules/<name>.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, { ...installed('react-hook-form', 'node_modules/.pnpm/react-hook-form@7.0.0'), 'main.ts': MAIN, 'decoy.ts': DECOY });
    fs.symlinkSync(path.join(tempDir, 'node_modules/.pnpm/react-hook-form@7.0.0/node_modules/react-hook-form'),
      path.join(tempDir, 'node_modules/react-hook-form'), 'junction');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(edgesFrom(cg, 'main.ts')).toEqual([]);
  });

  it('links to no project export when the nearest node_modules holds a broken link and a parent one holds the package', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, { ...installed('react-hook-form'), 'app/main.ts': MAIN, 'app/decoy.ts': DECOY });
    fs.mkdirSync(path.join(tempDir, 'app/node_modules'));
    fs.symlinkSync(path.join(tempDir, 'gone'), path.join(tempDir, 'app/node_modules/react-hook-form'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'app'), { index: true });
    expect(edgesFrom(cg, 'main.ts')).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('finishes indexing when an installed package.json is a FIFO', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, { 'main.ts': MAIN, 'decoy.ts': DECOY });
    fs.mkdirSync(path.join(tempDir, 'node_modules/react-hook-form'), { recursive: true });
    execFileSync('mkfifo', [path.join(tempDir, 'node_modules/react-hook-form/package.json')]);
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(edgesFrom(cg, 'main.ts')).toEqual([]);
  }, 30_000);

  it('still lets an inner declaration shadow the import', async () => {
    const graph = await index({
      ...installed('react-hook-form'),
      'main.ts': "import { useForm } from 'react-hook-form';\nexport function entry() {\n  function useForm() { return 1; }\n  return useForm();\n}\n",
      'decoy.ts': DECOY,
    });
    expect(edgesFrom(graph, 'main.ts')).toEqual(['calls main.ts:useForm']);
  });

  it('keeps a project `declare module` for it', async () => {
    const graph = await index({
      ...installed('react-hook-form'),
      'types.d.ts': "declare module 'react-hook-form' {\n  export function useForm(): number;\n}\n",
      'main.ts': MAIN,
      'decoy.ts': DECOY,
    });
    const edges = edgesFrom(graph, 'main.ts');
    expect(edges).toContain('calls types.d.ts:useForm');
    expect(edges.filter((e) => e.includes('decoy.ts'))).toEqual([]);
  });

  it('matches what a declared dependency already does', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-hook-form': '7.0.0' } }),
      'main.ts': MAIN,
      'decoy.ts': DECOY,
    });
    expect(edgesFrom(graph, 'main.ts')).toEqual([]);
  });
});

describe('an undeclared specifier with no install evidence keeps linking', () => {
  it("a bundler alias whose name is no project path (webpack's `ui`)", async () => {
    const graph = await index({
      ...installed('react'),
      'webpack.config.js': "module.exports = { resolve: { alias: { ui: require('path').resolve(__dirname, 'src/design-system') } } };\n",
      'src/design-system/index.ts': 'export function Button() { return 1; }\n',
      'src/app.ts': "import { Button } from 'ui';\nexport function App() {\n  return Button();\n}\n",
    });
    expect(edgesFrom(graph, 'src/app.ts')).toContain('calls src/design-system/index.ts:Button');
  });

  it("an import map entry (Deno's `helpers`)", async () => {
    const graph = await index({
      'deno.json': JSON.stringify({ imports: { helpers: './src/h.ts' } }),
      'src/h.ts': 'export function help() { return 1; }\n',
      'src/main.ts': "import { help } from 'helpers';\nexport function main() {\n  return help();\n}\n",
    });
    expect(edgesFrom(graph, 'src/main.ts')).toContain('calls src/h.ts:help');
  });

  it.each([
    ['$lib/format', 'src/lib/format.ts'],
    ['~/format', 'src/format.ts'],
    ['@/format', 'src/format.ts'],
    ['#format', 'src/format.ts'],
  ])('an alias that is not a package name (%s)', async (specifier, file) => {
    const graph = await index({
      [file]: 'export function fmt() { return 1; }\n',
      'src/app.ts': `import { fmt } from '${specifier}';\nexport function App() {\n  return fmt();\n}\n`,
    });
    expect(edgesFrom(graph, 'src/app.ts')).toContain(`calls ${file}:fmt`);
  });

  it('a sibling package no workspaces field lists, named unlike its folder', async () => {
    const graph = await index({
      'packages/shared/package.json': JSON.stringify({ name: '@acme/common', main: 'src/index.ts' }),
      'packages/shared/src/index.ts': 'export function makeKit() { return 1; }\n',
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/src/main.ts': "import { makeKit } from '@acme/common';\nexport function run() {\n  return makeKit();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/src/main.ts')).toContain('calls packages/shared/src/index.ts:makeKit');
  });

  it('a sibling package that node_modules links back into the project', async () => {
    // As a workspace install leaves it: a link in node_modules.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      'packages/kit/package.json': JSON.stringify({ name: 'acme-kit', main: 'src/index.ts' }),
      'packages/kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'packages/app/src/main.ts': "import { makeKit } from 'acme-kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.symlinkSync(path.join(tempDir, 'packages/kit'), path.join(tempDir, 'node_modules/acme-kit'), 'junction');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(edgesFrom(cg, 'packages/app/src/main.ts')).toContain('calls packages/kit/src/index.ts:makeKit');
  });

  it('a sibling package linked from node_modules when the project is opened through a link', async () => {
    // macOS's tmpdir is such a path: /var is a link to /private/var.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      'real/packages/kit/package.json': JSON.stringify({ name: 'acme-kit', main: 'src/index.ts' }),
      'real/packages/kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'real/packages/app/src/main.ts': "import { makeKit } from 'acme-kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    fs.mkdirSync(path.join(tempDir, 'real/node_modules'));
    fs.symlinkSync(path.join(tempDir, 'real/packages/kit'), path.join(tempDir, 'real/node_modules/acme-kit'), 'junction');
    fs.symlinkSync(path.join(tempDir, 'real'), path.join(tempDir, 'link'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'link'), { index: true });
    expect(edgesFrom(cg, 'packages/app/src/main.ts')).toContain('calls packages/kit/src/index.ts:makeKit');
  });

  it('a subpath of the indexed package itself, which a parent node_modules links to', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      'app/util.ts': 'export function fmt() { return 1; }\n',
      'app/src/main.ts': "import { fmt } from 'acme-app/util';\nexport function run() {\n  return fmt();\n}\n",
    });
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.symlinkSync(path.join(tempDir, 'app'), path.join(tempDir, 'node_modules/acme-app'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'app'), { index: true });
    expect(edgesFrom(cg, 'src/main.ts')).toContain('calls util.ts:fmt');
  });

  it("a worktree whose node_modules links to the main checkout's", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    const tree = {
      'packages/sib/package.json': JSON.stringify({ name: '@acme/sib', main: 'src/index.ts' }),
      'packages/sib/src/index.ts': 'export function sibFn() { return 1; }\n',
      'packages/app/src/main.ts': "import { sibFn } from '@acme/sib';\nexport function run() {\n  return sibFn();\n}\n",
    };
    write(path.join(tempDir, 'main'), tree);
    write(path.join(tempDir, 'wt'), tree);
    fs.mkdirSync(path.join(tempDir, 'main/node_modules/@acme'), { recursive: true });
    fs.symlinkSync(path.join(tempDir, 'main/packages/sib'), path.join(tempDir, 'main/node_modules/@acme/sib'), 'junction');
    fs.symlinkSync(path.join(tempDir, 'main/node_modules'), path.join(tempDir, 'wt/node_modules'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'wt'), { index: true });
    expect(edgesFrom(cg, 'packages/app/src/main.ts')).toContain('calls packages/sib/src/index.ts:sibFn');
  });

  it('a sibling package under a packages folder that links out of the project', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      'outside/kit/package.json': JSON.stringify({ name: 'acme-kit', main: 'src/index.ts' }),
      'outside/kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'proj/app/src/main.ts': "import { makeKit } from 'acme-kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    fs.symlinkSync(path.join(tempDir, 'outside'), path.join(tempDir, 'proj/packages'), 'junction');
    fs.mkdirSync(path.join(tempDir, 'proj/node_modules'));
    fs.symlinkSync(path.join(tempDir, 'proj/packages/kit'), path.join(tempDir, 'proj/node_modules/acme-kit'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'proj'), { index: true });
    expect(edgesFrom(cg, 'app/src/main.ts')).toContain('calls packages/kit/src/index.ts:makeKit');
  });

  it('a sibling package in a folder whose name starts with two dots', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      '..kit/package.json': JSON.stringify({ name: 'acme-kit', main: 'src/index.ts' }),
      '..kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'app/src/main.ts': "import { makeKit } from 'acme-kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.symlinkSync(path.join(tempDir, '..kit'), path.join(tempDir, 'node_modules/acme-kit'), 'junction');
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(edgesFrom(cg, 'app/src/main.ts')).toContain('calls ..kit/src/index.ts:makeKit');
  });

  it('an alias, when a node_modules above the link the project was opened through holds that name', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      ...installed('ui', 'home'),
      'work/app/webpack.config.js': "module.exports = { resolve: { alias: { ui: require('path').resolve(__dirname, 'src/ds') } } };\n",
      'work/app/src/ds/index.ts': 'export function Button() { return 1; }\n',
      'work/app/src/app.ts': "import { Button } from 'ui';\nexport function App() {\n  return Button();\n}\n",
    });
    fs.symlinkSync(path.join(tempDir, 'work/app'), path.join(tempDir, 'home/link'), 'junction');
    cg = await CodeGraph.init(path.join(tempDir, 'home/link'), { index: true });
    expect(edgesFrom(cg, 'src/app.ts')).toContain('calls src/ds/index.ts:Button');
  });

  it('a sibling package an install copied into node_modules', async () => {
    // yarn v1's `file:` and npm's install-links copy the folder instead of linking it.
    const graph = await index({
      'packages/kit/package.json': JSON.stringify({ name: 'acme-kit', version: '1.2.0', main: 'src/index.ts' }),
      'packages/kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'node_modules/acme-kit/package.json': JSON.stringify({ name: 'acme-kit', version: '1.2.0', main: 'src/index.ts' }),
      'node_modules/acme-kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/src/main.ts': "import { makeKit } from 'acme-kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/src/main.ts')).toContain('calls packages/kit/src/index.ts:makeKit');
  });

  it('a sibling package copied into node_modules before its version was bumped', async () => {
    const graph = await index({
      'libs/lib/package.json': JSON.stringify({ name: '@acme/lib', version: '1.3.0', main: 'index.ts' }),
      'libs/lib/index.ts': 'export function useLib() { return 1; }\n',
      'node_modules/@acme/lib/package.json': JSON.stringify({ name: '@acme/lib', version: '1.2.3', main: 'index.ts' }),
      'node_modules/@acme/lib/index.ts': 'export function useLib() { return 1; }\n',
      'apps/web/main.ts': "import { useLib } from '@acme/lib';\nexport function entry() {\n  return useLib();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/main.ts')).toContain('calls libs/lib/index.ts:useLib');
  });

  it('a sibling package copied into node_modules under another name', async () => {
    // Nothing indexed declares `kit`: the copy's own package.json names the sibling.
    const graph = await index({
      'libs/lib/package.json': JSON.stringify({ name: '@acme/lib', version: '1.2.3', main: 'index.ts' }),
      'libs/lib/index.ts': 'export function useLib() { return 1; }\n',
      'node_modules/kit/package.json': JSON.stringify({ name: '@acme/lib', version: '1.2.3', main: 'index.ts' }),
      'node_modules/kit/index.ts': 'export function useLib() { return 1; }\n',
      'apps/web/main.ts': "import { useLib } from 'kit';\nexport function entry() {\n  return useLib();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/main.ts')).toContain('calls libs/lib/index.ts:useLib');
  });

  it('a copied sibling whose package.json starts with a byte order mark', async () => {
    const manifest = '\uFEFF' + JSON.stringify({ name: '@acme/lib', version: '1.2.3', main: 'index.ts' });
    const graph = await index({
      'libs/lib/package.json': manifest,
      'libs/lib/index.ts': 'export function useLib() { return 1; }\n',
      'node_modules/@acme/lib/package.json': manifest,
      'node_modules/@acme/lib/index.ts': 'export function useLib() { return 1; }\n',
      'apps/web/main.ts': "import { useLib } from '@acme/lib';\nexport function entry() {\n  return useLib();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/main.ts')).toContain('calls libs/lib/index.ts:useLib');
  });

  it('a copy under another name whose package.json starts with a byte order mark', async () => {
    const graph = await index({
      'libs/lib/package.json': JSON.stringify({ name: '@acme/lib', main: 'index.ts' }),
      'libs/lib/index.ts': 'export function useLib() { return 1; }\n',
      'node_modules/kit/package.json': '\uFEFF' + JSON.stringify({ name: '@acme/lib', main: 'index.ts' }),
      'node_modules/kit/index.ts': 'export function useLib() { return 1; }\n',
      'apps/web/main.ts': "import { useLib } from 'kit';\nexport function entry() {\n  return useLib();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/main.ts')).toContain('calls libs/lib/index.ts:useLib');
  });

  it('a nameless sibling a package takes by a bare local path', async () => {
    const graph = await index({
      'libs/lib/package.json': JSON.stringify({ version: '1.0.0', main: 'index.ts' }),
      'libs/lib/index.ts': 'export function useLib() { return 1; }\n',
      'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { lib: '../../libs/lib' } }),
      'apps/api/index.ts': 'export const api = 1;\n',
      'node_modules/lib/package.json': JSON.stringify({ version: '1.0.0', main: 'index.ts' }),
      'node_modules/lib/index.ts': 'export function useLib() { return 1; }\n',
      'apps/web/main.ts': "import { useLib } from 'lib';\nexport function entry() {\n  return useLib();\n}\n",
    });
    expect(edgesFrom(graph, 'apps/web/main.ts')).toContain('calls libs/lib/index.ts:useLib');
  });

  it('a sibling package when the project itself lives inside a node_modules folder', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-undeclared-pkg-'));
    write(tempDir, {
      'node_modules/@acme/core/package.json': JSON.stringify({ name: '@acme/core', main: 'src/index.ts' }),
      'node_modules/@acme/core/src/index.ts': 'export function useCore() { return 1; }\n',
      'node_modules/@acme/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
      'node_modules/@acme/ui/src/main.ts': "import { useCore } from '@acme/core';\nexport function entry() {\n  return useCore();\n}\n",
    });
    cg = await CodeGraph.init(path.join(tempDir, 'node_modules/@acme'), { index: true });
    expect(edgesFrom(cg, 'ui/src/main.ts')).toContain('calls core/src/index.ts:useCore');
  });

  it('a workspace package the importing package does not declare', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/kit/package.json': JSON.stringify({ name: '@acme/kit', main: 'src/index.ts' }),
      'packages/kit/src/index.ts': 'export function makeKit() { return 1; }\n',
      'packages/app/package.json': JSON.stringify({ name: '@acme/app' }),
      'packages/app/src/main.ts': "import { makeKit } from '@acme/kit';\nexport function run() {\n  return makeKit();\n}\n",
    });
    expect(edgesFrom(graph, 'packages/app/src/main.ts')).toContain('calls packages/kit/src/index.ts:makeKit');
  });
});
