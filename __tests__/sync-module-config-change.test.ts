/**
 * A sync follows a change to the files import resolution is configured by
 * (#2977): `tsconfig.json` / `jsconfig.json` `paths` and `baseUrl`, their
 * `extends` chain, a `go.mod` module path, Cargo manifests, a
 * `compile_commands.json`, and the PHP `webRoot` of a `codegraph.json`
 * (#3298). The resolver read them once and
 * kept the maps for its lifetime, and the watcher follows source files only,
 * so an edit kept resolving imports by the old mapping — in the same process,
 * and in later ones too, since a sync re-resolves only the changed files.
 *
 * Each case indexes the first tree, edits it, syncs, and compares edges and
 * unresolved references with a full index of the final tree in a folder of
 * its own.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { ExtractionOrchestrator } from '../src/extraction';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-module-config-'));
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

/** The files the calls written in `caller` land in. */
function callTargets(graph: CodeGraph, caller: string): string[] {
  const node = graph.getNodesByQualifiedName(caller)[0]!;
  return graph.getOutgoingEdges(node.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${graph.getNode(e.target)!.filePath}::${graph.getNode(e.target)!.qualifiedName}`)
    .sort();
}

const tsconfig = (target: string): string =>
  JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': [`${target}/*`] } } });

const TS_BEFORE: Files = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': tsconfig('lib1'),
  'lib1/u.ts': 'export function foo() { return 1; }\n',
  'lib2/u.ts': 'export function foo() { return 2; }\n',
  'c.ts': "import { foo } from '@lib/u';\nexport function bar() { return foo(); }\n",
};

const GO_BEFORE: Files = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'util/u.go': 'package util\n\nfunc Foo() int { return 1 }\n',
  'main.go': 'package main\n\nimport "example.com/app/util"\n\nfunc run() int { return util.Foo() }\n',
};

const cargoMember = (name: string): Files => ({
  [`${name}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
  [`${name}/src/lib.rs`]: 'pub fn run() {}\npub struct Thing;\n',
});

const CARGO_BEFORE: Files = {
  'Cargo.toml': '[workspace]\nmembers = ["a"]\n',
  'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nb = { path = "../b" }\n',
  'a/src/lib.rs': 'use b::Thing;\npub fn go() { b::run(); let _t = Thing; }\n',
  ...cargoMember('b'),
};

const compileDb = (root: string, dir: string): string =>
  JSON.stringify([{ directory: root, file: 'src/a.c', command: `cc -I${dir} -c src/a.c` }]);

const C_BEFORE: Files = {
  'third/foo.h': 'int third_fn(void);\n',
  'other/foo.h': 'int other_fn(void);\n',
  'src/a.c': '#include "foo.h"\nint use(void) { return 1; }\n',
};

/** What the first `#include` of `file` names. */
function includeTarget(graph: CodeGraph, file: string): string[] {
  return graph.getNodesInFile(file).filter((n) => n.kind === 'file')
    .flatMap((n) => graph.getOutgoingEdges(n.id))
    .filter((e) => e.kind === 'imports')
    .map((e) => graph.getNode(e.target)!.filePath);
}

/** A site whose server serves public/, with a file of the same name at the project root. */
const PHP_SITE: Files = {
  'public/index.php': "<?php\nrequire_once $_SERVER['DOCUMENT_ROOT'] . '/config.php';\n",
  'public/config.php': '<?php\nfunction public_config() {}\n',
  'config.php': '<?php\nfunction private_config() {}\n',
};

/** A page that includes three files from the web root, which settle it once all three exist. */
const PHP_THREE_INCLUDES = [
  '<?php',
  "require $_SERVER['DOCUMENT_ROOT'] . '/lib/a.php';",
  "require $_SERVER['DOCUMENT_ROOT'] . '/lib/b.php';",
  "require $_SERVER['DOCUMENT_ROOT'] . '/lib/c.php';",
  '',
].join('\n');

/** The files a PHP file's includes link to. */
function phpIncludeTargets(graph: CodeGraph, file: string): string[] {
  return graph.getNodesInFile(file)
    .flatMap((n) => graph.getOutgoingEdges(n.id))
    .filter((e) => e.kind === 'imports' && graph.getNode(e.target)?.kind === 'file')
    .map((e) => graph.getNode(e.target)!.filePath)
    .sort();
}

/** What a full index of C_BEFORE holds under a compile database naming `dir`, which names the folder it's in. */
async function fullIndexWithDb(dir: string): Promise<string[]> {
  const root = tempRoot();
  write(root, { ...C_BEFORE, 'compile_commands.json': compileDb(root, dir) });
  return stateOf(root, await index(root));
}

/** Index `before`, write `after` over it, sync; return the graph and what a full index of the final tree holds. */
async function syncEdit(before: Files, after: Files): Promise<{ root: string; graph: CodeGraph; full: string[] }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  write(root, after);
  await graph.sync();
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  return { root, graph, full: stateOf(fullRoot, await index(fullRoot)) };
}

describe('a sync follows a module-config change (#2977)', () => {
  it('tsconfig paths retargeted, the importer untouched', async () => {
    const { root, graph, full } = await syncEdit(TS_BEFORE, { 'tsconfig.json': tsconfig('lib2') });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('tsconfig paths retargeted and the importer touched, as the issue did', async () => {
    const { root, graph, full } = await syncEdit(TS_BEFORE, {
      'tsconfig.json': tsconfig('lib2'),
      'c.ts': "import { foo } from '@lib/u';\nexport function bar() { return foo() + 0; }\n",
    });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it("a folder's package.json main retargeted, the importer untouched (#2964)", async () => {
    const before: Files = {
      'lib/package.json': JSON.stringify({ main: 'a.js' }),
      'lib/a.js': 'function a () { return 1 }\nmodule.exports = a\n',
      'lib/b.js': 'function b () { return 2 }\nmodule.exports = b\n',
      'app.js': "const lib = require('./lib')\nfunction go () { return lib() }\n",
    };
    const { root, graph, full } = await syncEdit(before, { 'lib/package.json': JSON.stringify({ main: 'b.js' }) });
    expect(callTargets(graph, 'go')).toEqual(['lib/b.js::b']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a mapping declared in the extends chain', async () => {
    const before: Files = {
      ...TS_BEFORE,
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: true } }),
      'tsconfig.base.json': tsconfig('lib1'),
    };
    const { root, graph, full } = await syncEdit(before, { 'tsconfig.base.json': tsconfig('lib2') });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a go.mod module path renamed, with the imports written for it', async () => {
    const { root, graph, full } = await syncEdit(GO_BEFORE, {
      'go.mod': 'module example.com/other\n\ngo 1.22\n',
      'main.go': 'package main\n\nimport "example.com/other/util"\n\nfunc run() int { return util.Foo() }\n',
    });
    expect(callTargets(graph, 'run')).toEqual(['util/u.go::Foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a Cargo workspace gains a member, the importer untouched', async () => {
    const { root, graph, full } = await syncEdit(CARGO_BEFORE, { 'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n' });
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a crate appears under a `crates/*` member, which no manifest the index knows says', async () => {
    const before: Files = {
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'crates/a/src/lib.rs': 'use b::Thing;\npub fn go() { b::run(); let _t = Thing; }\n',
    };
    const { root, graph, full } = await syncEdit(before, {
      'crates/b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'crates/b/src/lib.rs': 'pub fn run() {}\npub struct Thing;\n',
    });
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a member crate is renamed in its manifest, with the imports written for it', async () => {
    const { root, graph, full } = await syncEdit({ ...CARGO_BEFORE, 'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n' }, {
      'b/Cargo.toml': '[package]\nname = "c"\nversion = "0.1.0"\n',
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nc = { path = "../b" }\n',
      'a/src/lib.rs': 'use c::Thing;\npub fn go() { c::run(); let _t = Thing; }\n',
    });
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a compile database appears, the source untouched', async () => {
    const root = tempRoot();
    write(root, C_BEFORE);
    const graph = await index(root);
    write(root, { 'compile_commands.json': compileDb(root, 'third') });
    await graph.sync();
    expect(includeTarget(graph, 'src/a.c')).toEqual(['third/foo.h']);
    expect(stateOf(root, graph)).toEqual(await fullIndexWithDb('third'));
  }, 120_000);

  it('a compile database names another include directory, the source untouched', async () => {
    const root = tempRoot();
    write(root, { ...C_BEFORE, 'compile_commands.json': compileDb(root, 'third') });
    const graph = await index(root);
    expect(includeTarget(graph, 'src/a.c')).toEqual(['third/foo.h']);
    write(root, { 'compile_commands.json': compileDb(root, 'other') });
    await graph.sync();
    expect(includeTarget(graph, 'src/a.c')).toEqual(['other/foo.h']);
    expect(stateOf(root, graph)).toEqual(await fullIndexWithDb('other'));
  }, 120_000);

  it("a codegraph.json webRoot appears, the PHP untouched (#3298)", async () => {
    const { root, graph, full } = await syncEdit(PHP_SITE, { 'codegraph.json': JSON.stringify({ webRoot: 'public' }) });
    expect(phpIncludeTargets(graph, 'public/index.php')).toEqual(['public/config.php']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a webRoot moves to the project root, then goes away', async () => {
    const { root, graph, full } = await syncEdit(
      { ...PHP_SITE, 'codegraph.json': JSON.stringify({ webRoot: 'public' }) },
      { 'codegraph.json': JSON.stringify({ webRoot: '.' }) }
    );
    expect(phpIncludeTargets(graph, 'public/index.php')).toEqual(['config.php']);
    expect(stateOf(root, graph)).toEqual(full);
    write(root, { 'codegraph.json': JSON.stringify({ deprioritize: ['scripts/'] }) });
    await graph.sync();
    expect(phpIncludeTargets(graph, 'public/index.php')).toEqual([]);
    const fullRoot = tempRoot();
    write(fullRoot, { ...PHP_SITE, 'codegraph.json': JSON.stringify({ deprioritize: ['scripts/'] }) });
    expect(stateOf(root, graph)).toEqual(stateOf(fullRoot, await index(fullRoot)));
  }, 120_000);

  it('the web root the includes show appears when a sync adds the third file that settles it, and goes with it', async () => {
    const before: Files = { 'index.php': PHP_THREE_INCLUDES, 'lib/a.php': '<?php\nfunction a() {}\n', 'lib/b.php': '<?php\nfunction b() {}\n' };
    const { root, graph, full } = await syncEdit(before, { 'lib/c.php': '<?php\nfunction c() {}\n' });
    // Two paths settle nothing; the third places the project root, so the
    // unchanged index.php's parked includes of lib/a.php and lib/b.php link too.
    expect(phpIncludeTargets(graph, 'index.php')).toEqual(['lib/a.php', 'lib/b.php', 'lib/c.php']);
    expect(stateOf(root, graph)).toEqual(full);
    fs.rmSync(path.join(root, 'lib/c.php'));
    await graph.sync();
    expect(phpIncludeTargets(graph, 'index.php')).toEqual([]);
    const fullRoot = tempRoot();
    write(fullRoot, before);
    expect(stateOf(root, graph)).toEqual(stateOf(fullRoot, await index(fullRoot)));
  }, 120_000);

  it('an edit that leaves the inferred web root where it was re-opens nothing', async () => {
    const root = tempRoot();
    write(root, { 'index.php': PHP_THREE_INCLUDES, 'lib/a.php': '<?php\nfunction a() {}\n', 'lib/b.php': '<?php\nfunction b() {}\n', 'lib/c.php': '<?php\nfunction c() {}\n' });
    const graph = await index(root);
    expect(phpIncludeTargets(graph, 'index.php')).toEqual(['lib/a.php', 'lib/b.php', 'lib/c.php']);
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      write(root, { 'lib/b.php': '<?php\nfunction b() { return 2; }\n', 'lib/d.php': '<?php\nfunction d() {}\n' });
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
    expect(phpIncludeTargets(graph, 'index.php')).toEqual(['lib/a.php', 'lib/b.php', 'lib/c.php']);
  }, 120_000);

  it('a page in a new folder takes the inferred web root and re-opens nothing else', async () => {
    const root = tempRoot();
    write(root, { 'index.php': PHP_THREE_INCLUDES, 'lib/a.php': '<?php\nfunction a() {}\n', 'lib/b.php': '<?php\nfunction b() {}\n', 'lib/c.php': '<?php\nfunction c() {}\n' });
    const graph = await index(root);
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      write(root, { 'news/item.php': "<?php\nrequire $_SERVER['DOCUMENT_ROOT'] . '/lib/a.php';\n" });
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
    expect(phpIncludeTargets(graph, 'news/item.php')).toEqual(['lib/a.php']);
    expect(phpIncludeTargets(graph, 'index.php')).toEqual(['lib/a.php', 'lib/b.php', 'lib/c.php']);
  }, 120_000);

  it('a codegraph.json that sets no webRoot re-opens nothing, written or edited', async () => {
    const root = tempRoot();
    write(root, PHP_SITE);
    const graph = await index(root);
    const before = stateOf(root, graph);
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      write(root, { 'codegraph.json': JSON.stringify({ deprioritize: ['scripts/'] }) });
      await graph.sync();
      write(root, { 'codegraph.json': JSON.stringify({ deprioritize: ['scripts/', 'tools/'] }) });
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
    expect(stateOf(root, graph)).toEqual(before);
  }, 120_000);

  it('a folder under a config\'s name is no config: it counts as absent, and the next candidate is read', async () => {
    const root = tempRoot();
    write(root, { ...C_BEFORE, 'build/compile_commands.json': compileDb(root, 'third') });
    fs.mkdirSync(path.join(root, 'compile_commands.json'));
    fs.mkdirSync(path.join(root, 'Cargo.toml'));
    const graph = await index(root);
    expect(includeTarget(graph, 'src/a.c')).toEqual(['third/foo.h']);
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const stored = db.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'module_config_snapshot'").get() as { value: string };
      const snapshot = JSON.parse(stored.value) as Record<string, string>;
      expect(snapshot['compile_commands.json']).toBe('absent');
      expect(snapshot['Cargo.toml']).toBe('absent');
      expect(snapshot['build/compile_commands.json']).not.toBe('absent');
    } finally {
      db.close();
    }
  }, 120_000);

  it('a later process sees the change too', async () => {
    const root = tempRoot();
    write(root, TS_BEFORE);
    const first = await index(root);
    expect(callTargets(first, 'bar')).toEqual(['lib1/u.ts::foo']);
    first.close();
    graphs.splice(graphs.indexOf(first), 1);

    write(root, { 'tsconfig.json': tsconfig('lib2') });
    const second = await CodeGraph.open(root);
    graphs.push(second);
    await second.sync();
    expect(callTargets(second, 'bar')).toEqual(['lib2/u.ts::foo']);
  }, 120_000);

  it('an unchanged config re-opens nothing', async () => {
    const root = tempRoot();
    write(root, TS_BEFORE);
    const graph = await index(root);
    const before = stateOf(root, graph);
    // A body edit elsewhere: the import map is read again and found the same.
    write(root, { 'lib2/u.ts': 'export function foo() { return 3; }\n' });
    const result = await graph.sync();
    expect(result.filesModified).toBe(1);
    expect(stateOf(root, graph)).toEqual(before);
  }, 120_000);

  it('a manifest or compile database edit that moves no import re-opens nothing', async () => {
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      const root = tempRoot();
      write(root, { ...C_BEFORE, ...CARGO_BEFORE, 'compile_commands.json': compileDb(root, 'third') });
      const graph = await index(root);
      const before = stateOf(root, graph);
      reopen.mockClear();
      // A version bump, and a build that wrote its database again with more of the same.
      write(root, {
        'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.2.0"\n\n[dependencies]\nb = { path = "../b" }\n',
        'compile_commands.json': JSON.stringify([
          { directory: root, file: 'src/a.c', command: 'cc -Ithird -c src/a.c' },
          { directory: root, file: 'src/b.c', command: 'cc -Ithird -c src/b.c' },
        ]),
      });
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
      expect(stateOf(root, graph)).toEqual(before);
    } finally {
      reopen.mockRestore();
    }
  }, 120_000);

  it('a compile database whose stamp has not moved is not read again', async () => {
    const root = tempRoot();
    write(root, { ...C_BEFORE, 'compile_commands.json': compileDb(root, 'third') });
    const file = path.join(root, 'compile_commands.json');
    const when = new Date(1_700_000_000_000);
    fs.utimesSync(file, when, when);
    const graph = await index(root);
    // Unreadable as JSON, and the same size and time: reading it would drop the directory.
    fs.writeFileSync(file, 'x'.repeat(fs.statSync(file).size));
    fs.utimesSync(file, when, when);
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
  }, 120_000);

  it('an index from before manifests counted re-opens nothing on its first sync', async () => {
    const root = tempRoot();
    write(root, CARGO_BEFORE);
    const graph = await index(root);
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const stored = db.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'module_config_snapshot'").get() as { value: string };
      const old = Object.fromEntries(Object.entries(JSON.parse(stored.value) as Record<string, string>)
        .filter(([rel]) => !/Cargo\.toml$|compile_commands\.json$/.test(rel))
        .map(([rel, entry]) => [rel, entry.split('@')[0]!]));
      db.getDb().prepare("UPDATE project_metadata SET value = ? WHERE key = 'module_config_snapshot'").run(JSON.stringify(old));
    } finally {
      db.close();
    }
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      await graph.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
  }, 120_000);

  it('a config edit that moves no mapping re-opens nothing: a tsconfig flag, a go.mod requirement', async () => {
    const tsRoot = tempRoot();
    write(tsRoot, TS_BEFORE);
    const ts = await index(tsRoot);
    const tsBefore = stateOf(tsRoot, ts);
    const goRoot = tempRoot();
    write(goRoot, GO_BEFORE);
    const go = await index(goRoot);
    const goBefore = stateOf(goRoot, go);
    // Every import a language has goes back for the sweep when its map moves;
    // an edit resolution never reads must not send them there.
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      write(tsRoot, { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib1/*'] }, strict: true } }) });
      await ts.sync();
      write(goRoot, { 'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire golang.org/x/text v0.14.0\n' });
      await go.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
    expect(stateOf(tsRoot, ts)).toEqual(tsBefore);
    expect(stateOf(goRoot, go)).toEqual(goBefore);
  }, 120_000);
});
