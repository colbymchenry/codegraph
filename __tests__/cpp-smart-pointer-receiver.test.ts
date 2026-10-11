/**
 * A C++ `->` call on a receiver declared as a standard smart pointer or
 * optional — `std::unique_ptr<Iterator> iter; iter->Valid()` — calls a member
 * of the type it holds.
 *
 * facebook/rocksdb has about 14,000 of these calls on a declaration in the
 * calling function or its class. Receiver inference read the declared type as
 * `unique_ptr`, which has no project methods, so the call fell through to a
 * guess by the method's name and the receiver's words: `iter->Valid()` went
 * to `ArenaWrappedDBIter::Valid`, `db_copy->Get()` to a test's `Get`.
 *
 * The held type is looked up as C++ looks a name up where the call is
 * written — the scopes around the call, the file's `using`s, aliases
 * followed — and the method is taken from that class or the classes it
 * derives from. Its last name alone is not enough: rocksdb's `Iterator` is
 * also the name of `MemTableRep::Iterator` and other nested classes, while the
 * `Iterator` the call means inherits `Valid` from `IteratorBase`. A template
 * parameter, a library type and an alias of a type outside the project hold
 * no project class, so those calls get no edge; neither does a call the held
 * class has no method for (unless a class template's specialization may
 * declare it). A held type the project doesn't declare — a generated message
 * — leaves the call as it was.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-held-'));
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

/** `calls` callees of a function or method, as `qualifiedName`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** rocksdb's iterator family, trimmed: the public Iterator, a nested namesake, and an implementation a guess reaches. */
const ROCKSDB = {
  'include/rocksdb/iterator_base.h': lines(
    'namespace rocksdb {',
    'class IteratorBase {',
    ' public:',
    '  virtual ~IteratorBase() {}',
    '  virtual bool Valid() const = 0;',
    '  virtual void Next() = 0;',
    '};',
    '}  // namespace rocksdb',
  ),
  'include/rocksdb/iterator.h': lines(
    '#include "include/rocksdb/iterator_base.h"',
    'namespace rocksdb {',
    'class Iterator : public IteratorBase {',
    ' public:',
    '  virtual int value() const = 0;',
    '};',
    '}  // namespace rocksdb',
  ),
  'include/rocksdb/memtablerep.h': lines(
    'namespace rocksdb {',
    'class MemTableRep {',
    ' public:',
    '  class Iterator {',
    '   public:',
    '    virtual bool Valid() const = 0;',
    '    virtual void Next() = 0;',
    '  };',
    '};',
    '}  // namespace rocksdb',
  ),
  'db/arena_wrapped_db_iter.h': lines(
    '#include "include/rocksdb/iterator.h"',
    'namespace rocksdb {',
    'class ArenaWrappedDBIter : public Iterator {',
    ' public:',
    '  bool Valid() const override { return true; }',
    '  void Next() override {}',
    '  int value() const override { return 0; }',
    '};',
    '}  // namespace rocksdb',
  ),
  'include/rocksdb/db.h': lines(
    '#include "include/rocksdb/iterator.h"',
    'namespace rocksdb {',
    'class DB {',
    ' public:',
    '  virtual int Get(int key) = 0;',
    '  virtual Iterator* NewIterator() = 0;',
    '};',
    'class DBGetBatch {',
    ' public:',
    '  int Get(int key) { return key; }',
    '};',
    '}  // namespace rocksdb',
  ),
};

