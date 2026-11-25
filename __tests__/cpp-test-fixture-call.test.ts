/**
 * A bare call in a gtest `TEST_F(Fixture, Name)` or `TEST_P` body reaches
 * the fixture's method.
 *
 * The index holds such a body as a function named `TEST_F`, but gtest makes
 * it a method of a class it derives from `Fixture`, declared where the
 * `TEST_F` is. C++ looks a name the body calls up in that class, then in the
 * fixture and the classes it derives from, before the namespace. Since PR
 * #2533 the fixture's data members were found that way (`db_->Put(…)`); its
 * methods were not, so in facebook/rocksdb `Put(…)`, `Flush()` and `auto iter
 * = NewIterator(…)` — methods of `DBTestBase` — were guessed by name, and
 * `iter->SeekToFirst()` reached the nested `MemTableRep::Iterator`.
 *
 * A guess can land on the right method by a shared word, so these tests
 * check the confidence, not only the target.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-fixture-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** The function or method `qualifiedName`, the one in `file` when given. */
function callable(cg: CodeGraph, qualifiedName: string, file?: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find(
    (n) => n.qualifiedName === qualifiedName && (file === undefined || n.filePath === file),
  );
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName @confidence`, one per call site. */
function calls(cg: CodeGraph, caller: string, file?: string): string[] {
  return cg
    .getCallees(callable(cg, caller, file).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

/** `calls` callees as `qualifiedName by resolvedBy`. */
function resolvers(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} by ${(r.edge.metadata as { resolvedBy?: string } | undefined)?.resolvedBy}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** rocksdb's public iterator, the nested namesake, and the test fixture base, trimmed. */
const ROCKSDB = {
  'include/rocksdb/iterator.h': lines(
    'namespace rocksdb {',
    'class IteratorBase {',
    ' public:',
    '  virtual void SeekToFirst() = 0;',
    '  virtual bool Valid() const = 0;',
    '};',
    'class Iterator : public IteratorBase {};',
    '}  // namespace rocksdb',
  ),
  'db/db_test_util.h': lines(
    '#include "include/rocksdb/iterator.h"',
    'namespace rocksdb {',
    'class DBTestBase {',
    ' public:',
    '  Iterator* NewIterator();',
    '  void Put(int key);',
    '  void Flush();',
    '};',
    '}  // namespace rocksdb',
  ),
  // As in rocksdb, the fixture base's methods are defined out of line.
  'db/db_test_util.cc': lines(
    '#include "db/db_test_util.h"',
    'namespace rocksdb {',
    'Iterator* DBTestBase::NewIterator() { return nullptr; }',
    'void DBTestBase::Put(int key) {}',
    'void DBTestBase::Flush() {}',
    '}  // namespace rocksdb',
  ),
};

/** Namesakes beside the tests, which a guess by name prefers. */
const NAMESAKES = lines(
  'class MemTableRep {',
  ' public:',
  '  class Iterator {',
  '   public:',
  '    void SeekToFirst() {}',
  '    bool Valid() const { return false; }',
  '  };',
  '  Iterator* NewIterator() { return nullptr; }',
  '};',
  'class WriteBatch {',
  ' public:',
  '  void Put(int key) {}',
  '  void Flush() {}',
  '};',
);

describe('C++ bare calls in gtest TEST_F / TEST_P bodies', () => {
  it("reaches the fixture's own and inherited methods", async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_basic_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        NAMESAKES,
        'class DBBasicTest : public DBTestBase {',
        ' public:',
        '  void Reopen() {}',
        '};',
        'TEST_F(DBBasicTest, PutFlush) {',
        '  Put(1);',
        '  Flush();',
        '  Reopen();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::TEST_F')).toEqual([
        'rocksdb::DBBasicTest::Reopen @0.9',
        'rocksdb::DBTestBase::Flush @0.9',
        'rocksdb::DBTestBase::Put @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('types `auto iter = NewIterator()` from the fixture\'s method', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_iterator_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        NAMESAKES,
        'class DBIteratorTest : public DBTestBase {};',
        'TEST_F(DBIteratorTest, IterSeekToFirst) {',
        '  auto iter = NewIterator();',
        '  iter->SeekToFirst();',
        '  if (iter->Valid()) {}',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::TEST_F')).toEqual([
        'rocksdb::DBTestBase::NewIterator @0.9',
        'rocksdb::IteratorBase::SeekToFirst @0.9',
        'rocksdb::IteratorBase::Valid @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('does the same in a TEST_P body, and on `this->`', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_param_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        NAMESAKES,
        'class DBParamTest : public DBTestBase {};',
        'TEST_P(DBParamTest, Write) {',
        '  this->Put(2);',
        '  Flush();',
        '  auto it = this->NewIterator();',
        '  it->SeekToFirst();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::TEST_P')).toEqual([
        'rocksdb::DBTestBase::Flush @0.9',
        'rocksdb::DBTestBase::NewIterator @0.9',
        'rocksdb::DBTestBase::Put @0.9',
        'rocksdb::IteratorBase::SeekToFirst @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('uses the fixture declared in the test\'s own file, of two sharing its name', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/other_test_util.h': lines(
        'namespace rocksdb {',
        NAMESAKES,
        'class OtherTestBase {',
        ' public:',
        '  MemTableRep::Iterator* NewIterator() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/a_test.cc': lines(
        '#include "db/other_test_util.h"',
        'namespace rocksdb {',
        'class SharedTest : public OtherTestBase {};',
        '}  // namespace rocksdb',
      ),
      'db/b_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        'class SharedTest : public DBTestBase {};',
        'TEST_F(SharedTest, Seek) {',
        '  auto iter = NewIterator();',
        '  iter->SeekToFirst();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::TEST_F', 'db/b_test.cc')).toEqual([
        'rocksdb::DBTestBase::NewIterator @0.9',
        'rocksdb::IteratorBase::SeekToFirst @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it("types a method's bare call on what the inherited method returns, past a nested class's parameter of its name", async () => {
    // leveldb's SpecialEnv: a class declared in the method takes a `target`
    // parameter, which is no local the bare `target()` calls.
    const cg = await indexed({
      'db/db_test.cc': lines(
        'namespace leveldb {',
        'class Env {',
        ' public:',
        '  virtual int NewRandomAccessFile() { return 0; }',
        '};',
        'class EnvWrapper : public Env {',
        ' public:',
        '  Env* target() const { return target_; }',
        ' private:',
        '  Env* target_;',
        '};',
        'class SpecialEnv : public EnvWrapper {',
        ' public:',
        '  int NewRandomAccessFile() override {',
        '    class CountingFile {',
        '     public:',
        '      explicit CountingFile(Env* target) : target_(target) {}',
        '     private:',
        '      Env* target_;',
        '    };',
        '    return target()->NewRandomAccessFile();',
        '  }',
        '};',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::SpecialEnv::NewRandomAccessFile')).toContain('leveldb::Env::NewRandomAccessFile @0.85');
    } finally {
      cg.close();
    }
  });

  it("types a template's bare call into a base it names with a using-declaration", async () => {
    // protobuf's RepeatedFieldPrimitiveAccessor: `MutableRepeatedField` is
    // its dependent base's, brought in by `using RepeatedFieldWrapper<T>::MutableRepeatedField;`.
    const cg = await indexed({
      'src/google/protobuf/reflection_internal.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'template <typename T>',
        'class RepeatedField {',
        ' public:',
        '  void Swap(RepeatedField* other) {}',
        '};',
        'template <typename T>',
        'class RepeatedFieldWrapper {',
        ' public:',
        '  RepeatedField<T>* MutableRepeatedField(void* data) const { return nullptr; }',
        '};',
        'template <typename T>',
        'class RepeatedFieldPrimitiveAccessor final : public RepeatedFieldWrapper<T> {',
        '  using RepeatedFieldWrapper<T>::MutableRepeatedField;',
        ' public:',
        '  void Swap(void* data, void* other_data) const {',
        '    MutableRepeatedField(data)->Swap(MutableRepeatedField(other_data));',
        '  }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::RepeatedFieldPrimitiveAccessor::Swap')).toContain('google::protobuf::RepeatedField::Swap @0.85');
    } finally {
      cg.close();
    }
  });

  it("gives `->` on a value of a type from outside the project no project class sharing the type's name", async () => {
    // protobuf's JsonTest: `ToProto<Any>(…)` returns an `absl::StatusOr<Any>`,
    // whose `->` reaches the `Any` it holds, not protobuf's own `hpb::StatusOr`.
    const cg = await indexed({
      'hpb/status.h': lines(
        'namespace hpb {',
        'template <typename T>',
        'class StatusOr {',
        ' public:',
        '  T& value() { return value_; }',
        ' private:',
        '  T value_;',
        '};',
        '}  // namespace hpb',
      ),
      'src/google/protobuf/json/json_test.cc': lines(
        '#include "hpb/status.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace json {',
        'class JsonTest {',
        ' protected:',
        '  template <typename Proto>',
        '  absl::StatusOr<Proto> ToProto(absl::string_view json) { return Proto(); }',
        '};',
        'TEST_P(JsonTest, Any) {',
        '  auto m = ToProto<Any>("{}");',
        '  m->value();',
        '}',
        'void Parsed(absl::StatusOr<Any> parsed) {',
        '  parsed->value();',
        '}',
        '}  // namespace json',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      // (The name strategies still decide, as for any receiver of an unknown type;
      // in this small project the one `value` is that one.)
      expect(calls(cg, 'google::protobuf::json::TEST_P')).not.toContain('hpb::StatusOr::value @0.9');
      expect(calls(cg, 'google::protobuf::json::Parsed')).not.toContain('hpb::StatusOr::value @0.9');
    } finally {
      cg.close();
    }
  });

  it('leaves a TEST body, which has no fixture, to the name strategies', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_plain_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        'class DBPlainTest : public DBTestBase {};',
        'TEST(DBPlainTest, Plain) {',
        '  Put(1);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(resolvers(cg, 'rocksdb::TEST')).not.toContain('rocksdb::DBTestBase::Put by instance-method');
    } finally {
      cg.close();
    }
  });

  it('calls a local of the name the body declares, not the fixture\'s method', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'db/db_local_test.cc': lines(
        '#include "db/db_test_util.h"',
        'namespace rocksdb {',
        'class DBLocalTest : public DBTestBase {};',
        'TEST_F(DBLocalTest, Local) {',
        '  auto Put = [](int key) {};',
        '  Put(1);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(resolvers(cg, 'rocksdb::TEST_F')).not.toContain('rocksdb::DBTestBase::Put by instance-method');
    } finally {
      cg.close();
    }
  });
});
