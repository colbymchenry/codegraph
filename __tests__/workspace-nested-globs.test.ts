/**
 * Workspace globs reach nested member packages.
 *
 * pnpm's `packages/**\/*` (folo) and npm's `libs/**\/*` (bitwarden) list
 * members at any depth, `packages/plugin-*` and `apps/*\/web` name them by
 * part of a folder name or by a folder below the wildcard, and a negated glob
 * (`!**\/example`, `!examples/with-nx`) leaves some out. The workspace loader
 * listed only the folders directly under the text before the first `*`, and
 * took a negation for a folder name: folo's `@follow/utils`, two levels under
 * `packages/`, was no member, so every import of it was taken for an outside
 * package's, and an excluded example was a member all the same.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { loadWorkspacePackages } from '../src/resolution/workspace-packages';

type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function workspace(files: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-globs-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const pkg = (name: string) => JSON.stringify({ name });
const pnpm = (...globs: string[]) => `packages:\n${globs.map((g) => `  - '${g}'`).join('\n')}\n`;

/** The loader's member map, as sorted `name -> dir` lines. */
function members(root: string): string[] {
  const ws = loadWorkspacePackages(root);
  return [...(ws?.byName ?? new Map<string, string>())].map(([name, dir]) => `${name} -> ${dir}`).sort();
}

describe('workspace globs', () => {
  it("reach pnpm's nested members through `packages/**/*`", () => {
    const root = workspace({
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': pnpm('apps/*', 'packages/**/*'),
      'apps/web/package.json': pkg('@acme/web'),
      'packages/cli/package.json': pkg('@acme/cli'),
      'packages/internal/utils/package.json': pkg('@acme/utils'),
      'packages/internal/ui/package.json': pkg('@acme/ui'),
      'packages/internal/AGENTS.md': '# not a package\n',
    });
    expect(members(root)).toEqual([
      '@acme/cli -> packages/cli',
      '@acme/ui -> packages/internal/ui',
      '@acme/utils -> packages/internal/utils',
      '@acme/web -> apps/web',
    ]);
  });

  it("reach npm's nested members through `libs/**/*`, and `**` alone counts the folder itself", () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['libs/**/*', 'tools/**'] }),
      'libs/common/package.json': pkg('@bw/common'),
      'libs/tools/generator/core/package.json': pkg('@bw/generator-core'),
      'tools/package.json': pkg('@bw/tools'),
      'tools/lint/package.json': pkg('@bw/lint'),
    });
    expect(members(root)).toEqual([
      '@bw/common -> libs/common',
      '@bw/generator-core -> libs/tools/generator/core',
      '@bw/lint -> tools/lint',
      '@bw/tools -> tools',
    ]);
  });

  it('match part of a folder name, a choice of names, and folders below the wildcard', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/plugin-*', '{apps,sites}/*/web'] }),
      'packages/plugin-a/package.json': pkg('plugin-a'),
      'packages/core/package.json': pkg('core'),
      'apps/shop/web/package.json': pkg('shop-web'),
      'apps/shop/package.json': pkg('shop'),
      'sites/blog/web/package.json': pkg('blog-web'),
    });
    expect(members(root)).toEqual([
      'blog-web -> sites/blog/web',
      'plugin-a -> packages/plugin-a',
      'shop-web -> apps/shop/web',
    ]);
  });

  it('leave out what a negated glob matches, wherever it is listed', () => {
    const root = workspace({
      'package.json': pkg('root'),
      // Quoted both ways and bare, as folo writes them.
      'pnpm-workspace.yaml': "packages:\n  - '!packages/legacy'\n  - packages/*\n  - \"apps/**\"\n  - \"!**/example\"\n  - '!examples/with-*'\n  - examples/*\n",
      'packages/core/package.json': pkg('core'),
      'packages/legacy/package.json': pkg('legacy'),
      'apps/mobile/package.json': pkg('mobile'),
      'apps/mobile/native/example/package.json': pkg('mobile-example'),
      'examples/basic/package.json': pkg('example-basic'),
      'examples/with-nx/package.json': pkg('example-nx'),
    });
    expect(members(root)).toEqual([
      'core -> packages/core',
      'example-basic -> examples/basic',
      'mobile -> apps/mobile',
    ]);
  });

  it("don't take installed packages, hidden folders or a `**` walk's test fixtures for members, unless a glob names them", () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/**', 'e2e/tests/*'] }),
      'packages/core/package.json': pkg('core'),
      'packages/core/test/fixtures/react/package.json': pkg('react'),
      'packages/core/node_modules/lodash/package.json': pkg('lodash'),
      'packages/.cache/stale/package.json': pkg('stale'),
      'e2e/tests/smoke/package.json': pkg('smoke'),
    });
    expect(members(root)).toEqual([
      'core -> packages/core',
      'smoke -> e2e/tests/smoke',
    ]);
  });

  it('keep the member nearest the root when a deeper copy declares its name', () => {
    const root = workspace({
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': pnpm('packages/**'),
      'packages/a-build/core/package.json': pkg('@acme/core'),
      'packages/core/package.json': pkg('@acme/core'),
    });
    // `packages/a-build/core` sorts first, but `packages/core` is a level up.
    expect(members(root)).toEqual(['@acme/core -> packages/core']);
  });
});

describe('a call through an import of a nested workspace member', () => {
  it('links to the member package', async () => {
    const root = workspace({
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': pnpm('apps/*', 'packages/**/*'),
      'apps/web/package.json': pkg('@acme/web'),
      // Imported under another name, so only the import can link the call.
      'apps/web/src/main.ts': "import { fmt as format } from '@acme/utils';\nexport function main() {\n  return format('x');\n}\n",
      'packages/internal/utils/package.json': pkg('@acme/utils'),
      'packages/internal/utils/index.ts': 'export function fmt(s: string) {\n  return s.trim();\n}\n',
    });
    const graph = await CodeGraph.init(root, { index: true });
    graphs.push(graph);
    const fmt = graph.getNodesInFile('packages/internal/utils/index.ts').find((n) => n.name === 'fmt');
    expect(fmt).toBeDefined();
    // The call, and the file's import of the name.
    expect(graph.getCallers(fmt!.id).map((c) => `${c.edge.kind} ${c.node.filePath}::${c.node.name}`).sort()).toEqual([
      'calls apps/web/src/main.ts::main',
      'imports apps/web/src/main.ts::main.ts',
    ]);
  }, 60_000);
});
