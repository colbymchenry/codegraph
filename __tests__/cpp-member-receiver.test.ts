/**
 * A C++ call on a data member of the calling method's class reaches the
 * method of the member's type, wherever the class is declared.
 *
 * Receiver inference reads back through the call's file, then the header of
 * the same name (`foo.cc` → `foo.h`). In facebook/rocksdb, `DBImpl` is
 * declared in db_impl.h and its methods are defined in db_impl_write.cc,
 * db_impl_compaction_flush.cc, db_impl_open.cc and more, so `versions_`,
 * `mutex_` and the rest were never read there: their calls were guessed by
 * the receiver's name. Neither was a member declared below an inline method
 * that uses it, or one a base class declares. A gtest `TEST_F(Fixture, …)`
 * body is a method of a class derived from `Fixture`, so `db_` there is the
 * fixture's member.
 *
 * C++ looks a name up in the function first, then in its class and the
 * classes it derives from: a parameter or local of the name, or one the scan
 * can't read, still decides. A guess can land on the right method by a shared
 * word, so these tests check the confidence, not only the target.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-member-'));
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

/** `calls` callees of a function or method, as `qualifiedName @confidence`, one per call site. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** rocksdb's DBImpl, trimmed: declared in db_impl.h, its methods defined in other files. */
const ROCKSDB = {
  'db/version_set.h': lines(
    'namespace rocksdb {',
    'class ColumnFamilySet {',
    ' public:',
    '  int NumberOfColumnFamilies() const { return 0; }',
    '};',
    'class VersionSet {',
    ' public:',
    '  ColumnFamilySet* GetColumnFamilySet() { return nullptr; }',
    '  void SetLastSequence(int s) {}',
    '};',
    'class ColumnFamilyHandleImpl {',
    ' public:',
    '  ColumnFamilySet* GetColumnFamilySet() { return nullptr; }',
    '  void SetLastSequence(int s) {}',
    '};',
    'class Statistics {',
    ' public:',
    '  bool load() const { return false; }',
    '};',
    '}  // namespace rocksdb',
  ),
  'monitoring/instrumented_mutex.h': lines(
    'namespace rocksdb {',
    'class InstrumentedMutex {',
    ' public:',
    '  void Lock() {}',
    '  void Unlock() {}',
    '};',
    'namespace port {',
    'class Mutex {',
    ' public:',
    '  void Lock() {}',
    '  void Unlock() {}',
    '};',
    '}  // namespace port',
    '}  // namespace rocksdb',
  ),
  'db/db_impl/db_impl.h': lines(
    '#include <atomic>',
    '#include <memory>',
    '#include "db/version_set.h"',
    '#include "monitoring/instrumented_mutex.h"',
    'namespace rocksdb {',
    'class DBImpl {',
    ' public:',
    '  void WriteImpl();',
    '  void FlushMemTable();',
    ' protected:',
    '  std::unique_ptr<VersionSet> versions_;',
    '  InstrumentedMutex mutex_;',
    '  std::atomic<bool> shutting_down_;',
    '};',
    '}  // namespace rocksdb',
  ),
};

