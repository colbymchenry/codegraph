/**
 * A Dart name written without a receiver — a call, a type — means a
 * declaration its library can see: its own (the file and its `part`s), or one
 * a library it imports without a prefix exports, through `export` chains and
 * `show` / `hide`. riverpod's generated `async.g.dart` (`part of
 * 'async.dart'`) called the `family(…)` async.dart declares, and the call went
 * to the `family` of annotated.dart beside it; a test's `fakeAsync(…)` from
 * package:fake_async went to a vendored copy nobody imports.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { readDartDirectives } from '../src/resolution/dart-libraries';

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `<kind> <line> <name> -> <target file>:<target qualified name>` for every edge out of `file`. */
function edgesFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${e.kind} ${e.line} ${String(e.metadata?.refName ?? '')} -> ${t.filePath}:${t.qualifiedName}`;
    });
}

describe('Dart library visibility', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-libs-'));
    writeTree(root, {
      'pubspec.yaml': 'name: app\n',
      // Generated parts call and name their own library's declarations; a
      // library beside them declares the same names.
      'test/integration/annotated.dart': `part 'annotated.g.dart';

String family(Object ref, int id) => 'family $id';
`,
      'test/integration/annotated.g.dart': `part of 'annotated.dart';

String annotatedGenerated(Object ref) => family(ref, 1);
`,
      'test/integration/async.dart': `import 'dart:async';

part 'async.g.dart';

Future<String> family(Object ref, int first) async => '$first';

class GenericClass {}
`,
      'test/integration/async.g.dart': `part of 'async.dart';

Future<String> asyncGenerated(Object ref) {
  return family(ref, 2);
}

final GenericClass generic = GenericClass();
`,
      'test/integration/annotated_types.dart': `class GenericClass {}
`,
      // package:fake_async's function, and a vendored copy no file imports.
      'test/third_party/fake_async.dart': `T fakeAsync<T>(T Function(Object async) callback) => callback(Object());
`,
      'test/src/core/devtool_test.dart': `import 'package:fake_async/fake_async.dart';

void main() {
  fakeAsync((async) {});
}
`,
      // A test imports one utils library; an old copy declares the same function.
      'test/old/utils.dart': `List<Object> errorsOf(void Function() cb) => [];
`,
      'test/src/utils.dart': `List<Object> errorsOf(void Function() cb) => [];
`,
      'test/feature/uni_directional_test.dart': `import '../src/utils.dart';

void main() {
  errorsOf(() {});
}
`,
      // A package whose barrel exports with combinators; a prefixed import; a hidden name.
      'packages/kit/pubspec.yaml': 'name: kit\n',
      'packages/kit/lib/kit.dart': `export 'src/impl.dart'
    show
        // the public API
        shown,
        Widget;
export 'src/cond_stub.dart' if (dart.library.io) 'src/cond_io.dart';
`,
      'packages/kit/lib/src/impl.dart': `int shown() => 1;
int notShown() => 2;
class Widget {}
`,
      'packages/kit/lib/src/cond_stub.dart': `int platformName() => 0;
`,
      'packages/kit/lib/src/cond_io.dart': `int platformName() => 1;
`,
      'packages/kit/lib/src/prefixed.dart': `int viaPrefix() => 3;
class Report {}
`,
      'packages/kit/lib/src/hidden.dart': `int hiddenOne() => 4;
int keptOne() => 5;
`,
      'lib/main.dart': `import 'package:kit/kit.dart';
import 'package:kit/src/prefixed.dart' as p;
import 'package:kit/src/hidden.dart' hide hiddenOne;

void run(p.Report report) {
  shown();
  notShown();
  platformName();
  viaPrefix();
  hiddenOne();
  keptOne();
  Widget();
}
`,
      // Another library's Report, which main.dart does not import.
      'lib/a_report.dart': `class Report {}
`,
      // A part declared by library name, and a namesake in another library.
      'lib/named.dart': `library app.named;

part 'named_part.dart';

