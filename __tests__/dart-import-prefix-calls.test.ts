/**
 * A Dart call written through an import prefix — `http.get(uri)` after
 * `import 'package:http/http.dart' as http;` — calls a top-level declaration
 * the libraries imported with that prefix export, or nothing in the project.
 * It is no method call on a receiver named `http`: riverpod's docs' 25
 * `http.get(…)` / `http.post(…)` calls went to a docs example's `Http` class.
 *
 * Runs against the native kernel (when built) and the wasm extractor.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  'pubspec.yaml': 'name: app\n',
  // Namesakes of everything the prefixes below name, in a library beside the
  // callers — nearer than the libraries the prefixes import.
  'lib/legacy.dart': `class Http {
  Future<String> get(Uri url) async => '';
}

class Client {
  Client();
  static Client fromEnv() => Client();
}

class Formatter {
  String describe(Object value) => '';
}

class Loader {
  int load() => 0;
}

class Report {
  Report.empty();
  static Report blank() => Report.empty();
}

class Box<T> {
  const Box.named();
  static Box<int> create() => const Box.named();
}

String describe(Object value) => 'legacy';
int shown() => 0;
`,
  'lib/src/format.dart': `String describe(Object value) => '$value';

class Report {
  Report();
  Report.empty();
  static Report blank() => Report();
}
`,
  'lib/src/tools.dart': `int secret() => 1;
int open() => 2;
`,
  'lib/lazy.dart': `int load() => 1;
`,
  'packages/kit/pubspec.yaml': 'name: kit\n',
  'packages/kit/lib/kit.dart': `export 'src/impl.dart' show shown, Widget, Box, named;
`,
  'packages/kit/lib/src/impl.dart': `int shown() => 1;
int notShown() => 2;
int named() => 3;

class Widget {
  Widget();
}

class Box<T> {
  const Box.named();
  static Box<int> create() => const Box.named();
}
`,
  // package:http is not in the repository.
  'lib/net.dart': `import 'package:http/http.dart' as http;

Future<void> fetch() async {
  await http.get(Uri.parse('https://example.com'));
  http.Client();
  http.Client.fromEnv();
}
`,
  'lib/app.dart': `import 'package:kit/kit.dart' as kit;
import 'src/format.dart' as fmt;
import 'src/tools.dart' as tools hide secret;
import 'lazy.dart' deferred as lazy;

part 'app_part.dart';

String run(Object value) {
  fmt.Report();
  fmt.Report.empty();
  fmt.Report.blank();
  kit.shown();
  kit.notShown();
  kit.Widget();
  tools.open();
  tools.secret();
  final box = kit.Box<int>.named();
  kit.Box.create();
  const kit.Box.named();
  return fmt.describe(value);
}

Future<int> boot() async {
  await lazy.loadLibrary();
  return lazy.load();
}
`,
  'lib/app_part.dart': `part of 'app.dart';

String again(Object value) => fmt.describe(value);
`,
  // A parameter named like the prefix is the parameter, there.
  'lib/shadow.dart': `import 'package:http/http.dart' as http;
import 'legacy.dart';

Future<String> viaParameter(Http http) => http.get(Uri());
`,
};

/** `<kind> <line> <ref name> -> <target file>:<target qualified name>` for every call out of `file`. */
function callsFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${e.kind} ${e.line} ${String(e.metadata?.refName ?? '')} -> ${t.filePath}:${t.qualifiedName}`;
    });
}

describe.each(['default', 'wasm'])('Dart calls through an import prefix (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;
  const calls = (file: string): string[] => callsFrom(cg!, file);

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-prefix-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it('links nothing for a call into a package outside the repository', () => {
    expect(calls('lib/net.dart')).toEqual([]);
  });

  it("links a call to the prefixed library's function, not a namesake or a method", () => {
    expect(calls('lib/app.dart')).toContain('calls 20 fmt.describe -> lib/src/format.dart:describe');
    expect(calls('lib/app.dart')).toContain('calls 25 lazy.load -> lib/lazy.dart:load');
    expect(calls('lib/app_part.dart')).toEqual(['calls 3 fmt.describe -> lib/src/format.dart:describe']);
  });

  it('follows the export chain, show and hide of the prefixed import', () => {
    const edges = calls('lib/app.dart');
    expect(edges).toContain('calls 12 kit.shown -> packages/kit/lib/src/impl.dart:shown');
    expect(edges).toContain('instantiates 14 kit.Widget -> packages/kit/lib/src/impl.dart:Widget');
    expect(edges).toContain('calls 15 tools.open -> lib/src/tools.dart:open');
    // Not shown by kit.dart, hidden from `tools`, the deferred library's own `loadLibrary`.
    expect(edges.filter((e) => / (?:kit\.notShown|tools\.secret|lazy\.loadLibrary) /.test(e))).toEqual([]);
  });

  it("constructs and calls through the prefixed library's type", () => {
    const edges = calls('lib/app.dart');
    expect(edges).toContain('instantiates 9 fmt.Report -> lib/src/format.dart:Report');
    expect(edges).toContain('calls 10 empty -> lib/src/format.dart:Report::empty');
    expect(edges).toContain('calls 11 blank -> lib/src/format.dart:Report::blank');
    expect(edges).toContain('calls 17 Box.named -> packages/kit/lib/src/impl.dart:Box::named');
    expect(edges).toContain('calls 18 create -> packages/kit/lib/src/impl.dart:Box::create');
  });

  it('never lands a prefixed call on another library', () => {
    expect(calls('lib/app.dart').filter((e) => e.includes('lib/legacy.dart'))).toEqual([]);
    // `const kit.Box.named()` is no call of kit's top-level `named`.
    expect(calls('lib/app.dart').filter((e) => e.startsWith('calls 19 '))).toEqual([]);
  });

  it('leaves a name a parameter shadows to the parameter', () => {
    expect(calls('lib/shadow.dart')).toEqual(['calls 4 http.get -> lib/legacy.dart:Http::get']);
  });
});
