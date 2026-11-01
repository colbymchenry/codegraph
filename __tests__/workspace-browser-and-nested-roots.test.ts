/**
 * Two things decide what a package import of a monorepo means, beside the name.
 *
 * - The side of the wire: a file that reads the page takes an `exports` entry's
 *   `browser` condition. react's `fixtures/flight/src/index.js`, built for the
 *   page, took `react-server-dom-webpack/client` as `client.node.js`.
 * - The install: a folder whose package.json declares `workspaces` of its own is
 *   a monorepo inside the repository. Its files see neither the outer root's
 *   packages nor its globals: react's `compiler/` runs on an npm `react` and on
 *   `@types/jest`, not on `packages/react` and `scripts/jest`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-browser-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

/** Where a function's calls land: `<file>:<qualified name>`, sorted. */
function callsOf(cg: CodeGraph, fn: string): string[] {
  const node = cg.getNodesByName(fn).find((n) => n.kind === 'function');
  expect(node, fn).toBeDefined();
  return cg.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

const DUAL = {
  'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
  'packages/dual/package.json': JSON.stringify({
    name: 'dual',
    version: '1.0.0',
    exports: {
      './client': {
        workerd: './client.edge.js',
        node: './client.node.js',
        browser: './client.browser.js',
        default: './client.browser.js',
      },
    },
  }),
  'packages/dual/client.node.js': 'export function connect() {}\n',
  'packages/dual/client.browser.js': 'export function connect() {}\n',
  'packages/dual/client.edge.js': 'export function connect() {}\n',
};

describe('the browser condition of a package entry', () => {
  it('is what a file reading the page imports', async () => {
    const cg = await indexProject({
      ...DUAL,
      'app/page.js': "import {connect} from 'dual/client';\nexport function boot() {\n  document.title = 'x';\n  connect();\n}\n",
    });
    expect(callsOf(cg, 'boot')).toEqual(['packages/dual/client.browser.js:connect']);
  });

  it('is not what a file that never touches the page imports', async () => {
    const cg = await indexProject({
      ...DUAL,
      'app/server.js': "import {connect} from 'dual/client';\nexport function serve() {\n  connect();\n}\n",
    });
    expect(callsOf(cg, 'serve')).toEqual(['packages/dual/client.node.js:connect']);
  });

  it('is not read from a comment, a string or a property named like the page', async () => {
    const cg = await indexProject({
      ...DUAL,
      'app/server.js': "// document.title is the browser's\nimport {connect} from 'dual/client';\nexport function serve(res, page) {\n  res.document.x = 1;\n  page.evaluate('window.scrollTo(0, 0)');\n  connect();\n}\n",
    });
    expect(callsOf(cg, 'serve')).toEqual(['packages/dual/client.node.js:connect']);
  });
});

describe('a workspace root inside the repository', () => {
  const FILES = {
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
    'packages/core/package.json': '{ "name": "core", "version": "1.0.0", "main": "src/index.js" }\n',
    'packages/core/src/index.js': 'export function useThing() { return 1; }\n',
    'scripts/jest/jest.d.ts': 'declare function expect(val: any): any;\n',
    'compiler/package.json': '{ "name": "compiler-root", "private": true, "workspaces": { "packages": ["packages/*"] } }\n',
    'compiler/packages/n/package.json': '{ "name": "n", "version": "1.0.0", "devDependencies": { "core": "9.9.9" } }\n',
  };

  it("keeps the outer root's packages out", async () => {
    const cg = await indexProject({
      ...FILES,
      'compiler/packages/n/src/a.ts': "import { useThing } from 'core';\nexport function a() { return useThing(); }\n",
    });
    expect(callsOf(cg, 'a')).toEqual([]);
  });

  it("keeps the outer root's globals out", async () => {
    const cg = await indexProject({
      ...FILES,
      'compiler/packages/n/src/a.test.ts': 'export function a() { return expect(1); }\n',
    });
    expect(callsOf(cg, 'a')).toEqual([]);
  });

  it('leaves the files outside it as they were', async () => {
    const cg = await indexProject({
      ...FILES,
      'packages/core/src/index.test.ts': "import { useThing } from './index';\nexport function a() { return expect(useThing()); }\n",
      'fixtures/app/src/index.ts': "import { useThing } from 'core';\nexport function b() { return useThing(); }\n",
    });
    expect(callsOf(cg, 'a')).toEqual(['packages/core/src/index.js:useThing', 'scripts/jest/jest.d.ts:expect']);
    expect(callsOf(cg, 'b')).toEqual(['packages/core/src/index.js:useThing']);
  });

  it('takes a member of the outer workspace for a member, whatever its manifest declares', async () => {
    const cg = await indexProject({
      ...FILES,
      'packages/sub/package.json': '{ "name": "sub", "version": "1.0.0", "workspaces": ["inner/*"] }\n',
      'packages/sub/src/a.ts': "import { useThing } from 'core';\nexport function a() { return useThing(); }\n",
    });
    expect(callsOf(cg, 'a')).toEqual(['packages/core/src/index.js:useThing']);
  });

  it('counts a nested pnpm workspace too', async () => {
    const cg = await indexProject({
      ...FILES,
      'compiler/package.json': '{ "name": "compiler-root", "private": true }\n',
      'compiler/pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'compiler/packages/n/src/a.ts': "import { useThing } from 'core';\nexport function a() { return useThing(); }\n",
    });
    expect(callsOf(cg, 'a')).toEqual([]);
  });
});
