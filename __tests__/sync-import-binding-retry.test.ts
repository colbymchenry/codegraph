/**
 * A sync links a reference through an import binding once the module appears.
 *
 * `import tagsController from './tag/tag.controller'` binds a name the module
 * never declares: its default export is a `router`. So does a namespace import
 * and an aliased one (`import { Component as GroupsPageWrapper }`). Every
 * reference through such a name — the import itself, a call, `new`, a base
 * class, a JSX or Vue template tag, an Express mount — resolves only through
 * the module. Sync retries a parked failed ref by its tail (#1240), and these
 * were parked under the binding's own name, which neither the module's file
 * nor its symbols carry. So a module added after its importers were indexed,
 * one restored after a delete, or one that gained its export in a later edit
 * stayed unlinked from them until each importer changed or the project was
 * indexed again. #2392 fixed the same gap for the import of the file itself.
 *
 * Such a reference is now parked under its module's key, and still found by
 * its own name: a binding its module never resolves is linked by that name
 * alone, to whichever declaration carries it (vben's `{ VbenFormSchema as
 * FormSchema }`), and that link must come back when the declaration does.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { moduleReferenceKeys, moduleTail } from '../src/db/reference-tail';

type Files = Record<string, string>;

/** The files that reach a module through a binding the module doesn't declare by that name. */
const IMPORTERS: Files = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4', vue: '^3', svelte: '^4', astro: '^4' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  // A default import of a module whose default export has another name (ts-express).
  'src/routes/routes.ts': "import tagsController from './tag/tag.controller';\nexport const routes = [tagsController];\n",
  // An aliased import through a tsconfig alias (luci-go's milo).
  'src/pages/groups_page.test.tsx': "import { Component as GroupsPageWrapper } from '@/pages/groups_page';\nexport const page = <GroupsPageWrapper />;\n",
  'src/use-ns.ts': "import * as NS from './ns';\nexport const all = NS;\n",
  'src/call.ts': "import runIt from './handler';\nexport function go() { return runIt(); }\n",
  'src/draw.ts': "import { Widget as W } from './widgets/Widget';\nexport function paint() { return new W(); }\n",
  'src/admin.ts': "import Base from './base';\nexport class Admin extends Base {}\n",
  // An Express router mounted through a default import (proshop).
  'backend/server.js': "import express from 'express';\nimport uploadRoutes from './routes/uploadRoutes.js';\nconst app = express();\napp.use('/api/upload', uploadRoutes);\nexport default app;\n",
  // A Vue component imported through an alias and rendered by the template (vue3-element-admin).
  'src/layouts/LayoutMain.vue': "<template><Error404 /></template>\n<script setup>\nimport Error404 from '@/views/error/404.vue';\n</script>\n",
  'src/App.svelte': "<script>\n  import Banner from './lib/Hero.svelte';\n</script>\n<Banner />\n",
  'src/pages/index.astro': "---\nimport Shell from '../layouts/BaseLayout.astro';\n---\n<Shell><h1>Home</h1></Shell>\n",
};

const MODULES: Files = {
  'src/routes/tag/tag.controller.ts': 'const router = { list() { return []; } };\nexport default router;\n',
  'src/pages/groups_page.tsx': 'export function Component() { return null; }\n',
  'src/ns.ts': 'export const member = 1;\n',
  'src/handler.ts': 'export default function handle() { return 1; }\n',
  'src/widgets/Widget.ts': 'export class Widget {}\n',
  'src/base.ts': 'export default class BaseUser {}\n',
  'backend/routes/uploadRoutes.js': "import express from 'express';\nconst router = express.Router();\nrouter.post('/', (req, res) => res.send('ok'));\nexport default router;\n",
  'src/views/error/404.vue': '<template><p>Not found</p></template>\n',
  'src/lib/Hero.svelte': '<h1>Hero</h1>\n',
  'src/layouts/BaseLayout.astro': '<html><body><slot /></body></html>\n',
};

