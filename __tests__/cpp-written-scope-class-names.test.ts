/**
 * A C++ class, struct or union whose declaration writes its name with a
 * scope — a nested class defined outside the class it is nested in — is
 * indexed by its own name, qualified under that scope.
 *
 * google/leveldb defines `template <typename Key, class Comparator> struct
 * SkipList<Key, Comparator>::Node { … }` below the class, and facebook/rocksdb
 * `struct BlockBasedTable::Rep { … }` in a source file. Each was indexed as a
 * class named `<anonymous>`, so its members belonged to no class anyone
 * names, and a call on a `Node*` or `Rep*` couldn't reach them: leveldb's
 * `x->Next(level)` was guessed by the method's name. Such a class is now
 * `Node`, qualified `leveldb::SkipList::Node` the way an out-of-line method
 * `SkipList<Key, Comparator>::Node::Next` already was, and its members are
 * qualified under it. A specialization (`struct fmt::formatter<Answer>`)
 * keeps out of its template's name.
 *
 * A construction is recorded by its type's last name, so with
 * `DBImpl::Writer` named, leveldb's `new log::Writer(…)` in a `DBImpl` method
 * went to it. A construction now makes the class C++ lookup finds for the
 * type as written there.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-scoped-class-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** Every class, struct and union node, as `kind qualifiedName`, with the members it contains. */
function classes(cg: CodeGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of [...cg.getNodesByKind('class'), ...cg.getNodesByKind('struct'), ...cg.getNodesByKind('union')]) {
    const members = cg.getOutgoingEdgesFrom([n.id], ['contains'])
      .map((e) => cg.getNode(e.target))
      .filter((m): m is Node => m !== null && (m.kind === 'method' || m.kind === 'field' || m.kind === 'property'))
      .map((m) => m.qualifiedName)
      .sort();
    out[`${n.kind} ${n.qualifiedName}`] = members;
  }
  return out;
}

const SKIPLIST = lines(
  'namespace leveldb {',
  'template <typename Key, class Comparator>',
  'class SkipList {',
  ' public:',
  '  void Insert(const Key& key) {',
  '    Node* x = head_;',
  '    x->SetNext(0, x->Next(0));',
  '  }',
  ' private:',
  '  struct Node;',
  '  Node* head_;',
  '};',
  'template <typename Key, class Comparator>',
  'struct SkipList<Key, Comparator>::Node {',
  '  Node* Next(int n) { return nullptr; }',
  '  void SetNext(int n, Node* x) {}',
  '};',
  'class Table {',
  ' public:',
  '  int GlobalSeqno() const { return rep_->get_global_seqno(); }',
  ' private:',
  '  struct Rep;',
  '  Rep* rep_;',
  '};',
  'struct Table::Rep {',
  '  int get_global_seqno() const { return 0; }',
  '};',
  '// Another class with methods of these names, so a guess by the name can miss.',
  'class MemTableRep {',
  ' public:',
  '  void* Next(int n) { return nullptr; }',
  '  void SetNext(int n, void* x) {}',
  '  int get_global_seqno() const { return 1; }',
  '};',
  '}  // namespace leveldb',
);

