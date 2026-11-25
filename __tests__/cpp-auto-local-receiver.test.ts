/**
 * A C++ call on a receiver whose type C++ lookup finds reaches that class,
 * not a namesake; and a receiver of a type from outside the project reaches
 * none of the project's classes.
 *
 * #2493 resolved calls on declared pointers, values and references by C++
 * lookup. An `auto` local was still typed by the last name of its
 * initializer's type, when that could be read at all: in facebook/rocksdb,
 * `auto iter = std::unique_ptr<Iterator>(…)` couldn't be, so the scan read an
 * earlier function's `Iterator* iter`, and its last name took
 * `iter->SeekToFirst()` to the nested `MemTableRep::Iterator`. The local now
 * has the type its initializer has as written where it is declared: a
 * construction or cast names it; a call's declaration writes it. Its calls
 * then resolve as for a declared receiver.
 *
 * A type from outside the project (`absl::Status`, `std::ostream`) took the
 * project's class of the same last name: protocolbuffers/protobuf's
 * `upb::Status`, fmtlib/fmt's own `ostream`.
 *
 * A guess can still land on the right method by a shared word, so these
 * tests check the confidence, not only the target.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-auto-local-'));
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

/** rocksdb's iterators, trimmed: the public Iterator inherits its cursor methods; a nested namesake declares them. */
const ITERATORS = {
  'include/rocksdb/iterator_base.h': lines(
    'namespace rocksdb {',
    'class IteratorBase {',
    ' public:',
    '  virtual ~IteratorBase() {}',
    '  virtual bool Valid() const = 0;',
    '  virtual void SeekToFirst() = 0;',
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
    '    virtual void SeekToFirst() = 0;',
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
    'class Transaction {',
    ' public:',
    '  virtual Iterator* GetIterator() = 0;',
    '};',
    '}  // namespace rocksdb',
  ),
};

