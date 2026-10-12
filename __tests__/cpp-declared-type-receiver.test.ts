/**
 * A C++ call on a variable, parameter or member the calling function or its
 * class declares — `Iterator* iter; iter->Valid()`, `const Iterator& it;
 * it.Valid()` — calls a member of the class C++ name lookup finds for the
 * declared type where the call is written.
 *
 * Receiver typing used to look the method up by the type's last name, and
 * took any class of that name that declares it. facebook/rocksdb has 22
 * classes named `Iterator`; the `Iterator` the code means
 * (`ROCKSDB_NAMESPACE::Iterator`) inherits `Valid`, `Next` and `key` from
 * `IteratorBase`, so a nested namesake that declares them —
 * `MemTableRep::Iterator` — took about 1,100 calls. google/leveldb's
 * `Iterator*` calls went to `SkipList::Iterator` the same way.
 *
 * The type is now looked up as for a smart pointer's held type (#2440): from
 * the calling function's scopes outwards, then the file's `using`s, then the
 * global scope, with aliases followed. The method is the class's own, or
 * one a class it derives from declares. A class with no such method gets no
 * edge: protocolbuffers/protobuf's descriptor accessors aren't indexed, and
 * `field->full_name()` was guessed onto unrelated classes. When the lookup
 * can't place the type — a template parameter, a class only another source
 * file defines — or the declaration may be another variable's, the call
 * resolves as before.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-declared-'));
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

/** rocksdb's iterator family, trimmed: the public Iterator, which inherits its cursor methods, and a nested namesake that declares them. */
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
  'include/rocksdb/db.h': lines(
    '#include "include/rocksdb/iterator.h"',
    'namespace rocksdb {',
    'class DB {',
    ' public:',
    '  virtual Iterator* NewIterator() = 0;',
    '};',
    '}  // namespace rocksdb',
  ),
};

describe('a call on a receiver the caller declares reaches the class its type names', () => {
  it('reproduction: `Iterator* iter; iter->Valid()` is the Iterator the scope sees, not a nested namesake', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_impl.cc': lines(
        '#include "include/rocksdb/db.h"',
        '#include "include/rocksdb/memtablerep.h"',
        'namespace rocksdb {',
        'int CountKeys(DB* db) {',
        '  Iterator* iter = db->NewIterator();',
        '  int n = 0;',
        '  for (; iter->Valid(); iter->Next()) n += iter->value();',
        '  delete iter;',
        '  return n;',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // `Valid` and `Next` are IteratorBase's, which Iterator derives from; not MemTableRep::Iterator's.
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

  it('a reference parameter, a value, and a member the class declares in its header', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'util/bit_fields.h': lines(
        'namespace rocksdb {',
        'class BitFields {',
        ' public:',
        '  int Get() const { return 0; }',
        '};',
        'class ConcurrentTest {',
        ' public:',
        '  struct State {',
        '    int Get() const { return 1; }',
        '  };',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction_job.h': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'class CompactionJob {',
        ' public:',
        '  bool Advance();',
        ' private:',
        '  Iterator* input_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction_job.cc': lines(
        '#include "db/compaction_job.h"',
        '#include "include/rocksdb/memtablerep.h"',
        '#include "util/bit_fields.h"',
        'namespace rocksdb {',
        'struct State : public BitFields {};',
        'bool IsValid(const Iterator& it) {',
        '  return it.Valid();',
        '}',
        'int Slot() {',
        '  State state;',
        '  return state.Get();',
        '}',
        'bool CompactionJob::Advance() {',
        '  input_->Next();',
        '  return input_->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::IsValid')).toEqual(['rocksdb::IteratorBase::Valid']);
      // Not ConcurrentTest::State::Get, the one class named State that declares Get.
      expect(calls(cg, 'rocksdb::Slot')).toEqual(['rocksdb::BitFields::Get']);
      expect(calls(cg, 'rocksdb::CompactionJob::Advance')).toEqual(['rocksdb::IteratorBase::Next', 'rocksdb::IteratorBase::Valid']);
    } finally {
      cg.close();
    }
  });

  it('a nested class is found first from inside a class that inherits it', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'memtable/skiplistrep.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        '#include "include/rocksdb/memtablerep.h"',
        'namespace rocksdb {',
        'class SkipListRep : public MemTableRep {',
        ' public:',
        '  bool Check();',
        ' private:',
        '  Iterator* iter_;',
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

  it('a `using` in the namespace around the call comes before a global class of that name', async () => {
    // protocolbuffers/protobuf's upb generator writes `using
    // google::protobuf::Descriptor;` inside `namespace upb::generator`, and its
    // PHP extension declares a C struct `Descriptor` in a header.
    const cg = await indexed({
      'php/ext/google/protobuf/def.h': lines(
        'typedef struct Descriptor {',
        '  int index;',
        '} Descriptor;',
      ),
      'src/google/protobuf/descriptor.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class Descriptor {',
        ' public:',
        '  int FindFieldByNumber(int number) const { return number; }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'upb_generator/common/cpp_to_upb_def.cc': lines(
        '#include "src/google/protobuf/descriptor.h"',
        'namespace upb {',
        'namespace generator {',
        'using google::protobuf::Descriptor;',
        'int FindField(const Descriptor* message, int number) {',
        '  return message->FindFieldByNumber(number);',
        '}',
        '}  // namespace generator',
        '}  // namespace upb',
      ),
    });
    try {
      expect(calls(cg, 'upb::generator::FindField')).toEqual(['google::protobuf::Descriptor::FindFieldByNumber']);
    } finally {
      cg.close();
    }
  });
});