int namedHelper() => 6;
`,
      'lib/named_part.dart': `part of app.named;

int usesNamed() => namedHelper();
`,
      'lib/other_named.dart': `int namedHelper() => 7;
`,
      // A library's own declaration shadows the one it imports.
      'lib/a_util.dart': `int helper() => 1;
`,
      'lib/feature.dart': `import 'a_util.dart';

part 'feature_part.dart';

int runFeature() => helper();
`,
      'lib/feature_part.dart': `part of 'feature.dart';

int helper() => 2;
`,
      // A bare call never reaches another type's enum constant or static constant.
      'lib/kinds.dart': `enum Level { info, warning }

class TypeChecker {
  static const allOf = 'any';
}
`,
      'lib/check.dart': `import 'package:mason_logger/mason_logger.dart';
import 'package:matcher/matcher.dart';

void check(Object value) {
  info('checking');
  expect(value, allOf([isNotNull]));
}
`,
      // An unnamed extension on Color is no Color.
      'lib/colors.dart': `import 'package:flutter/material.dart';

extension on Color {
  Color brighten() => this;
}
`,
      // Nor is a generic one, beside the file that names the type.
      'lib/models/box.dart': `class Box<T> {
  T? value;
}
`,
      'lib/widgets/box_ext.dart': `import '../models/box.dart';

extension<T> on Box<T> {
  bool get isEmpty => value == null;
}
`,
      'lib/widgets/panel.dart': `import '../models/box.dart';
import 'box_ext.dart';

class Panel {
  final Box<int> box;
  Panel(this.box);
}
`,
      // An unnamed extension applies in every file of its library.
      'lib/shapes/shapes.dart': `part 'area_ext.dart';
part 'use.dart';

class Shape {}
`,
      'lib/shapes/area_ext.dart': `part of 'shapes.dart';

extension on Shape {
  int area() => 1;
}
`,
      'lib/shapes/use.dart': `part of 'shapes.dart';

int total(Shape s) => s.area();
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("links a generated part's call to its own library's function", () => {
    const edges = edgesFrom(cg, 'test/integration/async.g.dart');
    expect(edges).toContain('calls 4 family -> test/integration/async.dart:family');
    expect(edges.filter((e) => e.includes('annotated'))).toEqual([]);
  });

  it("links a generated part's type to its own library's type", () => {
    const edges = edgesFrom(cg, 'test/integration/async.g.dart').filter((e) => e.includes('GenericClass'));
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.endsWith('test/integration/async.dart:GenericClass'))).toBe(true);
  });

  it('links nothing for a function no imported library declares', () => {
    expect(edgesFrom(cg, 'test/src/core/devtool_test.dart').filter((e) => e.includes('fakeAsync'))).toEqual([]);
  });

  it('links the imported library over a namesake no import names', () => {
    expect(edgesFrom(cg, 'test/feature/uni_directional_test.dart')).toContain('calls 4 errorsOf -> test/src/utils.dart:errorsOf');
  });

  it('follows export chains, show, hide and import prefixes', () => {
    const edges = edgesFrom(cg, 'lib/main.dart');
    expect(edges).toContain('calls 6 shown -> packages/kit/lib/src/impl.dart:shown');
    expect(edges).toContain('calls 11 keptOne -> packages/kit/lib/src/hidden.dart:keptOne');
    expect(edges.some((e) => e.startsWith('instantiates 12 Widget -> packages/kit/lib/src/impl.dart:Widget'))).toBe(true);
    expect(edges.some((e) => / platformName -> packages\/kit\/lib\/src\/cond_(?:stub|io)\.dart:platformName$/.test(e))).toBe(true);
    // Not shown, only reachable through the prefix, hidden.
    expect(edges.filter((e) => / (?:notShown|viaPrefix|hiddenOne) /.test(e))).toEqual([]);
    // `p.Report` is the prefixed library's.
    expect(edges.filter((e) => e.includes(' Report '))).toEqual(['references 5 Report -> packages/kit/lib/src/prefixed.dart:Report']);
  });

  it('finds the library a part names by library name', () => {
    expect(edgesFrom(cg, 'lib/named_part.dart')).toContain('calls 3 namedHelper -> lib/named.dart:namedHelper');
  });

  it("prefers the library's own declaration to an imported one", () => {
    expect(edgesFrom(cg, 'lib/feature.dart').filter((e) => e.includes('helper'))).toEqual(['calls 5 helper -> lib/feature_part.dart:helper']);
  });

  it("never reaches another type's enum constant or static constant by a bare call", () => {
    expect(edgesFrom(cg, 'lib/check.dart').filter((e) => !e.startsWith('imports '))).toEqual([]);
  });

  it('never takes an unnamed extension for the type it extends', () => {
    expect(edgesFrom(cg, 'lib/colors.dart').filter((e) => e.includes('Color'))).toEqual([]);
    expect(edgesFrom(cg, 'lib/widgets/panel.dart').filter((e) => e.includes(' Box '))).toEqual(['references 5 Box -> lib/models/box.dart:Box']);
  });

  it("applies an unnamed extension in every file of its library", () => {
    expect(edgesFrom(cg, 'lib/shapes/use.dart').some((e) => e.endsWith('-> lib/shapes/area_ext.dart:Shape::area'))).toBe(true);
  });
});