describe('a data member of the calling method’s class', () => {
  it('reproduction: one the class declares in another header', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_impl/db_impl_write.cc': lines(
        '#include "db/db_impl/db_impl.h"',
        'namespace rocksdb {',
        '// Another function\'s local of the name, which the method does not see.',
        'void UnlockStale(port::Mutex* mutex_) { mutex_->Unlock(); }',
        'void DBImpl::WriteImpl() {',
        '  mutex_.Lock();',
        '  versions_->SetLastSequence(1);',
        '  versions_->GetColumnFamilySet()->NumberOfColumnFamilies();',
        '  if (shutting_down_.load()) return;',
        '  mutex_.Unlock();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // A `std::atomic<bool>` member calls no method of the project's.
      expect(calls(cg, 'rocksdb::DBImpl::WriteImpl')).toEqual([
        'rocksdb::ColumnFamilySet::NumberOfColumnFamilies @0.85',
        'rocksdb::InstrumentedMutex::Lock @0.9',
        'rocksdb::InstrumentedMutex::Unlock @0.9',
        'rocksdb::VersionSet::GetColumnFamilySet @0.9',
        'rocksdb::VersionSet::SetLastSequence @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('one declared below the inline method that uses it, and one a base class declares', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/memtable_list.h': lines(
        'namespace rocksdb {',
        'class MemTableListVersion {',
        ' public:',
        '  int NumNotFlushed() const { return 0; }',
        '};',
        'class MemTable {',
        ' public:',
        '  int NumNotFlushed() const { return 1; }',
        '};',
        'class MemTableList {',
        ' public:',
        '  bool IsFlushPending() const { return current_->NumNotFlushed() > 0; }',
        '  // A line that starts with a dereference is code, not a comment.',
        '  int Pick(const int* first) const {',
        '    return Choose(0,',
        '                  *first);',
        '  }',
        ' private:',
        '  int Choose(int a, int b) const { return a + b; }',
        '  /*',
        '  MemTable* current_;',
        '  */',
        '  MemTableListVersion* current_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_impl/db_impl_secondary.h': lines(
        '#include "db/db_impl/db_impl.h"',
        'namespace rocksdb {',
        'class DBImplSecondary : public DBImpl {',
        ' public:',
        '  void TryCatchUpWithPrimary();',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_impl/db_impl_secondary.cc': lines(
        '#include "db/db_impl/db_impl_secondary.h"',
        'namespace rocksdb {',
        'void DBImplSecondary::TryCatchUpWithPrimary() {',
        '  versions_->SetLastSequence(2);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MemTableList::IsFlushPending')).toEqual(['rocksdb::MemTableListVersion::NumNotFlushed @0.9']);
      expect(calls(cg, 'rocksdb::DBImplSecondary::TryCatchUpWithPrimary')).toEqual(['rocksdb::VersionSet::SetLastSequence @0.9']);
    } finally {
      cg.close();
    }
  });

  it("a gtest TEST_F body's fixture member", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': lines(
        'namespace rocksdb {',
        'class IteratorBase {',
        ' public:',
        '  virtual void SeekToFirst() = 0;',
        '};',
        'class Iterator : public IteratorBase {};',
        'class MemTableRep {',
        ' public:',
        '  class Iterator {',
        '   public:',
        '    virtual void SeekToFirst() = 0;',
        '  };',
        '};',
        'class DB {',
        ' public:',
        '  virtual Iterator* NewIterator() = 0;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_test_util.h': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'class DBTestBase {',
        ' protected:',
        '  DB* db_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_iterator_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        'class DBIteratorTest : public DBTestBase {};',
        'TEST_F(DBIteratorTest, IterSeekToFirst) {',
        '  auto iter = db_->NewIterator();',
        '  iter->SeekToFirst();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::TEST_F')).toEqual(['rocksdb::DB::NewIterator @0.9', 'rocksdb::IteratorBase::SeekToFirst @0.9']);
    } finally {
      cg.close();
    }
  });
});

