/**
 * A C++ range-based for over `auto` elements has the element type of the
 * range it iterates.
 *
 * #2439 read the type a loop declares, `for (ConformanceTestSuite *suite :
 * suites)`. A loop over `auto` elements declares none, so the scan went on
 * as for an `auto` local whose initializer it can't read: it reached an
 * earlier declaration of the same name, often another variable's, or the
 * call fell through to a guess by the receiver's name. In facebook/rocksdb,
 * `for (auto cfd : cfds)` iterates a `const autovector<ColumnFamilyData*>&`
 * parameter. The element type is read from the range where that can be done
 * reliably:
 *  - a name the calling function declares, or a data member of its class:
 *    a container's first template argument, aliases followed with their
 *    template arguments;
 *  - a call whose declaration writes its return type, `*x`, `x.m`, `x->m`;
 *  - one of the project's classes, through what its `begin()` returns:
 *    rocksdb's `ColumnFamilySet`, whose iterator's `operator*` returns a
 *    `ColumnFamilyData*`.
 * A guess can still land on the right method by a shared word, so these tests
 * check the typed path's confidence, not only the target.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-auto-range-for-'));
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

/**
 * facebook/rocksdb's column families, trimmed. `ColumnFamilyHandle` has
 * methods of the same names; `DBImpl` is declared in db_impl.h and its
 * methods are defined in db_impl_write.cc, so the scan's same-stem header
 * never reads `versions_`.
 */
const ROCKSDB = {
  'util/autovector.h': lines(
    '#include <cstddef>',
    'namespace rocksdb {',
    'template <class T, size_t kSize = 8>',
    'class autovector {',
    ' public:',
    '  size_t size() const { return 0; }',
    '  bool empty() const { return true; }',
    '};',
    '}  // namespace rocksdb',
  ),
  'db/column_family.h': lines(
    '#include <cstdint>',
    'namespace rocksdb {',
    'class ColumnFamilyData {',
    ' public:',
    '  bool IsDropped() const;',
    '  void Ref();',
    '  uint32_t GetID() const;',
    '};',
    'class ColumnFamilySet {',
    ' public:',
    '  class iterator {',
    '   public:',
    '    explicit iterator(ColumnFamilyData* cfd) : current_(cfd) {}',
    '    iterator& operator++() { current_ = nullptr; return *this; }',
    '    bool operator!=(const iterator& other) const { return current_ != other.current_; }',
    '    ColumnFamilyData* operator*() { return current_; }',
    '   private:',
    '    ColumnFamilyData* current_;',
    '  };',
    '  iterator begin() { return iterator(head_); }',
    '  iterator end() { return iterator(nullptr); }',
    ' private:',
    '  ColumnFamilyData* head_ = nullptr;',
    '};',
    'class ColumnFamilyHandle {',
    ' public:',
    '  bool IsDropped() const;',
    '  void Ref();',
    '  uint32_t GetID() const;',
    '};',
    '}  // namespace rocksdb',
  ),
  'db/column_family.cc': lines(
    '#include "db/column_family.h"',
    'namespace rocksdb {',
    'bool ColumnFamilyData::IsDropped() const { return false; }',
    'void ColumnFamilyData::Ref() {}',
    'uint32_t ColumnFamilyData::GetID() const { return 0; }',
    'bool ColumnFamilyHandle::IsDropped() const { return false; }',
    'void ColumnFamilyHandle::Ref() {}',
    'uint32_t ColumnFamilyHandle::GetID() const { return 0; }',
    '}  // namespace rocksdb',
  ),
  'db/version_set.h': lines(
    '#include <memory>',
    '#include "db/column_family.h"',
    'namespace rocksdb {',
    'class VersionSet {',
    ' public:',
    '  ColumnFamilySet* GetColumnFamilySet() { return column_family_set_.get(); }',
    ' private:',
    '  std::unique_ptr<ColumnFamilySet> column_family_set_;',
    '};',
    '}  // namespace rocksdb',
  ),
  'db/db_impl.h': lines(
    '#include <memory>',
    '#include "util/autovector.h"',
    '#include "db/version_set.h"',
    'namespace rocksdb {',
    'class DBImpl {',
    ' public:',
    '  void AssignAtomicFlushSeq(const autovector<ColumnFamilyData*>& cfds);',
    '  void ScheduleFlushes();',
    ' private:',
    '  std::unique_ptr<VersionSet> versions_;',
    '};',
    '}  // namespace rocksdb',
  ),
  'db/db_impl_write.cc': lines(
    '#include "db/db_impl.h"',
    'namespace rocksdb {',
    'void UseHandle(ColumnFamilyHandle* cfd) {',
    '  cfd->Ref();',
    '}',
    'void DBImpl::AssignAtomicFlushSeq(const autovector<ColumnFamilyData*>& cfds) {',
    '  for (auto cfd : cfds) {',
    '    cfd->GetID();',
    '  }',
    '}',
    'void DBImpl::ScheduleFlushes() {',
    '  for (auto cfd : *versions_->GetColumnFamilySet()) {',
    '    if (!cfd->IsDropped()) cfd->Ref();',
    '  }',
    '}',
    '}  // namespace rocksdb',
  ),
};

