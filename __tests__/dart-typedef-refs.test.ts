/**
 * A Dart typedef references the types it aliases (#2327).
 *
 * In
 *
 *   class Report { final int score; const Report(this.score); }
 *   typedef ReportCallback = void Function(Report r);
 *
 * `callers Report` did not list `ReportCallback`. Both extractors minted the
 * typedef's node and nothing else: the grammar gives `type_alias` no fields,
 * so the aliased type was never read, and impact on a model type missed every
 * callback type built on it. The legacy form with a return type, `typedef
 * Report LegacyMaker(int n);`, was named after that return type, the first
 * type name in it, so a `type_alias Report` stood beside the class.
 *
 * A typedef now references every type its aliased type names, from the
 * typedef, on each type's name: a function type's return and parameter types,
 * generic arguments, record fields, a type parameter's bound, and the legacy
 * form's return and parameter types. A type parameter, the typedef's own or a
 * generic function type's, means that parameter and never a project type of
 * its name; an import prefix names no type; and the legacy form is named by
 * its own name.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** Every typedef shape: new style and legacy, generic, prefixed, annotated, wrapped. */
const SOURCE = `import 'model.dart' as m;

class Report {
  final int score;
  const Report(this.score);
}

typedef ReportCallback = void Function(Report r);
typedef ReportMaker = Report Function();
typedef Reports = List<Report>;
typedef ReportsByName = Map<String, Report>;
typedef Results = Future<List<Report>?> Function(int page);
typedef void LegacyCallback(Report r);
typedef Report LegacyMaker(int n);
typedef List<Report> LegacyLoader([Report? seed]);
typedef m.Report PrefixedLegacy(m.Report r);
typedef Mapper<T> = T Function(Report r);
typedef Picker = T Function<T>(T a, Report r);
typedef T LegacyPicker<T>(T a, Report r);
typedef Bounded<X extends Report> = List<X>;
typedef Sdk = Future<String>;
typedef Dynamic = dynamic Function(int n);
typedef Prefixed = m.Report;
typedef Named = void Function({required Report report, int? n});
typedef Pair = (Report, {m.Report other});
typedef Nested = void Function(Report Function(int) make);
/// Documented.
@Deprecated('Use ReportCallback')
typedef OldCallback = void Function(Report r);
typedef Formatted =
    Map<String, Report> Function(
      Report first,
      Report second,
    );
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a Dart typedef references the types it aliases (#2327)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['dart']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('lib/typedefs.dart', source, 'dart');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('lib/typedefs.dart', source, 'dart');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  /** `<typedef> <type>` for every `references` ref out of a typedef, sorted. */
  function typedefRefs(result: ExtractionResult): string[] {
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    return result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references' && byId.get(r.fromNodeId)?.kind === 'type_alias')
      .map((r) => `${byId.get(r.fromNodeId)!.name} ${r.referenceName}`)
      .sort();
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`a legacy typedef is named by its own name, not its return type: %s${label}`, (backend) => {
      const result = extract(backend, eol(SOURCE));
      expect(result.nodes.filter((n) => n.kind === 'type_alias').map((n) => n.name)).toEqual([
        'ReportCallback',
        'ReportMaker',
        'Reports',
        'ReportsByName',
        'Results',
        'LegacyCallback',
        'LegacyMaker',
        'LegacyLoader',
        'PrefixedLegacy',
        'Mapper',
        'Picker',
        'LegacyPicker',
        'Bounded',
        'Sdk',
        'Dynamic',
        'Prefixed',
        'Named',
        'Pair',
        'Nested',
        'OldCallback',
        'Formatted',
      ]);
      // An annotated typedef keeps the dartdoc above its annotation.
      expect(result.nodes.find((n) => n.name === 'OldCallback')!.docstring).toBe('Documented.');
    });

    it.each(backends)(`every type the alias names is referenced from the typedef: %s${label}`, (backend) => {
      const source = eol(SOURCE);
      const result = extract(backend, source);
      // Built-ins (`void`, `int`, `String`, `dynamic`) are no references, an
      // import prefix (`m`) is none, and neither is a type parameter (`T`,
      // `X`), declared by the typedef or by a generic function type.
      expect(typedefRefs(result)).toEqual([
        'Bounded List',
        'Bounded Report',
        'Formatted Map',
        'Formatted Report',
        'Formatted Report',
        'Formatted Report',
        'LegacyCallback Report',
        'LegacyLoader List',
        'LegacyLoader Report',
        'LegacyLoader Report',
        'LegacyMaker Report',
        'LegacyPicker Report',
        'Mapper Report',
        'Named Report',
        'Nested Report',
        'OldCallback Report',
        'Pair Report',
        'Pair Report',
        'Picker Report',
        'Prefixed Report',
        'PrefixedLegacy Report',
        'PrefixedLegacy Report',
        'ReportCallback Report',
        'ReportMaker Report',
        'Reports List',
        'Reports Report',
        'ReportsByName Map',
        'ReportsByName Report',
        'Results Future',
        'Results List',
        'Results Report',
        'Sdk Future',
      ]);
      // Each sits on the type's name, where resolution reads an import prefix back.
      const lines = source.split(/\r?\n/);
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      for (const r of result.unresolvedReferences.filter((x) => byId.get(x.fromNodeId)?.kind === 'type_alias')) {
        expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
      }
      // The file takes none of them: no type is credited twice.
      const file = result.nodes.find((n) => n.kind === 'file')!;
      expect(result.unresolvedReferences.filter((r) => r.fromNodeId === file.id && r.referenceKind === 'references')).toEqual([]);
    });
  }
});

describe('an indexed Dart library links a typedef to the types it aliases (#2327)', () => {
  const FILES: Record<string, string> = {
    'pubspec.yaml': 'name: repro\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
    // The issue's repro.
    'lib/report.dart': 'class Report {\n  final int score;\n  const Report(this.score);\n}\n',
    'lib/callback.dart': "import 'report.dart';\n\ntypedef ReportCallback = void Function(Report r);\n",
    // A namesake reached only through the `m.` prefix.
    'lib/model.dart': 'class Report {}\n',
    // Project types named like the type parameters, imported where those are declared.
    'lib/params.dart': 'class T {}\n\nclass X {}\n',
    // A project `Future` the typedefs' library does not import.
    'lib/async.dart': 'class Future {}\n',
    'lib/typedefs.dart': `import 'model.dart' as m;
