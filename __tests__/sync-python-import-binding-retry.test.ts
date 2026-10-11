/**
 * A sync links a reference through a Python import alias once the module appears.
 *
 * `from .models import User as UserModel` and `from . import helpers as h`
 * bind a name their module never declares: it has `User` and `helpers`. Every
 * reference through that name — the import itself, a call, a base class, a
 * class or function passed as a value — resolves only through the module. Sync
 * retries a parked failed ref by its tail (#1240), and these were parked under
 * the alias, which neither the module's file nor its symbols carry. So a module
 * added after its importers were indexed, one restored after a delete, or one
 * that gained the name in a later edit stayed unlinked from them until each
 * importer changed or the project was indexed again. #2450 parked the ES-module
 * bindings under their module; a Python import names its module by a dotted
 * path, relative to the importing file's package when it starts with dots.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { moduleReferenceKeys } from '../src/db/reference-tail';

type Files = Record<string, string>;

/** The files that reach a module through a name the module declares under another. */
const IMPORTERS: Files = {
  'app/__init__.py': '',
  'app/sub/__init__.py': '',
  'app/pkg/__init__.py': '',
  // A package that re-exports a name from a module beside it.
  'app/store/__init__.py': 'from .user import Account\n',
  'app/main.py': [
    'from .models import User as UserModel',
    'from . import helpers as h',
    'from app.models import Group as GroupModel',
    'from .pkg import sub as subpkg',
    'from app.pkg import other as other_mod',
    'from .svc import make_thing as mk',
    'from .store import Account as Acct',
    '',
    'class Admin(UserModel):',
    '    pass',
    '',
    'def run(u):',
    '    x = mk()',
    '    if isinstance(u, UserModel):',
    '        return GroupModel(), Acct(), x',
    '    return mk',
    '',
  ].join('\n'),
  'app/sub/deep.py': [
    'from .. import helpers as hh',
    'from ..models import User as U2',
    'from ..pkg import sub as sp2',
    '',
    'def use():',
    '    return U2()',
    '',
  ].join('\n'),
  // A module at the root, imported by its absolute name.
  'main.py': 'from settings import Config as Cfg\n\n\ndef load():\n    return Cfg()\n',
};

const MODULES: Files = {
  'app/models.py': 'class User:\n    pass\n\n\nclass Group:\n    pass\n',
  'app/helpers.py': 'def x():\n    return 1\n',
  // A subpackage: what `from .pkg import sub` imports is its `__init__.py`.
  'app/pkg/sub/__init__.py': 'VALUE = 1\n',
  'app/pkg/other.py': 'def f():\n    return 2\n',
  'app/svc.py': 'def make_thing():\n    return 3\n',
  'app/store/user.py': 'class Account:\n    pass\n',
  'settings.py': 'class Config:\n    pass\n',
};

/** What a full index links through the aliases: `<refName>: <edge> <source kind> <file> -> <target kind> <file>::<name>`. */
const LINKS = [
  'Acct: imports file app/main.py -> class app/store/user.py::Account',
  'Acct: instantiates function app/main.py -> class app/store/user.py::Account',
  'Cfg: imports file main.py -> class settings.py::Config',
  'Cfg: instantiates function main.py -> class settings.py::Config',
  'GroupModel: imports file app/main.py -> class app/models.py::Group',
  'GroupModel: instantiates function app/main.py -> class app/models.py::Group',
  'U2: imports file app/sub/deep.py -> class app/models.py::User',
  'U2: instantiates function app/sub/deep.py -> class app/models.py::User',
  'UserModel: extends class app/main.py -> class app/models.py::User',
  'UserModel: imports file app/main.py -> class app/models.py::User',
  'UserModel: references function app/main.py -> class app/models.py::User',
  'h: imports file app/main.py -> file app/helpers.py::helpers.py',
  'hh: imports file app/sub/deep.py -> file app/helpers.py::helpers.py',
  'mk: calls function app/main.py -> function app/svc.py::make_thing',
  'mk: imports file app/main.py -> function app/svc.py::make_thing',
  'mk: references function app/main.py -> function app/svc.py::make_thing',
  'other_mod: imports file app/main.py -> file app/pkg/other.py::other.py',
  'sp2: imports file app/sub/deep.py -> file app/pkg/sub/__init__.py::__init__.py',
  'subpkg: imports file app/main.py -> file app/pkg/sub/__init__.py::__init__.py',
];