/** protocolbuffers/protobuf's descriptors, trimmed; `upb` has a `FieldDefPtr` with the same accessors. */
const PROTOBUF = {
  'src/google/protobuf/descriptor.h': lines(
    '#include <string>',
    'namespace google {',
    'namespace protobuf {',
    'class FieldDescriptor {',
    ' public:',
    '  int number() const;',
    '  const std::string& full_name() const;',
    '};',
    'class Descriptor {',
    ' public:',
    '  int field_count() const;',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  'src/google/protobuf/descriptor.cc': lines(
    '#include "google/protobuf/descriptor.h"',
    'namespace google {',
    'namespace protobuf {',
    'int FieldDescriptor::number() const { return 0; }',
    'const std::string& FieldDescriptor::full_name() const { static std::string s; return s; }',
    'int Descriptor::field_count() const { return 0; }',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  'upb/reflection/def.hpp': lines(
    'namespace upb {',
    'class FieldDefPtr {',
    ' public:',
    '  int number() const { return 0; }',
    '  const char* full_name() const { return ""; }',
    '};',
    '}  // namespace upb',
  ),
  'src/google/protobuf/compiler/cpp/field_layout.h': lines(
    '#include <vector>',
    '#include "absl/types/span.h"',
    '#include "google/protobuf/descriptor.h"',
    'namespace google {',
    'namespace protobuf {',
    'namespace compiler {',
    'namespace cpp {',
    'std::vector<const FieldDescriptor*> FieldNumberOrder(const Descriptor* descriptor);',
    'class FieldLayout {',
    ' public:',
    '  absl::Span<const FieldDescriptor* const absl_nonnull> optimized_order() const { return {}; }',
    '};',
    '}  // namespace cpp',
    '}  // namespace compiler',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  'src/google/protobuf/compiler/cpp/message.cc': lines(
    '#include "google/protobuf/compiler/cpp/field_layout.h"',
    'namespace google {',
    'namespace protobuf {',
    'namespace compiler {',
    'namespace cpp {',
    'std::vector<const FieldDescriptor*> FieldNumberOrder(const Descriptor* descriptor) {',
    '  return {};',
    '}',
    'int Numbers(const Descriptor* descriptor) {',
    '  int sum = 0;',
    '  for (const auto* field : FieldNumberOrder(descriptor)) {',
    '    sum += field->number();',
    '  }',
    '  return sum;',
    '}',
    'void Names(const FieldLayout& layout) {',
    '  for (const auto* field : layout.optimized_order()) {',
    '    field->full_name();',
    '  }',
    '}',
    '}  // namespace cpp',
    '}  // namespace compiler',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
};

describe('an `auto` range-for variable has the element type of its range', () => {
  it('reproduction: rocksdb\'s `for (auto cfd : cfds)` over an autovector parameter', async () => {
    const cg = await indexed(ROCKSDB);
    try {
      // The scan went past the loop to UseHandle's `ColumnFamilyHandle* cfd`.
      expect(calls(cg, 'rocksdb::DBImpl::AssignAtomicFlushSeq')).toEqual(['rocksdb::ColumnFamilyData::GetID @0.9']);
      expect(calls(cg, 'rocksdb::UseHandle')).toEqual(['rocksdb::ColumnFamilyHandle::Ref @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a project class iterated through its begin(), reached from a member another header declares', async () => {
    const cg = await indexed(ROCKSDB);
    try {
      // `versions_` is DBImpl's `std::unique_ptr<VersionSet>`; GetColumnFamilySet()
      // returns a `ColumnFamilySet*`, whose iterator's `operator*` returns a
      // `ColumnFamilyData*`. (The range's own call is left out here: no
      // receiver scan reads db_impl.h from db_impl_write.cc.)
      expect(calls(cg, 'rocksdb::DBImpl::ScheduleFlushes').filter((c) => !c.startsWith('rocksdb::VersionSet::'))).toEqual([
        'rocksdb::ColumnFamilyData::IsDropped @0.9',
        'rocksdb::ColumnFamilyData::Ref @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a call whose declaration writes its return type, and a nullability annotation in an element', async () => {
    const cg = await indexed(PROTOBUF);
    try {
      expect(calls(cg, 'google::protobuf::compiler::cpp::Numbers')).toEqual([
        'google::protobuf::FieldDescriptor::number @0.9',
        'google::protobuf::compiler::cpp::FieldNumberOrder @0.9',
      ]);
      expect(calls(cg, 'google::protobuf::compiler::cpp::Names')).toEqual([
        'google::protobuf::FieldDescriptor::full_name @0.9',
        'google::protobuf::compiler::cpp::FieldLayout::optimized_order @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('an `auto` local\'s initializer, an alias with template arguments, and a smart pointer element', async () => {
    const cg = await indexed({
      'db/blob_file_meta.h': lines(
        '#include <cstdint>',
        'namespace rocksdb {',
        'class BlobFileMetaData {',
        ' public:',
        '  uint64_t GetBlobFileNumber() const { return 0; }',
        '};',
        'class BlobFileAddition {',
        ' public:',
        '  uint64_t GetBlobFileNumber() const { return 0; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/version_storage.h': lines(
        '#include <memory>',
        '#include <vector>',
        '#include "db/blob_file_meta.h"',
        'namespace rocksdb {',
        'class VersionStorageInfo {',
        ' public:',
        '  using BlobFiles = std::vector<std::shared_ptr<BlobFileMetaData>>;',
        '  const BlobFiles& GetBlobFiles() const { return blob_files_; }',
        ' private:',
        '  BlobFiles blob_files_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_filesnapshot.cc': lines(
        '#include "db/version_storage.h"',
        'namespace rocksdb {',
        'uint64_t Largest(const VersionStorageInfo* vstorage) {',
        '  uint64_t largest = 0;',
        '  const auto& blob_files = vstorage->GetBlobFiles();',
        '  for (const auto& meta : blob_files) {',
        '    largest = meta->GetBlobFileNumber();',
        '  }',
        '  return largest;',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // `->` on the `std::shared_ptr<BlobFileMetaData>` element reaches the type it holds.
      expect(calls(cg, 'rocksdb::Largest')).toEqual([
        'rocksdb::BlobFileMetaData::GetBlobFileNumber @0.9',
        'rocksdb::VersionStorageInfo::GetBlobFiles @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a data member of another object, and loops inside loops', async () => {
    const cg = await indexed({
      'db/compaction/subcompaction_state.h': lines(
        'namespace rocksdb {',
        'class Output {',
        ' public:',
        '  void Finish() {}',
        '};',
        'class SubcompactionState {',
        ' public:',
        '  void RemoveLastEmptyOutput() {}',
        '  Output outputs[2];',
        '};',
        'class FlushJob {',
        ' public:',
        '  void RemoveLastEmptyOutput() {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction/compaction_state.h': lines(
        '#include <vector>',
        '#include "db/compaction/subcompaction_state.h"',
        'namespace rocksdb {',
        'class CompactionState {',
        ' public:',
        '  std::vector<SubcompactionState> sub_compact_states;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction/compaction_job.h': lines(
        '#include "db/compaction/compaction_state.h"',
        'namespace rocksdb {',
        'class CompactionJob {',
        ' public:',
        '  void RemoveEmptyOutputs();',
        ' private:',
        '  CompactionState* compact_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction/compaction_job.cc': lines(
        '#include "db/compaction/compaction_job.h"',
        'namespace rocksdb {',
        'void CompactionJob::RemoveEmptyOutputs() {',
        '  for (auto& state : compact_->sub_compact_states) {',
        '    state.RemoveLastEmptyOutput();',
        '  }',
        '}',
        'void Finish(const std::vector<CompactionState*>& compactions) {',
        '  for (const auto* compaction : compactions) {',
        '    for (auto& state : compaction->sub_compact_states) {',
        '      state.RemoveLastEmptyOutput();',
        '    }',
        '  }',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::CompactionJob::RemoveEmptyOutputs')).toEqual(['rocksdb::SubcompactionState::RemoveLastEmptyOutput @0.9']);
      expect(calls(cg, 'rocksdb::Finish')).toEqual(['rocksdb::SubcompactionState::RemoveLastEmptyOutput @0.9']);
    } finally {
      cg.close();
    }
  });
});

describe('what an `auto` element calls when it is not the project\'s', () => {
  const SLICE = {
    'util/slice.h': lines(
      '#include <cstddef>',
      'namespace rocksdb {',
      'class Slice {',
      ' public:',
      '  size_t size() const { return 0; }',
      '  const char* c_str() const { return ""; }',
      '};',
      'class TableReader {',
      ' public:',
      '  bool Valid() const { return true; }',
      '  void reset() {}',
      '};',
      'class TruncatedRangeDelIterator {',
      ' public:',
      '  bool Valid() const { return true; }',
      '};',
      '}  // namespace rocksdb',
    ),
  };

  it('a standard-library element\'s own member links to nothing', async () => {
    const cg = await indexed({
      ...SLICE,
      'db/names.cc': lines(
        '#include <string>',
        '#include <thread>',
        '#include <vector>',
        '#include "util/slice.h"',
        'namespace rocksdb {',
        'size_t Total(const std::vector<std::string>& files) {',
        '  size_t total = 0;',
        '  for (const auto& file : files) {',
        '    total += file.size();',
        '  }',
        '  return total;',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // The guess took `Slice::size` by the method's name.
      expect(calls(cg, 'rocksdb::Total')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a smart pointer element: `->` reaches the type it holds, `.` the holder\'s own member', async () => {
    const cg = await indexed({
      ...SLICE,
      'db/range_del_aggregator.h': lines(
        '#include <memory>',
        '#include <vector>',
        '#include "util/slice.h"',
        'namespace rocksdb {',
        'class RangeDelAggregator {',
        ' public:',
        '  bool IsRangeOverlapped();',
        '  void Reset();',
        ' private:',
        '  std::vector<std::unique_ptr<TruncatedRangeDelIterator>> iters_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/range_del_aggregator.cc': lines(
        '#include "db/range_del_aggregator.h"',
        'namespace rocksdb {',
        'bool RangeDelAggregator::IsRangeOverlapped() {',
        '  for (auto& iter : iters_) {',
        '    if (iter->Valid()) return true;',
        '  }',
        '  return false;',
        '}',
        'void RangeDelAggregator::Reset() {',
        '  for (auto& iter : iters_) iter.reset();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::RangeDelAggregator::IsRangeOverlapped')).toEqual(['rocksdb::TruncatedRangeDelIterator::Valid @0.9']);
      // `std::unique_ptr::reset`, not TableReader's.
      expect(calls(cg, 'rocksdb::RangeDelAggregator::Reset')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('an element a template argument decides is not read', async () => {
    const cg = await indexed({
      ...SLICE,
      'db/each.h': lines(
        '#include <vector>',
        '#include "util/slice.h"',
        'namespace rocksdb {',
        'template <class T>',
        'bool AllValid(const std::vector<T*>& items) {',
        '  for (auto* item : items) {',
        '    if (!item->Valid()) return false;',
        '  }',
        '  return true;',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // T is whatever the caller iterates: no typed edge, as before.
      expect(calls(cg, 'rocksdb::AllValid').filter((c) => c.endsWith('@0.9'))).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