describe('C++ classes named with a scope or template arguments', () => {
  it('names an out-of-line nested class, qualified with its members under its scope', async () => {
    const cg = await indexed({
      'db/skiplist.h': SKIPLIST,
      // rocksdb's thread pool hides its state in a `class` defined in its source file.
      'util/threadpool.h': lines(
        'namespace rocksdb {',
        'class ThreadPoolImpl {',
        ' public:',
        '  int Size() const;',
        ' private:',
        '  class Impl;',
        '  Impl* impl_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'util/threadpool.cc': lines(
        '#include "util/threadpool.h"',
        'namespace rocksdb {',
        'class ThreadPoolImpl::Impl {',
        ' public:',
        '  int GetQueueLen() const { return 0; }',
        '};',
        'int ThreadPoolImpl::Size() const { return impl_->GetQueueLen(); }',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const all = classes(cg);
      expect(all['struct leveldb::SkipList::Node']).toEqual(['leveldb::SkipList::Node::Next', 'leveldb::SkipList::Node::SetNext']);
      expect(all['struct leveldb::Table::Rep']).toEqual(['leveldb::Table::Rep::get_global_seqno']);
      expect(all['class rocksdb::ThreadPoolImpl::Impl']).toEqual(['rocksdb::ThreadPoolImpl::Impl::GetQueueLen']);
      expect(Object.keys(all).filter((k) => k.includes('<anonymous>'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("leaves a specialization out of its template's name", async () => {
    // Named `formatter`, fmt's specializations stood in for the template and
    // for each other: `formatter<weekday, Char> : formatter<std::tm, Char>`
    // extended `formatter<day, Char>`.
    const cg = await indexed({
      'include/fmt/base.h': lines(
        'namespace fmt {',
        'template <typename T, typename Char = char> struct formatter {',
        '  formatter() = delete;',
        '};',
        'template <> struct formatter<int> {',
        '  auto format(int x) const { return x; }',
        '};',
        '}  // namespace fmt',
      ),
      'test/format-test.cc': lines(
        '#include "include/fmt/base.h"',
        'struct Answer {};',
        'template <> struct fmt::formatter<Answer> : fmt::formatter<int> {};',
      ),
    });
    try {
      const named = [...cg.getNodesByKind('struct'), ...cg.getNodesByKind('class')]
        .filter((n) => n.name === 'formatter' || n.qualifiedName.includes('formatter'));
      expect(named.map((n) => `${n.qualifiedName} ${n.filePath}:${n.startLine}`)).toEqual(['fmt::formatter include/fmt/base.h:2']);
    } finally {
      cg.close();
    }
  });

  it('leaves a class unnamed when its scope is no plain name', async () => {
    const cg = await indexed({
      'outer.h': lines(
        'namespace ns {',
        'template <int N> struct Outer { struct Inner; struct Other; };',
        'template <int N> struct Outer<(N > 1)>::Inner { int x; };',
        'struct decltype(Outer<1>())::Other { int y; };',
        '}  // namespace ns',
      ),
    });
    try {
      expect(Object.keys(classes(cg)).sort()).toEqual(['struct ns::<anonymous>', 'struct ns::Outer']);
    } finally {
      cg.close();
    }
  });

  it("links a call on such a class's pointer to its method", async () => {
    const cg = await indexed({ 'db/skiplist.h': SKIPLIST });
    try {
      expect(targets(cg, 'leveldb::SkipList::Insert', 'calls')).toEqual(['leveldb::SkipList::Node::Next @0.9', 'leveldb::SkipList::Node::SetNext @0.9']);
      expect(targets(cg, 'leveldb::Table::GlobalSeqno', 'calls')).toEqual(['leveldb::Table::Rep::get_global_seqno @0.9']);
    } finally {
      cg.close();
    }
  });
});

/** What a function's or method's `kind` edges reach, as `qualifiedName @confidence`. */
function targets(cg: CodeGraph, qualifiedName: string, kind: 'calls' | 'instantiates'): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], [kind])
    .map((e) => `${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

describe('C++ constructions of a type a class shares its name with', () => {
  // leveldb's db_impl.cc constructs `log::Writer`s and, as `Writer w(…)`, the
  // `DBImpl::Writer` it defines out of line: by the type's last name alone,
  // the two were one.
  const LEVELDB = {
    'db/log_writer.h': lines(
      'namespace leveldb {',
      'namespace log {',
      'class Writer {',
      ' public:',
      '  explicit Writer(int* dest) {}',
      '};',
      '}  // namespace log',
      '}  // namespace leveldb',
    ),
    'db/db_impl.h': lines(
      '#include "db/log_writer.h"',
      'namespace leveldb {',
      'class DBImpl {',
      ' public:',
      '  void NewDB();',
      '  void Write();',
      ' private:',
      '  struct Writer;',
      '  log::Writer* log_;',
      '};',
      '}  // namespace leveldb',
    ),
    'db/db_impl.cc': lines(
      '#include "db/db_impl.h"',
      'namespace leveldb {',
      'struct DBImpl::Writer {',
      '  explicit Writer(int* mu) {}',
      '};',
      'void DBImpl::NewDB() {',
      '  int file = 0;',
      '  log_ = new log::Writer(&file);',
      '  const log::Writer scratch(&file);',
      '}',
      'void DBImpl::Write() {',
      '  int mu = 0;',
      '  Writer w(&mu);',
      '}',
      '}  // namespace leveldb',
    ),
    'db/log_test.cc': lines(
      '#include "db/log_writer.h"',
      'namespace leveldb {',
      'namespace log {',
      'class LogTest {',
      ' public:',
      '  void Reset() { writer_ = new Writer(nullptr); }',
      ' private:',
      '  Writer* writer_;',
      '};',
      '}  // namespace log',
      '}  // namespace leveldb',
    ),
  };

  it('makes the class C++ lookup finds for the type as written', async () => {
    const cg = await indexed(LEVELDB);
    try {
      expect(targets(cg, 'leveldb::DBImpl::NewDB', 'instantiates')).toEqual(['leveldb::log::Writer @0.9', 'leveldb::log::Writer @0.9']);
      expect(targets(cg, 'leveldb::DBImpl::Write', 'instantiates')).toEqual(['leveldb::DBImpl::Writer @0.9']);
      expect(targets(cg, 'leveldb::log::LogTest::Reset', 'instantiates')).toEqual(['leveldb::log::Writer @0.9']);
    } finally {
      cg.close();
    }
  });

  it("tells apart two classes' nested classes of one name", async () => {
    // rocksdb's `new BlockBasedTable::Rep(…)` reached `BlockBasedTableBuilder::Rep`.
    const cg = await indexed({
      'table/reader.h': lines(
        'namespace rocksdb {',
        'class BlockBasedTable {',
        ' public:',
        '  static void Open();',
        '  struct Rep;',
        '};',
        'struct BlockBasedTable::Rep {',
        '  explicit Rep(int level) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'table/reader.cc': lines(
        '#include "table/reader.h"',
        'namespace rocksdb {',
        'void BlockBasedTable::Open() {',
        '  Rep* rep = new BlockBasedTable::Rep(0);',
        '}',
        '}  // namespace rocksdb',
      ),
      'table/builder.cc': lines(
        '#include "table/reader.h"',
        'namespace rocksdb {',
        'class BlockBasedTableBuilder {',
        ' public:',
        '  void Finish();',
        ' private:',
        '  struct Rep;',
        '  Rep* rep_;',
        '};',
        'struct BlockBasedTableBuilder::Rep {',
        '  explicit Rep(int level) {}',
        '};',
        'void BlockBasedTableBuilder::Finish() {',
        '  rep_ = new Rep(1);',
        '  BlockBasedTable::Rep* other = new BlockBasedTable::Rep(2);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(targets(cg, 'rocksdb::BlockBasedTable::Open', 'instantiates')).toEqual(['rocksdb::BlockBasedTable::Rep @0.9']);
      expect(targets(cg, 'rocksdb::BlockBasedTableBuilder::Finish', 'instantiates'))
        .toEqual(['rocksdb::BlockBasedTable::Rep @0.9', 'rocksdb::BlockBasedTableBuilder::Rep @0.9']);
    } finally {
      cg.close();
    }
  });

  it('makes an enum, the class a local alias names, or nothing, where lookup finds no class', async () => {
    // rocksdb declares a `Comparator` class, and its skip lists take one as a
    // template parameter; protobuf's `CounterMap()` makes a `std::map` it
    // calls `Map`, beside protobuf's own `Map`.
    const cg = await indexed({
      'util/counters.cc': lines(
        '#include <map>',
        '#include "util/comparator.h"',
        'namespace rocksdb {',
        'void* CounterMap() {',
        '  using Bytes = std::map<int, int>;',
        '  return new Bytes{};',
        '}',
        'void* Buffer() { return new Bytes(1); }',
        'void* Owned() {',
        '  using Comparator = Bytes;',
        '  return new Comparator(2);',
        '}',
        '}  // namespace rocksdb',
      ),
      'util/comparator.h': lines(
        'namespace rocksdb {',
        'class Comparator {',
        ' public:',
        '  explicit Comparator(int n) {}',
        '};',
        'class Bytes {',
        ' public:',
        '  explicit Bytes(int n) {}',
        '};',
        'class value_type {',
        ' public:',
        '  explicit value_type(char c) {}',
        '};',
        'enum ValueType { kTypeValue, kTypeDeletion };',
        '}  // namespace rocksdb',
      ),
      'memtable/skiplist.h': lines(
        '#include <string>',
        '#include "util/comparator.h"',
        'namespace rocksdb {',
        'namespace memtable {',
        'using Bytes = std::string;',
        'template <typename Comparator>',
        'class SkipList {',
        ' public:',
        '  void Insert() {',
        '    Comparator compare(1);',
        '    Bytes key(8);',
        "    Bytes::value_type first('a');",
        '    const ValueType types[] = {kTypeValue};',
        '  }',
        '};',
        'template <typename ValueType>',
        'void Fill() { ValueType value(1); }',
        '}  // namespace memtable',
        '}  // namespace rocksdb',
      ),
      // An enum of the same name another source file declares for itself.
      'util/a.cc': lines(
        'namespace rocksdb {',
        'enum ValueType { kOther };',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(targets(cg, 'rocksdb::memtable::SkipList::Insert', 'instantiates')).toEqual(['rocksdb::ValueType @0.9', 'rocksdb::memtable::Bytes @0.9']);
      const insert = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'rocksdb::memtable::SkipList::Insert')!;
      expect(cg.getOutgoingEdgesFrom([insert.id], ['instantiates']).map((e) => cg.getNode(e.target)!)
        .filter((n) => n.kind === 'enum').map((n) => n.filePath)).toEqual(['util/comparator.h']);
      expect(targets(cg, 'rocksdb::memtable::Fill', 'instantiates')).toEqual([]);
      expect(targets(cg, 'rocksdb::CounterMap', 'instantiates')).toEqual([]);
      expect(targets(cg, 'rocksdb::Buffer', 'instantiates')).toEqual(['rocksdb::Bytes @0.9']);
      expect(targets(cg, 'rocksdb::Owned', 'instantiates')).toEqual(['rocksdb::Bytes @0.9']);
    } finally {
      cg.close();
    }
  });

  it('takes the class only the file sees at less than C++ lookup', async () => {
    const cg = await indexed({
      'widget.h': lines(
        'namespace ui {',
        'class Widget {',
        ' public:',
        '  explicit Widget(int n) {}',
        '};',
        '}  // namespace ui',
      ),
      'main.cc': lines(
        '#include "widget.h"',
        'class App {',
        ' public:',
        '  void Run() { Widget w(1); }',
        '};',
      ),
    });
    try {
      expect(targets(cg, 'App::Run', 'instantiates')).toEqual(['ui::Widget @0.7']);
    } finally {
      cg.close();
    }
  });

  it("reads the type's template arguments, and tells same-named local classes apart by where they are", async () => {
    const cg = await indexed({
      'util/writer_test.cc': lines(
        'namespace rocksdb {',
        'template <bool B> class Outer {',
        ' public:',
        '  class Inner {};',
        '};',
        'class WriterTest {',
        ' public:',
        '  void Make() {',
        '    auto* a = new Outer<true>::Inner();',
        '    auto* b = new Outer<(sizeof(int) > 2)>::Inner();',
        '  }',
        '};',
        'TEST_F(WriterTest, RangeSync) {',
        '  class FakeWF {',
        '   public:',
        '    explicit FakeWF(int n) {}',
        '  };',
        '  FakeWF* wf = new FakeWF(1);',
        '}',
        'TEST_F(WriterTest, IncrementalBuffer) {',
        '  class FakeWF {',
        '   public:',
        '    explicit FakeWF(int n) {}',
        '  };',
        '  FakeWF* wf = new FakeWF(2);',
        '}',
        '}  // namespace rocksdb',
      ),
      // googlemock's specializations, unnamed, each nest an `Impl` and an alias.
      'gmock/gmock.h': lines(
        'namespace testing {',
        'class Matchers {',
        '  template <typename T> class RefMatcher;',
        '  template <typename T> class RefMatcher<T&> {',
        '   public:',
        '    using Tuple = std::tuple<T>;',
        '    class Impl {};',
        "    // The next specialization's `Tuple` and `Impl` are nearer to",
        '    // this `Make` than its own.',
        '    //',
        '    //',
        '    //',
        '    void* Make() { Tuple t(1); return new Impl(); }',
        '  };',
        '  template <typename T> class RefMatcher<T*> {',
        '   public:',
        '    using Tuple = std::tuple<T*>;',
        '    class Impl {};',
        '    void* Make() { Tuple t(nullptr); return new Impl(); }',
        '  };',
        '};',
        '}  // namespace testing',
      ),
    });
    try {
      // (Recorded by the name before its first `<`, `Outer`.)
      expect(targets(cg, 'rocksdb::WriterTest::Make', 'instantiates')).toEqual(['rocksdb::Outer::Inner @0.9', 'rocksdb::Outer::Inner @0.9']);
      const made = (callers: Node[]): string[][] => callers.sort((a, b) => a.startLine - b.startLine)
        .map((fn) => cg.getOutgoingEdgesFrom([fn.id], ['instantiates']).map((e) => `${fn.startLine} -> ${cg.getNode(e.target)?.startLine}`).sort());
      expect(made(cg.getNodesByKind('function').filter((n) => n.name === 'TEST_F'))).toEqual([['13 -> 14'], ['20 -> 21']]);
      expect(made(cg.getNodesByKind('method').filter((n) => n.filePath === 'gmock/gmock.h')))
        .toEqual([['13 -> 6', '13 -> 7'], ['19 -> 17', '19 -> 18']]);
    } finally {
      cg.close();
    }
  });
});
