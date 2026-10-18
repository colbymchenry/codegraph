/**
 * A call on a TypeScript local or parameter annotated as an array of a class
 * is the array's method, not the class's.
 *
 * `items: Item[]` was read as an `Item`, because the annotation's capture
 * stopped at `[`, so `items.find(…)` linked to `Item.find` whenever the class
 * declares a method of that name: on vscode, `distinctElements.find(…)` on
 * an `ExplorerItem[]` reached `ExplorerItem.find`, and `ranges.map(…)` on an
 * `OffsetRange[]` reached `OffsetRange.map`. A method arrays don't have can
 * only be called on an element that shares the array's name, as in
 * `d.forEach(d => d.dispose())`, and that one keeps the element's type.
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

/** Index `files` and return each call edge as `<refName> -> <target qualified name>`. */
async function callsOf(files: Record<string, string>): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-array-recv-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  const nodes = graph.getFiles().flatMap((f) => graph.getNodesInFile(f.path));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return graph.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['calls'])
    .map((e) => `${e.metadata?.refName} -> ${byId.get(e.target)?.qualifiedName}`)
    .sort();
}

const CLASSES = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/item.ts':
    'export class Item {\n' +
    '  find(key: string) { return key; }\n' +
    '  push(value: number) { return value; }\n' +
    '  flush() { return 0; }\n' +
    '}\n' +
    'export class Repository<T> {\n' +
    '  save(value: T) { return value; }\n' +
    '  find(id: string) { return id; }\n' +
    '}\n',
  // The one project method named `findLast`, on an unrelated class.
  'src/stack.ts': 'export class Stack {\n  findLast() { return 1; }\n}\n',
};

describe('a call on a TypeScript local annotated as an array of a class', () => {
  it('links to no method of the element class', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function first(items: Item[]) {\n' +
        "  return items.find((i) => i !== undefined);\n" +
        '}\n' +
        'export function fill() {\n' +
        '  const list: Item[] = [];\n' +
        '  list.push(new Item());\n' +
        '  return list;\n' +
        '}\n' +
        'export function spaced(all: Item [], grid: Item[][]) {\n' +
        "  all.find((i) => i !== undefined);\n" +
        '  return grid.push([]);\n' +
        '}\n',
    });
    expect(calls.filter((c) => /^(items|list|all|grid)\./.test(c))).toEqual([]);
  }, 60_000);

  it("is not matched to another class's method by the call's name instead", async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function last(all: Item[]) {\n' +
        '  return all.findLast((i) => i !== undefined);\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('all.'))).toEqual([]);
  }, 60_000);

  it('does the same for an array of a generic class', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Repository } from './item';\n" +
        'export function saveAll(repos: Repository<string>[], value: string) {\n' +
        '  repos.forEach((r) => r.save(value));\n' +
        "  return repos.find((r) => r !== undefined);\n" +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('repos.'))).toEqual([]);
  }, 60_000);

  it("still links a method arrays don't have to the element's class: the call is on an element of the same name", async () => {
    // vscode's `d.forEach(d => d.dispose())` on an `IDisposable[]`, and
    // `extensions.map(extensions => extensions.syncInstalledExtensionsWithGallery(…))`.
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function flushAll(d: Item[]) {\n' +
        '  d.forEach((d) => d.flush());\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('d.'))).toEqual(['d.flush -> Item::flush']);
  }, 60_000);

  it('still links a call on a local annotated as the class, generic or not', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item, Repository } from './item';\n" +
        'export function one(item: Item, repo: Repository<string>) {\n' +
        "  repo.find('x');\n" +
        "  return item.find('k');\n" +
        '}\n',
    });
    expect(calls).toEqual(['item.find -> Item::find', 'repo.find -> Repository::find']);
  }, 60_000);
});
