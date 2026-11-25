/**
 * A sync links a member reference through an import binding once the module
 * appears.
 *
 * `NODE_PATH_EXCLUDELIST.includes(p)` after `import { NODE_PATH_EXCLUDELIST }
 * from './constants'` links the constant through the import, as do
 * `store.get(k)` through a default import, `useStore.setState()` through an
 * aliased one and `api.get()` through a namespace import. A reference that
 * failed to resolve is parked under its tail (#1240), and a member's tail is
 * the member's name: `includes`, `get`, `setState`. The module that appears
 * later seldom declares that name, and one that common is shared by more
 * failed references than the retry's ceiling, so the retry never looked. So a
 * module added after its importers were indexed, one restored after a delete,
 * or one that gained its export in a later edit stayed unlinked from those
 * calls until each importer changed or the project was indexed again.
 *
 * Such a reference is now parked under its module's key, as #2450 parks a
 * whole name through a default, namespace or aliased binding, and is still
 * found by its member's name — a namespace import's barrel forwards the member
 * from another file, a guess by name links a receiver whose module never
 * resolves, a router's navigation retry looks calls up by method — and by its
 * receiver's: a barrel forwards the binding's declaration from a file of
 * another name. Only a direct member is: a chain (`CONFIG.load().then`) or a
 * longer path (`CONFIG.api.fetch`) keeps its member's name, as what its last
 * member hangs off is seldom a type the module declares.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { MEMBER_TAIL_SQL, MODULE_PARKED_SQL, moduleReferenceKeys, moduleTail, referenceNameTail } from '../src/db/reference-tail';

type Files = Record<string, string>;

/** 501 failed `get` calls on a receiver no binding names: `get` is past the retry's ceiling. */
const NOISE = `export function noise() {\n${Array.from({ length: 501 }, (_, i) => `  extApi.get(${i});`).join('\n')}\n}\n`;

/** The files that call members of what they import. */
const IMPORTERS: Files = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  // A named import of a constant (infrahub).
  'src/diff-utils.ts': "import { NODE_PATH_EXCLUDELIST } from './constants';\nexport function keep(p: string) { return !NODE_PATH_EXCLUDELIST.includes(p); }\n",
  // Through a tsconfig alias (luci-go's milo).
  'src/flags.ts': "import { REGISTERED_FLAGS } from '@/flags/registry';\nexport function flag(n: string) { return REGISTERED_FLAGS.get(n); }\n",
  // A default import of a store.
  'src/save.ts': "import store from './store';\nexport function save(v: number) {\n  store.set('k', v);\n  return store.get('k');\n}\n",
  // An aliased import (folo's zustand store).
  'src/entry.ts': "import { useEntryStore as useStore } from './entry-store';\nexport function reset() { useStore.setState({ entries: [] }); }\n",
  // A namespace import whose member's name many other failed calls share.
  'src/client.ts': "import * as api from './api';\nexport function load() { return api.get('/me'); }\n",
  // A Vue component's script.
  'src/components/Panel.vue': "<template>\n  <div>{{ names }}</div>\n</template>\n<script setup lang=\"ts\">\nimport { COLUMNS } from '@/table';\nconst names = COLUMNS.map((c) => c.name);\n</script>\n",
  'src/noise.ts': NOISE,
};

const MODULES: Files = {
  'src/constants.ts': "export const NODE_PATH_EXCLUDELIST = ['a', 'b'];\n",
  'src/flags/registry.ts': 'export const REGISTERED_FLAGS = new Map<string, boolean>();\n',
  'src/store.ts': "import { createStore } from 'jotai';\nconst store = createStore();\nexport default store;\n",
  'src/entry-store.ts': "import { create } from 'zustand';\nexport const useEntryStore = create(() => ({ entries: [] as number[] }));\n",
  'src/api.ts': 'export function get(path: string) { return path; }\n',
  'src/table.ts': "export const COLUMNS = [{ name: 'a' }];\n",
};