/** What a full index links through the bindings: `<refName>: <edge> <source kind> <file> -> <target kind> <file>::<name>`. */
const LINKS = [
  'Banner: imports file src/App.svelte -> component src/lib/Hero.svelte::Hero',
  'Banner: references component src/App.svelte -> component src/lib/Hero.svelte::Hero',
  'Base: extends class src/admin.ts -> class src/base.ts::BaseUser',
  'Base: imports file src/admin.ts -> file src/base.ts::base.ts',
  'Error404: imports file src/layouts/LayoutMain.vue -> component src/views/error/404.vue::404',
  'Error404: references component src/layouts/LayoutMain.vue -> component src/views/error/404.vue::404',
  'GroupsPageWrapper: imports file src/pages/groups_page.test.tsx -> function src/pages/groups_page.tsx::Component',
  'NS: imports file src/use-ns.ts -> file src/ns.ts::ns.ts',
  'Shell: imports file src/pages/index.astro -> component src/layouts/BaseLayout.astro::BaseLayout',
  'Shell: references component src/pages/index.astro -> component src/layouts/BaseLayout.astro::BaseLayout',
  'W: imports file src/draw.ts -> class src/widgets/Widget.ts::Widget',
  'W: instantiates function src/draw.ts -> class src/widgets/Widget.ts::Widget',
  'runIt: calls function src/call.ts -> function src/handler.ts::handle',
  'runIt: imports file src/call.ts -> file src/handler.ts::handler.ts',
  'tagsController: imports file src/routes/routes.ts -> file src/routes/tag/tag.controller.ts::tag.controller.ts',
  'uploadRoutes: imports file backend/server.js -> file backend/routes/uploadRoutes.js::uploadRoutes.js',
  'uploadRoutes: references route backend/server.js -> constant backend/routes/uploadRoutes.js::router',
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-binding-'));
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

/** The {@link LINKS} the graph has. */
function linksOf(graph: CodeGraph): string[] {
  const names = new Set(LINKS.map((link) => link.slice(0, link.indexOf(':'))));
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  const links: string[] = [];
  for (const edge of graph.getOutgoingEdgesFrom(ids)) {
    const ref = edge.metadata?.refName;
    if (typeof ref !== 'string' || !names.has(ref)) continue;
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

/** A module before the edit that gives it what its importers import. */
const stub = (file: string): string =>
  file.endsWith('.vue') ? '<template><p></p></template>\n' : /\.(svelte|astro)$/.test(file) ? '<p></p>\n' : 'export const placeholder = 1;\n';

describe('sync links references through an import binding to their module', () => {
  it('when the module is added after its importers', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    const graph = await index(root);
    expect(linksOf(graph)).toEqual([]);

    write(root, MODULES);
    const result = await graph.sync();
    // The importers did not change: only the retry of their parked refs links them.
    expect(result.filesAdded).toBe(Object.keys(MODULES).length);
    expect(result.filesModified).toBe(0);
    expect(linksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when the module comes back after it was deleted', async () => {
    const root = tempRoot();
    write(root, { ...IMPORTERS, ...MODULES });
    const graph = await index(root);
    expect(linksOf(graph)).toEqual(LINKS);

    for (const file of Object.keys(MODULES)) fs.rmSync(path.join(root, file));
    expect((await graph.sync()).filesRemoved).toBe(Object.keys(MODULES).length);
    expect(linksOf(graph)).toEqual([]);

    write(root, MODULES);
    expect((await graph.sync()).filesAdded).toBe(Object.keys(MODULES).length);
    expect(linksOf(graph)).toEqual(LINKS);
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
    expect(linksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);

  it('and by its own name when its module never resolves it', async () => {
    // vben: the module doesn't declare the imported name, so a full index
    // links the local name to the declaration that carries it.
    const initial: Files = {
      'src/lib.ts': 'export const unrelated = 1;\n',
      'src/form.ts': "import type { VbenFormSchema as FormSchema } from './lib';\nexport type Schema = FormSchema;\n",
    };
    const added: Files = { 'src/types.ts': 'export type FormSchema = { field: string };\n' };
    const root = tempRoot();
    write(root, initial);
    const graph = await index(root);

    write(root, added);
    expect((await graph.sync()).filesAdded).toBe(1);
    const formSchema = edgesOf(graph).filter((edge) => edge.includes('"refName":"FormSchema"'));
    expect(formSchema).toHaveLength(2);
    expect(formSchema.every((edge) => edge.includes('-> type_alias src/types.ts:'))).toBe(true);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...initial, ...added }));
  }, 120_000);
});

describe('a failed reference through an import binding', () => {
  it('waits for its module, and every other reference keeps its own tail', async () => {
    const root = tempRoot();
    write(root, {
      ...IMPORTERS,
      // A package's binding, an unaliased named import and a member of a
      // namespace import wait for the name they use.
      'src/other.ts': "import express from 'express';\nimport { helper } from './util';\nimport * as NS from './ns';\nexport const app = express();\nexport const values = [helper, NS.make()];\n",
    });
    (await CodeGraph.init(root, { index: true })).close();

    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const rows = db.getDb()
        .prepare("SELECT reference_name AS name, reference_kind AS kind, file_path AS file, name_tail AS tail FROM unresolved_refs WHERE status = 'failed'")
        .all() as Array<{ name: string; kind: string; file: string; tail: string }>;
      const tailOf = (file: string, name: string, kind: string): string | undefined =>
        rows.find((r) => r.file === file && r.name === name && r.kind === kind)?.tail;

      expect(tailOf('src/routes/routes.ts', 'tagsController', 'imports')).toBe('module:tag');
      expect(tailOf('src/pages/groups_page.test.tsx', 'GroupsPageWrapper', 'imports')).toBe('module:groups_page');
      expect(tailOf('src/use-ns.ts', 'NS', 'imports')).toBe('module:ns');
      expect(tailOf('src/call.ts', 'runIt', 'calls')).toBe('module:handler');
      expect(tailOf('src/draw.ts', 'W', 'instantiates')).toBe('module:Widget');
      expect(tailOf('src/admin.ts', 'Base', 'extends')).toBe('module:base');
      expect(tailOf('backend/server.js', 'uploadRoutes', 'references')).toBe('module:uploadRoutes');
      expect(tailOf('src/layouts/LayoutMain.vue', 'Error404', 'imports')).toBe('module:404');
      expect(tailOf('src/App.svelte', 'Banner', 'references')).toBe('module:Hero');
      expect(tailOf('src/pages/index.astro', 'Shell', 'imports')).toBe('module:BaseLayout');

      expect(tailOf('src/other.ts', 'express', 'imports')).toBe('express');
      expect(tailOf('src/other.ts', 'helper', 'imports')).toBe('helper');
      expect(tailOf('src/other.ts', 'NS.make', 'calls')).toBe('make');

      // Each module's file is one of the keys its references wait under.
      for (const [file, module] of [
        ['src/routes/tag/tag.controller.ts', './tag/tag.controller'],
        ['src/views/error/404.vue', '@/views/error/404.vue'],
        ['src/pages/Team/index.tsx', './pages/Team'],
      ]) {
        expect(moduleReferenceKeys(file)).toContain(moduleTail(module));
      }
    } finally {
      db.close();
    }
  }, 60_000);
});

describe('schema v15', () => {
  let db: DatabaseConnection | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function fixture(): QueryBuilder {
    const root = tempRoot();
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({ id: 'f', kind: 'file', name: 'form.ts', qualifiedName: 'src/form.ts', filePath: 'src/form.ts',
      language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 });
    for (const [referenceName, referenceKind, tail, line] of [
      ['FormSchema', 'imports', 'module:lib', 1],
      ['FormSchema', 'references', 'module:lib', 2],
      ['tagsController', 'imports', 'module:tag', 3],
      // A ref its name parks: the name lookup finds it by its tail already.
      ['helper', 'calls', 'helper', 4],
    ] as const) {
      queries.insertUnresolvedRef({ fromNodeId: 'f', referenceName, referenceKind, line, column: 0, filePath: 'src/form.ts', language: 'typescript' });
      db.getDb().prepare("UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE line = ?").run(tail, line);
    }
    return queries;
  }

  const retried = (queries: QueryBuilder, names: string[], ceiling?: number) =>
    queries.getRetryableFailedReferences(names, ceiling).map((ref) => `${ref.referenceKind} ${ref.referenceName}`).sort();

  it('finds a reference parked under its module by its module and by its own name', () => {
    const queries = fixture();
    expect(retried(queries, moduleReferenceKeys('src/lib.ts'))).toEqual(['imports FormSchema', 'references FormSchema']);
    expect(retried(queries, ['FormSchema'])).toEqual(['imports FormSchema', 'references FormSchema']);
    expect(retried(queries, ['FormSchema', 'module:lib', 'helper'])).toEqual(['calls helper', 'imports FormSchema', 'references FormSchema']);
    expect(retried(queries, ['tag', 'module:tag.controller.ts'])).toEqual([]);
    // The per-name ceiling holds for the name lookup too.
    expect(retried(queries, ['FormSchema'], 1)).toEqual([]);
  });

  it('adds the name index to an older index, and replays cleanly', () => {
    fixture();
    const indexes = () => db!.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_unresolved_failed_module_name'").all();
    db!.getDb().exec(`DROP INDEX idx_unresolved_failed_module_name;
      DELETE FROM schema_versions WHERE version >= 15;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (14, 0, 'legacy fixture');`);
    expect(indexes()).toHaveLength(0);
    runMigrations(db!.getDb(), 14);
    expect(getCurrentVersion(db!.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(indexes()).toHaveLength(1);
    db!.getDb().exec('DELETE FROM schema_versions WHERE version >= 15');
    runMigrations(db!.getDb(), 14);
    expect(indexes()).toHaveLength(1);
  });

  it('looks a reference up by its name through the name index, not every failed row', () => {
    const queries = fixture();
    const prepare = vi.spyOn(db!.getDb(), 'prepare');
    queries.getRetryableFailedReferences(['FormSchema']);
    const selects = prepare.mock.calls.map(([sql]) => sql as string).filter((sql) => sql.includes('reference_name IN'));
    prepare.mockRestore();
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      const plan = db!.getDb().prepare(`EXPLAIN QUERY PLAN ${select}`).all('FormSchema')
        .map((row) => (row as { detail: string }).detail).join('; ');
      expect(plan).toMatch(/USING (COVERING )?INDEX idx_unresolved_failed_module_name/);
    }
  });
});