describe('a class with no such method gets no guess', () => {
  it('a method the class only inherits from a library type', async () => {
    // rocksdb's `MultiScanException& ex; ex.what()` reached the Java bindings' `KVException::what`.
    const cg = await indexed({
      'java/rocksjni/kv_helper.h': lines(
        'namespace rocksdb {',
        'class KVException {',
        ' public:',
        '  const char* what() const { return ""; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'include/rocksdb/multi_scan.h': lines(
        '#include <stdexcept>',
        'namespace rocksdb {',
        'class MultiScanException : public std::runtime_error {',
        ' public:',
        '  explicit MultiScanException(const char* message) : std::runtime_error(message) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'tools/db_bench_tool.cc': lines(
        '#include "include/rocksdb/multi_scan.h"',
        'namespace rocksdb {',
        'const char* Describe(const MultiScanException& ex) {',
        '  return ex.what();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Describe')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('what keeps the call as it was', () => {
  it('a template parameter, and a class another source file defines', async () => {
    // rocksdb's multi-CF iterator takes its heap type as a template parameter
    // named like the class it is used with; version_set.cc defines its file
    // pickers, then includes the header whose code uses them.
    const cg = await indexed({
      'util/heap.h': lines(
        'namespace rocksdb {',
        'class BinaryHeap {',
        ' public:',
        '  void push(int v) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/multi_cf_iterator_impl.h': lines(
        '#include "util/heap.h"',
        'namespace rocksdb {',
        'template <typename BinaryHeap>',
        'class MultiCfIteratorImpl {',
        ' public:',
        '  void Reset(BinaryHeap& heap) { heap.push(1); }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/version_set.cc': lines(
        'namespace rocksdb {',
        'class FilePicker {',
        ' public:',
        '  int GetNextFile() { return 0; }',
        '};',
        '}  // namespace rocksdb',
        '#include "db/version_set_sync_and_async.h"',
      ),
      'db/version_set_sync_and_async.h': lines(
        'namespace rocksdb {',
        'int NextFile() {',
        '  FilePicker fp;',
        '  return fp.GetNextFile();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiCfIteratorImpl::Reset')).toEqual(['rocksdb::BinaryHeap::push']);
      expect(calls(cg, 'rocksdb::NextFile')).toEqual(['rocksdb::FilePicker::GetNextFile']);
    } finally {
      cg.close();
    }
  });

  it('a class with a base the index does not link, which may declare the method', async () => {
    // protobuf's FlatAllocator derives from a `decltype(…)` that names FlatAllocatorImpl.
    const cg = await indexed({
      'src/google/protobuf/descriptor.cc': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'template <typename... T>',
        'class FlatAllocatorImpl {',
        ' public:',
        '  void PlanArray(int array_size) {}',
        '};',
        'template <typename... T>',
        'FlatAllocatorImpl<T...> ApplyTypeList(int);',
        'class FlatAllocator : public decltype(ApplyTypeList<char, int>(0)) {};',
        '}  // namespace internal',
        'void PlanAllocationSize(internal::FlatAllocator& alloc) {',
        '  alloc.PlanArray(1);',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::PlanAllocationSize')).toEqual(['google::protobuf::internal::FlatAllocatorImpl::PlanArray']);
    } finally {
      cg.close();
    }
  });

  it('a declaration read from outside the calling function and its class', async () => {
    // Reading back from the call reaches an earlier function's local of the
    // same name, not the global the call uses, so its type is no evidence.
    const cg = await indexed({
      ...ROCKSDB,
      'db/table_cursor.h': lines(
        '#include "include/rocksdb/memtablerep.h"',
        'namespace rocksdb {',
        'extern MemTableRep::Iterator* iter;',
        '}  // namespace rocksdb',
      ),
      'db/db_iter.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        '#include "db/table_cursor.h"',
        'namespace rocksdb {',
        'void Prepare() {',
        '  Iterator* iter = nullptr;',
        '}',
        'bool Step() {',
        '  return iter->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Step')).toEqual(['rocksdb::MemTableRep::Iterator::Valid']);
    } finally {
      cg.close();
    }
  });
});
