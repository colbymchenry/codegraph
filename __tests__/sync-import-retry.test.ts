/**
 * A sync links an import whose file appears after the importer was indexed.
 *
 * Sync retries parked failed refs by name tail (#1240), but an import names a
 * file, a folder or a namespace, not a symbol, so the symbol-name lookup never
 * found it: the tail of `package:app/b.dart` was `dart`, of `inc/db.php`
 * `php`, of `./foo` `/foo`. Most languages never even parked theirs: a module
 * path that named no file reached the importing file's own `import` node by
 * its qualified name, and that edge was never revisited. A Lua `require` took
 * the local it is assigned to. Either way the import linked only once the
 * importer itself changed, or on a full index.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { importPathKeys } from '../src/db/reference-tail';
import type { Node } from '../src/types';

interface Case {
  name: string;
  initial: Record<string, string>;
  added: Record<string, string>;
  /** The importing file. */
  from: string;
  /** What its imports reach once `added` exists: `<kind> <file>`. */
  expected: string[];
}

const CASES: Case[] = [
  {
    name: 'Dart',
    initial: {
      'pubspec.yaml': 'name: app\n',
      'lib/a.dart': "import 'package:app/b.dart';\nimport 'package:kit/kit.dart';\nimport 'c.dart';\nimport 'src/d.dart';\nexport 'src/e.dart';\npart 'a.g.dart';\n\nvoid main() {}\n",
    },
    added: {
      'lib/b.dart': 'class B {}\n',
      'packages/kit/pubspec.yaml': 'name: kit\n',
      'packages/kit/lib/kit.dart': 'class Kit {}\n',
      'lib/c.dart': 'class C {}\n',
      'lib/src/d.dart': 'class D {}\n',
      'lib/src/e.dart': 'class E {}\n',
      // A generated part, written by build_runner after the library was indexed.
      'lib/a.g.dart': "part of 'a.dart';\n\nclass _Generated {}\n",
    },
    from: 'lib/a.dart',
    expected: ['file lib/b.dart', 'file packages/kit/lib/kit.dart', 'file lib/c.dart', 'file lib/src/d.dart', 'file lib/src/e.dart', 'file lib/a.g.dart'],
  },
  {
    name: 'TypeScript',
    initial: {
      'src/a.ts': "import { X } from './x';\nimport './side';\nimport * as NS from './ns';\nimport { Y } from './dir';\nimport { Z } from './z.js';\nimport type { T } from './types';\nexport function run() { return [X, NS, Y, Z]; }\nexport type U = T;\n",
    },
    added: {
      'src/x.ts': 'export const X = 1;\n',
      'src/side.ts': 'console.log(1);\n',
      'src/ns.ts': 'export const member = 1;\n',
      'src/dir/index.ts': 'export const Y = 2;\n',
      'src/z.ts': 'export const Z = 3;\n',
      'src/types.d.ts': 'export interface T { a: number }\n',
    },
    from: 'src/a.ts',
    expected: ['file src/x.ts', 'file src/side.ts', 'file src/ns.ts', 'file src/dir/index.ts', 'file src/z.ts', 'file src/types.d.ts'],
  },
  {
    name: 'JavaScript',
    initial: {
      'a.js': "import './side';\nimport def from './def.js';\nconst req = require('./req');\nconst lib = require('./lib');\nmodule.exports = { def, req, lib };\n",
    },
    added: {
      'side.js': 'console.log(1);\n',
      'def.js': 'export default function def() {}\n',
      'req.js': 'module.exports = 1;\n',
      'lib/index.js': 'module.exports = 2;\n',
    },
    from: 'a.js',
    expected: ['file side.js', 'file def.js', 'file req.js', 'file lib/index.js'],
  },
  {
    name: 'C',
    initial: { 'src/main.c': '#include "a/b.h"\n#include "c.h"\n#include <stdio.h>\nint main(void) { return 0; }\n' },
    added: { 'src/a/b.h': 'int b(void);\n', 'src/c.h': 'int c(void);\n' },
    from: 'src/main.c',
    expected: ['file src/a/b.h', 'file src/c.h'],
  },
  {
    name: 'C++',
    initial: { 'src/main.cpp': '#include "util/u.hpp"\n#include "w.h"\nint main() { return 0; }\n' },
    added: { 'src/util/u.hpp': 'namespace util { int u(); }\n', 'src/w.h': 'int w();\n' },
    from: 'src/main.cpp',
    expected: ['file src/util/u.hpp', 'file src/w.h'],
  },
  {
    name: 'Objective-C',
    initial: { 'Foo.m': '#import "Bar.h"\n#import "sub/Baz.h"\n@implementation Foo\n@end\n' },
    added: { 'Bar.h': '@interface Bar\n@end\n', 'sub/Baz.h': '@interface Baz\n@end\n' },
    from: 'Foo.m',
    expected: ['file Bar.h', 'file sub/Baz.h'],
  },
  {
    name: 'PHP',
    initial: { 'index.php': "<?php\nrequire 'inc/db.php';\ninclude_once 'helpers.php';\n" },
    added: { 'inc/db.php': '<?php\nfunction db() {}\n', 'helpers.php': '<?php\nfunction helper() {}\n' },
    from: 'index.php',
    expected: ['file inc/db.php', 'file helpers.php'],
  },
  {
    name: 'Ruby',
    initial: { 'app.rb': "require_relative 'lib/foo'\nrequire 'lib/bar'\nclass App; end\n" },
    added: { 'lib/foo.rb': 'class Foo; end\n', 'lib/bar.rb': 'class Bar; end\n' },
    from: 'app.rb',
    expected: ['file lib/foo.rb', 'file lib/bar.rb'],
  },
  {
    name: 'Python',
    initial: { 'main.py': 'import pkg.mod\nfrom pkg import other\nfrom pkg.sub import thing\nimport single\n\ndef run():\n    return pkg.mod, other, thing, single\n' },
    added: {
      'pkg/__init__.py': '',
      'pkg/mod.py': 'def f():\n    return 1\n',
      'pkg/other.py': 'def g():\n    return 2\n',
      'pkg/sub/__init__.py': 'thing = 3\n',
      'single.py': 'value = 4\n',
    },
    from: 'main.py',
    expected: ['file pkg/mod.py', 'file pkg/other.py', 'file pkg/sub/__init__.py', 'file single.py', 'variable pkg/sub/__init__.py'],
  },
  {
    name: 'Lua',
    initial: { 'main.lua': 'local m = require("lib.mod")\nlocal p = require("pkg")\nreturn { m, p }\n' },
    added: { 'lib/mod.lua': 'local M = {}\nreturn M\n', 'pkg/init.lua': 'local P = {}\nreturn P\n' },
    from: 'main.lua',
    expected: ['file lib/mod.lua', 'file pkg/init.lua'],
  },
  {
    name: 'Luau',
    initial: { 'src/main.luau': 'local Signal = require(script.Parent.Signal)\nreturn Signal\n' },
    added: { 'src/Signal.luau': 'local S = {}\nreturn S\n' },
    from: 'src/main.luau',
    expected: ['file src/Signal.luau'],
  },
  {
    name: 'Nix',
    initial: { 'default.nix': '{ pkgs }:\nlet\n  foo = import ./foo.nix;\n  bar = import ./bar;\nin { inherit foo bar; }\n' },
    added: { 'foo.nix': '{ a = 1; }\n', 'bar/default.nix': '{ b = 2; }\n' },
    from: 'default.nix',
    expected: ['file foo.nix', 'file bar/default.nix'],
  },
  {
    name: 'R',
    initial: { 'main.R': 'source("utils.R")\nsource("R/helpers.R")\nrun <- function() 1\n' },
    added: { 'utils.R': 'u <- function() 1\n', 'R/helpers.R': 'h <- function() 2\n' },
    from: 'main.R',
    expected: ['file utils.R', 'file R/helpers.R'],
  },
  {
    name: 'Solidity',
    initial: { 'A.sol': 'pragma solidity ^0.8.0;\nimport "./B.sol";\nimport "./lib/C.sol";\ncontract A {}\n' },
    added: { 'B.sol': 'pragma solidity ^0.8.0;\ncontract B {}\n', 'lib/C.sol': 'pragma solidity ^0.8.0;\ncontract C {}\n' },
    from: 'A.sol',
    expected: ['file B.sol', 'file lib/C.sol'],
  },
  {
    name: 'Erlang',
    initial: { 'src/a.erl': '-module(a).\n-include("b.hrl").\n-include_lib("app/include/c.hrl").\n-export([f/0]).\nf() -> ok.\n' },
    added: { 'src/b.hrl': '-define(B, 1).\n', 'include/c.hrl': '-define(C, 1).\n' },
    from: 'src/a.erl',
    expected: ['file src/b.hrl', 'file include/c.hrl'],
  },
  {
    name: 'COBOL',
    initial: {
      'MAIN.cbl': '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MAIN.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       COPY CUSTREC.\n       PROCEDURE DIVISION.\n           STOP RUN.\n',
    },
    added: { 'CUSTREC.cpy': '       01 CUST-REC.\n          05 CUST-ID PIC 9(5).\n' },
    from: 'MAIN.cbl',
    expected: ['file CUSTREC.cpy'],
  },
  {
    name: 'Java (a package wildcard)',
    initial: { 'src/com/x/A.java': 'package com.x;\nimport com.z.*;\npublic class A {}\n' },
    added: { 'src/com/z/Z.java': 'package com.z;\npublic class Z {}\n' },
    from: 'src/com/x/A.java',
    expected: ['namespace src/com/z/Z.java'],
  },
  {
    name: 'C# (a using of a namespace declared later)',
    initial: { 'A.cs': 'using Foo.Bar;\nnamespace App { class A {} }\n' },
    added: { 'Baz.cs': 'namespace Foo.Bar { class Baz {} }\n' },
    from: 'A.cs',
    expected: ['namespace Baz.cs'],
  },
  {
    name: 'Svelte',
    initial: { 'src/App.svelte': "<script>\n  import Child from './Child.svelte';\n</script>\n<Child />\n" },
    added: { 'src/Child.svelte': '<p>child</p>\n' },
    from: 'src/App.svelte',
    expected: ['file src/Child.svelte'],
  },
  {
    name: 'Vue',
    initial: { 'src/App.vue': "<script setup>\nimport Child from './Child.vue';\n</script>\n<template><Child /></template>\n" },
    added: { 'src/Child.vue': '<template><p>child</p></template>\n' },
    from: 'src/App.vue',
    expected: ['file src/Child.vue'],
  },
];

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `<kind> <file>` for every `imports` edge out of `file`, plus how many land on one of its own import statements. */
function importsOf(file: string): { targets: string[]; ownStatements: number } {
  const graph = cg!;
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  const targets = new Set<string>();
  let ownStatements = 0;
  for (const edge of graph.getOutgoingEdgesFrom(ids, ['imports'])) {
    const target = graph.getNode(edge.target);
    if (!target) continue;
    if (target.filePath === file) {
      if (target.kind === 'import') ownStatements++;
      continue;
    }
    targets.add(`${target.kind} ${target.filePath}`);
  }
  return { targets: [...targets].sort(), ownStatements };
}