describe('a data member of the class itself', () => {
  it('not one of a class nested in it, which its header declares first', async () => {
    // rocksdb's `MultiScan::MultiScanIterator` has a `scan_opts_` of its own.
    const cg = await indexed({
      'table/multi_scan.h': lines(
        'namespace rocksdb {',
        'class ScanOptions {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'class ScanRanges {',
        ' public:',
        '  int size() const { return 1; }',
        '};',
        'class MultiScan {',
        ' public:',
        '  class MultiScanIterator {',
        '   private:',
        '    ScanRanges* scan_opts_;',
        '  };',
        '  int Count() const;',
        ' private:',
        '  ScanOptions* scan_opts_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'table/multi_scan.cc': lines(
        '#include "table/multi_scan.h"',
        'namespace rocksdb {',
        'int MultiScan::Count() const { return scan_opts_->size(); }',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiScan::Count')).toEqual(['rocksdb::ScanOptions::size @0.9']);
    } finally {
      cg.close();
    }
  });
});

describe('which class declares the member', () => {
  it('the declaration in the caller’s own translation unit, of classes that share a name', async () => {
    // google/leveldb's memenv.cc and fault_injection_test.cc each declare a `FileState`.
    const cg = await indexed({
      'include/leveldb/slice.h': lines(
        'namespace leveldb {',
        'class Slice {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'class Block {',
        ' public:',
        '  int size() const { return 1; }',
        '};',
        '}  // namespace leveldb',
      ),
      'helpers/memenv/memenv.cc': lines(
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'class FileState {',
        ' public:',
        '  int Size() const;',
        ' private:',
        '  Slice* blocks_;',
        '};',
        'int FileState::Size() const { return blocks_->size(); }',
        '}  // namespace leveldb',
      ),
      'db/fault_injection_test.cc': lines(
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'class FileState {',
        ' public:',
        '  int Size() const;',
        ' private:',
        '  Block* blocks_;',
        '};',
        'int FileState::Size() const { return blocks_->size(); }',
        '}  // namespace leveldb',
      ),
    });
    try {
      const sizes = cg.getNodesByKind('method').filter((n) => n.qualifiedName === 'leveldb::FileState::Size');
      const byFile = Object.fromEntries(sizes.map((n) => [n.filePath, cg.getCallees(n.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName)]));
      expect(byFile).toEqual({
        'db/fault_injection_test.cc': ['leveldb::Block::size'],
        'helpers/memenv/memenv.cc': ['leveldb::Slice::size'],
      });
    } finally {
      cg.close();
    }
  });

  it('not a base that depends on the template’s parameters, where a bare name is not looked up', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'util/heap_test.cc': lines(
        '#include "db/db_impl/db_impl.h"',
        'namespace rocksdb {',
        'template <typename T>',
        'class Holder {',
        ' protected:',
        '  InstrumentedMutex mutex_;',
        '};',
        'port::Mutex mutex_;',
        'template <typename T>',
        'class Guard : public Holder<T> {',
        ' public:',
        '  void Enter() { mutex_.Lock(); }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // C++ finds the namespace's `mutex_` here: `this->mutex_` would name the base's.
      expect(calls(cg, 'rocksdb::Guard::Enter')).not.toContain('rocksdb::InstrumentedMutex::Lock @0.9');
    } finally {
      cg.close();
    }
  });
});

describe('what keeps the call as it was', () => {
  it('a local of the name that the scan cannot read', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_impl/db_impl_compaction_flush.cc': lines(
        '#include "db/db_impl/db_impl.h"',
        'namespace rocksdb {',
        'void DBImpl::FlushMemTable() {',
        '  auto mutex_ = GetFlushMutex();',
        '  mutex_->Lock();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // `mutex_` here is the local, not the member.
      expect(calls(cg, 'rocksdb::DBImpl::FlushMemTable').filter((c) => c.includes('Lock'))).not.toContain('rocksdb::InstrumentedMutex::Lock @0.9');
    } finally {
      cg.close();
    }
  });

  it('a parameter of a method the class declares, which is no member', async () => {
    // rocksdb's DB declares `CreateColumnFamilies(const std::vector<…>&
    // column_families, …)`. (The function declares no local of the names:
    // one the scan reads would decide first.)
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_impl/db_impl.h': ROCKSDB['db/db_impl/db_impl.h'].replace(
        '  void FlushMemTable();',
        '  void FlushMemTable();\n  void CreateColumnFamilies(std::vector<int>* column_families,\n                            int* handles);\n  int CountColumnFamilies();\n  ColumnFamilySet* stats() const;',
      ),
      'db/db_impl/db_impl_write.cc': lines(
        '#include "db/db_impl/db_impl.h"',
        'namespace rocksdb {',
        'int DBImpl::CountColumnFamilies() {',
        '  if (stats->load()) return 0;',
        '  return column_families->NumberOfColumnFamilies();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::DBImpl::CountColumnFamilies').filter((c) => c.includes('NumberOfColumnFamilies'))).toEqual([
        'rocksdb::ColumnFamilySet::NumberOfColumnFamilies @0.7',
      ]);
      // Nor is a method the class declares (`stats()`) a member of its name.
      expect(calls(cg, 'rocksdb::DBImpl::CountColumnFamilies').filter((c) => c.includes('load'))).toEqual(['rocksdb::Statistics::load @0.7']);
    } finally {
      cg.close();
    }
  });

  it("a member of a template parameter's type", async () => {
    // rocksdb's `ComparatorWithU64TsImpl<TComparator>` holds a `TComparator cmp_without_ts_`.
    const cg = await indexed({
      'util/comparator.cc': lines(
        'namespace rocksdb {',
        'class Comparator {',
        ' public:',
        '  int timestamp_size() const { return 0; }',
        '};',
        'template <typename TComparator>',
        'class ComparatorWithU64TsImpl {',
        ' public:',
        '  int Check() const { return cmp_without_ts_.timestamp_size(); }',
        ' private:',
        '  TComparator cmp_without_ts_;',
        '};',
        '// rocksdb\'s clock cache test reaches its shard through a dependent alias.',
        'class ClockCacheShard {',
        ' public:',
        '  void Insert(int key) {}',
        '};',
        'template <class ClockCache>',
        'class ClockCacheTest {',
        ' public:',
        '  using Shard = typename ClockCache::Shard;',
        '  void Insert(int key) { shard_->Insert(key); }',
        ' private:',
        '  Shard* shard_ = nullptr;',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::ComparatorWithU64TsImpl::Check')).toEqual(['rocksdb::Comparator::timestamp_size @0.7']);
      expect(calls(cg, 'rocksdb::ClockCacheTest::Insert')).toEqual(['rocksdb::ClockCacheShard::Insert @0.65']);
    } finally {
      cg.close();
    }
  });

  it('a member a base class template declares through an alias of its parameter', async () => {
    // protobuf's MapIteratorBase<kIsMutable> holds a `MapFieldBase* map_` through
    // `using MapFieldBase = std::conditional_t<kIsMutable, internal::MapFieldBase, …>`.
    const cg = await indexed({
      'src/google/protobuf/map_field.h': lines(
        '#include <type_traits>',
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'class MapFieldBase {',
        ' public:',
        '  void SetMapDirty() {}',
        '};',
        '}  // namespace internal',
        'template <bool kIsMutable>',
        'class MapIteratorBase {',
        ' protected:',
        '  using MapFieldBase = std::conditional_t<kIsMutable, internal::MapFieldBase, const internal::MapFieldBase>;',
        '  MapFieldBase* map_;',
        '};',
        'class MapIterator : public MapIteratorBase<true> {',
        ' public:',
        '  void MutableValueRef() { map_->SetMapDirty(); }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/map_field.cc': lines('#include "src/google/protobuf/map_field.h"'),
    });
    try {
      expect(calls(cg, 'google::protobuf::MapIterator::MutableValueRef')).toEqual(['google::protobuf::internal::MapFieldBase::SetMapDirty @0.9']);
    } finally {
      cg.close();
    }
  });
});
