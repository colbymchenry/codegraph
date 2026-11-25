/**
 * A class, struct, union or enum DEFINED in the type of a C or C++ variable
 * declaration was never indexed:
 *
 *   namespace n { struct Foo { int a; void f() {} } foo; }   // only n::foo
 *   static struct { int argc; char **argv; } SPT;             // nothing at all
 *   enum { MODE_IDLE, MODE_BUSY } current_mode;               // no enumerators
 *
 * Both extractors handed such a declaration to the variable extractor and
 * skipped its children, so the type, its methods and its enumerators never
 * became nodes, a base class defined this way had nothing to resolve to, and
 * calls on its methods linked to nothing.
 *
 * The type is now walked like one written on its own, beside the variables
 * (which keep their nodes), and the comment above the declaration documents
 * it. An unnamed one takes the name of the first variable its declaration
 * declares, as `typedef struct { … } Name;` takes the typedef name: no code
 * can name the type of `SPT`, only `SPT`. In a C++ file whose tree has errors
 * the type is walked in the scopes the file's braces open (#2426), and not at
 * all when the braces don't balance. Runs against the native kernel (when
 * built) and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT'] as const;

/** `<kind> <qualifiedName>` for every symbol, file and imports aside. */
function symbols(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .map((n) => `${n.kind} ${n.qualifiedName}`);
}

/** `<parent> > <child>` for every containment edge below the file. */
function containment(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.edges
    .filter((e) => e.kind === 'contains' && byId.get(e.source)?.kind !== 'file')
    .map((e) => `${byId.get(e.source)?.qualifiedName} > ${byId.get(e.target)?.qualifiedName}`);
}

describe('a type defined in a C/C++ declaration', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp']);
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

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`C++ classes and structs beside their variables: %s${label}`, (backend) => {
      const source = [
        'namespace n {',
        'struct Foo { int a; void f() {} } foo;',
        'class Bar { void g() {} } bar, *pbar;',
        '}',
        '',
      ].join('\n');
      const result = extract(backend, 'src/decl.cpp', eol(source), 'cpp');
      expect(symbols(result)).toEqual([
        'struct n::Foo',
        'method n::Foo::f',
        'variable n::foo',
        'class n::Bar',
        'method n::Bar::g',
        'variable n::bar',
      ]);
      expect(containment(result)).toEqual(['n::Foo > n::Foo::f', 'n::Bar > n::Bar::g']);
    });

    it.each(backends)(`C structs, unions and enums; an unnamed one takes its variable's name: %s${label}`, (backend) => {
      const source = [
        'struct Foo { int a; } foo;',
        'static struct { int argc; char **argv; } SPT;',
        'static const struct { const char *name; int code; } errors[] = { { "none", 0 } };',
        'struct { int x; } *first_point, second_point;',
        'union { int i; float f; } scratch = { 0 };',
        'enum { MODE_IDLE, MODE_BUSY } current_mode;',
        'typedef struct Bar { int c; } Bar;',
        '',
      ].join('\n');
      const result = extract(backend, 'src/decl.c', eol(source), 'c');
      expect(symbols(result)).toEqual([
        'struct Foo',
        'struct SPT',
        'struct errors',
        'constant errors',
        'struct first_point',
        'variable first_point',
        'union scratch',
        'variable scratch',
        'enum current_mode',
        'enum_member current_mode::MODE_IDLE',
        'enum_member current_mode::MODE_BUSY',
        'struct Bar',
      ]);
    });

    it.each(backends)(`a type whose declaration declares no variable stays unnamed: %s${label}`, (backend) => {
      // A function's return type: naming it after the function would be wrong.
      const result = extract(backend, 'src/proto.c', eol('struct { int unused; } make_unnamed(void);\n'), 'c');
      expect(symbols(result)).toEqual(['struct <anonymous>']);
    });

    it.each(backends)(`the comment above the declaration documents the type: %s${label}`, (backend) => {
      const source = [
        'namespace app {',
        '/** The handler registry. */',
        'struct Registry { int size() const { return 2; } } registry;',
        '}',
        '',
      ].join('\n');
      const result = extract(backend, 'src/registry.cc', eol(source), 'cpp');
      const docs = result.nodes
        .filter((n) => n.name === 'Registry' || n.name === 'registry')
        .map((n) => `${n.kind} ${n.docstring}`);
      expect(docs).toEqual(['struct The handler registry.', 'variable The handler registry.']);
    });

    it.each(backends)(`an unnamed type in a function body takes its variable's name too: %s${label}`, (backend) => {
      const source = 'int hits(void) {\n  static struct { int count; } local_stats;\n  return ++local_stats.count;\n}\n';
      const result = extract(backend, 'src/stats.c', eol(source), 'c');
      expect(symbols(result)).toEqual(['function hits', 'struct hits::local_stats']);
    });

    it.each(backends)(`a file the parser misreads: C keeps the type, C++ needs balanced braces: %s${label}`, (backend) => {
      // The kernel defers a file whose tree has errors to wasm; its
      // error-extract hatch walks one anyway, and must agree.
      process.env.CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT = '1';
      const c = extract(backend, 'src/spt.c', eol('static struct { int argc; } SPT;\nint broken( { return 1; }\n'), 'c');
      expect(symbols(c)).toContain('struct SPT');
      // A C++ file with errors is walked in the scopes its braces open, so the
      // class lands in its namespace. When the braces don't balance there are
      // no scopes to trust, and error recovery can close a namespace or a
      // class at the wrong `}`: the variable is kept and the class not walked.
      const config = 'namespace n {\nstruct Config { int retries; void apply() {} } config;\n}\n';
      const balanced = extract(backend, 'src/config.cc', eol(`${config}int broken( { return 1; }\n`), 'cpp');
      expect(symbols(balanced)).toEqual(['struct n::Config', 'method n::Config::apply', 'variable n::config']);
      const unbalanced = extract(backend, 'src/config2.cc', eol(`${config}int broken() { return 1;\n`), 'cpp');
      expect(symbols(unbalanced)).toEqual(['variable n::config', 'function broken']);
    });

    it.each(backends)(`a function value in the type's body is captured once, by the type: %s${label}`, (backend) => {
      const source = [
        'void on_open() {}',
        'struct Handlers { void (*all[1])() = {&on_open}; } handlers;',
        '',
      ].join('\n');
      const result = extract(backend, 'src/handlers.cc', eol(source), 'cpp');
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      const refs = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'function_ref')
        .map((r) => `${byId.get(r.fromNodeId)?.name} ${r.referenceName}`);
      expect(refs).toEqual(['Handlers on_open']);
    });
  }
});

