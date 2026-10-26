/**
 * A sync re-links what a default import reads when the module's default changes.
 *
 * `import Y from './x'; new Y()` resolves to whatever `x` exports as its
 * default. When an edit makes that another declaration (`export default A`
 * becomes `export default B`) or stops exporting one, while the old default
 * stays declared, a sync moved the edges other files made into `x` onto the
 * node that replaces each old target. That is still `A`, so `new Y()` kept
 * linking `A` where a full index links `B` (or nothing). An `export default`
 * statement is no node, so neither the definition delta (CG-33) nor the
 * failed-reference retry (#1240, #2450) saw it change.
 *
 * Each case indexes the first tree, edits it, syncs, and compares the graph
 * with a full index of the final tree in a folder of its own (#2411).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';

type Files = Record<string, string>;

const run = '{ static create() { return 1; } run(): number { return 1; } }';

/** Every way another file reaches `src/x.ts`'s default export, and a named import that must stay put. */
const READERS: Files = {
  'src/y.ts': "import Y from './x';\nexport function make(): unknown { return new Y(); }\nexport function build(): unknown { return Y.create(); }\nexport let held: Y | undefined;\n",
  'src/w.ts': "import { default as W } from './x';\nexport function wrap(): unknown { return new W(); }\n",
  'src/r.ts': "export function load(): unknown { const R = require('./x').default; return new R(); }\n",
  'src/n.ts': "import { A } from './x';\nexport function named(): unknown { return new A(); }\n",
  // A value typed by the default, and a subclass of it, reach its members by name only.
  'src/t.ts': "import T from './x';\nexport function typed(v: T): number { return v.run(); }\n",
  'src/s.ts': "import S from './x';\nexport class Sub extends S { go(): number { return this.run(); } }\n",
};

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-default-'));
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

/** Where each reference to `refName` landed: `<source> -> <target kind> <file>::<qualified name>`. */
function targetsOf(graph: CodeGraph, refName: string): string[] {
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  return graph.getOutgoingEdgesFrom(ids)
    .filter((e) => e.metadata?.refName === refName && e.kind !== 'imports')
    .map((e) => {
      const target = graph.getNode(e.target)!;
      return `${graph.getNode(e.source)!.name} -> ${target.kind} ${target.filePath}::${target.qualifiedName}`;
    })
    .sort();
}

/** Index `before`, write `after` over it, sync; return the graph and what a full index of `after` holds. */
async function syncEdit(before: Files, after: Files): Promise<{ root: string; graph: CodeGraph; full: string[]; modified: number }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  write(root, after);
  const result = await graph.sync();
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  const full = stateOf(fullRoot, await index(fullRoot));
  return { root, graph, full, modified: result.filesModified };
}

