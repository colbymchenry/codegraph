/**
 * A sync links a member call on a local typed by an imported class once the
 * class's module appears.
 *
 * `const cache = new LRUCache<string, number>(2)` after `import { LRUCache }
 * from './lru-cache'`, then `cache.get(key)`: a fresh index reads the local's
 * declaration and links the call to `LRUCache.get` (folo's lru-cache tests,
 * milo-ui's `astCache.get`). The same holds for an annotated local, a typed
 * parameter and a class imported by default or through a namespace. While the
 * module was missing or empty the call failed, and it was parked under its
 * member's name, `get`, which more failed calls share than the retry's
 * ceiling: a sync that brought the class back never retried it.
 *
 * Such a call is now parked under the key of the module the type's binding
 * imports, as #2630 parks a member of the binding itself, and keeps its
 * member's name as a key under that name's ceiling.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';

type Files = Record<string, string>;

/** 501 failed `get` calls on a receiver nothing declares: `get` is past the retry's ceiling. */
const NOISE = `export function noise() {\n${Array.from({ length: 501 }, (_, i) => `  extApi.get(${i});`).join('\n')}\n}\n`;

/** The files that call members of locals typed by a class they import. */
const CALLERS: Files = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/use-new.ts': "import { LRUCache } from './lru-cache';\nexport function a() {\n  const cache = new LRUCache<string, number>(10);\n  cache.set('k', 1);\n  return cache.get('k');\n}\n",
  'src/use-annotated.ts': "import { LRUCache } from './lru-cache';\nexport function b(make: () => LRUCache<string, number>) {\n  const cache: LRUCache<string, number> = make();\n  return cache.get('k');\n}\n",
  'src/use-param.ts': "import { LRUCache } from './lru-cache';\nexport function c(cache: LRUCache<string, number>) {\n  return cache.get('k');\n}\n",
  'src/use-namespace.ts': "import * as lib from './lru-cache';\nexport function g() {\n  const cache = new lib.LRUCache<string, number>(3);\n  return cache.get('k');\n}\n",
  'src/use-default.ts': "import Store from './store';\nexport function e() {\n  const s = new Store();\n  return s.get();\n}\n",
  // A call on an element that shares the array's name: the element's class.
  'src/use-each.ts': "import { LRUCache } from './lru-cache';\nexport function h(cs: LRUCache<string, number>[]) {\n  cs.forEach((cs) => cs.get('k'));\n}\n",
  // One of the class's properties, which resolution reads as the class.
  'src/use-prop.ts': "import { LRUCache } from './lru-cache';\nexport function i(max: LRUCache<string, number>['max']) {\n  return max.toFixed(0);\n}\n",
  'src/noise.ts': NOISE,
};

const MODULES: Files = {
  'src/lru-cache.ts': 'export class LRUCache<K, V> {\n  constructor(private max: number) {}\n  get(key: K): V | undefined { return undefined; }\n  set(key: K, value: V) { return this; }\n}\n',
  'src/store.ts': 'export default class Store {\n  get() { return 1; }\n}\n',
};

/** What a full index links: `<refName>: <edge> <source file> -> <target kind> <file>::<qualified name>`. */
const LINKS = [
  'cache.get: calls src/use-annotated.ts -> method src/lru-cache.ts::LRUCache::get',
  'cache.get: calls src/use-namespace.ts -> method src/lru-cache.ts::LRUCache::get',
  'cache.get: calls src/use-new.ts -> method src/lru-cache.ts::LRUCache::get',
  'cache.get: calls src/use-param.ts -> method src/lru-cache.ts::LRUCache::get',
  'cache.set: calls src/use-new.ts -> method src/lru-cache.ts::LRUCache::set',
  'cs.get: calls src/use-each.ts -> method src/lru-cache.ts::LRUCache::get',
  's.get: calls src/use-default.ts -> method src/store.ts::Store::get',
];

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-typed-local-'));
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

/** The calls on a lowercase local's member (`cache.get`): `<refName>: <edge> <source file> -> <target kind> <file>::<qualified name>`. */
function localMemberLinksOf(graph: CodeGraph): string[] {
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  const links: string[] = [];
  for (const edge of graph.getOutgoingEdgesFrom(ids, ['calls'])) {
    const ref = edge.metadata?.refName;
    if (typeof ref !== 'string' || !/^[a-z]\w*\.\w+$/.test(ref) || ref.startsWith('extApi.')) continue;
    const source = graph.getNode(edge.source)!;
    const target = graph.getNode(edge.target)!;
    links.push(`${ref}: ${edge.kind} ${source.filePath} -> ${target.kind} ${target.filePath}::${target.qualifiedName}`);
  }
  return [...new Set(links)].sort();
}

/** The final tree, indexed from scratch in a folder of its own: what the sync has to match. */
async function fullIndexOf(files: Files): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  return edgesOf(await index(root));
}