describe('a `->` call on a standard smart pointer or optional reaches the type it holds', () => {
  it('reproduction: `std::unique_ptr<Iterator> iter; iter->Valid()` is the Iterator the scope sees, not a namesake', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_impl.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/db.h"',
        '#include "db/arena_wrapped_db_iter.h"',
        'namespace rocksdb {',
        'int CountKeys(DB* db) {',
        '  std::unique_ptr<Iterator> iter(db->NewIterator());',
        '  int n = 0;',
        '  for (; iter->Valid(); iter->Next()) n += iter->value();',
        '  return n;',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // `Valid` and `Next` are IteratorBase's, which Iterator derives from.
      expect(calls(cg, 'rocksdb::CountKeys')).toEqual([
        'rocksdb::DB::NewIterator',
        'rocksdb::Iterator::value',
        'rocksdb::IteratorBase::Next',
        'rocksdb::IteratorBase::Valid',
      ]);
    } finally {
      cg.close();
    }
  });

  it('`std::shared_ptr`, `std::optional`, a parameter, and a member the class declares in its header', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      // Classes the receivers' names point a guess at.
      'table/table_db.h': lines(
        'namespace rocksdb {',
        'class TableDB {',
        ' public:',
        '  int Get(int key) { return key; }',
        '};',
        'class CuckooTableDB {',
        ' public:',
        '  int Get(int key) { return key; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_impl.h': lines(
        '#include <memory>',
        '#include "include/rocksdb/db.h"',
        'namespace rocksdb {',
        'class DBImpl {',
        ' public:',
        '  int Lookup(int key);',
        ' private:',
        '  std::shared_ptr<DB> table_db_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_impl.cc': lines(
        '#include <optional>',
        '#include "db/db_impl.h"',
        '#include "table/table_db.h"',
        'namespace rocksdb {',
        'int DBImpl::Lookup(int key) {',
        '  return table_db_->Get(key);',
        '}',
        'int Probe(const std::shared_ptr<DB>& cuckoo_db) {',
        '  std::optional<DBGetBatch> batch;',
        '  return cuckoo_db->Get(1) + batch->Get(2);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::DBImpl::Lookup')).toEqual(['rocksdb::DB::Get']);
      expect(calls(cg, 'rocksdb::Probe')).toEqual(['rocksdb::DB::Get', 'rocksdb::DBGetBatch::Get']);
    } finally {
      cg.close();
    }
  });

  it('a nested class is found first from inside the class that declares it', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'memtable/skiplistrep.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/iterator.h"',
        '#include "include/rocksdb/memtablerep.h"',
        'namespace rocksdb {',
        'class SkipListRep : public MemTableRep {',
        ' public:',
        '  bool Check();',
        ' private:',
        '  std::unique_ptr<Iterator> iter_;',
        '};',
        'bool SkipListRep::Check() { return iter_->Valid(); }',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // MemTableRep's own `Iterator`, which SkipListRep inherits, hides rocksdb::Iterator.
      expect(calls(cg, 'rocksdb::SkipListRep::Check')).toEqual(['rocksdb::MemTableRep::Iterator::Valid']);
    } finally {
      cg.close();
    }
  });

  it('a held type named through an alias, a `using namespace`, and a class local to the function', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'table/internal_iterator.h': lines(
        'namespace rocksdb {',
        'template <class TValue>',
        'class InternalIteratorBase {',
        ' public:',
        '  virtual void SeekToFirst() = 0;',
        '};',
        'using InternalIterator = InternalIteratorBase<int>;',
        'class MergingIterator : public InternalIterator {',
        ' public:',
        '  void SeekToFirst() override {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'table/scan.cc': lines(
        '#include <memory>',
        '#include "table/internal_iterator.h"',
        'namespace rocksdb {',
        'void ScanTable(InternalIterator* raw) {',
        '  std::unique_ptr<InternalIterator> it(raw);',
        '  it->SeekToFirst();',
        '}',
        'class EventListener {',
        ' public:',
        '  void OnFlushCompleted() {}',
        '};',
        'void Notify() {',
        '  class FlushListener {',
        '   public:',
        '    void OnFlushCompleted() {}',
        '  };',
        '  std::shared_ptr<FlushListener> listener;',
        '  listener->OnFlushCompleted();',
        '}',
        '}  // namespace rocksdb',
      ),
      'tools/dump.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/db.h"',
        '#include "include/rocksdb/memtablerep.h"',
        'using namespace rocksdb;',
        'int Dump(DB* db) {',
        '  std::unique_ptr<Iterator> it(db->NewIterator());',
        '  return it->Valid() ? 1 : 0;',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::ScanTable')).toEqual(['rocksdb::InternalIteratorBase::SeekToFirst']);
      expect(calls(cg, 'rocksdb::Notify')).toEqual(['rocksdb::Notify::FlushListener::OnFlushCompleted']);
      expect(calls(cg, 'Dump')).toEqual(['rocksdb::DB::NewIterator', 'rocksdb::IteratorBase::Valid']);
    } finally {
      cg.close();
    }
  });
});

