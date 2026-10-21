/**
 * A sync re-resolves what an import statement binds when the module it names
 * appears or goes away.
 *
 * `from shop import Order` reaches `shop/models.py` through `shop/__init__.py`,
 * which re-exports `Order`; `import { Button } from './components'` reaches
 * `components/Button.ts` through `components/index.ts`. Deleting the
 * re-exporting file left every importer linked through it: those edges point
 * into files that stay, so nothing removed them, while a fresh index of the
 * tree without the file links them by name or not at all. And a module that
 * appeared after its importers were bound by name in its absence left those
 * edges as the name lookup made them, while a fresh index binds them through
 * the module.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

type Files = Record<string, string>;

/**
 * Python: an absolute import, imports from inside and beside the package, a
 * renamed re-export, a plain module, a subpackage imported from the package
 * around it (`from app import orm`, then `orm.Model`), and an import inside a
 * function, which has no import node. Two packages re-export the shop package
 * in turn, one with a star import and one by name, and are imported in its
 * stead. `vendored.py` makes `shop` as common a name among failed imports as
 * `models` or `test` is in a large project: more than sync's failed-import
 * retry looks up by name.
 */
const PYTHON: Files = {
  'vendored.py': Array.from({ length: 501 }, (_, i) => `import vendor${i}.shop\n`).join(''),
  'app/store/__init__.py': 'from app.shop import *\n',
  'report.py': 'from app.store import Order\n\n\ndef report():\n    return Order()\n',
  'app/front/__init__.py': 'from ..shop import Cart as Basket\n',
  'kiosk.py': 'from app.front import Basket\n\n\ndef sell():\n    return Basket()\n',
  'app/__init__.py': '',
  'app/shop/models.py': 'class _Order:\n    pass\n\n\nclass Cart:\n    pass\n',
  'app/shop/__init__.py': 'from .models import _Order as Order\nfrom .models import Cart\n',
  'app/shop/api/views.py': 'from .. import Order, Cart\n\n\ndef view():\n    return Order(), Cart()\n',
  'app/checkout.py': 'from .shop import Cart\n\n\ndef run():\n    return Cart()\n',
  'main.py': 'from app.shop import Order\n\n\ndef go():\n    return Order()\n',
  'lib/__init__.py': '',
  'lib/impl.py': 'def helper():\n    return 1\n',
  'lib/api.py': 'from .impl import helper as public_helper\n',
  'tool.py': 'from lib.api import public_helper\n\n\ndef use():\n    return public_helper()\n',
  'app/orm/base.py': 'class _Model:\n    pass\n',
  'app/orm/__init__.py': 'from .base import _Model as Model\n',
  'app/blog.py': 'from app import orm\n\n\nclass Post(orm.Model):\n    pass\n',
  'test_orders.py': 'def test_order():\n    from app.shop import Order\n    return Order()\n',
};
const PYTHON_BARRELS = ['app/shop/__init__.py', 'lib/api.py', 'app/orm/__init__.py'];

/**
 * ES modules: an `index.ts` re-exporting under the same name and under
 * another, and modules re-exporting it in turn — an outer `index.ts`, all of
 * it and one name renamed, and a module passing on one name, read through a
 * namespace import — imported in its stead. It is imported from Vue
 * components too (one beside it, as `.`), and through a scoped package a
 * `tsconfig` path maps to it.
 */
