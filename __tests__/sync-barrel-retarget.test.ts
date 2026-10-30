/**
 * A sync follows a barrel whose re-export points elsewhere (#2978).
 *
 * `c.ts` imports `foo` through `index.ts`, which re-exports it from `a.ts`.
 * When the barrel's clause is changed to `b.ts`, the barrel declares nothing
 * of `foo` and `c.ts` did not change, so no definition delta, added file or
 * failed reference named `c.ts`'s binding, and it stayed on `a.ts` until a
 * full re-index. The importers of a module whose re-exports changed now have
 * their bindings through it re-resolved.
 *
 * Each case indexes the first tree, edits it, syncs, and compares edges and
 * unresolved references with a full index of the final tree in a folder of
 * its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';

type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-barrel-retarget-'));
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

/** Every edge by its ends' natural keys, and every reference left unresolved. */
function stateOf(root: string, graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`);
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const refs = (db.getDb()
      .prepare('SELECT reference_name, reference_kind, file_path, line, col, status, name_tail FROM unresolved_refs')
      .all() as Array<Record<string, unknown>>)
      .map((r) => `ref ${r.file_path}:${r.line}:${r.col} ${r.reference_kind} ${r.reference_name} ${r.status} ${r.name_tail}`);
    return [...edges, ...refs].sort();
  } finally {
    db.close();
  }
}

/** Where `bar`'s call to `foo` lands: `<file>::<qualified name>`, or nothing. */
function fooCalledBy(graph: CodeGraph): string[] {
  const bar = graph.getNodesByQualifiedName('bar')[0]!;
  return graph.getOutgoingEdges(bar.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${graph.getNode(e.target)!.filePath}::${graph.getNode(e.target)!.qualifiedName}`)
    .sort();
}

/** Index `before`, write `after` over it, sync (scoped to `paths` when given); return the graph and a full index of the final tree. */
async function syncEdit(before: Files, after: Files, paths?: string[]): Promise<{ root: string; graph: CodeGraph; full: string[] }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  expect(fooCalledBy(graph)).toEqual(['src/a.ts::foo']);
  write(root, after);
  await graph.sync(paths ? { paths } : {});
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  return { root, graph, full: stateOf(fullRoot, await index(fullRoot)) };
}

const BEFORE: Files = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/a.ts': 'export function foo() { return 1; }\n',
  'src/b.ts': 'export function foo() { return 2; }\n',
  'src/index.ts': "export { foo } from './a';\n",
  'src/c.ts': "import { foo } from './index';\nexport function bar() { return foo(); }\n",
};