describe('a held type that is no class of the project\'s gets no guess', () => {
  it('a template parameter, a library type, and an alias of one', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'table/block.h': lines(
        'namespace rocksdb {',
        'class Block {',
        ' public:',
        '  unsigned size() const { return 0; }',
        '  int front() const { return 0; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db_stress_tool/stress.cc': lines(
        '#include <deque>',
        '#include <memory>',
        '#include <vector>',
        '#include "db/arena_wrapped_db_iter.h"',
        '#include "table/block.h"',
        'namespace rocksdb {',
        'template <class IterType>',
        'void TestIterate(IterType* raw) {',
        '  std::unique_ptr<IterType> iter(raw);',
        '  iter->Next();',
        '}',
        'using BlockList = std::vector<int>;',
        'class BlockBasedTableIterator {',
        ' public:',
        '  int First();',
        ' private:',
        '  std::unique_ptr<std::deque<int>> block_handles_;',
        '  std::shared_ptr<BlockList> block_list_;',
        '};',
        'int BlockBasedTableIterator::First() {',
        '  return block_handles_->front() + static_cast<int>(block_list_->size());',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // Not ArenaWrappedDBIter::Next, Block::front or Block::size.
      expect(calls(cg, 'rocksdb::TestIterate')).toEqual([]);
      expect(calls(cg, 'rocksdb::BlockBasedTableIterator::First')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a class that has no such method, nor does any class it derives from', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/compaction.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/db.h"',
        '#include "db/arena_wrapped_db_iter.h"',
        'namespace rocksdb {',
        'class CompactionIterator {',
        ' public:',
        '  void Release() {}',
        '};',
        'void Compact(DB* raw) {',
        '  std::unique_ptr<DB> db(raw);',
        '  db->Release();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Compact')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('what keeps the call as it was', () => {
  it('a type the project does not declare, such as a generated message, and a class template\'s specialization', async () => {
    // protocolbuffers/protobuf's tests hold generated messages, which derive
    // from Message; facebook/rocksdb's order-maintenance tree has members only
    // a specialization declares.
    const cg = await indexed({
      'src/google/protobuf/message.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class Message {',
        ' public:',
        '  unsigned SpaceUsedLong() const { return 0; }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/extension_set_unittest.cc': lines(
        '#include <memory>',
        '#include "src/google/protobuf/message.h"',
        'namespace google {',
        'namespace protobuf {',
        'unsigned SpaceUsed() {',
        '  std::unique_ptr<unittest::TestAllExtensions> message;',
        '  return message->SpaceUsedLong();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'util/omt.h': lines(
        '#include <memory>',
        'namespace toku {',
        'template <typename omtdata_t, bool marks>',
        'class omt_node {',
        ' public:',
        '  void clear_stolen_bits() {}',
        '};',
        'template <typename omtdata_t>',
        'class omt_node<omtdata_t, true> {',
        ' public:',
        '  bool get_marked() const { return false; }',
        '};',
        'bool HasMarks() {',
        '  std::unique_ptr<omt_node<int, true>> node;',
        '  return node->get_marked();',
        '}',
        '}  // namespace toku',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::SpaceUsed')).toEqual(['google::protobuf::Message::SpaceUsedLong']);
      expect(cg.getCallees(callable(cg, 'toku::HasMarks').id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.name)).toEqual(['get_marked']);
    } finally {
      cg.close();
    }
  });

  it('`->` through a raw pointer to a smart pointer is the smart pointer\'s own member', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'cache/cache.h': lines(
        'namespace rocksdb {',
        'class Cache {',
        ' public:',
        '  void reset() {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/version_set.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/iterator.h"',
        '#include "cache/cache.h"',
        'namespace rocksdb {',
        'void Drop(std::unique_ptr<Iterator>* iter_cache) {',
        '  iter_cache->reset();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Drop')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