describe('sync links an import of a file that appears after the importer', () => {
  it.each(CASES)('$name', async (c) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-import-'));
    write(c.initial);
    cg = await CodeGraph.init(root, { index: true });

    // Unresolved, the import parks as failed — not as an edge to itself.
    const before = importsOf(c.from);
    expect(before.ownStatements).toBe(0);
    for (const target of c.expected) expect(before.targets).not.toContain(target);

    write(c.added);
    const result = await cg.sync();
    expect(result.filesAdded).toBe(Object.keys(c.added).length);

    // The importer did not change: only the retry of its parked import links it.
    const synced = importsOf(c.from);
    expect(synced.targets).toEqual(expect.arrayContaining(c.expected));
    expect(synced.ownStatements).toBe(0);
    expect(cg.getPendingReferenceCount()).toBe(0);

    await cg.indexAll();
    expect(importsOf(c.from)).toEqual(synced);
  }, 60_000);
});

describe('a removed file', () => {
  it('relinks its unchanged importers when it is restored', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-import-'));
    write({
      'pubspec.yaml': 'name: app\n',
      'lib/a.dart': "import 'package:app/b.dart';\n\nvoid main() {}\n",
      'lib/b.dart': 'class B {}\n',
    });
    cg = await CodeGraph.init(root, { index: true });
    expect(importsOf('lib/a.dart').targets).toEqual(['file lib/b.dart']);

    fs.rmSync(path.join(root, 'lib/b.dart'));
    expect((await cg.sync()).filesRemoved).toBe(1);
    expect(importsOf('lib/a.dart')).toEqual({ targets: [], ownStatements: 0 });
    expect(cg.getPendingReferenceCount()).toBe(0);

    write({ 'lib/b.dart': 'class B {}\n' });
    expect((await cg.sync()).filesAdded).toBe(1);
    expect(importsOf('lib/a.dart').targets).toEqual(['file lib/b.dart']);
  }, 60_000);
});