describe('a sync follows a barrel whose re-export points elsewhere (#2978)', () => {
  it('a named re-export retargeted to another module', async () => {
    const { root, graph, full } = await syncEdit(BEFORE, { 'src/index.ts': "export { foo } from './b';\n" });
    expect(fooCalledBy(graph)).toEqual(['src/b.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('an `export *` retargeted to another module', async () => {
    const before = { ...BEFORE, 'src/index.ts': "export * from './a';\n" };
    const { root, graph, full } = await syncEdit(before, { 'src/index.ts': "export * from './b';\n" });
    expect(fooCalledBy(graph)).toEqual(['src/b.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a scoped sync of the barrel alone', async () => {
    const { root, graph, full } = await syncEdit(BEFORE, { 'src/index.ts': "export { foo } from './b';\n" }, ['src/index.ts']);
    expect(fooCalledBy(graph)).toEqual(['src/b.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a re-export taken away leaves the importer where a full index leaves it', async () => {
    // The import fails through the barrel now; whatever a full index then
    // links the call to by name, the sync links it to the same way.
    const { root, graph, full } = await syncEdit(BEFORE, { 'src/index.ts': 'export const version = 1;\n' });
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('through a second barrel that passes the first one on', async () => {
    const before = {
      ...BEFORE,
      'src/lib.ts': "export * from './index';\n",
      'src/c.ts': "import { foo } from './lib';\nexport function bar() { return foo(); }\n",
    };
    const { root, graph, full } = await syncEdit(before, { 'src/index.ts': "export { foo } from './b';\n" });
    expect(fooCalledBy(graph)).toEqual(['src/b.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a value typed by the binding reaches the members of the new target', async () => {
    const before: Files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.ts': 'export class Widget { run(): number { return 1; } }\n',
      'src/b.ts': 'export class Widget { run(): number { return 2; } }\n',
      'src/index.ts': "export { Widget } from './a';\n",
      'src/c.ts': "import { Widget } from './index';\nexport function make(): number { const w = new Widget(); return w.run(); }\n",
    };
    const root = tempRoot();
    write(root, before);
    const graph = await index(root);
    const runTargets = (g: CodeGraph) => g.getOutgoingEdges(g.getNodesByQualifiedName('make')[0]!.id)
      .filter((e) => e.kind === 'calls' && e.metadata?.refName === 'w.run')
      .map((e) => `${g.getNode(e.target)!.filePath}::${g.getNode(e.target)!.qualifiedName}`);
    expect(runTargets(graph)).toEqual(['src/a.ts::Widget::run']);
    write(root, { 'src/index.ts': "export { Widget } from './b';\n" });
    await graph.sync();
    expect(runTargets(graph)).toEqual(['src/b.ts::Widget::run']);
    const fullRoot = tempRoot();
    write(fullRoot, { ...before, 'src/index.ts': "export { Widget } from './b';\n" });
    expect(stateOf(root, graph)).toEqual(stateOf(fullRoot, await index(fullRoot)));
  }, 120_000);

  it('a body-only edit of the barrel re-resolves nothing', async () => {
    const root = tempRoot();
    write(root, { ...BEFORE, 'src/index.ts': "export { foo } from './a';\nexport const version = 1;\n" });
    const graph = await index(root);
    const before = stateOf(root, graph);
    write(root, { 'src/index.ts': "export { foo } from './a';\nexport const version = 2;\n" });
    const result = await graph.sync();
    expect(result.reExportsChangedFilePaths).toBeUndefined();
    expect(stateOf(root, graph)).toEqual(before);
  }, 120_000);

  it('a name dropped from a re-export whose module stays', async () => {
    // The barrel still names `./a`, so only the clause's names tell the edit.
    const before: Files = {
      ...BEFORE,
      'src/a.ts': 'export function foo() { return 1; }\nexport function qux() { return 3; }\n',
      'src/index.ts': "export { foo, qux } from './a';\n",
      'src/c.ts': "import { foo, qux } from './index';\nexport function bar() { return foo(); }\nexport function baz() { return qux(); }\n",
    };
    const { root, graph, full } = await syncEdit(before, { 'src/index.ts': "export { foo } from './a';\n" });
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a plain import edit in a module others import reports nothing', async () => {
    // Importers bind through `util.ts`, which passes nothing on: dropping its
    // own import moves none of their bindings.
    const root = tempRoot();
    write(root, {
      ...BEFORE,
      'src/util.ts': "import { foo } from './a';\nexport function helper() { return foo(); }\n",
      'src/c.ts': "import { helper } from './util';\nexport function bar() { return helper(); }\n",
    });
    const graph = await index(root);
    write(root, { 'src/util.ts': 'export function helper() { return 5; }\n' });
    const result = await graph.sync();
    expect(result.reExportsChangedFilePaths).toBeUndefined();
    const fullRoot = tempRoot();
    write(fullRoot, { ...BEFORE, 'src/util.ts': 'export function helper() { return 5; }\n', 'src/c.ts': "import { helper } from './util';\nexport function bar() { return helper(); }\n" });
    expect(stateOf(root, graph)).toEqual(stateOf(fullRoot, await index(fullRoot)));
  }, 120_000);
});
