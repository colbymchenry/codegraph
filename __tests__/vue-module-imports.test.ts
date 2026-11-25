/**
 * In a Vue project, an import's module path links the module's file.
 *
 * Every script's `imports` reference named by a path (`@/flags/registry`,
 * `~/utils/helper`) went through the Vue resolver first, which mapped `@/` and
 * `~/` to `src/` by hand and linked the FIRST node of the file it found: a
 * constant the module declares, a component, or for a `#app/…` path alias the
 * importing file itself (the Nuxt virtual-module rule). Without Vue the import
 * resolver links the file node, following tsconfig paths. So in any project
 * with a `vue` dependency or a `.vue` file, no importer's edge reached the
 * module's file, and what follows those edges came up empty: sync's walk from
 * a module that appears to the files importing it (#2512), and a barrel's
 * importers (#2560).
 *
 * Now the import resolver links what it finds, and the Vue resolver only adds
 * what a Vue app's bundler finds from a plain script: a component named
 * without `.vue`, or a folder's `index.vue` (`import Layout from '@/layout'`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

type Files = Record<string, string>;

const PROJECT: Files = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '~/*': ['src/*'], '#app/*': ['client/*'] } } }),
  'src/flags.ts': "import { REGISTERED_FLAGS } from '@/flags/registry';\nexport function flag(n: string) { return REGISTERED_FLAGS.get(n); }\n",
  'src/flags/registry.ts': 'export const REGISTERED_FLAGS = new Map<string, boolean>();\n',
  'src/router.js': "import Layout from '@/layout';\nimport Foo from '@/components/Foo.vue';\nimport api from '@/api';\nexport const routes = [Layout, Foo, api];\n",
  'src/layout/index.vue': '<template><div><slot /></div></template>\n<script>\nexport default { name: "Layout" }\n</script>\n',
  'src/components/Foo.vue': '<template><p>Foo</p></template>\n',
  'src/api/index.js': 'export default { get() { return 1; } };\n',
  'src/tilde.ts': "import { helper } from '~/utils/helper';\nexport const h = helper();\n",
  'src/utils/helper.ts': 'export const flagged = 1;\nexport function helper() { return flagged; }\n',
  'src/components/Panel.vue': "<template><div>{{ names }}</div></template>\n<script setup lang=\"ts\">\nimport { COLUMNS } from '@/table';\nconst names = COLUMNS.map((c) => c.name);\n</script>\n",
  'src/table.ts': "export const COLUMNS = [{ name: 'a' }];\n",
  // A tsconfig alias that starts like one of Nuxt's virtual modules.
  'src/elsewhere.ts': "import { where } from '#app/where';\nexport const w = where;\n",
  'client/where.ts': "export const where = 'client';\n",
  // A Nuxt virtual module is no file: it keeps linking the importing file.
  'src/virtual.ts': "import { useHead } from '#imports';\nexport const head = useHead;\n",
};

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-imports-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

async function index(root: string): Promise<CodeGraph> {
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** Each `imports` edge whose reference names a module by path: `<file> <path> -> <target kind> <target file>`. */
function moduleImportsOf(graph: CodeGraph): string[] {
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  const links: string[] = [];
  for (const edge of graph.getOutgoingEdgesFrom(ids, ['imports'])) {
    const ref = edge.metadata?.refName;
    if (typeof ref !== 'string' || (!ref.includes('/') && !ref.startsWith('#'))) continue;
    const source = graph.getNode(edge.source)!;
    const target = graph.getNode(edge.target)!;
    links.push(`${source.filePath} ${ref} -> ${target.kind} ${target.filePath}`);
  }
  return links.sort();
}

/** Every edge, by its ends' natural keys, with where it is written and how it resolved. */
function edgesOf(graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  return graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`)
    .sort();
}

describe('a module import in a Vue project', () => {
  it('links the module\'s file, as without Vue', async () => {
    const root = tempRoot();
    write(root, PROJECT);
    const graph = await index(root);
    expect(moduleImportsOf(graph)).toEqual([
      'src/components/Panel.vue @/table -> file src/table.ts',
      'src/elsewhere.ts #app/where -> file client/where.ts',
      'src/flags.ts @/flags/registry -> file src/flags/registry.ts',
      'src/router.js @/api -> file src/api/index.js',
      'src/router.js @/components/Foo.vue -> file src/components/Foo.vue',
      'src/router.js @/layout -> file src/layout/index.vue',
      'src/tilde.ts ~/utils/helper -> file src/utils/helper.ts',
      'src/virtual.ts #imports -> file src/virtual.ts',
    ]);
  }, 60_000);

  it('links the module the way the import resolver does, wherever it can', async () => {
    const root = tempRoot();
    write(root, PROJECT);
    const graph = await index(root);
    const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
    const how = new Map(graph.getOutgoingEdgesFrom(ids, ['imports'])
      .map((e) => [String(e.metadata?.refName), String(e.metadata?.resolvedBy)] as const));
    expect(how.get('@/flags/registry')).toBe('import');
    expect(how.get('@/table')).toBe('import');
    expect(how.get('#app/where')).toBe('import');
    // A script's `@/layout` is a folder's `index.vue` only to a Vue bundler.
    expect(how.get('@/layout')).toBe('framework');
  }, 60_000);

});

describe('a sync in a Vue project follows an import to its barrel', () => {
  // `src/components/index.ts` passes `Button` on from `./Button`. Its first
  // node is the constant it declares, which the import of `@/components`
  // used to link; sync finds a barrel's importers through the edge into the
  // barrel's file (#2512).
  const BASE: Files = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/components/Button.ts': 'export function Button() { return 1; }\n',
    'src/views/page.ts': "import { Button } from '@/components';\nexport function page() { return Button(); }\n",
  };
  const BARREL: Files = { 'src/components/index.ts': "export const VERSION = 1;\nexport * from './Button';\n" };

  /** The final tree, indexed from scratch in a folder of its own. */
  async function fullIndexOf(files: Files): Promise<string[]> {
    const root = tempRoot();
    write(root, files);
    return edgesOf(await index(root));
  }

  it('when the barrel is added after its importers', async () => {
    // Meanwhile `Button` links its one namesake by name; through the barrel
    // once it is there.
    const root = tempRoot();
    write(root, BASE);
    const graph = await index(root);

    write(root, BARREL);
    expect((await graph.sync()).filesAdded).toBe(1);
    const fresh = await fullIndexOf({ ...BASE, ...BARREL });
    expect(fresh.filter((e) => e.startsWith('calls ') && e.includes('"refName":"Button"') && e.includes('"resolvedBy":"import"'))).toHaveLength(1);
    expect(edgesOf(graph)).toEqual(fresh);
  }, 120_000);

  it('when the barrel is deleted', async () => {
    const root = tempRoot();
    write(root, { ...BASE, ...BARREL });
    const graph = await index(root);

    fs.rmSync(path.join(root, 'src/components/index.ts'));
    expect((await graph.sync()).filesRemoved).toBe(1);
    expect(edgesOf(graph)).toEqual(await fullIndexOf(BASE));
  }, 120_000);
});
