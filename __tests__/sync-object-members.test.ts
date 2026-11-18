/**
 * A sync re-links calls through an object literal whose members an edit
 * changed (#3015).
 *
 * `api.bar()` after `import { api } from './api'`, with `export const api =
 * { foo, bar }`, binds to the member the literal names, and to the object
 * itself when it names none. The caller's file is unchanged, and an edit that
 * adds, drops or rebinds a member (`{ foo }` to `{ foo, bar }`, `{ bar }` to
 * `{ bar: baz }`) declares no name, so neither the definition-delta rebind
 * (CG-33) nor any other sync pass re-opened the call: it kept its old target
 * until the caller changed or the project was indexed again.
 *
 * Each case indexes the first tree, edits it, syncs, and compares the graph
 * with a full index of the final tree in a folder of its own.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

type Files = Record<string, string>;

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-members-'));
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

/** Where each call through `refName` landed: `<caller> -> <target kind> <file>::<qualified name>`. */
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
async function syncEdit(before: Files, after: Files): Promise<{ root: string; graph: CodeGraph; full: string[] }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  write(root, after);
  await graph.sync();
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  const full = stateOf(fullRoot, await index(fullRoot));
  return { root, graph, full };
}

const LIB = (members: string): string =>
  `function foo() { return 1; }\nfunction bar() { return 2; }\nexport function baz() { return 3; }\nexport const __testing = { ${members} };\n`;
const CALLER: Files = {
  'src/lib.test.ts': "import { __testing } from './lib';\nexport function t() { return __testing.bar(); }\n",
};

describe('sync re-links calls through an object literal whose members changed (#3015)', () => {
  it('when an edit adds the member', async () => {
    const { root, graph, full } = await syncEdit({ ...CALLER, 'src/lib.ts': LIB('foo') }, { 'src/lib.ts': LIB('foo, bar') });
    expect(targetsOf(graph, '__testing.bar')).toEqual(['t -> function src/lib.ts::bar']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when an edit removes the member', async () => {
    const { root, graph, full } = await syncEdit({ ...CALLER, 'src/lib.ts': LIB('foo, bar') }, { 'src/lib.ts': LIB('foo') });
    expect(targetsOf(graph, '__testing.bar')).toEqual(['t -> constant src/lib.ts::__testing']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('when an edit points the member at another binding', async () => {
    const { root, graph, full } = await syncEdit({ ...CALLER, 'src/lib.ts': LIB('foo, bar') }, { 'src/lib.ts': LIB('foo, bar: baz') });
    expect(targetsOf(graph, '__testing.bar')).toEqual(['t -> function src/lib.ts::baz']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('when an edit writes the member inline', async () => {
    const { root, graph, full } = await syncEdit(
      { ...CALLER, 'src/lib.ts': LIB('foo, bar') },
      { 'src/lib.ts': LIB('foo, bar() { return 4; }') },
    );
    expect(targetsOf(graph, '__testing.bar')).toEqual(['t -> function src/lib.ts::__testing::bar']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('through a facade whose members come from another module, under an alias and a barrel', async () => {
    const before: Files = {
      'src/impl.ts': 'export function foo() { return 1; }\nexport function bar() { return 2; }\n',
      'src/api.ts': "import { foo, bar } from './impl';\nexport const api = { foo, bar };\n",
      'src/index.ts': "export { api } from './api';\n",
      'src/use.ts': "import { api as A } from './api';\nexport function use() { return A.bar(); }\n",
      'src/viaBarrel.ts': "import { api } from './index';\nexport function viaBarrel() { return api.bar(); }\n",
    };
    const { root, graph, full } = await syncEdit(before, { 'src/api.ts': "import { foo, bar } from './impl';\nexport const api = { foo };\n" });
    expect(targetsOf(graph, 'A.bar')).toEqual(['use -> constant src/api.ts::api']);
    expect(targetsOf(graph, 'api.bar')).toEqual(['viaBarrel -> constant src/api.ts::api']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('leaves a member alone that names an import under another name, on an edit that keeps it', async () => {
    const reopened = vi.spyOn(QueryBuilder.prototype, 'replaceResolutionEdgesWithUnresolvedRefs');
    const api = (extra: string): string =>
      `import { getUser as fetchUser } from './users';\nexport const api = { fetchUser };\n${extra}`;
    const { root, graph, full } = await syncEdit(
      {
        'src/users.ts': 'export function getUser() { return 1; }\n',
        'src/api.ts': api(''),
        'src/page.ts': "import { api } from './api';\nexport function page() { return api.fetchUser(); }\n",
      },
      { 'src/api.ts': api('export const later = 2;\n') },
    );
    const refs = reopened.mock.calls.flatMap(([, refs]) => refs.map((ref) => ref.referenceName));
    expect(refs.filter((name) => name.startsWith('api.'))).toEqual([]);
    expect(targetsOf(graph, 'api.fetchUser')).toEqual(['page -> function src/users.ts::getUser']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('re-opens nothing through a literal whose members an edit left alone', async () => {
    const reopened = vi.spyOn(QueryBuilder.prototype, 'replaceResolutionEdgesWithUnresolvedRefs');
    const { root, graph, full } = await syncEdit(
      { ...CALLER, 'src/lib.ts': LIB('foo, bar') },
      { 'src/lib.ts': LIB('foo, bar').replace('return 2;', 'return 2 + 0;') },
    );
    const refs = reopened.mock.calls.flatMap(([, refs]) => refs.map((ref) => ref.referenceName));
    expect(refs.filter((name) => name.startsWith('__testing.'))).toEqual([]);
    expect(targetsOf(graph, '__testing.bar')).toEqual(['t -> function src/lib.ts::bar']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);
});