const TS: Files = {
  'package.json': '{"name":"app"}',
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/widgets': ['./src/components/index.ts'] } } }),
  'src/View.vue':
    "<script setup lang=\"ts\">\nimport { Button } from './components';\nconst label = Button();\n</script>\n<template><div>{{ label }}</div></template>\n",
  'src/aliased.ts': "import { Button } from '@app/widgets';\nexport function aliased() { return Button(); }\n",
  'src/components/Panel.vue':
    "<script setup lang=\"ts\">\nimport { Button } from '.';\nconst inner = Button();\n</script>\n<template><div>{{ inner }}</div></template>\n",
  'src/components/Button.ts': 'export function Button() { return 1; }\n',
  'src/components/Icon.ts': 'export function BaseIcon() { return 2; }\n',
  'src/components/index.ts': "export { Button } from './Button';\nexport { BaseIcon as Icon } from './Icon';\n",
  'src/app.ts': "import { Button, Icon } from './components';\nexport function render() { return [Button(), Icon()]; }\n",
  'src/ui/index.ts': "export * from '../components';\nexport { Icon as UiIcon } from '../components';\n",
  'src/page.ts': "import { Button, UiIcon } from './ui';\nexport function page() { return [Button(), UiIcon()]; }\n",
  'src/kit.ts': "export { Button as KitButton } from './components';\n",
  'src/screen.ts': "import * as kit from './kit';\nexport function screen() { return kit.KitButton(); }\n",
};
const TS_BARRELS = ['src/components/index.ts'];

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-importers-'));
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

/** The tree, indexed from scratch in a folder of its own: what the sync has to match. */
async function fullIndexOf(files: Files): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  return edgesOf(await index(root));
}

const without = (files: Files, gone: string[]): Files =>
  Object.fromEntries(Object.entries(files).filter(([file]) => !gone.includes(file)));
const only = (files: Files, kept: string[]): Files =>
  Object.fromEntries(Object.entries(files).filter(([file]) => kept.includes(file)));

/**
 * A file beside the one an extensionless import resolved to, which outranks
 * it: a component's `./button` names `button.ts` when it is there, and
 * `button.vue` when it is not — `sizeOf`, which both export, from the one or
 * the other, and `onlyVue`, which only `button.vue` exports, through it or by
 * its name.
 */
const OUTRANKING: Files = {
  'package.json': '{"name":"app"}',
  'src/widgets/button.vue':
    '<script lang="ts">\nexport function sizeOf() { return 1; }\nexport function onlyVue() { return 3; }\n</script>\n<template><button /></template>\n',
  'src/widgets/button.ts':
    "export default function button() { return 'b'; }\nexport function buttonClass() { return 'c'; }\nexport function sizeOf() { return 2; }\n",
  'src/widgets/group.vue':
    "<script setup lang=\"ts\">\nimport Button, { buttonClass, sizeOf, onlyVue } from './button';\nconst c = buttonClass();\nconst b = Button();\nconst s = sizeOf();\nconst o = onlyVue();\n</script>\n<template><div>{{ c }}{{ b }}{{ s }}{{ o }}</div></template>\n",
  'src/widgets/panel.ts': "import button from './button';\nexport function panel() { return button(); }\n",
};
const OUTRANKING_FILES = ['src/widgets/button.ts'];

describe.each([
  ['Python package and module', PYTHON, PYTHON_BARRELS],
  ['ES module barrel', TS, TS_BARRELS],
  ['file outranking the one an import resolved to', OUTRANKING, OUTRANKING_FILES],
])('sync re-resolves the imports through a re-exporting file: %s', (_label, files, barrels) => {
  it('when it is deleted', async () => {
    const root = tempRoot();
    write(root, files);
    const graph = await index(root);

    for (const file of barrels) fs.rmSync(path.join(root, file));
    expect((await graph.sync()).filesRemoved).toBe(barrels.length);
    expect(edgesOf(graph)).toEqual(await fullIndexOf(without(files, barrels)));
  }, 120_000);

  it('when it comes back after it was deleted', async () => {
    const root = tempRoot();
    write(root, files);
    const graph = await index(root);

    for (const file of barrels) fs.rmSync(path.join(root, file));
    await graph.sync();
    write(root, only(files, barrels));
    expect((await graph.sync()).filesAdded).toBe(barrels.length);
    expect(edgesOf(graph)).toEqual(await fullIndexOf(files));
  }, 120_000);

  it('when it appears after its importers were bound without it', async () => {
    const root = tempRoot();
    write(root, without(files, barrels));
    const graph = await index(root);

    write(root, only(files, barrels));
    expect((await graph.sync()).filesAdded).toBe(barrels.length);
    expect(edgesOf(graph)).toEqual(await fullIndexOf(files));
  }, 120_000);
});