/** What a full index links through the bindings: `<refName>: <edge> <source kind> <file> -> <target kind> <file>::<name>`. */
const LINKS = [
  'COLUMNS.map: calls component src/components/Panel.vue -> constant src/table.ts::COLUMNS',
  'NODE_PATH_EXCLUDELIST.includes: calls function src/diff-utils.ts -> constant src/constants.ts::NODE_PATH_EXCLUDELIST',
  'REGISTERED_FLAGS.get: calls function src/flags.ts -> constant src/flags/registry.ts::REGISTERED_FLAGS',
  'api.get: calls function src/client.ts -> function src/api.ts::get',
  'store.get: calls function src/save.ts -> constant src/store.ts::store',
  'store.set: calls function src/save.ts -> constant src/store.ts::store',
  'useStore.setState: calls function src/entry.ts -> constant src/entry-store.ts::useEntryStore',
];

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-member-'));
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

/** The edges made by references whose name has a member (`x.y`): `<refName>: <edge> <source kind> <file> -> <target kind> <file>::<name>`. */
function memberLinksOf(graph: CodeGraph): string[] {
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  const links: string[] = [];
  for (const edge of graph.getOutgoingEdgesFrom(ids)) {
    const ref = edge.metadata?.refName;
    if (typeof ref !== 'string' || !/^[A-Za-z_$][\w$]*\./.test(ref)) continue;
    const source = graph.getNode(edge.source)!;
    const target = graph.getNode(edge.target)!;
    links.push(`${ref}: ${edge.kind} ${source.kind} ${source.filePath} -> ${target.kind} ${target.filePath}::${target.name}`);
  }
  return [...new Set(links)].sort();
}

/** The final tree, indexed from scratch in a folder of its own: what the sync has to match. */
async function fullIndexOf(files: Files): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  return edgesOf(await index(root));
}

/** The tail each failed reference of `root`'s index is parked under, by `<file> <kind> <name>`. */
function failedTails(root: string): Map<string, string> {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const rows = db.getDb()
      .prepare("SELECT reference_name AS name, reference_kind AS kind, file_path AS file, name_tail AS tail FROM unresolved_refs WHERE status = 'failed'")
      .all() as Array<{ name: string; kind: string; file: string; tail: string }>;
    return new Map(rows.map((r) => [`${r.file} ${r.kind} ${r.name}`, r.tail]));
  } finally {
    db.close();
  }
}

/** A module before the edit that gives it what its importers import. */
const stub = (file: string): string => (file.endsWith('.vue') ? '<template><p></p></template>\n' : 'export const placeholder = 1;\n');

