/**
 * A C++ class keeps the namespaces and enclosing classes it is declared in
 * when tree-sitter's error recovery closes one of them at the wrong `}`.
 *
 * tree-sitter recovers from a construct it can't parse by inserting the token
 * it expected, and inside a class that is often a `}`. An unknown macro in
 * front of a member (protobuf's `PROTOBUF_FUTURE_ADD_EARLY_NODISCARD
 * absl::string_view name() const`) or in a class head (rocksdb's `struct
 * ALIGN_AS(64U) HandleImpl`) closed the class there, and every `}` after it
 * then closed the scope one level out. The rest of the class parsed as
 * declarations of its namespace, and the rest of each namespace as
 * declarations of the one around it:
 *  - protobuf's `FieldDescriptor` was indexed as `FieldDescriptor`, not
 *    `google::protobuf::FieldDescriptor`;
 *  - rocksdb's `struct Opts` lost the class it is declared in, and
 *    `AutoHyperClockTable` lost `clock_cache::`;
 *  - a scope could also stay open past its own `}`, putting the next class
 *    inside the previous one.
 * Lookups that start from a declaration's scope (base classes, alias
 * receivers, constructors) then had only a unique-name guess left.
 *
 * For a file whose tree has errors, the walker now takes each declaration's
 * namespaces and enclosing classes from the source's braces, which the
 * parser rarely misreads; a class the tree glued into a declaration's type is
 * still walked as a class. Files that parse cleanly keep the tree's scopes.
 * The native kernel defers erroring files to this walker; under its
 * error-extract sweep hatch it must produce the same result.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';
import { cppExtractor } from '../src/extraction/languages/c-cpp';
import { scanCppBraceScopes } from '../src/extraction/languages/cpp-brace-scopes';
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

/** protocolbuffers/protobuf descriptor.h: an unknown attribute macro in front of a member. */
const PROTOBUF_SHAPE = `namespace google {
namespace protobuf {

class Names {
 public:
  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view name() const {
    return absl::string_view(payload_);
  }

 private:
  const char* payload_;
};

class FieldDescriptor : private internal::SymbolBase {
 public:
  int index() const;
};

}  // namespace protobuf
}  // namespace google
`;

/** facebook/rocksdb cache/clock_cache.h: a macro call in a nested struct's head. */
const ROCKSDB_SHAPE = `namespace rocksdb {
namespace clock_cache {

class FixedTable : public BaseTable {
 public:
  struct ALIGN_AS(64U) HandleImpl : public ClockHandle {
    RelaxedAtomic<uint32_t> displacements{};
    bool standalone = false;
  };

  struct Opts : public BaseOpts {
    explicit Opts(size_t size) : BaseOpts(0), size(size) {}
    size_t size;
  };

  void Insert(const Opts& opts);
};

class AutoTable : public BaseTable {
 public:
  void Erase();
};

}  // namespace clock_cache
}  // namespace rocksdb
`;

/** A function head per #if branch: recovery keeps the class open past its own `}`. */
const BRANCHES_SHAPE = `namespace net {

class Socket {
 public:
#ifdef _WIN32
  int Open(SOCKET handle) {
#else
  int Open(int fd) {
#endif
    return Bind();
  }

  int Bind();
};

class Listener {
 public:
  void Accept() {}
};

}  // namespace net
`;

/** fmtlib/fmt core.h: \`unsigned(id) < unsigned(…)\` read as a template turns the namespaces into an ERROR. */
const FMT_SHAPE = `namespace fmt {
namespace detail {

template <typename Context> class basic_format_args {
 public:
  FMT_CONSTEXPR auto get(int id) const -> format_arg {
    auto arg = format_arg();
    if (!is_packed()) {
      if (unsigned(id) < unsigned(max_size())) arg = args_[id];
      return arg;
    }
    if (unsigned(id) >= detail::max_packed_args) return arg;
    return arg;
  }

  auto max_size() const -> int { return 0; }
};

class context {
 public:
  void advance_to(int it) {}
};

}  // namespace detail
}  // namespace fmt
`;

const SHAPES: Record<string, string> = {
  'descriptor.h': PROTOBUF_SHAPE,
  'clock_cache.h': ROCKSDB_SHAPE,
  'socket.h': BRANCHES_SHAPE,
  'core.h': FMT_SHAPE,
};

function wasmExtract(file: string, source: string): ExtractionResult {
  const saved = process.env.CODEGRAPH_KERNEL;
  process.env.CODEGRAPH_KERNEL = '0';
  try {
    return extractFromSource(file, source, 'cpp');
  } finally {
    if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = saved;
  }
}