describe('importPathKeys', () => {
  it('names a file and its folder, whole and up to the first dot', () => {
    expect(importPathKeys('lib/src/d.dart')).toEqual(['src', 'd.dart', 'd']);
    expect(importPathKeys('src/types.d.ts')).toEqual(['src', 'types.d.ts', 'types']);
    expect(importPathKeys('pkg/sub/__init__.py')).toEqual(['sub', '__init__.py', '__init__']);
    expect(importPathKeys('vendor/gopkg.in/yaml.v3/yaml.go')).toEqual(['yaml.v3', 'yaml', 'yaml.go']);
    expect(importPathKeys('main.c')).toEqual(['main.c', 'main']);
    expect(importPathKeys('.github/.eslintrc.js')).toEqual(['.github', '.eslintrc.js', '.eslintrc']);
  });
});

describe('getRetryableFailedImports', () => {
  let db: DatabaseConnection | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup(): QueryBuilder {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-import-'));
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    const failed = (id: string, referenceName: string, referenceKind: 'imports' | 'calls' = 'imports') => {
      const node: Node = { id, kind: 'file', name: id, qualifiedName: id, filePath: id, language: 'dart',
        startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: Date.now() };
      queries.insertNode(node);
      queries.insertUnresolvedRef({ fromNodeId: id, referenceName, referenceKind, line: 1, column: 0, filePath: id, language: 'dart' });
      queries.markReferencesFailed([{ fromNodeId: id, referenceName, referenceKind }]);
    };
    failed('a.dart', 'package:app/b.dart');
    failed('c.dart', '../b.dart');
    failed('d.dart', 'src/b.dart');
    failed('e.dart', 'b.dart');
    failed('f.dart', 'x.b', 'calls');
    failed('g.cs', 'Foo.Bar');
    failed('h.ts', 'useState');
    return queries;
  }

  const names = (refs: Array<{ referenceName: string }>) => refs.map((r) => r.referenceName).sort();

  it('finds an import by the stem of its path or by its whole name, and nothing else', () => {
    const queries = setup();
    expect(names(queries.getRetryableFailedImports(['b']))).toEqual(['../b.dart', 'package:app/b.dart', 'src/b.dart']);
    expect(names(queries.getRetryableFailedImports(['b.dart']))).toEqual(['b.dart']);
    expect(queries.getRetryableFailedImports(['b', 'b.dart', 'b'])).toHaveLength(4);
  });

  it('finds an import by a node name only when the name is not also its tail', () => {
    const queries = setup();
    // `using Foo.Bar` waits for the namespace node of that name.
    expect(names(queries.getRetryableFailedImports([], ['Foo.Bar', 'useState', 'b']))).toEqual(['Foo.Bar']);
    // A path key still reaches a plain name.
    expect(names(queries.getRetryableFailedImports(['useState']))).toEqual(['useState']);
  });

  it('skips a key that more failed imports share than the ceiling', () => {
    const queries = setup();
    expect(queries.getRetryableFailedImports(['b'], [], 2)).toEqual([]);
    expect(names(queries.getRetryableFailedImports(['b', 'b.dart'], [], 2))).toEqual(['b.dart']);
    expect(queries.getRetryableFailedImports(['b'], [], 3)).toHaveLength(3);
  });
});

