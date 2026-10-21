/**
 * A barrel's own `export { A, B as C } from './x'` links each name it passes
 * on to what that module exports under it. No import statement binds a
 * re-exported name, so the resolver used to look it up by name alone: in
 * luci-go's milo/ui, `export { DefaultExpandedProvider, … } from './context'`
 * in the commit table's `context/index.ts` linked to a namesake the build
 * table's `context.ts` declares, as soon as both were indexed. A name a barrel
 * passes on from a package (`export { debounce } from 'lodash'`) is the
 * package's, never a project namesake.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

type Files = Record<string, string>;

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  graphs = [];
  dirs = [];
});

const write = (dir: string, files: Files): void => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
};

/** A project of `files`, indexed from scratch in a folder of its own. */
const indexed = async (files: Files): Promise<{ dir: string; graph: CodeGraph }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-named-reexport-'));
  dirs.push(dir);
  write(dir, files);
  const graph = await CodeGraph.init(dir, { index: true });
  graphs.push(graph);
  return { dir, graph };
};

/** What `file`'s `imports` edges to symbols reach, as `name@file`, by the name imported. */
const reExportLinks = (graph: CodeGraph, file: string): Record<string, string[]> => {
  const fileNode = graph.getNodesInFile(file).find((n) => n.kind === 'file')!;
  const out: Record<string, string[]> = {};
  for (const edge of graph.getOutgoingEdges(fileNode.id)) {
    if (edge.kind !== 'imports') continue;
    const target = graph.getNode(edge.target)!;
    if (target.kind === 'file') continue;
    const refName = String((edge.metadata as Record<string, unknown> | undefined)?.refName);
    (out[refName] ??= []).push(`${target.name}@${target.filePath}`);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
};

const PACKAGE = JSON.stringify({ name: 'app', private: true, dependencies: { react: '^18', lodash: '^4' } });

describe('a re-export links what its module exports', () => {
  it('passes on the module\'s own export, not a namesake elsewhere', async () => {
    const { graph } = await indexed({
      'package.json': PACKAGE,
      'src/table/context/index.ts': "export { Provider, Lonely } from './context';\nexport { Provider as TableProvider } from './context';\n",
      'src/table/context/context.tsx': 'export const Provider = 1;\nexport const Lonely = 2;\n',
      'src/grid/context.ts': 'export const Provider = 3;\nexport const Lonely = 4;\n',
    });
    expect(reExportLinks(graph, 'src/table/context/index.ts')).toEqual({
      Provider: ['Provider@src/table/context/context.tsx', 'Provider@src/table/context/context.tsx'],
      Lonely: ['Lonely@src/table/context/context.tsx'],
    });
  }, 60_000);

  it('follows a module that passes the name on itself', async () => {
    const { graph } = await indexed({
      'package.json': PACKAGE,
      'src/kit/index.ts': "export { Button } from './inner';\n",
      'src/kit/inner.ts': "export { Button } from './button/button';\n",
      'src/kit/button/button.tsx': 'export function Button() {\n  return null;\n}\n',
      'src/legacy/Button.tsx': 'export function Button() {\n  return null;\n}\n',
    });
    expect(reExportLinks(graph, 'src/kit/index.ts')).toEqual({ Button: ['Button@src/kit/button/button.tsx'] });
    expect(reExportLinks(graph, 'src/kit/inner.ts')).toEqual({ Button: ['Button@src/kit/button/button.tsx'] });
  }, 60_000);

  it('leaves a name a package passes on to the package', async () => {
    const { graph } = await indexed({
      'package.json': PACKAGE,
      'src/hooks/index.ts': "export { debounce } from 'lodash';\nexport { useCounter } from './counter';\n",
      'src/hooks/counter.ts': 'export function useCounter() {\n  return 0;\n}\n',
      'src/legacy/timing.ts': 'export function debounce() {\n  return 0;\n}\n',
    });
    expect(reExportLinks(graph, 'src/hooks/index.ts')).toEqual({ useCounter: ['useCounter@src/hooks/counter.ts'] });
  }, 60_000);
});

describe('sync, for a re-export', () => {
  const BARREL: Files = {
    'package.json': PACKAGE,
    'src/table/context/index.ts': "export { Provider } from './context';\n",
    'src/grid/context.ts': 'export const Provider = 3;\n',
  };
  const MODULE: Files = {
    'src/table/context/context.tsx': 'export const Provider = 1;\n',
  };

  it('moves to the module once it appears, as a fresh index has it', async () => {
    const { dir, graph } = await indexed(BARREL);
    write(dir, MODULE);
    expect((await graph.sync()).filesAdded).toBe(1);
    const expected = { Provider: ['Provider@src/table/context/context.tsx'] };
    expect(reExportLinks(graph, 'src/table/context/index.ts')).toEqual(expected);
    expect(reExportLinks((await indexed({ ...BARREL, ...MODULE })).graph, 'src/table/context/index.ts')).toEqual(expected);
  }, 60_000);
});