const named = (result: ExtractionResult, kind: string): string[] =>
  result.nodes.filter((n) => n.kind === kind).map((n) => n.qualifiedName);

const nodeAt = (result: ExtractionResult, qualifiedName: string): Node | undefined =>
  result.nodes.find((n) => n.qualifiedName === qualifiedName);

describe('C++ scopes from the source braces of a file whose tree has errors', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  it('every fixture still misparses (else the cases below prove nothing)', () => {
    for (const [file, source] of Object.entries(SHAPES)) {
      const tree = getParser('cpp')!.parse(cppExtractor.preParse!(source, file))!;
      expect(tree.rootNode.hasError, file).toBe(true);
      tree.delete();
    }
  });

  it('a class after one closed early keeps its namespaces (protobuf FieldDescriptor)', () => {
    const result = wasmExtract('src/google/protobuf/descriptor.h', PROTOBUF_SHAPE);
    expect(named(result, 'class')).toEqual(['google::protobuf::Names', 'google::protobuf::FieldDescriptor']);
    // `Names` is the one recovery glued to the tokens after it: it ends at its own `};`.
    expect(nodeAt(result, 'google::protobuf::Names')!.endLine).toBe(12);
  });

  it('a nested struct keeps its class and the next class its namespaces (rocksdb clock_cache)', () => {
    const result = wasmExtract('cache/clock_cache.h', ROCKSDB_SHAPE);
    expect(named(result, 'class')).toEqual(['rocksdb::clock_cache::FixedTable', 'rocksdb::clock_cache::AutoTable']);
    expect(named(result, 'struct')).toEqual(['rocksdb::clock_cache::FixedTable::Opts']);
    expect(named(result, 'method')).toEqual(['rocksdb::clock_cache::FixedTable::Opts::Opts']);
    // The class spans its whole body, so the struct it holds lies inside it.
    const fixed = nodeAt(result, 'rocksdb::clock_cache::FixedTable')!;
    expect([fixed.startLine, fixed.endLine]).toEqual([4, 17]);
    const contains = result.edges.find(
      (e) => e.kind === 'contains' && e.target === nodeAt(result, 'rocksdb::clock_cache::FixedTable::Opts')!.id
    );
    expect(contains?.source).toBe(fixed.id);
  });

  it('a class the tree kept open past its `}` lets go of the next class', () => {
    const result = wasmExtract('net/socket.h', BRANCHES_SHAPE);
    expect(named(result, 'class')).toEqual(['net::Socket', 'net::Listener']);
    expect(named(result, 'method')).toContain('net::Listener::Accept');
    expect(nodeAt(result, 'net::Socket')!.endLine).toBe(14);
  });

  it('namespaces the tree swallowed into an ERROR still prefix what they hold (fmt core.h)', () => {
    const result = wasmExtract('include/fmt/core.h', FMT_SHAPE);
    expect(named(result, 'class')).toEqual(['fmt::detail::context']);
    expect(named(result, 'method')).toEqual(['fmt::detail::context::advance_to']);
  });

  it('a file that parses cleanly keeps the tree scopes', () => {
    const clean = PROTOBUF_SHAPE.replace('PROTOBUF_FUTURE_ADD_EARLY_NODISCARD ', '');
    const tree = getParser('cpp')!.parse(cppExtractor.preParse!(clean, 'descriptor.h'))!;
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
    const result = wasmExtract('src/google/protobuf/descriptor.h', clean);
    expect(named(result, 'class')).toEqual(['google::protobuf::Names', 'google::protobuf::FieldDescriptor']);
    expect(named(result, 'method')).toEqual(['google::protobuf::Names::name']);
  });

  it('the base class of a class that lost its namespace resolves by scope lookup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-brace-scopes-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'descriptor.h'), PROTOBUF_SHAPE);
      // The base, and a namesake in another namespace: with the namespace
      // lost, neither a scope lookup nor the only-candidate guess finds it.
      fs.writeFileSync(
        path.join(dir, 'src', 'symbol_base.h'),
        'namespace google {\nnamespace protobuf {\nnamespace internal {\nclass SymbolBase {\n public:\n  int kind() const;\n};\n}  // namespace internal\n}  // namespace protobuf\n}  // namespace google\n'
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'other.h'),
        'namespace other {\nnamespace internal {\nclass SymbolBase {\n public:\n  int kind() const;\n};\n}  // namespace internal\n}  // namespace other\n'
      );
      const cg = await CodeGraph.init(dir);
      try {
        await cg.indexAll();
        const derived = cg.searchNodes('FieldDescriptor').map((r) => r.node).find((n) => n.kind === 'class')!;
        expect(derived.qualifiedName).toBe('google::protobuf::FieldDescriptor');
        const bases = cg
          .getOutgoingEdges(derived.id)
          .filter((e) => e.kind === 'extends')
          .map((e) => cg.getNode(e.target)?.qualifiedName);
        expect(bases).toEqual(['google::protobuf::internal::SymbolBase']);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scanCppBraceScopes', () => {
  it('matches braces past comments, literals and preprocessor lines', () => {
    const source = [
      'namespace a {',
      '// } a comment',
      '/* { */ const char* s = "}{";',
      "char c = '}'; int n = 1'000'000;",
      'auto r = R"x(})x";',
      '#define OPEN {',
      'struct S { int x; };',
      '}',
      '',
    ].join('\n');
    const scopes = scanCppBraceScopes(source)!;
    expect(scopes).not.toBeNull();
    const open = source.indexOf('{');
    expect(scopes.closeOf(open)).toBe(source.lastIndexOf('}'));
    const struct = source.indexOf('S {') + 2;
    expect(source.slice(struct, scopes.closeOf(struct)! + 1)).toBe('{ int x; }');
    expect(scopes.namespacesAt(struct)).toEqual(['a']);
  });

  it('reads each #if branch from the braces open at the #if', () => {
    const source = [
      'namespace a {',
      '#if defined(X)',
      'struct S : Base {',
      '#else',
      'struct S {',
      '#endif',
      '  int x;',
      '};',
      'struct T {};',
      '}',
      '',
    ].join('\n');
    const scopes = scanCppBraceScopes(source)!;
    expect(scopes).not.toBeNull();
    const first = source.indexOf('Base {') + 5;
    expect(scopes.closeOf(first)).toBe(source.indexOf('};'));
    expect(scopes.namespacesAt(source.indexOf('struct T'))).toEqual(['a']);
  });

  it('names namespaces as written and skips what declares none', () => {
    const source = [
      'namespace a::b {',
      'namespace [[deprecated]] c {',
      'inline namespace v1 {',
      'namespace {',
      'using namespace std;',
      'namespace fs = std::filesystem;',
      'int here;',
      '}',
      '}',
      '}',
      '}',
      'namespace std _GLIBCXX_VISIBILITY(default) {',
      'int there;',
      '}',
      '',
    ].join('\n');
    const scopes = scanCppBraceScopes(source)!;
    expect(scopes.namespacesAt(source.indexOf('int here'))).toEqual(['a::b', 'c', 'v1']);
    expect(scopes.namespacesAt(source.indexOf('int there'))).toEqual(['std']);
  });

  it('gives up on braces that do not balance', () => {
    expect(scanCppBraceScopes('namespace a {\nint x;\n')).toBeNull();
    expect(scanCppBraceScopes('int x;\n}\n')).toBeNull();
  });

  it('places offsets in UTF-16 columns, as the parser does', () => {
    const source = 'namespace n {\n/* é😀 */ class C { int x; };\n}\n';
    const scopes = scanCppBraceScopes(source)!;
    const close = scopes.closeOf(source.indexOf('{ int'))!;
    expect(scopes.positionOf(close + 1)).toEqual({ line: 2, column: 28 });
  });
});

describe.skipIf(!kernelAvailable)('C++ brace scopes: native kernel parity (error-extract hatch)', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  afterEach(() => {
    delete process.env.CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT;
    delete process.env.CODEGRAPH_KERNEL_LANGS;
    resetKernelForTests();
  });

  const canon = (result: ExtractionResult) => ({
    nodes: result.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort(),
  });

  it.each(Object.keys(SHAPES))('%s: the kernel walks the same scopes as the wasm walker', (file) => {
    for (const eol of ['\n', '\r\n']) {
      const source = SHAPES[file]!.replace(/\n/g, eol);
      process.env.CODEGRAPH_KERNEL_LANGS = 'cpp';
      process.env.CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT = '1';
      const viaKernel = tryKernelExtract(file, source, 'cpp');
      delete process.env.CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT;
      expect(viaKernel).not.toBeNull();
      // Without the hatch a file with parse errors defers to wasm. (Asked
      // second: a deferral is memoized for the same file and source.)
      expect(tryKernelExtract(file, source, 'cpp')).toBeNull();
      const viaWasm = wasmExtract(file, source);
      expect(canon(viaKernel!)).toEqual(canon(viaWasm));
    }
  });
});
