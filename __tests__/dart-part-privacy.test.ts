/**
 * A Dart `_name` is private to its library — the library file and every file
 * its `part` directives name — not to the one file that declares it (#2466).
 * A library split into parts calls its own private helpers across those
 * files, and those calls were dropped as if each file were a library of its
 * own. A file of another library still never reaches them, importing the
 * library or not. Whether a pubspec.yaml sits above the files makes no
 * difference: a part names its library by a path or by a library name.
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

/** `<source qualified name> -> <target file>:<target qualified name>` for every `calls` edge out of `files`. */
function callEdges(cg: CodeGraph, files: string[]): string[] {
  return edgesOf(cg, files, ['calls']).map((e) => e.slice(e.indexOf(' ') + 1));
}

/** `<kind> <source qualified name> -> <target file>:<target qualified name>` for every edge of `kinds` out of `files`. */
function edgesOf(cg: CodeGraph, files: string[], kinds: string[]): string[] {
  const ids = files.flatMap((f) => cg.getNodesInFile(f).map((n) => n.id));
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => kinds.includes(e.kind))
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${e.kind} ${cg.getNode(e.source)!.qualifiedName} -> ${t.filePath}:${t.qualifiedName}`;
    })
    .sort();
}

/**
 * The issue's library (a library file and three parts, one of them in a
 * subdirectory), a library with a generated part, and a library that uses both.
 */
const GREETER: Record<string, string> = {
  'lib/greeter.dart': `part 'greeter_format.dart';
part 'greeter_shout.dart';
part 'src/_greeter_whisper.dart';

class Greeter with _Formatting, _Shouting, _Whispering {
  String greet(String name) => _format(name); // library file -> private member in a part
  String hello() => _local();                 // same-file control
  String _local() => 'hi';
}

void _trace(String s) => print(s);
`,
  'lib/greeter_format.dart': `part of 'greeter.dart';

mixin _Formatting {
  String _format(String name) {
    _trace(name); // part -> private top-level function in the library file
    return 'Hello, $name';
  }
}
`,
  'lib/greeter_shout.dart': `part of 'greeter.dart';

mixin _Shouting on _Formatting {
  String shout(String name) => _format(name).toUpperCase(); // part -> sibling part
  String echo(Greeter g) => g._local(); // part -> private member, through a receiver
}
`,
  'lib/src/_greeter_whisper.dart': `part of '../greeter.dart';

mixin _Whispering on _Formatting {
  String whisper(String name) => _format(name).toLowerCase(); // part in a subdirectory -> sibling part
  void log(String s) => _trace(s); // -> the library file's, not the namesake beside this part
}
`,
  // What code generators write into a part: json_serializable's `_$UserFromJson`,
  // and a base class like riverpod_generator's `_$Counter`.
  'lib/models/user.dart': `part 'user.g.dart';

class User {
  final String name;
  User(this.name);
  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}

class Counter extends _$Counter {}
`,
  'lib/models/user.g.dart': `part of 'user.dart';

User _$UserFromJson(Map<String, dynamic> json) => User(json['name'] as String);

abstract class _$Counter {}
`,
  // Another library: the greeter library's privates are not its to name, even through an import.
  'lib/other.dart': `import 'greeter.dart';
import 'models/user.dart';

void callsOther(Greeter g, Object o) {
  _trace('x');
  g._local();
  if (o is _$Counter) _$UserFromJson({});
}
`,
};

const GREETER_FILES = ['lib/greeter.dart', 'lib/greeter_format.dart', 'lib/greeter_shout.dart', 'lib/src/_greeter_whisper.dart'];

const GREETER_EDGES = [
  'Greeter::greet -> lib/greeter_format.dart:_Formatting::_format',
  'Greeter::hello -> lib/greeter.dart:Greeter::_local',
  '_Formatting::_format -> lib/greeter.dart:_trace',
  '_Shouting::echo -> lib/greeter.dart:Greeter::_local',
  '_Shouting::shout -> lib/greeter_format.dart:_Formatting::_format',
  '_Whispering::log -> lib/greeter.dart:_trace',
  '_Whispering::whisper -> lib/greeter_format.dart:_Formatting::_format',
];

for (const pubspec of [true, false]) {
  describe(`Dart private names across a library's parts (${pubspec ? 'with' : 'without'} a pubspec.yaml)`, () => {
    let root = '';
    let cg: CodeGraph;

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-part-private-'));
      writeTree(root, {
        ...(pubspec ? { 'pubspec.yaml': 'name: greeter\n' } : {}),
        ...GREETER,
        // A library that keeps its own `_trace` and `_local`, beside the
        // greeter's part in lib/src/ and so nearer it than the greeter's own.
        'lib/src/farewell.dart': `void _trace(String s) => print(s);

class Farewell {
  String _local() => 'bye';
  String bye() => _local();
}

void wave() => _trace('wave');
`,
        // A library whose part is named by the library's name.
        'lib/named.dart': `library app.named;

part 'named_part.dart';

int _seed() => 6;
`,
        'lib/named_part.dart': `part of app.named;

int usesSeed() => _seed();
`,
        // A part whose library the project doesn't have: its own file is all it can see.
        'lib/stray_part.dart': `part of 'missing.dart';

int usesStray() => _seed();
`,
      });
      cg = await CodeGraph.init(root, { index: true });
    });

    afterAll(() => {
      cg?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('links a call to a private member or function declared in another file of the library', () => {
      expect(callEdges(cg, GREETER_FILES)).toEqual(GREETER_EDGES);
    });

    it('links the private function and class a generated part declares', () => {
      expect(edgesOf(cg, ['lib/models/user.dart'], ['calls', 'extends'])).toEqual([
        'calls User::fromJson -> lib/models/user.g.dart:_$UserFromJson',
        'extends Counter -> lib/models/user.g.dart:_$Counter',
      ]);
    });

    it("never links another library's private names, even when the file imports that library", () => {
      // Only the public `Greeter` the parameter names.
      expect(edgesOf(cg, ['lib/other.dart'], ['calls', 'references', 'instantiates'])).toEqual([
        'references callsOther -> lib/greeter.dart:Greeter',
      ]);
    });

    it("keeps another library's private namesakes to that library", () => {
      expect(callEdges(cg, ['lib/src/farewell.dart'])).toEqual([
        'Farewell::bye -> lib/src/farewell.dart:Farewell::_local',
        'wave -> lib/src/farewell.dart:_trace',
      ]);
    });

    it('finds the library a part names by library name', () => {
      expect(callEdges(cg, ['lib/named_part.dart'])).toEqual(['usesSeed -> lib/named.dart:_seed']);
    });

    it("links nothing from a part whose library isn't in the project", () => {
      expect(callEdges(cg, ['lib/stray_part.dart'])).toEqual([]);
    });
  });
}
