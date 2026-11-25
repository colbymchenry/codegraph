/**
 * Dart getter reads and extension members on enums (#2338).
 *
 * Reading a getter runs it: `x.area` calls `Box`'s `int get area`. A read
 * linked to nothing, so `callers area` was empty while `x.grow()` worked. And
 * a member an `extension … on` an ENUM adds (`s.shout()`) resolved nowhere,
 * while the same extension on a class did.
 *
 * A read links only a getter the receiver's type reaches — never a field (they
 * mint no nodes), a getter of a type outside the project, or a same-named
 * getter guessed by name.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-getters-'));
  const files: Record<string, string> = {
    'pubspec.yaml': 'name: repro\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
    // The issue's two files, verbatim.
    'lib/shape.dart': `enum Shape { circle, square }

extension ShapeInfo on Shape {
  String get label => name.toUpperCase();
  String shout() => name.toUpperCase();
}

class Box {
  const Box(this.size);
  final int size;
  int get area => size * size;
  int grow() => size + 1;
}

extension BoxActions on Box {
  int twice() => size * 2;
}
`,
    'lib/use.dart': `import 'shape.dart';

String a(Shape s) => s.label;   // getter, extension on enum
String b(Shape s) => s.shout(); // method, extension on enum
int c(Box x) => x.area;         // getter, plain class
int d(Box x) => x.grow();       // method, plain class
int e(Box x) => x.twice();      // method, extension on class
`,
    // Block bodies and class methods, through a parameter, a local and a field.
    'lib/render.dart': `import 'shape.dart';

class Square extends Box {
  const Square(int size) : super(size);
  static Square get unit => const Square(1);
}

class Renderer {
  final Box box;
  final Shape shape;
  Renderer(this.box, this.shape);

  int paint(Box other) {
    final local = Box(2);
    return other.area + local.area;
  }

  int viaField() {
    return box.area;
  }

  String tag() {
    final text = shape.label;
    return text + shape.shout();
  }
}

int inherited(Square s) {
  return s.area;
}

Square staticGetter() => Square.unit;
`,
    // Reads that must link nothing.
    'lib/other.dart': `class Panel {
  int get size => 0;
  int get length => 0;
}

extension on Box {
  int get hidden => 0;
}
`,
    'lib/negatives.dart': `import 'shape.dart';

int fieldRead(Box x) => x.size;           // a field, not Panel's getter
int outside(List<int> xs) => xs.length;   // a getter of a type outside the project
int untyped(dynamic d) => d.area;         // nothing says what d is
int unnamed(Box x) => x.hidden;           // an unnamed extension in another library
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `kind name` of each caller of the node with qualified name `qn`, sorted. */
function callersOf(qn: string): string[] {
  const [target] = cg.getNodesByQualifiedName(qn);
  expect(target, `no node ${qn}`).toBeDefined();
  return cg.getCallers(target!.id).map(({ node, edge }) => `${edge.kind} ${node.qualifiedName}`).sort();
}

describe('Dart getter reads (#2338)', () => {
  it('link a getter read on a plain class, as a call', () => {
    expect(callersOf('Box::area')).toContain('calls c');
  });

  it('link a getter an extension on an enum adds', () => {
    expect(callersOf('ShapeInfo::label')).toEqual(['calls Renderer::tag', 'calls a']);
  });

  it('link reads in block bodies and class methods, through parameters, locals and fields', () => {
    expect(callersOf('Box::area')).toEqual([
      'calls Renderer::paint',
      'calls Renderer::viaField',
      'calls c',
      'calls inherited',
    ]);
  });

  it('link a static getter read through its class', () => {
    expect(callersOf('Square::unit')).toEqual(['calls staticGetter']);
  });

  it('link nothing for a field, an outside type, an untyped receiver or an out-of-library unnamed extension', () => {
    const ids = cg.getNodesInFile('lib/negatives.dart').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids, ['calls'])
      .map((edge) => cg.getNode(edge.target)!.qualifiedName);
    expect(targets).toEqual([]);
    expect(callersOf('Panel::size')).toEqual([]);
    expect(callersOf('Panel::length')).toEqual([]);
  });
});

describe('Dart extension members on an enum (#2338)', () => {
  it('resolve a method an extension on an enum adds', () => {
    expect(callersOf('ShapeInfo::shout')).toEqual(['calls Renderer::tag', 'calls b']);
  });

  it('still resolve methods on a class and its extensions', () => {
    expect(callersOf('Box::grow')).toEqual(['calls d']);
    expect(callersOf('BoxActions::twice')).toEqual(['calls e']);
  });
});
