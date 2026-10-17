/**
 * A C++ receiver declared through a `typedef` / `using` alias calls the type
 * the alias names.
 *
 * google/leveldb's `MemTable::Add` calls `table_.Insert(buf)` on a member
 * declared `Table table_;`, beside `typedef SkipList<const char*,
 * KeyComparator> Table;` in the same class. Receiver inference read the
 * declared type as `Table`; no class `Table` has an `Insert` (the one class
 * `Table` is the unrelated `leveldb::Table`), and the C/C++ extractors record
 * no aliased type on a `type_alias` node, so the call fell through to a guess
 * by the receiver's name: `HandleTable::Insert` in util/cache.cc.
 *
 * The alias is now looked up the way C++ looks a name up: an alias declared
 * earlier in the calling function, then the caller's class and the classes it
 * inherits from, then the namespaces around it, innermost first, where a
 * class of that name stops the search. The alias's declaration is read and
 * its type followed, so the call reaches `SkipList::Insert`, a
 * `Table::Iterator` declaration constructs `SkipList::Iterator`, and its
 * methods resolve there. When the aliased type has no such method (an alias
 * of `std::vector`, say) or the alias names a template parameter, no method
 * is guessed by the receiver's name — unless the call goes through `->` on an
 * iterator or smart pointer, which reaches a type the alias doesn't name, or
 * the declaration was read from outside the calling function and its class.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { cppTypeSegments } from '../src/resolution/cpp-type-aliases';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-alias-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName (file)`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} (${r.node.filePath})`)
    .sort();
}

/** google/leveldb's shapes, trimmed: the skip list, the unrelated `Table`, and the decoy `Insert`. */
const LEVELDB = {
  'include/leveldb/table.h': [
    'namespace leveldb {',
    'class Table {',
    ' public:',
    '  explicit Table(int* rep);',
    '  int ApproximateOffsetOf(int key) const;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'util/cache.cc': [
    'namespace leveldb {',
    'class HandleTable {',
    ' public:',
    '  void Insert(int h) { last_ = h; }',
    ' private:',
    '  int last_;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/skiplist.h': [
    'namespace leveldb {',
    'template <typename Key, class Comparator>',
    'class SkipList {',
    ' public:',
    '  explicit SkipList(Comparator cmp, int* arena);',
    '  void Insert(const Key& key);',
    '  class Iterator {',
    '   public:',
    '    explicit Iterator(const SkipList* list);',
    '    void Seek(const Key& target);',
    '  };',
    '};',
    'template <typename Key, class Comparator>',
    'SkipList<Key, Comparator>::SkipList(Comparator cmp, int* arena) {}',
    'template <typename Key, class Comparator>',
    'void SkipList<Key, Comparator>::Insert(const Key& key) {}',
    'template <typename Key, class Comparator>',
    'SkipList<Key, Comparator>::Iterator::Iterator(const SkipList* list) {}',
    'template <typename Key, class Comparator>',
    'void SkipList<Key, Comparator>::Iterator::Seek(const Key& target) {}',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/memtable.h': [
    '#include "db/skiplist.h"',
    'namespace leveldb {',
    'struct KeyComparator {',
    '  int operator()(const char* a, const char* b) const;',
    '};',
    'class MemTable {',
    ' public:',
    '  void Add(const char* buf);',
    '  bool Get(const char* key);',
    '  void Rebuild(int* arena);',
    '  void Index(const char* key);',
    ' private:',
    '  typedef SkipList<const char*, KeyComparator> Table;',
    '  using Lookup = Table;',
    '  Table table_;',
    '  Lookup lookup_;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/memtable.cc': [
    '#include "db/memtable.h"',
    'namespace leveldb {',
    'void MemTable::Add(const char* buf) {',
    '  table_.Insert(buf);',
    '}',
    'bool MemTable::Get(const char* key) {',
    '  Table::Iterator iter(&table_);',
    '  iter.Seek(key);',
    '  return true;',
    '}',
    'void MemTable::Rebuild(int* arena) {',
    '  KeyComparator cmp;',
    '  Table fresh(cmp, &arena[0]);',
    '  Table stale(&arena[1]);',
    '}',
    'void MemTable::Index(const char* key) {',
    '  lookup_.Insert(key);',
    '}',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
};

describe('a C++ receiver declared through an alias', () => {
  it('reproduction: `table_.Insert` reaches SkipList::Insert, not a class named after the receiver', async () => {
    const cg = await indexed(LEVELDB);
    try {
      expect(calls(cg, 'leveldb::MemTable::Add')).toEqual(['leveldb::SkipList::Insert (db/skiplist.h)']);
      expect(cg.getCallers(callable(cg, 'leveldb::HandleTable::Insert').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a nested type reached through the alias is constructed and called on the aliased type', async () => {
    const cg = await indexed(LEVELDB);
    try {
      expect(calls(cg, 'leveldb::MemTable::Get')).toEqual([
        'leveldb::SkipList::Iterator::Iterator (db/skiplist.h)',
        'leveldb::SkipList::Iterator::Seek (db/skiplist.h)',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a local object of the alias type constructs the aliased type, never an outer class the alias hides', async () => {
    const cg = await indexed(LEVELDB);
    try {
      // `Table fresh(cmp, &arena[0])` is SkipList's two-argument constructor;
      // `Table stale(&arena[1])` fits no SkipList constructor, and
      // `leveldb::Table(int*)` is not the `Table` this scope names.
      expect(calls(cg, 'leveldb::MemTable::Rebuild')).toEqual(['leveldb::SkipList::SkipList (db/skiplist.h)']);
      expect(cg.getCallers(callable(cg, 'leveldb::Table::Table').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('follows an alias of an alias', async () => {
    const cg = await indexed(LEVELDB);
    try {
      expect(calls(cg, 'leveldb::MemTable::Index')).toEqual(['leveldb::SkipList::Insert (db/skiplist.h)']);
    } finally {
      cg.close();
    }
  });

  it('an alias spelled from outside its class, and one declared in the calling function', async () => {
    const cg = await indexed({
      ...LEVELDB,
      'db/builder.cc': [
        '#include "db/memtable.h"',
        'namespace leveldb {',
        'void Fill(MemTable::Table* t) {',
        '  t->Insert("k");',
        '}',
        'void Build(int* arena) {',
        '  typedef SkipList<const char*, KeyComparator> List;',
        '  KeyComparator cmp;',
        '  List list(cmp, &arena[0]);',
        '  list.Insert("k");',
        '}',
        '}  // namespace leveldb',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'leveldb::Fill')).toEqual(['leveldb::SkipList::Insert (db/skiplist.h)']);
      expect(calls(cg, 'leveldb::Build')).toEqual([
        'leveldb::SkipList::Insert (db/skiplist.h)',
        'leveldb::SkipList::SkipList (db/skiplist.h)',
      ]);
    } finally {
      cg.close();
    }
  });

  it('no guess by the receiver\'s name when the aliased type lacks the method', async () => {
    const cg = await indexed({
      ...LEVELDB,
      'include/leveldb/slice.h': [
        'namespace leveldb {',
        'class Slice {',
        ' public:',
        '  void clear() { size_ = 0; }',
        ' private:',
        '  int size_;',
        '};',
        '}  // namespace leveldb',
        '',
      ].join('\n'),
      'db/version_set.h': [
        '#include <vector>',
        'namespace leveldb {',
        'class VersionSet {',
        ' public:',
        '  void Clear();',
        ' private:',
        '  using Table = std::vector<int>;',
        '  Table files_;',
        '};',
        '}  // namespace leveldb',
        '',
      ].join('\n'),
      'db/version_set.cc': [
        '#include "db/version_set.h"',
        'namespace leveldb {',
        'void VersionSet::Clear() {',
        '  files_.clear();',
        '}',
        '}  // namespace leveldb',
        '',
      ].join('\n'),
    });
    try {
      // `files_` is a std::vector: not Slice::clear, the one project `clear`.
      expect(calls(cg, 'leveldb::VersionSet::Clear')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('nor when the call continues on the next line', async () => {
    // protocolbuffers/protobuf's descriptor.cc writes `symbols_by_parent_`
    // and `.insert(…)` on separate lines.
    const cg = await indexed({
      'src/descriptor.cc': [
        '#include "absl/container/flat_hash_set.h"',
        'namespace google { namespace protobuf {',
        'class Arena {',
        ' public:',
        '  void insert(int block) {}',
        '};',
        'class FileDescriptorTables {',
        ' public:',
        '  bool AddAliasUnderParent(int symbol);',
        ' private:',
        '  typedef absl::flat_hash_set<int> SymbolsByParentSet;',
        '  SymbolsByParentSet symbols_by_parent_;',
        '};',
        'bool FileDescriptorTables::AddAliasUnderParent(int symbol) {',
        '  return symbols_by_parent_',
        '      .insert(symbol)',
        '      .second;',
        '}',
        '} }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'google::protobuf::FileDescriptorTables::AddAliasUnderParent')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a class declared in an inner scope hides an outer alias of the same name; outside it the alias applies', async () => {
    const cg = await indexed({
      'app/holder.h': [
        'namespace app {',
        'class Gadget {',
        ' public:',
        '  void Spin();',
        '};',
        'using Widget = Gadget;',
        'class Holder {',
        ' public:',
        '  class Widget {',
        '   public:',
        '    void Spin();',
        '  };',
        '  void Use();',
        ' private:',
        '  Widget w_;',
        '};',
        '}  // namespace app',
        '',
      ].join('\n'),
      'app/holder.cc': [
        '#include "app/holder.h"',
        'namespace app {',
        'void Gadget::Spin() {}',
        'void Holder::Widget::Spin() {}',
        'void Holder::Use() {',
        '  w_.Spin();',
        '}',
        'void Twirl(Widget& w) {',
        '  w.Spin();',
        '}',
        '}  // namespace app',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'app::Holder::Use')).toEqual(['app::Holder::Widget::Spin (app/holder.cc)']);
      // Outside Holder, `Widget` is the namespace's alias of Gadget.
      expect(calls(cg, 'app::Twirl')).toEqual(['app::Gadget::Spin (app/holder.cc)']);
    } finally {
      cg.close();
    }
  });
});

describe('an alias a class inherits', () => {
  it('is found in the base class before an enclosing namespace, and a dependent alias is not followed', async () => {
    // protocolbuffers/protobuf's json traits: `Field` in the derived traits is
    // the base's `const FieldDescriptor*`, not the namespace's alias template.
    const cg = await indexed({
      'protobuf/descriptor.h': [
        'namespace google { namespace protobuf {',
        'class FieldDescriptor {',
        ' public:',
        '  bool is_repeated() const;',
        '};',
        'inline bool FieldDescriptor::is_repeated() const { return false; }',
        'class OneofDescriptor {',
        ' public:',
        '  bool is_repeated() const { return false; }',
        '};',
        '} }',
        '',
      ].join('\n'),
      'protobuf/json/traits.h': [
        '#include "protobuf/descriptor.h"',
        'namespace google { namespace protobuf { namespace json_internal {',
        'template <typename Traits>',
        'using Field = typename Traits::Field;',
        'struct Proto2Descriptor {',
        '  using Field = const FieldDescriptor*;',
        '};',
        'struct ParseProto2Descriptor : Proto2Descriptor {',
        '  static bool NewMsg(Field f) { return f->is_repeated(); }',
        '};',
        '} } }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'google::protobuf::json_internal::ParseProto2Descriptor::NewMsg')).toEqual([
        'google::protobuf::FieldDescriptor::is_repeated (protobuf/descriptor.h)',
      ]);
    } finally {
      cg.close();
    }
  });
});

describe('an alias of a template parameter', () => {
  it('names no type, so a class that shares the alias\'s name is not it', async () => {
    // protocolbuffers/protobuf: `GenericTypeHandler<GenericType>` declares
    // `using Type = GenericType;`, and the generated `google.protobuf.Type`
    // message is a class named `Type` with a `Clear`.
    const cg = await indexed({
      'protobuf/type.pb.h': [
        'namespace google { namespace protobuf {',
        'class Type {',
        ' public:',
        '  void Clear();',
        '};',
        'inline void Type::Clear() {}',
        '} }',
        '',
      ].join('\n'),
      'protobuf/repeated_ptr_field.h': [
        'namespace google { namespace protobuf { namespace internal {',
        'template <typename GenericType>',
        'class GenericTypeHandler {',
        ' public:',
        '  using Type = GenericType;',
        '  static void Reset(Type* value) { value->Clear(); }',
        '};',
        '} } }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'google::protobuf::internal::GenericTypeHandler::Reset')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('what does not rule a guess out', () => {
  it('`->` through an alias of an iterator reaches the element type, which the alias does not name', async () => {
    // google/googletest's gmock: `ExpectationSet::const_iterator` is a
    // `std::set<Expectation>` iterator, and `it->` is an Expectation.
    const cg = await indexed({
      'gmock/expectation.h': [
        '#include <set>',
        'namespace testing {',
        'class Expectation {',
        ' public:',
        '  int expectation_base() const { return 0; }',
        '};',
        'class ExpectationSet {',
        ' public:',
        '  typedef ::std::set<Expectation> Set;',
        '  typedef Set::const_iterator const_iterator;',
        '};',
        'int Describe(const ExpectationSet& set) {',
        '  ExpectationSet::const_iterator it;',
        '  return it->expectation_base();',
        '}',
        '}  // namespace testing',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'testing::Describe')).toEqual(['testing::Expectation::expectation_base (gmock/expectation.h)']);
    } finally {
      cg.close();
    }
  });

  it('a class template\'s specialization can declare a member the template itself does not', async () => {
    // facebook/rocksdb's toku order-maintenance tree: `get_marked` is a member
    // of `omt_node_templated<omtdata_t, true>` only.
    const cg = await indexed({
      'util/omt.h': [
        'namespace toku {',
        'namespace omt_internal {',
        'template <typename omtdata_t, bool subtree_supports_marks>',
        'class omt_node_templated {',
        ' public:',
        '  void clear_stolen_bits() {}',
        '};',
        'template <typename omtdata_t>',
        'class omt_node_templated<omtdata_t, true> {',
        ' public:',
        '  bool get_marked() const { return false; }',
        '};',
        '}  // namespace omt_internal',
        'template <typename omtdata_t, bool supports_marks = false>',
        'class omt {',
        ' public:',
        '  bool has_marks() const;',
        ' private:',
        '  typedef omt_internal::omt_node_templated<omtdata_t, supports_marks> omt_node;',
        '  omt_node root_;',
        '};',
        'template <typename omtdata_t, bool supports_marks>',
        'bool omt<omtdata_t, supports_marks>::has_marks() const {',
        '  const omt_node &node = root_;',
        '  return node.get_marked();',
        '}',
        '}  // namespace toku',
        '',
      ].join('\n'),
    });
    try {
      const callees = cg.getCallees(callable(cg, 'toku::omt::has_marks').id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.name);
      expect(callees).toEqual(['get_marked']);
    } finally {
      cg.close();
    }
  });

  it('a declaration read from another class is not known to be the receiver\'s', async () => {
    // fmtlib/fmt's scan.h: `auto data = scan_data<T...>()` deduces nothing
    // the reader can see, and the `data` it then finds is another class's
    // `const scan_arg* data;`.
    const cg = await indexed({
      'test/scan.h': [
        'namespace fmt {',
        'class basic_scan_arg {',
        ' public:',
        '  int type() const { return 0; }',
        '};',
        'using scan_arg = basic_scan_arg;',
        'class scan_args {',
        '  const scan_arg* data;',
        '};',
        'template <typename... T> class scan_data {',
        ' public:',
        '  int make_args() { return 0; }',
        '};',
        'template <typename... T> int scan() {',
        '  auto data = scan_data<T...>();',
        '  return data.make_args();',
        '}',
        '}  // namespace fmt',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'fmt::scan')).toEqual(['fmt::scan_data::make_args (test/scan.h)']);
    } finally {
      cg.close();
    }
  });
});

describe('cppTypeSegments', () => {
  it('reads a written type as its `::` segments, without qualifiers or template arguments', () => {
    expect(cppTypeSegments('SkipList<const char*, KeyComparator>')).toEqual(['SkipList']);
    expect(cppTypeSegments('const ::leveldb::SkipList<Key, Cmp<int>>::Iterator&')).toEqual(['leveldb', 'SkipList', 'Iterator']);
    expect(cppTypeSegments('typename Base<T>::Iter')).toEqual(['Base', 'Iter']);
    expect(cppTypeSegments('struct Node*')).toEqual(['Node']);
    expect(cppTypeSegments('unsigned int')).toBeNull();
    expect(cppTypeSegments('void (*)(int)')).toBeNull();
  });
});