describe('an `auto` local has the type its initializer has where that is written', () => {
  it('reproduction: a smart pointer cast to, and what a method is declared to return', async () => {
    const cg = await indexed({
      ...ITERATORS,
      'db/db_iterator_test.cc': lines(
        '#include <memory>',
        '#include "include/rocksdb/db.h"',
        '#include "include/rocksdb/memtablerep.h"',
        'namespace rocksdb {',
        'int CountKeys(DB* db) {',
        '  int n = 0;',
        '  auto iter = std::unique_ptr<Iterator>(db->NewIterator());',
        '  for (iter->SeekToFirst(); iter->Valid(); iter->Next()) n += iter->value();',
        '  return n;',
        '}',
        'bool FirstValid(Transaction* txn) {',
        '  auto it = txn->GetIterator();',
        '  it->SeekToFirst();',
        '  return it->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // IteratorBase's, which Iterator derives from; not MemTableRep::Iterator's.
      expect(calls(cg, 'rocksdb::CountKeys')).toEqual([
        'rocksdb::DB::NewIterator @0.9',
        'rocksdb::Iterator::value @0.9',
        'rocksdb::IteratorBase::Next @0.9',
        'rocksdb::IteratorBase::SeekToFirst @0.9',
        'rocksdb::IteratorBase::Valid @0.9',
      ]);
      expect(calls(cg, 'rocksdb::FirstValid')).toEqual([
        'rocksdb::IteratorBase::SeekToFirst @0.9',
        'rocksdb::IteratorBase::Valid @0.9',
        'rocksdb::Transaction::GetIterator @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it("a smart pointer to a class template of the project's, whatever its arguments", async () => {
    // rocksdb's ExternalTableReaderAdapter<Mode> holds an ExternalTableReaderBase<Mode>.
    const cg = await indexed({
      'table/external_table.cc': lines(
        '#include <memory>',
        'namespace rocksdb {',
        'template <int Mode>',
        'class ExternalTableReaderBase {',
        ' public:',
        '  virtual ~ExternalTableReaderBase() {}',
        '  int NewIterator() { return Mode; }',
        '};',
        'class IndexFactoryReader {',
        ' public:',
        '  int NewIterator() { return 0; }',
        '};',
        'template <int Mode>',
        'class ExternalTableReaderAdapter {',
        ' public:',
        '  int Open() {',
        '    auto reader = std::unique_ptr<ExternalTableReaderBase<Mode>>(nullptr);',
        '    return reader->NewIterator();',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::ExternalTableReaderAdapter::Open')).toEqual(['rocksdb::ExternalTableReaderBase::NewIterator @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a cast, and a construction through a typedef', async () => {
    // rocksdb's sync-point callbacks cast their argument; HashSkipListRep's
    // `Bucket` is a typedef of a SkipList.
    const cg = await indexed({
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
      'memtable/skiplist.h': lines(
        'namespace rocksdb {',
        'template <typename Key, class Comparator>',
        'class SkipList {',
        ' public:',
        '  void Insert(const Key& key) {}',
        '};',
        'class InlineSkipList {',
        ' public:',
        '  void Insert(const char* key) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/merge_test.cc': lines(
        '#include "monitoring/instrumented_mutex.h"',
        '#include "memtable/skiplist.h"',
        'namespace rocksdb {',
        'void Callback(void* arg) {',
        '  auto* mutex = static_cast<InstrumentedMutex*>(arg);',
        '  mutex->Unlock();',
        '  mutex->Lock();',
        '}',
        'class HashSkipListRep {',
        ' public:',
        '  typedef SkipList<const char*, int> Bucket;',
        '  void Add(const char* key) {',
        '    auto list = new Bucket();',
        '    list->Insert(key);',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Callback')).toEqual(['rocksdb::InstrumentedMutex::Lock @0.9', 'rocksdb::InstrumentedMutex::Unlock @0.9']);
      expect(calls(cg, 'rocksdb::HashSkipListRep::Add')).toEqual(['rocksdb::SkipList::Insert @0.9']);
    } finally {
      cg.close();
    }
  });

  it("a bare call to a method the caller's class inherits, and a smart pointer made for a class", async () => {
    // protobuf's `auto* h = micro_rep();` read an earlier function's
    // `LargeRep* h`; a test helper's `Widget` shares a name with the UI's.
    const cg = await indexed({
      'src/google/protobuf/micro_string.h': lines(
        '#include <memory>',
        'namespace google {',
        'namespace protobuf {',
        'struct LargeRep {',
        '  void ChangeSize(int n) {}',
        '};',
        'struct MicroRep {',
        '  void ChangeSize(int n) {}',
        '};',
        'class MicroStringBase {',
        ' protected:',
        '  MicroRep* micro_rep() { return nullptr; }',
        '  LargeRep* large_rep() { return nullptr; }',
        '};',
        'class MicroString : public MicroStringBase {',
        ' public:',
        '  void Grow();',
        '  void Clear();',
        '};',
        'namespace ui {',
        'class Widget {',
        ' public:',
        '  void Draw() {}',
        '};',
        '}  // namespace ui',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/micro_string.cc': lines(
        '#include "src/google/protobuf/micro_string.h"',
        'namespace google {',
        'namespace protobuf {',
        'void MicroString::Grow() {',
        '  LargeRep* h = large_rep();',
        '  h->ChangeSize(2);',
        '}',
        'namespace test {',
        'class Widget {',
        ' public:',
        '  void Draw() {}',
        '};',
        '}  // namespace test',
        'void MicroString::Clear() {',
        '  auto* h = micro_rep();',
        '  h->ChangeSize(0);',
        '}',
        'namespace ui {',
        'void Paint() {',
        '  auto w = std::make_unique<Widget>();',
        '  w->Draw();',
        '}',
        'void Repaint() {',
        '  auto w = Widget();',
        '  w.Draw();',
        '}',
        '}  // namespace ui',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::MicroString::Clear')).toEqual([
        'google::protobuf::MicroRep::ChangeSize @0.9',
        'google::protobuf::MicroStringBase::micro_rep @0.9',
      ]);
      expect(calls(cg, 'google::protobuf::ui::Paint').filter((c) => c.includes('Draw'))).toEqual(['google::protobuf::ui::Widget::Draw @0.9']);
      expect(calls(cg, 'google::protobuf::ui::Repaint').filter((c) => c.includes('Draw'))).toEqual(['google::protobuf::ui::Widget::Draw @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a chained call through a smart pointer reaches a method of the class it holds', async () => {
    const cg = await indexed({
      'table/table_test.cc': lines(
        '#include <memory>',
        'namespace rocksdb {',
        'class PinnedReader {',
        ' public:',
        '  void SetPinnedData(int data) {}',
        '};',
        'class OtherReader {',
        ' public:',
        '  void SetPinnedData(int data) {}',
        '};',
        'class PinnedFactory {',
        ' public:',
        '  PinnedReader* last_reader() const { return nullptr; }',
        '};',
        'void Pin() {',
        '  auto factory = std::make_shared<PinnedFactory>();',
        '  factory->last_reader()->SetPinnedData(1);',
        '}',
        'void PinAgain(const std::unique_ptr<PinnedFactory>& factory) {',
        '  factory->last_reader()->SetPinnedData(2);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Pin')).toEqual(['rocksdb::PinnedFactory::last_reader @0.9', 'rocksdb::PinnedReader::SetPinnedData @0.85']);
      expect(calls(cg, 'rocksdb::PinAgain')).toEqual(['rocksdb::PinnedFactory::last_reader @0.9', 'rocksdb::PinnedReader::SetPinnedData @0.85']);
    } finally {
      cg.close();
    }
  });

  it('the type of a local a chained call reads first is the same for its other calls', async () => {
    // rocksdb's compaction test reads `cfd` while it works out a three-call
    // chain on it; the local's type is kept for its other calls too.
    const cg = await indexed({
      'db/version_set.h': lines(
        '#include <memory>',
        'namespace rocksdb {',
        'class VersionStorageInfo {',
        ' public:',
        '  int LevelFiles(int level) const { return level; }',
        '};',
        'class Version {',
        ' public:',
        '  VersionStorageInfo* storage_info() { return nullptr; }',
        '};',
        'class ColumnFamilyData {',
        ' public:',
        '  Version* current() const { return nullptr; }',
        '};',
        'class ColumnFamilySet {',
        ' public:',
        '  ColumnFamilyData* GetDefault() const { return nullptr; }',
        '};',
        'class VersionSet {',
        ' public:',
        '  ColumnFamilySet* GetColumnFamilySet() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/compaction/compaction_job_test.cc': lines(
        '#include "db/version_set.h"',
        'namespace rocksdb {',
        'class CompactionJobTestBase {',
        ' public:',
        '  void VerifyTables(int output_level);',
        ' protected:',
        '  std::unique_ptr<VersionSet> versions_;',
        '};',
        'void CompactionJobTestBase::VerifyTables(int output_level) {',
        '  auto cfd = versions_->GetColumnFamilySet()->GetDefault();',
        '  cfd->current()->storage_info()->LevelFiles(output_level);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::CompactionJobTestBase::VerifyTables')).toEqual([
        'rocksdb::ColumnFamilyData::current @0.9',
        'rocksdb::ColumnFamilySet::GetDefault @0.85',
        'rocksdb::Version::storage_info @0.85',
        'rocksdb::VersionSet::GetColumnFamilySet @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a chained call reaches the class the inner call is declared to return, not a namesake', async () => {
    // protobuf's Java and C# generators each declare an EnumGenerator.
    const cg = await indexed({
      'src/google/protobuf/compiler/csharp/csharp_enum.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'namespace csharp {',
        'class EnumGenerator {',
        ' public:',
        '  void Generate(int printer) {}',
        '};',
        '}  // namespace csharp',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/compiler/java/generator_factory.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'namespace java {',
        'class EnumGenerator {',
        ' public:',
        '  void Generate(int printer) {}',
        '};',
        'class GeneratorFactory {',
        ' public:',
        '  EnumGenerator* NewEnumGenerator(int descriptor) const { return nullptr; }',
        '};',
        '}  // namespace java',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/compiler/java/file.cc': lines(
        '#include "src/google/protobuf/compiler/java/generator_factory.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'namespace java {',
        'void GenerateEnums(const GeneratorFactory* generator_factory) {',
        '  generator_factory->NewEnumGenerator(1)->Generate(2);',
        '}',
        '}  // namespace java',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::compiler::java::GenerateEnums')).toEqual([
        'google::protobuf::compiler::java::EnumGenerator::Generate @0.85',
        'google::protobuf::compiler::java::GeneratorFactory::NewEnumGenerator @0.9',
      ]);
    } finally {
      cg.close();
    }
  });
});

describe('what keeps the call as it was', () => {
  it('an initializer that goes on past its line is read to its end', async () => {
    // rocksdb's options test casts a member it reads on the line above the cast.
    const cg = await indexed({
      'include/rocksdb/merge_operator.h': lines(
        '#include <memory>',
        'namespace rocksdb {',
        'class Customizable {',
        ' public:',
        '  template <typename T>',
        '  T* CheckedCast() { return nullptr; }',
        '};',
        'class MergeOperator : public Customizable {',
        ' public:',
        '  virtual const char* Name() const { return ""; }',
        '};',
        'struct ColumnFamilyOptions {',
        '  std::shared_ptr<MergeOperator> merge_operator;',
        '};',
        'namespace test {',
        'class ChanglingMergeOperator : public MergeOperator {',
        ' public:',
        '  void SetName(const char* name) {}',
        '};',
        '}  // namespace test',
        '}  // namespace rocksdb',
      ),
      'options/options_test.cc': lines(
        '#include "include/rocksdb/merge_operator.h"',
        'namespace rocksdb {',
        'void Rename(ColumnFamilyOptions* base_cf_opt) {',
        '  auto* merge_operator = base_cf_opt->merge_operator',
        '                             ->CheckedCast<test::ChanglingMergeOperator>();',
        '  merge_operator->SetName("other");',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // Not the shared_ptr<MergeOperator> member's type, which has no SetName:
      // the type `CheckedCast<test::ChanglingMergeOperator>()` returns.
      expect(calls(cg, 'rocksdb::Rename').filter((c) => c.includes('SetName'))).toEqual(['rocksdb::test::ChanglingMergeOperator::SetName @0.9']);
    } finally {
      cg.close();
    }
  });

  it('what a function template returns is a template parameter, after the macros that follow its header', async () => {
    // protobuf's `Arena::Create<T>` is declared `PROTOBUF_NDEBUG_INLINE static T* PROTOBUF_NONNULL Create(…)`.
    const cg = await indexed({
      'src/google/protobuf/arena.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class Arena {',
        ' public:',
        '  void Reset() {}',
        '  template <typename T, typename... Args>',
        '  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD PROTOBUF_NDEBUG_INLINE static T*',
        '      PROTOBUF_NONNULL',
        '      Create(Arena* arena, Args&&... args) {',
        '    return new T();',
        '  }',
        '};',
        'template <typename Element>',
        'class RepeatedPtrField {',
        ' public:',
        '  Element* Add() { return nullptr; }',
        '};',
        'class MessageLite {',
        ' public:',
        '  int AccessCachedSize() const { return 0; }',
        '};',
        'class Message : public MessageLite {};',
        'class Pool {',
        ' public:',
        '  void Reset() {}',
        '};',
        'PROTOBUF_EXPORT Arena* PROTOBUF_NONNULL DefaultArena() { return nullptr; }',
        '// Overloads by argument: what each returns depends on T.',
        'template <typename T>',
        'PROTOBUF_FUTURE_ADD_EARLY_NODISCARD std::shared_ptr<T> DownCastMessage(const std::shared_ptr<MessageLite>& from) {',
        '  return nullptr;',
        '}',
        'template <typename T>',
        'PROTOBUF_FUTURE_ADD_EARLY_NODISCARD const T& DownCastMessage(const MessageLite& from) {',
        '  return *static_cast<const T*>(&from);',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/repeated_ptr_field_unittest.cc': lines(
        '#include "src/google/protobuf/arena.h"',
        'namespace google {',
        'namespace protobuf {',
        'void Fill(Arena* arena) {',
        '  auto* field = Arena::Create<RepeatedPtrField<int>>(arena);',
        '  field->Add();',
        '}',
        'int ByteSizeLong(const MessageLite& msg) {',
        '  auto& _this = DownCastMessage<Message>(msg);',
        '  return _this.AccessCachedSize();',
        '}',
        'void Clear() {',
        '  auto* arena = DefaultArena();',
        '  arena->Reset();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Fill').filter((c) => c.includes('::Add'))).toEqual(['google::protobuf::RepeatedPtrField::Add @0.7']);
      // Not read as the first overload's `std::shared_ptr<T>`, which would call a library method.
      expect(calls(cg, 'google::protobuf::ByteSizeLong').filter((c) => c.includes('AccessCachedSize'))).toEqual([
        'google::protobuf::MessageLite::AccessCachedSize @0.7',
      ]);
      // A macro after the return type is no part of it.
      expect(calls(cg, 'google::protobuf::Clear').filter((c) => c.includes('::Reset'))).toEqual(['google::protobuf::Arena::Reset @0.9']);
    } finally {
      cg.close();
    }
  });
});

describe('a type from outside the project reaches none of its classes', () => {
  it('one under a namespace the project declares nothing in', async () => {
    const cg = await indexed({
      'upb/status.h': lines(
        'namespace upb {',
        'class Status {',
        ' public:',
        '  bool ok() const { return true; }',
        '};',
        '}  // namespace upb',
      ),
      'conformance/conformance_test.cc': lines(
        '#include "absl/status/status.h"',
        '#include "upb/status.h"',
        'namespace google {',
        'namespace protobuf {',
        'bool Passed(const absl::Status& status) {',
        '  return status.ok();',
        '}',
        'absl::Status Parse(int payload) { return absl::Status(); }',
        'bool Parsed(int payload) {',
        '  return Parse(payload).ok();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      // A specialization the index reads as a method named `google::protobuf::absl::Cord`.
      'src/google/protobuf/lite_unittest.cc': lines(
        '#include "absl/strings/cord.h"',
        'namespace google {',
        'namespace protobuf {',
        'template <typename T>',
        'T SerializeAs(const int& msg);',
        'template <>',
        'absl::Cord SerializeAs<absl::Cord>(const int& msg) {',
        '  return absl::Cord();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Passed')).toEqual([]);
      // What a function returns, for a chained call.
      expect(calls(cg, 'google::protobuf::Parsed').filter((c) => c.includes('::ok'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("a standard one whose name a class of the project shares", async () => {
    // fmt opens its namespace with a macro and declares an `ostream` of its own.
    const cg = await indexed({
      'include/fmt/os.h': lines(
        '#define FMT_BEGIN_NAMESPACE namespace fmt { inline namespace v11 {',
        '#define FMT_END_NAMESPACE } }',
        'FMT_BEGIN_NAMESPACE',
        'class ostream {',
        ' public:',
        '  void flush() {}',
        '};',
        'FMT_END_NAMESPACE',
      ),
      'src/ostream.cc': lines(
        '#include <ostream>',
        '#include "include/fmt/os.h"',
        'FMT_BEGIN_NAMESPACE',
        'void flush_stream(std::ostream& os) {',
        '  os.flush();',
        '}',
        'FMT_END_NAMESPACE',
      ),
    });
    try {
      expect(calls(cg, 'flush_stream')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('not one of a namespace the project declares, which the file does not see', async () => {
    const cg = await indexed({
      'src/google/protobuf/descriptor.pb.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class FileDescriptorProto {',
        ' public:',
        '  void Clear() {}',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/compiler/java/shared_code_generator.cc': lines(
        'namespace google {',
        'namespace protobuf {',
        'void Reset(google::protobuf::FileDescriptorProto& file_proto) {',
        '  file_proto.Clear();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Reset')).toEqual(['google::protobuf::FileDescriptorProto::Clear @0.9']);
    } finally {
      cg.close();
    }
  });
});
