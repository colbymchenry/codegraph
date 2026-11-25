/**
 * A C++ call among a class's overloads that take the same number of
 * arguments picks the one the arguments' types fit.
 *
 * Overloads were told apart by argument count and string literals only, so
 * a tie went to the first one written. In facebook/rocksdb's
 * lru_cache_test.cc, `Insert(ch)` on a `char ch` reached `Insert(const
 * std::string& key, …)` instead of `Insert(char key, …)`. What a call's
 * arguments are is read where it can be: a character, number, `true`/`false`
 * or `nullptr` literal, a name the calling function declares (or its
 * address), or an expression whose type is known.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-overload-type-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** The method `qualifiedName` whose declaration starts on `line`, or the only one. */
function method(cg: CodeGraph, qualifiedName: string, line?: number): Node {
  const node = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName && (line === undefined || n.startLine === line));
  if (!node) throw new Error(`no method ${qualifiedName}${line === undefined ? '' : ` at line ${line}`}`);
  return node;
}

/** A method's `calls` edges, as `<call line> -> <target>:<target line> @<confidence>`. */
function callsAt(cg: CodeGraph, caller: Node): string[] {
  return cg
    .getOutgoingEdgesFrom([caller.id], ['calls'])
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${e.line} -> ${target?.qualifiedName}:${target?.startLine} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`;
    })
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

describe('C++ overloads chosen by argument types', () => {
  it("is the char overload for a char, and the string one for a string", async () => {
    const cg = await indexed({
      'cache/lru_cache_test.cc': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class LRUCacheTest {',
        ' public:',
        '  void Insert(const std::string& key, int priority = 0, size_t charge = 1) {}',
        '  void Insert(char key, int priority = 0) {',
        '    Insert(std::string(1, key), priority);',
        '  }',
        '  void Fill() {',
        "    for (char ch = 'a'; ch <= 'e'; ch++) {",
        '      Insert(ch);',
        '    }',
        '    std::string name = "x";',
        '    Insert(name);',
        '    Insert(name, 1, 2);',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'rocksdb::LRUCacheTest::Fill'))).toEqual([
        '11 -> rocksdb::LRUCacheTest::Insert:6 @0.9',
        '14 -> rocksdb::LRUCacheTest::Insert:5 @0.9',
        '15 -> rocksdb::LRUCacheTest::Insert:5 @0.9',
      ]);
      expect(callsAt(cg, method(cg, 'rocksdb::LRUCacheTest::Insert', 6))).toEqual(['7 -> rocksdb::LRUCacheTest::Insert:5 @0.9']);
    } finally {
      cg.close();
    }
  });

  it('is the overload a number, bool, char or null literal fits', async () => {
    const cg = await indexed({
      'db/writer.cc': lines(
        'namespace rocksdb {',
        'class Slice;',
        'class Writer {',
        ' public:',
        '  void Write(bool flag) {}',
        '  void Write(int n) {}',
        '  void Write(const Slice* s) {}',
        '  void Run() {',
        '    Write(7);',
        '    Write(false);',
        '    Write(nullptr);',
        "    Write('c');",
        '  }',
        '};',
        'class Holder {',
        ' public:',
        '  void Set(const std::string& name) {}',
        '  void Set(const Slice* slice) {}',
        '  void Clear() { Set(0); }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'rocksdb::Writer::Run'))).toEqual([
        '10 -> rocksdb::Writer::Write:5 @0.9',
        '11 -> rocksdb::Writer::Write:7 @0.9',
        '12 -> rocksdb::Writer::Write:6 @0.9',
        '9 -> rocksdb::Writer::Write:6 @0.9',
      ]);
      // A `0` is a null pointer as well as a number.
      expect(callsAt(cg, method(cg, 'rocksdb::Holder::Clear'))).toEqual(['19 -> rocksdb::Holder::Set:18 @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is the pointer overload for an object's address, and the string_view one for a string", async () => {
    const cg = await indexed({
      'compiler/builder.cc': lines(
        '#include <string>',
        'namespace protobuf {',
        'struct Proto {};',
        'class Builder {',
        ' public:',
        '  int Build(absl::string_view schema) { return 0; }',
        '  int Build(const Proto* proto) { return 1; }',
        '  void Run(const Proto& proto, const std::string& text) {',
        '    Build(&proto);',
        '    Build(text);',
        '  }',
        '};',
        '}  // namespace protobuf',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'protobuf::Builder::Run'))).toEqual([
        '10 -> protobuf::Builder::Build:6 @0.9',
        '9 -> protobuf::Builder::Build:7 @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('is the overload a typed receiver takes the arguments to', async () => {
    const cg = await indexed({
      'cache/lru_cache.cc': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class LRUCacheShard {',
        ' public:',
        '  void Insert(const std::string& key, int priority = 0) {}',
        '  void Insert(char key, int priority = 0) {}',
        '};',
        'void Fill(LRUCacheShard* shard) {',
        "  char ch = 'a';",
        '  shard->Insert(ch);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const fill = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'rocksdb::Fill')!;
      expect(callsAt(cg, fill)).toEqual(['10 -> rocksdb::LRUCacheShard::Insert:6 @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is an overload of the receiver's own class, not of a namesake another source file declares", async () => {
    // leveldb's db_bench.cc and db_bench_sqlite3.cc each declare a RandomGenerator.
    const cg = await indexed({
      'benchmarks/db_bench.cc': lines(
        'class RandomGenerator {',
        ' public:',
        '  const char* Generate(size_t len) { return nullptr; }',
        '};',
        'class Benchmark {',
        '  int value_size_;',
        '  void Write() {',
        '    RandomGenerator gen;',
        '    gen.Generate(value_size_);',
        '  }',
        '};',
      ),
      'benchmarks/db_bench_sqlite3.cc': lines(
        'class RandomGenerator {',
        ' public:',
        '  const char* Generate(int len) { return nullptr; }',
        '};',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'Benchmark::Write')).map((c) => c.replace(/ @.*$/, ''))).toEqual(['9 -> RandomGenerator::Generate:3']);
      const generate = cg.getOutgoingEdgesFrom([method(cg, 'Benchmark::Write').id], ['calls']).map((e) => cg.getNode(e.target)?.filePath);
      expect(generate).toEqual(['benchmarks/db_bench.cc']);
    } finally {
      cg.close();
    }
  });

  it("keeps a chained call's first overload: the arguments where it starts are the inner call's", async () => {
    const cg = await indexed({
      'gmock/gmock.h': lines(
        'namespace testing {',
        'class Sequence {};',
        'namespace internal {',
        'template <typename F>',
        'class TypedExpectation {',
        ' public:',
        '  TypedExpectation& InSequence(const Sequence& s) { return *this; }',
        '  TypedExpectation& InSequence(const Sequence& s1, const Sequence& s2) { return *this; }',
        '  TypedExpectation& InSequence(const Sequence& s1, const Sequence& s2,',
        '                               const Sequence& s3) {',
        '    return InSequence(s1, s2).InSequence(s3);',
        '  }',
        '};',
        '}  // namespace internal',
        '}  // namespace testing',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'testing::internal::TypedExpectation::InSequence', 9)).map((c) => c.replace(/ @.*$/, ''))).toEqual([
        '11 -> testing::internal::TypedExpectation::InSequence:7',
        '11 -> testing::internal::TypedExpectation::InSequence:8',
      ]);
    } finally {
      cg.close();
    }
  });

  it("is not an overload whose parameter a string literal can't be passed to", async () => {
    // rocksdb's `db_->Get(ro, db_->DefaultColumnFamily(), "empty_key", &result)`.
    const cg = await indexed({
      'include/rocksdb/db.h': lines(
        '#include <string>',
        'namespace rocksdb {',
        'struct ReadOptions {};',
        'class Slice { public: Slice(const char* s) {} };',
        'struct PinnableSlice {};',
        'struct ColumnFamilyHandle {};',
        'class DB {',
        ' public:',
        '  virtual int Get(const ReadOptions& options, const Slice& key, std::string* value, std::string* timestamp) = 0;',
        '  virtual int Get(const ReadOptions& options, ColumnFamilyHandle* column_family, const Slice& key, PinnableSlice* value) = 0;',
        '};',
        'int Read(DB* db, ColumnFamilyHandle* cf, PinnableSlice* result) {',
        '  ReadOptions ro;',
        '  return db->Get(ro, cf, "empty_key", result);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const read = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'rocksdb::Read')!;
      expect(callsAt(cg, read)).toEqual(['14 -> rocksdb::DB::Get:10 @0.9']);
    } finally {
      cg.close();
    }
  });

  it("reads a method's defaults from its declaration in the class, and a raw string as a string literal", async () => {
    // protobuf's io::Printer, whose overloads are defined below the class or in printer.cc.
    const cg = await indexed({
      'io/printer.h': lines(
        'namespace io {',
        'struct Sub {};',
        'class EnumDescriptor {};',
        'class Printer {',
        ' public:',
        '  void Annotate(absl::string_view varname, absl::string_view file_name, int semantic = 0) {}',
        '  template <typename Desc>',
        '  void Annotate(absl::string_view begin_varname, absl::string_view end_varname,',
        '                const Desc* descriptor, int semantic = 0);',
        '  void Emit(absl::string_view format, SourceLocation loc = SourceLocation::current());',
        '  void Emit(absl::Span<const Sub> vars, absl::string_view format,',
        '            SourceLocation loc = SourceLocation::current());',
        '};',
        'template <typename Desc>',
        'void Printer::Annotate(absl::string_view begin_varname, absl::string_view end_varname,',
        '                       const Desc* descriptor, int semantic) {}',
        'inline void Printer::Emit(absl::string_view format, SourceLocation loc) {}',
        '}  // namespace io',
      ),
      'io/printer.cc': lines(
        '#include "io/printer.h"',
        'namespace io {',
        'void Printer::Emit(absl::Span<const Sub> vars, absl::string_view format, SourceLocation loc) {}',
        '}  // namespace io',
      ),
      'compiler/enum.cc': lines(
        '#include "io/printer.h"',
        'namespace io {',
        'void Generate(Printer* printer, const EnumDescriptor* descriptor) {',
        '  printer->Annotate("{", "}", descriptor);',
        '  printer->Emit({Sub()}, R"cc(',
        '    $name$_ { visibility }',
        '  )cc");',
        '}',
        '}  // namespace io',
      ),
    });
    try {
      const generate = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'io::Generate')!;
      expect(callsAt(cg, generate).map((c) => c.replace(/ @.*$/, ''))).toEqual([
        '4 -> io::Printer::Annotate:15',
        '5 -> io::Printer::Emit:3',
      ]);
    } finally {
      cg.close();
    }
  });

  it("reads an element of a container a subscript names", async () => {
    // rocksdb's TransactionBaseImpl: `TryLock(column_family[i], keys[i], …)` over a
    // `std::vector<Slice>`, in the .cc that defines the SliceParts overload.
    const cg = await indexed({
      'utilities/transactions/transaction_base.h': lines(
        'namespace rocksdb {',
        'class Slice {};',
        'class SliceParts {};',
        'class ColumnFamilyHandle {};',
        'class TransactionBaseImpl {',
        ' public:',
        '  int TryLock(ColumnFamilyHandle* column_family, const Slice& key, bool read_only, bool exclusive) { return 0; }',
        '  int TryLock(ColumnFamilyHandle* column_family, const SliceParts& key, bool read_only, bool exclusive);',
        '  void MultiGetForUpdate(const std::vector<ColumnFamilyHandle*>& column_family, const std::vector<Slice>& keys);',
        '};',
        '}  // namespace rocksdb',
      ),
      'utilities/transactions/transaction_base.cc': lines(
        '#include "utilities/transactions/transaction_base.h"',
        'namespace rocksdb {',
        'int TransactionBaseImpl::TryLock(ColumnFamilyHandle* column_family, const SliceParts& key, bool read_only, bool exclusive) {',
        '  return 1;',
        '}',
        'void TransactionBaseImpl::MultiGetForUpdate(const std::vector<ColumnFamilyHandle*>& column_family,',
        '                                             const std::vector<Slice>& keys) {',
        '  for (size_t i = 0; i < keys.size(); i++) {',
        '    TryLock(column_family[i], keys[i], true, true);',
        '  }',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const multiGet = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'rocksdb::TransactionBaseImpl::MultiGetForUpdate')!;
      const tryLock = cg.getOutgoingEdgesFrom([multiGet.id], ['calls']).map((e) => cg.getNode(e.target)).filter((n) => n?.name === 'TryLock');
      expect(tryLock.map((n) => `${n!.filePath}:${n!.startLine}`)).toEqual(['utilities/transactions/transaction_base.h:7']);
    } finally {
      cg.close();
    }
  });

  it('reads arguments and parameters past their comments', async () => {
    const cg = await indexed({
      'cache/cache.cc': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class Cache {',
        ' public:',
        '  int Insert(const std::string& key, const void* value, int hash) { return 1; }',
        '  int Insert(const std::string& key, int hash, const void* value) { return 0; }',
        '  void Fill(const std::string& key) {',
        '    Insert(key, 0 /*hash*/, nullptr /*value*/);',
        '  }',
        '};',
        'class TextGenerator {',
        ' public:',
        '  void PrintEnum(int32_t /*val*/, const std::string& name) {}',
        '  void PrintEnum(int32_t val, absl::string_view name) {',
        '    PrintEnum(val, std::string(name));',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'rocksdb::Cache::Fill'))).toEqual(['8 -> rocksdb::Cache::Insert:6 @0.9']);
      // (protobuf's text_format.cc: a parameter named in a comment is still an `int32_t`.)
      expect(callsAt(cg, method(cg, 'rocksdb::TextGenerator::PrintEnum', 14))).toEqual(['15 -> rocksdb::TextGenerator::PrintEnum:13 @0.9']);
    } finally {
      cg.close();
    }
  });

  it('scores each kind of argument against each kind of parameter, whatever the order they are declared in', async () => {
    const cg = await indexed({
      'util/scorer.h': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class Slice { public: Slice(const char* s) {} };',
        'class Foo {};',
        "char MakeChar() { return 'a'; }",
        'class Scorer {',
        ' public:',
        '  void Num(int32_t n) {}',
        '  void Num(int64_t n) {}',
        '  void Text(const Slice& s) {}',
        '  void Text(absl::string_view s) {}',
        '  void Value(const std::string& s) {}',
        '  void Value(Foo f) {}',
        '  void Count(int n) {}',
        '  void Count(Foo f) {}',
        '  void Ptr(const Slice* p) {}',
        '  void Ptr(Foo f) {}',
        '  void Lit(int n) {}',
        '  void Lit(const char* s) {}',
        '  void Key(const std::string& k) {}',
        '  void Key(char k) {}',
        '  void Run(int64_t wide, const std::string& name, int n) {',
        '    Num(wide);',
        '    Text(name);',
        '    Value(n);',
        '    Count(name);',
        '    Ptr(n);',
        '    Lit(R"(raw)");',
        '    Key(MakeChar());',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(callsAt(cg, method(cg, 'rocksdb::Scorer::Run')).map((c) => c.replace(/ @.*$/, ''))).toEqual([
        // The type itself over another of its kind.
        '23 -> rocksdb::Scorer::Num:9',
        // A string for a string type, over a class of another name.
        '24 -> rocksdb::Scorer::Text:11',
        // A number for no string, a string for no number, a number for no pointer.
        '25 -> rocksdb::Scorer::Value:13',
        '26 -> rocksdb::Scorer::Count:15',
        '27 -> rocksdb::Scorer::Ptr:17',
        // A raw string is a string literal.
        '28 -> rocksdb::Scorer::Lit:19',
        // What a call returns.
        '29 -> rocksdb::MakeChar:5',
        '29 -> rocksdb::Scorer::Key:21',
      ]);
    } finally {
      cg.close();
    }
  });

  it("reads no type from another function's local of the name", async () => {
    const cg = await indexed({
      'cache/lru_cache_test.cc': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class LRUCacheTest {',
        ' public:',
        '  void Insert(const std::string& key) {}',
        '  void Insert(char key) {}',
        '};',
        "void Earlier() { char ch = 'x'; }",
        'void Later(LRUCacheTest* t) {',
        '  t->Insert(ch);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const later = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'rocksdb::Later')!;
      expect(callsAt(cg, later).map((c) => c.replace(/ @.*$/, ''))).toEqual(['10 -> rocksdb::LRUCacheTest::Insert:5']);
    } finally {
      cg.close();
    }
  });

  it('keeps the first overload when the arguments say nothing', async () => {
    const cg = await indexed({
      'cache/lru_cache_test.cc': lines(
        '#include <string>',
        'namespace rocksdb {',
        'class LRUCacheTest {',
        ' public:',
        '  void Insert(const std::string& key) {}',
        '  void Insert(char key) {}',
        '  void Fill() {',
        "    char ch = 'a';",
        '    {',
        '      auto ch = MakeKey();',
        '      Insert(ch);',
        '    }',
        '    Insert(MakeKey());',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // The inner `ch` is MakeKey()'s, which isn't known: not the outer `char ch`.
      expect(callsAt(cg, method(cg, 'rocksdb::LRUCacheTest::Fill')).filter((c) => c.includes('Insert'))).toEqual([
        '11 -> rocksdb::LRUCacheTest::Insert:5 @0.9',
        '13 -> rocksdb::LRUCacheTest::Insert:5 @0.9',
      ]);
    } finally {
      cg.close();
    }
  });
});
