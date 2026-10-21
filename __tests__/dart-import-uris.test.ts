/**
 * A Dart `import` / `export` names a library by URI, and links the file the
 * URI names or nothing. `package:<name>/<path>` is `<root>/lib/<path>` of the
 * project package whose pubspec.yaml says `name: <name>`; any other URI is a
 * path from the importing file; `dart:` and a package from outside the project
 * name no project file. The URI's last path segment is not a file name to
 * match: riverpod's `import 'package:flutter/foundation.dart'` went to its own
 * packages/riverpod/lib/src/core/foundation.dart, bloc_tools'
 * `package:args/command_runner.dart` to the importing file itself, and the
 * import of an indexed project file went to the importing file's own `import`
 * node, which says nothing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

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

describe('Dart import and export URIs', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-uris-'));
    writeTree(root, {
      // riverpod: an example app imports flutter's foundation.dart and the
      // project's own riverpod package; riverpod has a foundation.dart too.
      'packages/riverpod/pubspec.yaml': 'name: riverpod\n',
      'packages/riverpod/lib/riverpod.dart': `export 'src/core/foundation.dart';
export 'package:meta/meta.dart' show internal;
`,
      'packages/riverpod/lib/src/core/foundation.dart': `class ProviderBase {}
`,
      'packages/riverpod/lib/src/core/container.dart': `import 'dart:async';

import 'package:meta/meta.dart';

import 'foundation.dart';

class Container extends ProviderBase {}
`,
      'examples/pub/pubspec.yaml': 'name: pub\n',
      'examples/pub/lib/pub_repository.dart': `import 'package:flutter/foundation.dart';
import 'package:riverpod/riverpod.dart';
import 'package:riverpod/src/core/foundation.dart' as core;

class PubRepository {}
`,
      // bloc_tools imports package:args' command_runner.dart from its own command_runner.dart.
      'packages/bloc_tools/pubspec.yaml': 'name: bloc_tools\n',
      'packages/bloc_tools/lib/src/command_runner.dart': `import 'package:args/command_runner.dart';

class BlocToolsCommandRunner {}
`,
      // An integration test imports package:integration_test; a driver beside it is named integration_test.dart.
      'examples/flutter_counter/pubspec.yaml': 'name: flutter_counter\n',
      'examples/flutter_counter/integration_test/app_test.dart': `import 'package:integration_test/integration_test.dart';

void main() {}
`,
      'examples/flutter_counter/test_driver/integration_test.dart': `import 'package:integration_test/integration_test_driver.dart';

Future<void> main() async {}
`,
      // A relative import, and an old file with the same name.
      'pubspec.yaml': 'name: app\n',
      'test/src/utils.dart': `int errorsOf() => 0;
`,
      'test/old/utils.dart': `int errorsOf() => 0;
`,
      'test/feature/uni_directional_test.dart': `import '../src/utils.dart';

void main() {}
`,
      // A translated copy of a docs page whose sibling was never translated.
      'website/docs/cancel/detail_screen/codegen.dart': `class DetailScreen {}
`,
      'website/i18n/it/cancel/home_screen.dart': `import 'detail_screen/codegen.dart';

class HomeScreen {}
`,
      // Two apps each keep a package named auth_repo, and each app's pubspec says which by path.
      'examples/login_a/pubspec.yaml': `name: login_a
dependencies:
  auth_repo:
    # the app's own copy
    path: packages/auth_repo
  bloc: ^9.0.0
`,
      'examples/login_a/packages/auth_repo/pubspec.yaml': 'name: auth_repo\n',
      'examples/login_a/packages/auth_repo/lib/auth_repo.dart': `class AuthRepo {}
`,
      'examples/login_a/lib/app.dart': `import 'package:auth_repo/auth_repo.dart';

class AppA {}
`,
      'examples/login_b/pubspec.yaml': `name: login_b
dependencies:
  auth_repo: { path: "packages/auth_repo" }
`,
      'examples/login_b/packages/auth_repo/pubspec.yaml': 'name: auth_repo\n',
      'examples/login_b/packages/auth_repo/lib/auth_repo.dart': `class AuthRepo {}
`,
      'examples/login_b/lib/app.dart': `import 'package:auth_repo/auth_repo.dart';

class AppB {}
`,
      // A third app says nothing about which auth_repo it means.
      'examples/login_c/pubspec.yaml': 'name: login_c\n',
      'examples/login_c/lib/app.dart': `import 'package:auth_repo/auth_repo.dart';

class AppC {}
`,
      // Packages named example: each one's own package: imports mean itself.
      'packages/a/example/pubspec.yaml': 'name: example\n',
      'packages/a/example/lib/main.dart': `import 'package:example/src/screen.dart';

void main() {}
`,
      'packages/a/example/lib/src/screen.dart': `class ScreenA {}
`,
      'packages/b/example/pubspec.yaml': 'name: example\n',
      'packages/b/example/lib/src/screen.dart': `class ScreenB {}
`,
      // A package import of a file the project doesn't have (a generated file nobody committed).
      'packages/riverpod/lib/src/missing_user.dart': `import 'package:riverpod/src/core/foundation.g.dart';
import 'package:riverpod/src/missing_user.dart';
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("links an outside package's import to no project file of the same name", () => {
    expect(importsFrom(cg, 'examples/pub/lib/pub_repository.dart')).toEqual([
      '2 -> packages/riverpod/lib/riverpod.dart',
      '3 -> packages/riverpod/lib/src/core/foundation.dart',
    ]);
    expect(unresolvedImportsOf(cg, 'examples/pub/lib/pub_repository.dart')).toEqual(['package:flutter/foundation.dart']);
  });

  it('never links a file to itself or a namesake for an outside package', () => {
    expect(importsFrom(cg, 'packages/bloc_tools/lib/src/command_runner.dart')).toEqual([]);
    expect(importsFrom(cg, 'examples/flutter_counter/integration_test/app_test.dart')).toEqual([]);
    expect(importsFrom(cg, 'examples/flutter_counter/test_driver/integration_test.dart')).toEqual([]);
  });

  it('links a relative import and an export to the file they name, and dart: or outside packages to nothing', () => {
    expect(importsFrom(cg, 'packages/riverpod/lib/src/core/container.dart')).toEqual([
      '5 -> packages/riverpod/lib/src/core/foundation.dart',
    ]);
    expect(unresolvedImportsOf(cg, 'packages/riverpod/lib/src/core/container.dart')).toEqual(['dart:async', 'package:meta/meta.dart']);
    expect(importsFrom(cg, 'packages/riverpod/lib/riverpod.dart')).toEqual(['1 -> packages/riverpod/lib/src/core/foundation.dart']);
    expect(importsFrom(cg, 'test/feature/uni_directional_test.dart')).toEqual(['1 -> test/src/utils.dart']);
  });

  it('links nothing when the file a URI names is not in the project', () => {
    expect(importsFrom(cg, 'website/i18n/it/cancel/home_screen.dart')).toEqual([]);
    // Nor does a file's import of itself say anything.
    expect(importsFrom(cg, 'packages/riverpod/lib/src/missing_user.dart')).toEqual([]);
  });

  it("tells same-named packages apart by the importing package's own name or its path dependency", () => {
    expect(importsFrom(cg, 'examples/login_a/lib/app.dart')).toEqual(['1 -> examples/login_a/packages/auth_repo/lib/auth_repo.dart']);
    expect(importsFrom(cg, 'examples/login_b/lib/app.dart')).toEqual(['1 -> examples/login_b/packages/auth_repo/lib/auth_repo.dart']);
    expect(importsFrom(cg, 'examples/login_c/lib/app.dart')).toEqual([]);
    expect(importsFrom(cg, 'packages/a/example/lib/main.dart')).toEqual(['1 -> packages/a/example/lib/src/screen.dart']);
  });
});