describe('sync links a member call on a local typed by an imported class', () => {
  it('when the class\'s module is added after the callers', async () => {
    const root = tempRoot();
    write(root, CALLERS);
    const graph = await index(root);
    expect(localMemberLinksOf(graph)).toEqual([]);

    write(root, MODULES);
    const result = await graph.sync();
    // The callers did not change: only the retry of their parked refs links them.
    expect(result.filesAdded).toBe(Object.keys(MODULES).length);
    expect(result.filesModified).toBe(0);
    expect(localMemberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...CALLERS, ...MODULES }));
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when the class\'s module comes back after it was deleted', async () => {
    const root = tempRoot();
    write(root, { ...CALLERS, ...MODULES });
    const graph = await index(root);
    expect(localMemberLinksOf(graph)).toEqual(LINKS);

    for (const file of Object.keys(MODULES)) fs.rmSync(path.join(root, file));
    expect((await graph.sync()).filesRemoved).toBe(Object.keys(MODULES).length);
    expect(localMemberLinksOf(graph)).toEqual([]);

    write(root, MODULES);
    expect((await graph.sync()).filesAdded).toBe(Object.keys(MODULES).length);
    expect(localMemberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...CALLERS, ...MODULES }));
  }, 120_000);

  it('when an edit gives the module the class', async () => {
    const root = tempRoot();
    write(root, CALLERS);
    write(root, Object.fromEntries(Object.keys(MODULES).map((file) => [file, 'export const placeholder = 1;\n'])));
    const graph = await index(root);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesModified).toBe(Object.keys(MODULES).length);
    expect(result.filesAdded).toBe(0);
    expect(localMemberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...CALLERS, ...MODULES }));
  }, 120_000);
});

describe('a failed member call on a typed local', () => {
  it('waits for the module of the class its declaration imports, and every other one keeps its own tail', async () => {
    const root = tempRoot();
    write(root, {
      ...CALLERS,
      // A local of a built-in type, of a package's, of a type the file
      // declares itself and one a factory returns: none waits for a module of
      // the project. Nor does a local or a parameter declared as an array of
      // an imported class, whose array methods are the array's, or a method of
      // `this` passed as a value, which resolution looks up in the enclosing
      // class, whatever `this` is declared as.
      'src/other.ts':
        "import { createCache, LRUCache } from './factory';\n" +
        "import QuickLRU from 'quick-lru';\n" +
        'class Local { get() { return 1; } }\n' +
        'export function run() {\n' +
        '  const seen = new Map<string, number>();\n' +
        "  seen.get('k');\n" +
        '  const pkg = new QuickLRU();\n' +
        "  pkg.get('k');\n" +
        '  const mine: Local = new Local();\n' +
        '  mine.peek();\n' +
        '  const made = createCache();\n' +
        "  made.get('k');\n" +
        '  const caches: LRUCache<string, number>[] = [];\n' +
        '  caches.push(made);\n' +
        '}\n' +
        'export function each(all: LRUCache<string, number>[]) {\n' +
        '  return all.map((c) => c);\n' +
        '}\n' +
        'export function bound(this: LRUCache<string, number>) {\n' +
        "  return ['k'].map(this.peek);\n" +
        '}\n',
    });
    (await CodeGraph.init(root, { index: true })).close();

    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const rows = db.getDb()
        .prepare("SELECT reference_name AS name, file_path AS file, name_tail AS tail FROM unresolved_refs WHERE status = 'failed' AND reference_kind IN ('calls', 'function_ref')")
        .all() as Array<{ name: string; file: string; tail: string }>;
      const tails = (file: string, name: string) => [...new Set(rows.filter((r) => r.file === file && r.name === name).map((r) => r.tail))];

      expect(tails('src/use-new.ts', 'cache.get')).toEqual(['module:lru-cache']);
      expect(tails('src/use-new.ts', 'cache.set')).toEqual(['module:lru-cache']);
      expect(tails('src/use-annotated.ts', 'cache.get')).toEqual(['module:lru-cache']);
      expect(tails('src/use-param.ts', 'cache.get')).toEqual(['module:lru-cache']);
      expect(tails('src/use-namespace.ts', 'cache.get')).toEqual(['module:lru-cache']);
      expect(tails('src/use-default.ts', 's.get')).toEqual(['module:store']);
      expect(tails('src/use-each.ts', 'cs.get')).toEqual(['module:lru-cache']);
      expect(tails('src/use-each.ts', 'cs.forEach')).toEqual(['forEach']);
      expect(tails('src/use-prop.ts', 'max.toFixed')).toEqual(['module:lru-cache']);

      expect(tails('src/other.ts', 'seen.get')).toEqual(['get']);
      expect(tails('src/other.ts', 'pkg.get')).toEqual(['get']);
      expect(tails('src/other.ts', 'mine.peek')).toEqual(['peek']);
      expect(tails('src/other.ts', 'made.get')).toEqual(['get']);
      expect(tails('src/other.ts', 'caches.push')).toEqual(['push']);
      expect(tails('src/other.ts', 'all.map')).toEqual(['map']);
      expect(tails('src/other.ts', 'this.peek')).toEqual(['peek']);
    } finally {
      db.close();
    }
  }, 60_000);
});
