/**
 * What a C or C++ source file declares for itself is no target of a name
 * written in another file.
 *
 * A class or alias a `.cc` file declares, and whatever its unnamed namespace
 * (`namespace { … }`) declares, belongs to that translation unit: another
 * file can't name it. Name matching took them anyway. In facebook/rocksdb,
 * other test files' bare `Put(…)` reached column_family_test.cc's own
 * `ColumnFamilyTestBase::Put` 7,989 times, and inlineskiplist.h's `Node*`
 * receivers reached the `Node` hash_linklist_rep.cc declares in an unnamed
 * namespace. A source file's declarations are still seen by the file itself,
 * by a file that includes it, and by a header it includes after them
 * (rocksdb's version_set.cc includes version_set_sync_and_async.h below its
 * `FilePicker` classes).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-tu-'));
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

/** `calls` callees of a function or method, as `qualifiedName [file] @confidence`. */
function calls(cg: CodeGraph, caller: string, file?: string): string[] {
  return cg
    .getCallees(callable(cg, caller, file).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} [${r.node.filePath}] @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

describe('C/C++ declarations local to another translation unit', () => {
  it("is not another source file's class in an unnamed namespace", async () => {
    const cg = await indexed({
      'memtable/hash_linklist_rep.cc': lines(
        'namespace rocksdb {',
        'namespace {',
        'struct Node {',
        '  Node* Next() { return nullptr; }',
        '};',
        '}  // namespace',
        '}  // namespace rocksdb',
      ),
      'memtable/inlineskiplist.h': lines(
        'namespace rocksdb {',
        'template <class Comparator>',
        'class InlineSkipList {',
        ' private:',
        '  struct Node;',
        ' public:',
        '  void Insert() {',
        '    Node* x = head_;',
        '    x->Next();',
        '  }',
        ' private:',
        '  Node* head_;',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::InlineSkipList::Insert').filter((c) => c.includes('hash_linklist_rep.cc'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("is not another test file's fixture method a bare call names", async () => {
    const cg = await indexed({
      'db/column_family_test.cc': lines(
        'namespace rocksdb {',
        'class ColumnFamilyTestBase {',
        ' public:',
        '  void Put(int key) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_basic_test.cc': lines(
        'namespace rocksdb {',
        'void Put(int key);',
        'void Check() {',
        '  Put(1);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Check').filter((c) => c.includes('column_family_test.cc'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("is not a function another source file's unnamed namespace declares", async () => {
    const cg = await indexed({
      'conformance/matchers.cc': lines(
        'namespace conformance {',
        'namespace {',
        'int RawPayload(int response) { return response; }',
        '}  // namespace',
        '}  // namespace conformance',
      ),
      'conformance/matchers_test.cc': lines(
        'namespace conformance {',
        'int Describe() {',
        '  return RawPayload(1);',
        '}',
        '}  // namespace conformance',
      ),
    });
    try {
      expect(calls(cg, 'conformance::Describe').filter((c) => c.includes('matchers.cc'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("is a member of the header's class, not of a source file's namesake", async () => {
    // rocksdb declares a `SharedState` in db_stress_shared_state.h and two
    // more of its own in cache_bench_tool.cc and db_bench_tool.cc.
    const cg = await indexed({
      'cache/cache_bench_tool.cc': lines(
        'namespace rocksdb {',
        'class SharedState {',
        ' public:',
        '  int* GetMutex() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db_stress_tool/db_stress_shared_state.h': lines(
        'namespace rocksdb {',
        'class SharedState {',
        ' public:',
        '  int* GetMutex() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db_stress_tool/db_stress_common.cc': lines(
        '#include "db_stress_tool/db_stress_shared_state.h"',
        'namespace rocksdb {',
        'void Lock(SharedState* shared) {',
        '  shared->GetMutex();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Lock')).toEqual(['rocksdb::SharedState::GetMutex [db_stress_tool/db_stress_shared_state.h] @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is the header's class for a receiver a namespace-scope variable holds", async () => {
    const cg = await indexed({
      'cache/cache_bench_tool.cc': lines(
        'namespace rocksdb {',
        'class SharedState {',
        ' public:',
        '  int* GetMutex() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db_stress_tool/db_stress_shared_state.h': lines(
        'namespace rocksdb {',
        'class SharedState {',
        ' public:',
        '  int* GetMutex() { return nullptr; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db_stress_tool/db_stress_common.cc': lines(
        '#include "db_stress_tool/db_stress_shared_state.h"',
        'namespace rocksdb {',
        'SharedState* shared_state = nullptr;',
        'void LockShared() {',
        '  shared_state->GetMutex();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::LockShared')).toEqual(['rocksdb::SharedState::GetMutex [db_stress_tool/db_stress_shared_state.h] @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is a header's class, with no include the index follows", async () => {
    const cg = await indexed({
      'include/rocksdb/cache.h': lines(
        'namespace rocksdb {',
        'class Cache {',
        ' public:',
        '  virtual int Insert(int key) { return key; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'cache/user.cc': lines(
        'namespace rocksdb {',
        'int Use(Cache* cache) {',
        '  return cache->Insert(1);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Use')).toEqual(['rocksdb::Cache::Insert [include/rocksdb/cache.h] @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is not an out-of-line method of a class another source file declares", async () => {
    // protobuf's descriptor.cc declares `FileDescriptorTables` outside its
    // unnamed namespaces and defines the class's methods below it.
    const cg = await indexed({
      'src/descriptor.cc': lines(
        'namespace google {',
        'namespace protobuf {',
        'class FileDescriptorTables {',
        ' public:',
        '  const int* FindFieldByLowercaseName(const char* name) const;',
        '};',
        'const int* FileDescriptorTables::FindFieldByLowercaseName(const char* name) const {',
        '  return nullptr;',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'python/message.cc': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace python {',
        'const int* Find(CMessage* self, const char* name) {',
        '  return self->message_descriptor->FindFieldByLowercaseName(name);',
        '}',
        '}  // namespace python',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::python::Find')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('is not a class another source file declares, named as a type', async () => {
    // rocksdb's db/log_test.cc declares a `StringSource` of its own; other
    // tests' `new test::StringSource(…)` are test_util's.
    const cg = await indexed({
      'db/log_test.cc': lines(
        'namespace rocksdb {',
        'namespace log {',
        'class StringSource {',
        ' public:',
        '  explicit StringSource(int contents) {}',
        '};',
        '}  // namespace log',
        '}  // namespace rocksdb',
      ),
      'db/plain_table_db_test.cc': lines(
        'namespace rocksdb {',
        'void* Make() {',
        '  return new test::StringSource(1);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const make = callable(cg, 'rocksdb::Make');
      expect(cg.getOutgoingEdgesFrom([make.id]).map((e) => cg.getNode(e.target)?.filePath).filter((f) => f === 'db/log_test.cc')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('reads an unnamed namespace past comments, preprocessor lines and literals that spell one', async () => {
    const cg = await indexed({
      'db/c.cc': lines(
        'namespace rocksdb {',
        '// namespace { in a line comment',
        '/* namespace { in a block comment */',
        '#define ROCKSDB_ANONYMOUS_BEGIN namespace {',
        'const char* kDoc = "namespace {";',
        'const char* kRaw = R"(a "b namespace {" c)";',
        'int Helper(int x) { return x; }',
        '}  // namespace rocksdb',
      ),
      // A macro continued onto the next line, in a file checked out with CRLF.
      'db/crlf.cc': ['namespace rocksdb {', '#define ROCKSDB_ANONYMOUS_BEGIN \\', '  namespace {', 'int Other(int x) { return x; }', '}  // namespace rocksdb', ''].join('\r\n'),
      'db/c_test.cc': lines(
        'namespace rocksdb {',
        'int Check() {',
        '  return Helper(1) + Other(2);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Check')).toEqual(['rocksdb::Helper [db/c.cc] @0.9', 'rocksdb::Other [db/crlf.cc] @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is still the file's own, and a header's it includes after the declaration", async () => {
    const cg = await indexed({
      'db/version_set.cc': lines(
        'namespace rocksdb {',
        'namespace {',
        'class FilePicker {',
        ' public:',
        '  int GetNextFile() { return 0; }',
        '};',
        '}  // namespace',
        'int Pick(FilePicker& fp) {',
        '  return fp.GetNextFile();',
        '}',
        '}  // namespace rocksdb',
        '#include "db/version_set_sync_and_async.h"',
      ),
      'db/version_set_sync_and_async.h': lines(
        'namespace rocksdb {',
        'int PickAsync(FilePicker& fp) {',
        '  return fp.GetNextFile();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Pick')).toEqual(['rocksdb::FilePicker::GetNextFile [db/version_set.cc] @0.9']);
      expect(calls(cg, 'rocksdb::PickAsync')).toEqual(['rocksdb::FilePicker::GetNextFile [db/version_set.cc] @0.9']);
    } finally {
      cg.close();
    }
  });

  it('is seen by a file that includes the source file', async () => {
    const cg = await indexed({
      'util/impl.cc': lines(
        'namespace {',
        'class Impl {',
        ' public:',
        '  int Run() { return 0; }',
        '};',
        '}  // namespace',
      ),
      'util/impl_test.cc': lines(
        '#include "util/impl.cc"',
        'int Test(Impl& impl) {',
        '  return impl.Run();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Test')).toEqual(['Impl::Run [util/impl.cc] @0.9']);
    } finally {
      cg.close();
    }
  });

  it('keeps an out-of-line method of a class a header declares, through an alias too', async () => {
    const cg = await indexed({
      'include/rocksdb/multi_scan.h': lines(
        'namespace rocksdb {',
        'class MultiScan {',
        ' public:',
        '  class MultiScanIterator {',
        '   public:',
        '    void SeekCurrentRange();',
        '    void Next() { SeekCurrentRange(); }',
        '  };',
        '};',
        'class Table {',
        ' public:',
        '  int Open();',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/multi_scan.cc': lines(
        '#include "include/rocksdb/multi_scan.h"',
        'namespace rocksdb {',
        'using MultiScanIterator = MultiScan::MultiScanIterator;',
        'void MultiScanIterator::SeekCurrentRange() {}',
        'int Table::Open() { return 0; }',
        '}  // namespace rocksdb',
      ),
      'db/open.cc': lines(
        '#include "include/rocksdb/multi_scan.h"',
        'namespace rocksdb {',
        'int OpenTable(Table* t) {',
        '  return t->Open();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiScan::MultiScanIterator::Next').filter((c) => c.includes('SeekCurrentRange'))).toHaveLength(1);
      expect(calls(cg, 'rocksdb::OpenTable')).toEqual(['rocksdb::Table::Open [db/multi_scan.cc] @0.9']);
    } finally {
      cg.close();
    }
  });

  it("keeps a namespace's function a source file defines out of line, beside another file's namesake struct", async () => {
    // fmt's posix-mock-test.cc defines posix-mock.h's `test::close`, and
    // ostream-test.cc declares a `struct test` of its own.
    const cg = await indexed({
      'test/posix-mock.h': lines('namespace test {', 'int close(int fildes);', '}  // namespace test'),
      'test/posix-mock-test.cc': lines('#include "posix-mock.h"', 'int test::close(int fildes) { return fildes; }'),
      'test/ostream-test.cc': lines('struct test {};'),
      'test/os-test.cc': lines('#include "posix-mock.h"', 'int Shut(int fd) {', '  return test::close(fd);', '}'),
    });
    try {
      expect(calls(cg, 'Shut').filter((c) => c.startsWith('test::close'))).toHaveLength(1);
    } finally {
      cg.close();
    }
  });

  it("gives a class no base another source file declares", async () => {
    const cg = await indexed({
      'util/base.cc': lines(
        'namespace rocksdb {',
        'class Base {',
        ' public:',
        '  virtual void Run() {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'util/derived.h': lines(
        'namespace rocksdb {',
        'class Derived : public Base {};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const derived = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'rocksdb::Derived')!;
      expect(cg.getOutgoingEdgesFrom([derived.id], ['extends']).map((e) => cg.getNode(e.target)?.filePath)).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