describe('Dart files outside any package', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-nopkg-'));
    // A mason brick's template: no pubspec.yaml says what its imports mean.
    writeTree(root, {
      'bricks/feature/__brick__/helper.dart': `int helper() => 1;
`,
      'bricks/feature/__brick__/page.dart': `import 'package:{{name}}/helper.dart';

int page() => helper();
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('are resolved as before, by name', () => {
    expect(edgesFrom(cg, 'bricks/feature/__brick__/page.dart')).toContain('calls 3 helper -> bricks/feature/__brick__/helper.dart:helper');
  });
});

describe('readDartDirectives', () => {
  it('reads every directive up to the first declaration', () => {
    const d = readDartDirectives(`// Copyright
@TestOn('vm')
library app.main;

import 'dart:async';
import 'package:kit/kit.dart' show A, B hide B;
import 'stub.dart' if (dart.library.io) 'io.dart' if (dart.library.js_interop == 'true') 'web.dart';
import 'lazy.dart' deferred as lazy;
export 'src/a.dart'
    show
        // one
        One,
        Two;
part 'main.g.dart';

void main() {}
import 'late.dart';
`);
    expect(d.libraryName).toBe('app.main');
    expect(d.partOf).toBeNull();
    expect(d.parts).toEqual(['main.g.dart']);
    expect(d.imports.map((i) => i.uris)).toEqual([['dart:async'], ['package:kit/kit.dart'], ['stub.dart', 'io.dart', 'web.dart'], ['lazy.dart']]);
    expect(d.imports.map((i) => i.prefix)).toEqual([null, null, null, 'lazy']);
    expect([...d.imports[1]!.filter.show!]).toEqual(['A', 'B']);
    expect([...d.imports[1]!.filter.hide!]).toEqual(['B']);
    expect(d.exports.map((e) => [e.uris, [...(e.filter.show ?? [])]])).toEqual([[['src/a.dart'], ['One', 'Two']]]);
  });

  it('reads `part of` by URI and by library name, and an unnamed library', () => {
    expect(readDartDirectives(`part of 'async.dart';\n`).partOf).toEqual({ uri: 'async.dart' });
    expect(readDartDirectives(`part of app.named;\n`).partOf).toEqual({ name: 'app.named' });
    expect(readDartDirectives(`/// Docs\nlibrary;\n\nimport 'a.dart';\n`)).toMatchObject({ libraryName: '', imports: [{ uris: ['a.dart'] }] });
  });

  it('stops at a declaration that looks like a directive', () => {
    expect(readDartDirectives(`import 'a.dart';\npart() => 1;\nimport 'b.dart';\n`).imports.map((i) => i.uris[0])).toEqual(['a.dart']);
  });
});