describe('sync links member references through an import binding to their module', () => {
  it('when the module is added after its importers', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    const graph = await index(root);
    expect(memberLinksOf(graph)).toEqual([]);

    write(root, MODULES);
    const result = await graph.sync();
    // The importers did not change: only the retry of their parked refs links them.
    expect(result.filesAdded).toBe(Object.keys(MODULES).length);
    expect(result.filesModified).toBe(0);
    expect(memberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when the module comes back after it was deleted', async () => {
    const root = tempRoot();
    write(root, { ...IMPORTERS, ...MODULES });
    const graph = await index(root);
    expect(memberLinksOf(graph)).toEqual(LINKS);

    for (const file of Object.keys(MODULES)) fs.rmSync(path.join(root, file));
    expect((await graph.sync()).filesRemoved).toBe(Object.keys(MODULES).length);
    expect(memberLinksOf(graph)).toEqual([]);

    write(root, MODULES);
    expect((await graph.sync()).filesAdded).toBe(Object.keys(MODULES).length);
    expect(memberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);

  it('when an edit gives the module what its importers import', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    write(root, Object.fromEntries(Object.keys(MODULES).map((file) => [file, stub(file)])));
    const graph = await index(root);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesModified).toBe(Object.keys(MODULES).length);
    expect(result.filesAdded).toBe(0);
    expect(memberLinksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);

  it('and through its barrel when the file the barrel forwards from is added', async () => {
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/config.ts': "export * from './shared/flags';\n",
      'src/use-flags.ts': "import { FLAGS } from './config';\nexport function on(f: string) { return FLAGS.includes(f); }\n",
    };
    const added: Files = { 'src/shared/flags.ts': "export const FLAGS = ['a'];\n" };
    // None of the added file's keys is the barrel's.
    expect(moduleReferenceKeys('src/shared/flags.ts')).not.toContain(moduleTail('src/config'));
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);

    write(root, added);
    expect((await graph.sync()).filesAdded).toBe(1);
    expect(memberLinksOf(graph)).toEqual(['FLAGS.includes: calls function src/use-flags.ts -> constant src/shared/flags.ts::FLAGS']);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...added }));
  }, 120_000);

  it('and through its barrel when the file the barrel forwards from gains the declaration', async () => {
    // Parked under the barrel's key, the call is one the sync's walk up from
    // an edited file to the barrels passing it on re-opens (#2560).
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/config.ts': "export * from './shared/flags';\n",
      'src/use-flags.ts': "import { FLAGS } from './config';\nexport function on(f: string) { return FLAGS.includes(f); }\n",
      'src/shared/flags.ts': 'export const placeholder = 1;\n',
    };
    const edited: Files = { 'src/shared/flags.ts': "export const FLAGS = ['a'];\n" };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);

    write(root, edited);
    expect((await graph.sync()).filesModified).toBe(1);
    expect(memberLinksOf(graph)).toEqual(['FLAGS.includes: calls function src/use-flags.ts -> constant src/shared/flags.ts::FLAGS']);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...edited }));
  }, 120_000);

  it('and by its receiver when the barrel names that file through an alias in a Vue project', async () => {
    // With Vue's resolver, the barrel's `export * from '@/shared/flags'`
    // links the constant the file declares, not the file, so no walk up from
    // the edited file finds the barrel: only the receiver's name does.
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/config.ts': "export * from '@/shared/flags';\n",
      'src/use-flags.ts': "import { FLAGS } from '@/config';\nexport function on(f: string) { return FLAGS.includes(f); }\n",
      'src/shared/flags.ts': 'export const placeholder = 1;\n',
    };
    const edited: Files = { 'src/shared/flags.ts': "export const FLAGS = ['a'];\n" };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);

    write(root, edited);
    expect((await graph.sync()).filesModified).toBe(1);
    expect(memberLinksOf(graph)).toEqual(['FLAGS.includes: calls function src/use-flags.ts -> constant src/shared/flags.ts::FLAGS']);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...edited }));
  }, 120_000);

  it('and by its member when a namespace import\'s barrel forwards it from a file of another name', async () => {
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/ns.ts': "export * from './impl/make';\n",
      'src/use-ns.ts': "import * as NS from './ns';\nexport function go() { return NS.make(); }\n",
    };
    const added: Files = { 'src/impl/make.ts': 'export function make() { return 1; }\n' };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);
    expect(failedTails(root).get('src/use-ns.ts calls NS.make')).toBe('module:ns');

    write(root, added);
    expect((await graph.sync()).filesAdded).toBe(1);
    expect(memberLinksOf(graph)).toEqual(['NS.make: calls function src/use-ns.ts -> function src/impl/make.ts::make']);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...added }));
  }, 120_000);

  it('and by its member when a full index guesses the method by its name', async () => {
    // The binding's module never resolves, so a full index links the call by
    // the method's name, to the one class declaring it.
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.ts': "import { store } from './missing-store';\nexport function a() { return store.fetchUserProfile(); }\n",
    };
    const added: Files = { 'src/impl/profile.ts': 'export class ProfileStore {\n  fetchUserProfile() { return 1; }\n}\n' };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);
    expect(failedTails(root).get('src/a.ts calls store.fetchUserProfile')).toBe('module:missing-store');

    write(root, added);
    expect((await graph.sync()).filesAdded).toBe(1);
    expect(memberLinksOf(graph)).toEqual([
      'store.fetchUserProfile: calls function src/a.ts -> method src/impl/profile.ts::fetchUserProfile',
    ]);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...added }));
  }, 120_000);

  it('and by its method when a route it navigates to appears in another file', async () => {
    // Vue Router: the router module default-exports a call, which no binding
    // resolves to, so `router.push` fails and is parked under the module. A
    // route added to the table in another file binds it again.
    const initial: Files = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '3', 'vue-router': '4' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/router/index.js':
        "import { createRouter, createWebHistory } from 'vue-router'\n" +
        "import { routes } from '../routes'\n" +
        'export default createRouter({ history: createWebHistory(), routes })\n',
      'src/routes.js': "export const routes = [\n  { name: 'home', path: '/', component: () => import('@/views/Home.vue') },\n]\n",
      'src/views/Home.vue': '<template>\n  <div>Home</div>\n</template>\n',
      'src/views/Login.vue': '<template>\n  <div>Login</div>\n</template>\n',
      'src/auth.js': "import router from '@/router'\nexport function logout() {\n  router.push('/login')\n}\n",
    };
    const edited: Files = {
      'src/routes.js':
        "export const routes = [\n  { name: 'home', path: '/', component: () => import('@/views/Home.vue') },\n" +
        "  { name: 'login', path: '/login', component: () => import('@/views/Login.vue') },\n]\n",
    };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);
    expect(failedTails(root).get('src/auth.js calls router.push')).toBe('module:router');
    // None of the edited file's keys or names is the call's module, receiver or method.
    expect(moduleReferenceKeys('src/routes.js')).not.toContain('module:router');

    write(root, edited);
    expect((await graph.sync()).filesModified).toBe(1);
    expect(memberLinksOf(graph)).toEqual(['router.push: navigates function src/auth.js -> route src/routes.js::/login']);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...edited }));
  }, 120_000);
});

