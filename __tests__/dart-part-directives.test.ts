/**
 * A Dart library names each of its parts with `part '<uri>';`, and that links
 * the library's file to the part's: an `imports` edge, by the URI rules an
 * import or export follows. A part and its library are one library, so a
 * change to the part is a change to what every importer of the library sees.
 * Before, neither `part` nor `part of` left a trace, and the two files were
 * joined only by whatever symbol edges happened to cross between them —
 * riverpod's framework.dart, which holds nothing but its parts, by none, so a
 * change to one of them reached no test that imports riverpod. `part of`
 * still adds nothing: the library's edge already joins the two files.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildFile } from '../src/ui-server/api/file';

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `<line> -> <target>` for every `imports` edge out of `file`: a file by its path, anything else by kind, file and name. */
function importsFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids, ['imports'])
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${e.line} -> ${t.kind === 'file' ? t.filePath : `${t.kind} ${t.filePath}#${t.name}`}`;
    })
    .sort();
}

/** The URIs of `file`'s imports left unresolved. */
function unresolvedImportsOf(cg: CodeGraph, file: string): string[] {
  const fileNode = cg.getNodesInFile(file).find((n) => n.kind === 'file')!;
  return cg.getUnresolvedReferencesFrom(fileNode.id)
    .filter((r) => r.referenceKind === 'imports')
    .map((r) => r.referenceName)
    .sort();
}

/** `<name> | <signature>` of each `import` node in `file`. */
function importNodesIn(cg: CodeGraph, file: string): string[] {
  return cg.getNodesInFile(file)
    .filter((n) => n.kind === 'import')
    .map((n) => `${n.name} | ${n.signature}`)
    .sort();
}

/** Every file a change to `file` reaches through its dependents, as `codegraph affected` walks them. */
function reachedFrom(cg: CodeGraph, file: string): string[] {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    for (const dependent of cg.getFileDependents(queue.shift()!)) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  seen.delete(file);
  return [...seen].sort();
}

describe('Dart part directives', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-parts-'));
    writeTree(root, {
      // riverpod's framework.dart: a library made of nothing but its parts,
      // one in a subdirectory, one generated; a barrel exports it and a test
      // imports the barrel.
      'pubspec.yaml': 'name: app\n',
      'lib/src/framework.dart': `import 'dart:async';

import 'package:meta/meta.dart';

part 'core/element.dart';
part "core/container.dart";
part 'framework.g.dart';
`,
      'lib/src/core/element.dart': `part of '../framework.dart';

class Element {}
`,
      'lib/src/core/container.dart': `part of '../framework.dart';

class Container {}
`,
      'lib/src/framework.g.dart': `// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'framework.dart';

String _$frameworkHash() => 'abc';
`,
      'lib/app.dart': `export 'src/framework.dart';
`,
      'test/framework_test.dart': `import 'package:app/app.dart';

void main() {}
`,
      // A part named by a package: URI, and a part of a library named by its library name.
      'packages/kit/pubspec.yaml': 'name: kit\n',
      'packages/kit/lib/kit.dart': `part 'package:kit/src/widgets.dart';
`,
      'packages/kit/lib/src/widgets.dart': `part of 'package:kit/kit.dart';

class Widget {}
`,
      'lib/legacy/models.dart': `library app.models;

part 'user.dart';
`,
      'lib/legacy/user.dart': `part of app.models;

class User {}
`,
      // A generated part nobody committed, and another app's file of that name.
      'examples/a/pubspec.yaml': 'name: a\n',
      'examples/a/lib/main.dart': `part 'main.g.dart';

void main() {}
`,
      'examples/b/pubspec.yaml': 'name: b\n',
      'examples/b/lib/main.dart': `part 'main.g.dart';

void main() {}
`,
      'examples/b/lib/main.g.dart': `part of 'main.dart';
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links a library to each part it names, as an import node and an imports edge', () => {
    expect(importsFrom(cg, 'lib/src/framework.dart')).toEqual([
      '5 -> lib/src/core/element.dart',
      '6 -> lib/src/core/container.dart',
      '7 -> lib/src/framework.g.dart',
    ]);
    expect(unresolvedImportsOf(cg, 'lib/src/framework.dart')).toEqual(['dart:async', 'package:meta/meta.dart']);
    expect(importNodesIn(cg, 'lib/src/framework.dart')).toEqual([
      'core/container.dart | part "core/container.dart";',
      'core/element.dart | part \'core/element.dart\';',
      'dart:async | import \'dart:async\';',
      'framework.g.dart | part \'framework.g.dart\';',
      'package:meta/meta.dart | import \'package:meta/meta.dart\';',
    ]);
  });

  it('resolves a part named by a package: URI or under a library name', () => {
    expect(importsFrom(cg, 'packages/kit/lib/kit.dart')).toEqual(['1 -> packages/kit/lib/src/widgets.dart']);
    expect(importsFrom(cg, 'lib/legacy/models.dart')).toEqual(['3 -> lib/legacy/user.dart']);
  });

  it('records nothing for `part of`', () => {
    for (const part of ['lib/src/core/element.dart', 'lib/src/framework.g.dart', 'packages/kit/lib/src/widgets.dart', 'lib/legacy/user.dart']) {
      expect(importsFrom(cg, part), part).toEqual([]);
      expect(unresolvedImportsOf(cg, part), part).toEqual([]);
      expect(importNodesIn(cg, part), part).toEqual([]);
    }
  });

  it("leaves a part the project doesn't have unresolved, never another file of its name", () => {
    expect(importsFrom(cg, 'examples/a/lib/main.dart')).toEqual([]);
    expect(unresolvedImportsOf(cg, 'examples/a/lib/main.dart')).toEqual(['main.g.dart']);
    expect(importsFrom(cg, 'examples/b/lib/main.dart')).toEqual(['1 -> examples/b/lib/main.g.dart']);
  });

  it('makes a change to a part reach what depends on its library', () => {
    expect(cg.getFileDependents('lib/src/core/element.dart')).toEqual(['lib/src/framework.dart']);
    expect(cg.getFileDependencies('lib/src/framework.dart').sort()).toEqual([
      'lib/src/core/container.dart',
      'lib/src/core/element.dart',
      'lib/src/framework.g.dart',
    ]);
    expect(reachedFrom(cg, 'lib/src/core/element.dart')).toEqual([
      'lib/app.dart',
      'lib/src/framework.dart',
      'test/framework_test.dart',
    ]);
  });

  it("shows the parts on the library's import rail and the library on each part's", () => {
    const library = buildFile(cg, root, 'lib/src/framework.dart') as {
      imports: { items: Array<{ file: string }> };
      dependencies: string[];
    };
    expect(library.imports.items.map((row) => row.file).sort()).toEqual([
      'lib/src/core/container.dart',
      'lib/src/core/element.dart',
      'lib/src/framework.g.dart',
    ]);
    const part = buildFile(cg, root, 'lib/src/framework.g.dart') as {
      imports: { items: unknown[] };
      importedBy: { items: Array<{ file: string }> };
      unresolvedImports: unknown[];
      dependents: string[];
    };
    expect(part.importedBy.items.map((row) => row.file)).toEqual(['lib/src/framework.dart']);
    expect(part.imports.items).toEqual([]);
    expect(part.unresolvedImports).toEqual([]);
    expect(part.dependents).toEqual(['lib/src/framework.dart']);
  });
});
