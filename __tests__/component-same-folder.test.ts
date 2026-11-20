/**
 * The folder preference of the React, Svelte, Astro and Vue component
 * resolvers, which pick among several definitions of a component name.
 *
 * They preferred a definition whose path started with the referencing file's
 * folder, compared as text: `src/ui` also starts `src/ui-kit/Widget.tsx`, so
 * `src/ui/Card.tsx`'s `Widget` could land in the sibling folder. A file at the
 * project root has the folder `''`, which every path starts with, so its pick
 * was whatever definition came first, skipping the rule that a name with
 * several definitions and nothing to tell them apart links nothing (#764).
 *
 * The folder is now compared whole, a folder below it still counts, and a root
 * file has no folder to prefer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { inReferencingFolder } from '../src/resolution/frameworks/component-folder';

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  graphs = [];
  dirs = [];
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-component-folder-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const cg = await CodeGraph.init(dir, { index: true });
  graphs.push(cg);
  return cg;
}

/** Every edge the framework resolvers made into a node named `name`, as `file` of the target. */
function frameworkPicks(cg: CodeGraph, name: string): string[] {
  return cg
    .getNodesByName(name)
    .flatMap((target) =>
      cg
        .getIncomingEdges(target.id)
        .filter((e) => (e.metadata as { resolvedBy?: string } | undefined)?.resolvedBy === 'framework')
        .map(() => target.filePath)
    )
    .sort();
}

const REACT = JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } });
const SVELTE = JSON.stringify({ name: 'app', devDependencies: { svelte: '^4.0.0' } });
const ASTRO = JSON.stringify({ name: 'app', dependencies: { astro: '^4.0.0' } });
const VUE = JSON.stringify({ name: 'app', dependencies: { vue: '^3.0.0' } });
const reactWidget = 'export function Widget(props: {}) { return null; }\n';

describe('the folder a component resolver prefers', () => {
  it('compares folders whole, keeps folders below, and gives a root file none', () => {
    const files = ['src/ui-kit/Widget.tsx', 'src/ui/forms/Widget.tsx', 'src/ui/Widget.tsx', 'Widget.tsx'];
    expect(inReferencingFolder('src/ui/Card.tsx', files, (f) => f)).toEqual(['src/ui/forms/Widget.tsx', 'src/ui/Widget.tsx']);
    expect(inReferencingFolder('App.tsx', files, (f) => f)).toEqual([]);
  });

  it('React: a sibling folder that only starts with the same name is not the folder', async () => {
    const cg = await index({
      'package.json': REACT,
      'src/ui/Card.tsx': 'export function Card() {\n  return Widget({});\n}\n',
      'src/ui-kit/Widget.tsx': reactWidget,
      'lib/Widget.tsx': reactWidget,
    });
    // Two definitions, neither in `src/ui/`: the framework has nothing to choose by.
    expect(frameworkPicks(cg, 'Widget')).toEqual([]);
  });

  it('React: the folder itself, and a folder below it, still come first', async () => {
    const cg = await index({
      'package.json': REACT,
      'src/ui/Card.tsx': 'export function Card() {\n  return Widget({});\n}\n',
      'src/ui/Banner.tsx': 'export function Banner() {\n  return Field({});\n}\n',
      'src/ui-kit/Widget.tsx': reactWidget,
      'src/ui/Widget.tsx': reactWidget,
      'src/ui/forms/Field.tsx': 'export function Field(props: {}) { return null; }\n',
      'lib/Field.tsx': 'export function Field(props: {}) { return null; }\n',
    });
    expect(frameworkPicks(cg, 'Widget')).toEqual(['src/ui/Widget.tsx']);
    expect(frameworkPicks(cg, 'Field')).toEqual(['src/ui/forms/Field.tsx']);
  });

  it('React: a file at the project root does not take whichever definition comes first', async () => {
    const cg = await index({
      'package.json': REACT,
      'App.tsx': 'export function App() {\n  return Panel({});\n}\n',
      'src/a/Panel.tsx': 'export function Panel(props: {}) { return null; }\n',
      'src/b/Panel.tsx': 'export function Panel(props: {}) { return null; }\n',
    });
    expect(frameworkPicks(cg, 'Panel')).toEqual([]);
  });

  it('Svelte: a sibling folder that only starts with the same name is not the folder', async () => {
    const cg = await index({
      'package.json': SVELTE,
      'src/ui/mount.ts': 'export function mount() {\n  return Widget({});\n}\n',
      'src/ui-kit/Widget.svelte': '<span>kit</span>\n',
      'lib/Widget.svelte': '<span>lib</span>\n',
    });
    expect(frameworkPicks(cg, 'Widget')).toEqual([]);
  });

  it('Astro: a sibling folder that only starts with the same name is not the folder', async () => {
    const cg = await index({
      'package.json': ASTRO,
      'src/ui/Card.astro': '---\n---\n<div>\n  <Widget />\n</div>\n',
      'src/ui-kit/Widget.astro': '---\n---\n<span>kit</span>\n',
      'lib/Widget.astro': '---\n---\n<span>lib</span>\n',
    });
    expect(frameworkPicks(cg, 'Widget')).toEqual([]);
  });

  it('Vue: a sibling folder that only starts with the same name is not the folder', async () => {
    const cg = await index({
      'package.json': VUE,
      'src/ui/mount.ts': 'export function mount() {\n  return Widget({});\n}\n',
      'src/ui-kit/Widget.vue': '<template><span>kit</span></template>\n',
      'lib/Widget.vue': '<template><span>lib</span></template>\n',
    });
    expect(frameworkPicks(cg, 'Widget')).toEqual([]);
  });
});