describe('schema v12', () => {
  let db: DatabaseConnection | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  function fixture(): QueryBuilder {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-import-'));
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({ id: 'a', kind: 'file', name: 'a.dart', qualifiedName: 'lib/a.dart', filePath: 'lib/a.dart',
      language: 'dart', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 });
    for (const [referenceName, referenceKind, tail] of [
      ['package:app/b.dart', 'imports', 'dart'],
      ['c.h', 'imports', 'h'],
      ['lists::map/2', 'calls', 'map'],
    ] as const) {
      queries.insertUnresolvedRef({ fromNodeId: 'a', referenceName, referenceKind, line: 1, column: 0, filePath: 'lib/a.dart', language: 'dart' });
      db.getDb().prepare("UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE reference_name = ?").run(tail, referenceName);
    }
    return queries;
  }

  const tails = () => db!.getDb().prepare('SELECT reference_name AS name, name_tail AS tail FROM unresolved_refs ORDER BY id').all();

  it('rewrites the tail of a path import parked by an older version, and replays cleanly', () => {
    fixture();
    db!.getDb().exec(`DROP INDEX idx_unresolved_failed_import_tail;
      DROP INDEX idx_unresolved_failed_import_name;
      DELETE FROM schema_versions WHERE version >= 12;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (11, 0, 'legacy fixture');`);
    db!.close();
    db = DatabaseConnection.open(path.join(root, 'test.db'));
    expect(getCurrentVersion(db.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    const indexes = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_unresolved_failed_import_%' ORDER BY name").all();
    expect(indexes).toEqual([{ name: 'idx_unresolved_failed_import_name' }, { name: 'idx_unresolved_failed_import_tail' }]);
    const migrated = tails();
    expect(migrated).toEqual([
      { name: 'package:app/b.dart', tail: 'b' },
      { name: 'c.h', tail: 'h' },
      { name: 'lists::map/2', tail: 'map' },
    ]);

    db.getDb().exec('DELETE FROM schema_versions WHERE version >= 12');
    runMigrations(db.getDb(), 11);
    expect(tails()).toEqual(migrated);
  });

  it('looks failed imports up through their own indexes', () => {
    const queries = fixture();
    const prepare = vi.spyOn(db!.getDb(), 'prepare');
    // The fixture's tails are old ones: `dart` finds a row by tail, `c.h` by name.
    expect(queries.getRetryableFailedImports(['dart', 'c.h'], ['Foo.Bar'])).toHaveLength(2);
    const lookups = prepare.mock.calls.map(([sql]) => sql as string).filter((sql) => sql.includes("reference_kind = 'imports'"));
    prepare.mockRestore();
    expect(lookups.length).toBeGreaterThan(0);
    for (const sql of lookups) {
      const plan = db!.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('k').map((row) => (row as { detail: string }).detail).join('; ');
      expect(plan).toMatch(/USING (COVERING )?INDEX idx_unresolved_failed_import_(tail|name)/);
    }
  });
});