import 'params.dart';
import 'report.dart';

typedef ReportMaker = Report Function();
typedef Reports = List<Report>;
typedef Report LegacyMaker(int n);
typedef Mapper<T> = T Function(Report r);
typedef Picker = T Function<T>(T a, Report r);
typedef Bounded<X extends Report> = List<X>;
typedef Sdk = Future<String>;
typedef Prefixed = m.Report;
typedef Pair = (Report, {m.Report other});
`,
  };

  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-typedef-refs-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    kernel = process.env.CODEGRAPH_KERNEL;
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it.each(['default', 'wasm'])('callers of a type list the typedefs built on it (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const node = (file: string, name: string): Node => {
      const found = graph.getNodesInFile(file).filter((n) => n.name === name && n.kind !== 'import');
      expect(found, `${name} in ${file}`).toHaveLength(1);
      return found[0]!;
    };
    /** `kind file:qualifiedName` of each `references` target of the typedef `name`, sorted. */
    const referenced = (name: string): string[] =>
      [...new Set(graph
        .getOutgoingEdgesFrom([node('lib/typedefs.dart', name).id], ['references'])
        .map((e) => graph.getNode(e.target)!)
        .map((n) => `${n.kind} ${n.filePath}:${n.qualifiedName}`))]
        .sort();

    // `callers Report` lists every typedef that names it, the issue's first.
    const callers = graph.getCallers(node('lib/report.dart', 'Report').id).map(({ node: n }) => `${n.kind} ${n.filePath}:${n.name}`);
    expect(callers.filter((c) => c.startsWith('type_alias')).sort()).toEqual([
      'type_alias lib/callback.dart:ReportCallback',
      'type_alias lib/typedefs.dart:Bounded',
      'type_alias lib/typedefs.dart:LegacyMaker',
      'type_alias lib/typedefs.dart:Mapper',
      'type_alias lib/typedefs.dart:Pair',
      'type_alias lib/typedefs.dart:Picker',
      'type_alias lib/typedefs.dart:ReportMaker',
      'type_alias lib/typedefs.dart:Reports',
    ]);

    // A prefixed type is the one its import names.
    expect(referenced('Prefixed')).toEqual(['class lib/model.dart:Report']);
    expect(referenced('Pair')).toEqual(['class lib/model.dart:Report', 'class lib/report.dart:Report']);
    // A type parameter is not the project's `T` or `X`, though both are imported.
    expect(referenced('Mapper')).toEqual(['class lib/report.dart:Report']);
    expect(referenced('Picker')).toEqual(['class lib/report.dart:Report']);
    expect(referenced('Bounded')).toEqual(['class lib/report.dart:Report']);
    expect(graph.getCallers(node('lib/params.dart', 'T').id)).toEqual([]);
    expect(graph.getCallers(node('lib/params.dart', 'X').id)).toEqual([]);
    // The SDK's Future is not a project class the library does not import.
    expect(referenced('Sdk')).toEqual([]);
    expect(graph.getCallers(node('lib/async.dart', 'Future').id)).toEqual([]);
    // The legacy typedef is named LegacyMaker; nothing else is named Report there.
    expect(graph.getNodesInFile('lib/typedefs.dart').filter((n) => n.name === 'Report')).toEqual([]);
    expect(referenced('LegacyMaker')).toEqual(['class lib/report.dart:Report']);
  }, 60_000);
});