describe('an indexed C/C++ project with types defined in declarations', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('links base classes and calls to them, and finds an unnamed struct by its variable', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-declaration-types-'));
    const files: Record<string, string> = {
      'src/registry.cc': [
        'namespace app {',
        'struct Registry { int size() const { return 2; } } registry;',
        'class Base { public: virtual int run() { return 1; } } base_instance;',
        'class Worker : public Base { public: int run() override { return registry.size(); } };',
        'int tick() { Worker w; return w.run() + registry.size(); }',
        '}',
        '',
      ].join('\n'),
      'src/setproctitle.c': [
        '/* Saved argv. */',
        'static struct { int argc; char **argv; } SPT;',
        'int spt_init(int argc) { SPT.argc = argc; return SPT.argc; }',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const one = (qualifiedName: string) => {
      const found = graph.getNodesByName(qualifiedName.split('::').pop()!).filter((n) => n.qualifiedName === qualifiedName);
      expect(found, qualifiedName).toHaveLength(1);
      return found[0]!;
    };
    const edges = (id: string, kind: 'calls' | 'extends') =>
      graph
        .getIncomingEdgesTo([id], [kind])
        .map((e) => graph.getNode(e.source)?.qualifiedName)
        .sort();

    expect(edges(one('app::Registry::size').id, 'calls')).toEqual(['app::Worker::run', 'app::tick']);
    expect(edges(one('app::Base').id, 'extends')).toEqual(['app::Worker']);

    const spt = graph.searchNodes('SPT', { limit: 5 }).map((r) => `${r.node.kind} ${r.node.name}`);
    expect(spt).toContain('struct SPT');
    expect(one('SPT').docstring).toBe('Saved argv.');
  }, 60_000);
});