describe('a failed member reference through an import binding', () => {
  it('waits for its module, and every other reference keeps its own tail', async () => {
    const root = tempRoot();
    write(root, {
      ...IMPORTERS,
      // A member of a package's binding, the whole name of an unaliased named
      // import, and a chain or a longer path through a binding wait for the
      // name they use.
      'src/other.ts':
        "import express from 'express';\nimport { helper } from './util';\nimport CONFIG from './config';\n" +
        'export const app = express.Router();\nexport const value = helper;\n' +
        'export const fetched = CONFIG.api.fetch();\nexport const loaded = CONFIG.load().then(() => 1);\n',
    });
    (await CodeGraph.init(root, { index: true })).close();
    const tails = failedTails(root);

    expect(tails.get('src/diff-utils.ts calls NODE_PATH_EXCLUDELIST.includes')).toBe('module:constants');
    expect(tails.get('src/flags.ts calls REGISTERED_FLAGS.get')).toBe('module:registry');
    expect(tails.get('src/save.ts calls store.set')).toBe('module:store');
    expect(tails.get('src/save.ts calls store.get')).toBe('module:store');
    expect(tails.get('src/entry.ts calls useStore.setState')).toBe('module:entry-store');
    expect(tails.get('src/client.ts calls api.get')).toBe('module:api');
    expect(tails.get('src/components/Panel.vue calls COLUMNS.map')).toBe('module:table');

    expect(tails.get('src/noise.ts calls extApi.get')).toBe('get');
    expect(tails.get('src/other.ts calls express.Router')).toBe('Router');
    expect(tails.get('src/other.ts imports helper')).toBe('helper');
    expect(tails.get('src/other.ts calls CONFIG.api.fetch')).toBe('fetch');
    expect(tails.get('src/other.ts calls CONFIG.load().then')).toBe('then');
    // The chain's own first call is a direct member.
    expect(tails.get('src/other.ts calls CONFIG.load')).toBe('module:config');
  }, 60_000);
});