/** An alias of a name its module doesn't have, which a full index links to a namesake. */
const BY_NAME: Files = {
  'app/__init__.py': '',
  'app/lib.py': 'unrelated = 1\n',
  'app/form.py': 'from .lib import FormSchemaBase as FormSchema\n\n\nclass Form(FormSchema):\n    pass\n',
};
const BY_NAME_ADDED: Files = { 'app/schemas.py': 'class FormSchema:\n    pass\n' };

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-pybinding-'));
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

describe('sync links references through a Python import alias to their module', () => {
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

  it('when an edit gives the module the name its importers import', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    write(root, Object.fromEntries(Object.keys(MODULES).map((file) => [file, 'PLACEHOLDER = 0\n'])));
    const graph = await index(root);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesModified).toBe(Object.keys(MODULES).length);
    expect(result.filesAdded).toBe(0);
    expect(linksOf(graph)).toEqual(LINKS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);

  it('and by its own name when its module never declares it', async () => {
    // As vben's case for an ES module: the module has no such name, so a full
    // index links the alias by its own name to the class that carries it.
    const root = tempRoot();
    write(root, BY_NAME);
    const graph = await index(root);

    write(root, BY_NAME_ADDED);
    expect((await graph.sync()).filesAdded).toBe(1);
    const formSchema = edgesOf(graph).filter((edge) => edge.includes('"refName":"FormSchema"'));
    expect(formSchema).toHaveLength(2);
    expect(formSchema.every((edge) => edge.includes('-> class app/schemas.py:'))).toBe(true);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...BY_NAME, ...BY_NAME_ADDED }));
  }, 120_000);
});

describe('a failed reference through a Python import alias', () => {
  it('waits for its module, and every other reference keeps its own tail', async () => {
    const root = tempRoot();
    write(root, {
      ...IMPORTERS,
      ...BY_NAME,
      // An unaliased import, a standard-library alias and a member read
      // through an alias wait for the name they use.
      'app/other.py': [
        'from .models import Group',
        'from collections import OrderedDict as OD',
        'from .models import User as UserModel',
        '',
        'def build():',
        '    return Group(), OD(), UserModel.create()',
        '',
      ].join('\n'),
    });
    (await CodeGraph.init(root, { index: true })).close();

    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const rows = db.getDb()
        .prepare("SELECT reference_name AS name, reference_kind AS kind, file_path AS file, name_tail AS tail FROM unresolved_refs WHERE status = 'failed'")
        .all() as Array<{ name: string; kind: string; file: string; tail: string }>;
      const tailOf = (file: string, name: string, kind: string): string | undefined =>
        rows.find((r) => r.file === file && r.name === name && r.kind === kind)?.tail;

      // A module named relative to the importing file's package, or absolutely.
      expect(tailOf('app/main.py', 'UserModel', 'imports')).toBe('module:models');
      expect(tailOf('app/main.py', 'UserModel', 'extends')).toBe('module:models');
      expect(tailOf('app/main.py', 'GroupModel', 'calls')).toBe('module:models');
      expect(tailOf('app/sub/deep.py', 'U2', 'calls')).toBe('module:models');
      expect(tailOf('app/main.py', 'mk', 'calls')).toBe('module:svc');
      // `from . import helpers` imports from the file's own package, `..` from the one above.
      expect(tailOf('app/main.py', 'h', 'imports')).toBe('module:app');
      expect(tailOf('app/sub/deep.py', 'hh', 'imports')).toBe('module:app');
      expect(tailOf('app/main.py', 'subpkg', 'imports')).toBe('module:pkg');
      expect(tailOf('app/main.py', 'other_mod', 'imports')).toBe('module:pkg');
      expect(tailOf('app/main.py', 'Acct', 'calls')).toBe('module:store');
      expect(tailOf('main.py', 'Cfg', 'calls')).toBe('module:settings');
      // Still found by its own name too: sync's lookup by whole name.
      expect(tailOf('app/form.py', 'FormSchema', 'extends')).toBe('module:lib');

      expect(tailOf('app/other.py', 'Group', 'calls')).toBe('Group');
      expect(tailOf('app/other.py', 'OD', 'calls')).toBe('OD');
      expect(tailOf('app/other.py', 'UserModel.create', 'calls')).toBe('create');

      // A submodule's keys hold its package's: a module file's folder, and
      // the folder above a subpackage's `__init__.py`.
      expect(moduleReferenceKeys('app/helpers.py')).toContain('module:app');
      expect(moduleReferenceKeys('app/pkg/sub/__init__.py')).toEqual(expect.arrayContaining(['module:sub', 'module:pkg']));
      expect(moduleReferenceKeys('pkg/__init__.py')).toEqual(['module:pkg', 'module:__init__.py', 'module:__init__']);
    } finally {
      db.close();
    }
  }, 60_000);
});