describe('sync re-links default-import readers when the module default changes', () => {
  it('when `export default` names another declaration', async () => {
    const reopened = vi.spyOn(QueryBuilder.prototype, 'replaceResolutionEdgesWithUnresolvedRefs');
    const before = { ...READERS, 'src/x.ts': `export class A ${run}\nexport class B ${run}\nexport default A;\n` };
    const after = { 'src/x.ts': `export class A ${run}\nexport class B ${run}\nexport default B;\n` };
    const { root, graph, full, modified } = await syncEdit(before, after);
    expect(modified).toBe(1);
    // What reads the default went back, and what reaches the old default's
    // members; not the named import, which reads A as before.
    expect(reopened.mock.calls.flatMap(([, refs]) => refs.map((ref) => ref.referenceName)).sort())
      .toEqual(['R', 'S', 'T', 'W', 'Y', 'Y', 'Y.create', 'run', 'v.run']);
    expect(targetsOf(graph, 'Y')).toEqual(['held -> class src/x.ts::B', 'make -> class src/x.ts::B']);
    expect(targetsOf(graph, 'Y.create')).toEqual(['build -> method src/x.ts::B::create']);
    expect(targetsOf(graph, 'W')).toEqual(['wrap -> class src/x.ts::B']);
    expect(targetsOf(graph, 'R')).toEqual(['load -> class src/x.ts::B']);
    expect(targetsOf(graph, 'v.run')).toEqual(['typed -> method src/x.ts::B::run']);
    expect(targetsOf(graph, 'S')).toEqual(['Sub -> class src/x.ts::B']);
    // The named import still reads A.
    expect(targetsOf(graph, 'A')).toEqual(['named -> class src/x.ts::A']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when a route renders the default as its layout', async () => {
    const root = (dflt: string): Files => ({
      'src/root.tsx': `export function AppRoot() { return null; }\nexport function Shell() { return null; }\nexport default ${dflt};\n`,
    });
    const before = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
      'src/router.tsx': "import { createBrowserRouter } from 'react-router-dom';\nimport { default as AppRoot } from './root';\nimport { One } from './one';\n" +
        "export const router = createBrowserRouter([\n  {\n    path: '/app',\n    element: <AppRoot />,\n    children: [{ path: 'one', element: <One /> }],\n  },\n]);\n",
      'src/one.tsx': 'export function One() { return null; }\n',
      ...root('AppRoot'),
    };
    const { root: dir, graph, full } = await syncEdit(before, root('Shell'));
    expect(targetsOf(graph, 'layout:AppRoot').every((t) => t.endsWith('::Shell'))).toBe(true);
    expect(stateOf(dir, graph)).toEqual(full);
  }, 120_000);

  it('when the default declaration moves to another class', async () => {
    const before = { ...READERS, 'src/x.ts': `export default class A ${run}\nexport class B ${run}\n` };
    const after = { 'src/x.ts': `export default class B ${run}\nexport class A ${run}\n` };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Y')).toEqual(['held -> class src/x.ts::B', 'make -> class src/x.ts::B']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('when the module stops exporting a default', async () => {
    // Without `src/n.ts`: `{ A }` names a class exported only as the default,
    // which no import of it reaches, so only a name match ever linked it.
    const defaultReaders = Object.fromEntries(Object.entries(READERS).filter(([file]) => file !== 'src/n.ts'));
    const before = { ...defaultReaders, 'src/x.ts': `export const VERSION = 1;\nclass A ${run}\nexport default A;\n` };
    const after = { 'src/x.ts': `export const VERSION = 1;\nclass A ${run}\n` };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Y')).toEqual([]);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('when a module forwards another module\'s default', async () => {
    const lib = (from: string): Files => ({ 'src/lib/index.ts': `export { default } from './${from}';\n` });
    const before = {
      'src/lib/a.ts': `export default class A ${run}\n`,
      'src/lib/b.ts': `export default class B ${run}\n`,
      'src/y.ts': "import Y from './lib';\nexport function make(): unknown { return new Y(); }\n",
      ...lib('a'),
    };
    const { root, graph, full } = await syncEdit(before, lib('b'));
    expect(targetsOf(graph, 'Y')).toEqual(['make -> class src/lib/b.ts::B']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('and puts nothing back when an edit leaves the default alone', async () => {
    const moved = vi.spyOn(ReferenceResolver.prototype, 'changedDefaultExports');
    const before = {
      ...READERS,
      'src/x.ts': `export class A ${run}\nexport class B ${run}\nexport default A;\n`,
      // A default that is an alias: a call through it links the function it names.
      'src/alias.ts': 'function impl(): number { return 1; }\nconst go = impl;\nexport default go;\n',
      'src/use-alias.ts': "import start from './alias';\nexport function call(): number { return start(); }\n",
    };
    const after = {
      'src/x.ts': `export class A { static create() { return 2; } run(): number { return 2; } }\nexport class B ${run}\nexport default A;\n`,
      'src/alias.ts': 'function impl(): number { return 2; }\nconst go = impl;\nexport default go;\n',
    };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'start')).toEqual(['call -> function src/alias.ts::impl']);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved.mock.results[0]!.value).toEqual([]);
    expect(targetsOf(graph, 'Y')).toEqual(['held -> class src/x.ts::A', 'make -> class src/x.ts::A']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);
});