describe('schema v16', () => {
  let db: DatabaseConnection | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function fixture(): QueryBuilder {
    const root = tempRoot();
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({ id: 'f', kind: 'file', name: 'save.ts', qualifiedName: 'src/save.ts', filePath: 'src/save.ts',
      language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 });
    for (const [referenceName, referenceKind, tail, line] of [
      ['store.get', 'calls', 'module:store', 1],
      ['store.set', 'calls', 'module:store', 2],
      ['router.push', 'calls', 'module:router', 3],
      ['api.fetchUser', 'calls', 'module:api', 4],
      ['tagsController', 'imports', 'module:tag', 5],
      // A member of a receiver no binding names: parked under its member.
      ['extApi.get', 'calls', 'get', 6],
    ] as const) {
      queries.insertUnresolvedRef({ fromNodeId: 'f', referenceName, referenceKind, line, column: 0, filePath: 'src/save.ts', language: 'typescript' });
      db.getDb().prepare("UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE line = ?").run(tail, line);
    }
    return queries;
  }

  const retried = (queries: QueryBuilder, names: string[], ceiling?: number) =>
    queries.getRetryableFailedReferences(names, ceiling).map((ref) => `${ref.referenceKind} ${ref.referenceName}`).sort();

  it('finds a member reference parked under its module by its module, its member and its receiver', () => {
    const queries = fixture();
    expect(retried(queries, moduleReferenceKeys('src/store.ts'))).toEqual(['calls store.get', 'calls store.set']);
    expect(retried(queries, ['get'])).toEqual(['calls extApi.get', 'calls store.get']);
    expect(retried(queries, ['store'])).toEqual(['calls store.get', 'calls store.set']);
    expect(retried(queries, ['fetchUser', 'router'])).toEqual(['calls api.fetchUser', 'calls router.push']);
    // A whole name's lookup is #2450's, by its name.
    expect(retried(queries, ['tagsController'])).toEqual(['imports tagsController']);
    // A file's name, a key and a prefix of a receiver are no receiver.
    expect(retried(queries, ['store.ts', 'module:store.ts', 'stor', 'rou'])).toEqual([]);
    // The per-name ceiling holds for the member and receiver lookups too, and
    // a member shares its name's with the refs still parked under that name,
    // as one tail before.
    expect(retried(queries, ['store'], 1)).toEqual([]);
    expect(retried(queries, ['get'], 1)).toEqual([]);
    expect(retried(queries, ['get'], 2)).toEqual(['calls extApi.get', 'calls store.get']);
    expect(retried(queries, ['set', 'push'], 0)).toEqual([]);
  });

  it('finds a call parked under its module by its method for a router, and its member for the dead-code check', () => {
    const queries = fixture();
    expect(queries.getFailedCallsByTail(['push', 'get']).map((ref) => ref.referenceName).sort()).toEqual(['extApi.get', 'router.push', 'store.get']);
    expect([...queries.getUnresolvedNamesAmong(['fetchUser', 'push', 'set', 'store', 'nothing'])].sort()).toEqual(['fetchUser', 'push', 'set']);
  });

  it('reads the member as the tail its name gives', () => {
    fixture();
    const memberOf = db!.getDb().prepare(`SELECT ${MEMBER_TAIL_SQL} AS member FROM (SELECT ? AS reference_name)`);
    for (const name of ['store.get', 'NODE_PATH_EXCLUDELIST.includes', 'LogAPI.getVisitOverview().then', 'CONFIG.api.fetch', 'a.b.c.d', '$el.$on', 'helper', 'café.größe']) {
      expect((memberOf.get(name) as { member: string }).member).toBe(referenceNameTail(name, 'calls'));
    }
  });

  it('looks a member and a receiver up through the module indexes, not every failed row', () => {
    const queries = fixture();
    const prepare = vi.spyOn(db!.getDb(), 'prepare');
    queries.getRetryableFailedReferences(['get', 'store']);
    queries.getFailedCallsByTail(['push']);
    queries.getUnresolvedNamesAmong(['fetchUser']);
    const sqls = prepare.mock.calls.map(([sql]) => sql as string);
    prepare.mockRestore();
    const plan = (sql: string) => db!.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'store'))
      .map((row) => (row as { detail: string }).detail).join('; ');

    const memberSelects = sqls.filter((sql) => sql.includes(`${MEMBER_TAIL_SQL} IN`));
    // Counts and rows of the retry, the router's calls, the dead-code names.
    expect(memberSelects).toHaveLength(4);
    for (const sql of memberSelects) expect(plan(sql)).toMatch(/USING (COVERING )?INDEX idx_unresolved_failed_module_member/);
    const receiverSelects = sqls.filter((sql) => sql.includes('reference_name >= ?'));
    expect(receiverSelects).toHaveLength(1);
    expect(plan(receiverSelects[0]!)).toMatch(/USING (COVERING )?INDEX idx_unresolved_failed_module_name \(status=\? AND reference_name>\? AND reference_name<\?\)/);
  });

  it('adds the member index to an older index, and replays cleanly', () => {
    fixture();
    const indexes = () => db!.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_unresolved_failed_module_member'").all();
    db!.getDb().exec(`DROP INDEX idx_unresolved_failed_module_member;
      DELETE FROM schema_versions WHERE version >= 16;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (15, 0, 'legacy fixture');`);
    expect(indexes()).toHaveLength(0);
    runMigrations(db!.getDb(), 15);
    expect(getCurrentVersion(db!.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(indexes()).toHaveLength(1);
    db!.getDb().exec('DELETE FROM schema_versions WHERE version >= 16');
    runMigrations(db!.getDb(), 15);
    expect(indexes()).toHaveLength(1);
  });

  it('defines the member index in schema.sql with the expression the queries spell', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
    const definition = /CREATE INDEX IF NOT EXISTS idx_unresolved_failed_module_member[^;]*;/.exec(schema)?.[0];
    expect(definition).toBe(`CREATE INDEX IF NOT EXISTS idx_unresolved_failed_module_member ON unresolved_refs(status, ${MEMBER_TAIL_SQL}) WHERE ${MODULE_PARKED_SQL};`);
  });
});
