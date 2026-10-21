/**
 * A C++ call through a namespace — protobuf's `absl::StripPrefix(…)`, fmt's
 * `fmt::ptr(p)` — links no class's method, which is all the name strategies
 * of matchMethodCall can find: a namespace holds functions and types.
 *
 * protocolbuffers/protobuf's `absl::StripPrefix(name, …)` went to its Rust
 * generator's `MultiCasePrefixStripper::StripPrefix`, the one method of that
 * name, and `absl::Status(…)` to `upb::Status`'s constructor. fmtlib/fmt's
 * `fmt::ptr(p)` went to a scanner's `ptr()` method; fmt's own `ptr` function,
 * which `FMT_BEGIN_NAMESPACE` puts in `fmt`, is found by the step after those
 * strategies, and is now what the call links.
 *
 * A lowercase qualifier is a namespace when no C or C++ type or alias has its
 * name and the calling file declares it as neither a template parameter nor
 * an alias. rocksdb's `hash_table::Insert(…)`, through `typedef HashTable<…>
 * hash_table;`, still reaches `HashTable::Insert`.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-namespace-'));
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

/** `calls` callees of a function or method, as `kind qualifiedName (file)`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.kind} ${r.node.qualifiedName} (${r.node.filePath})`)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** fmt's namespace macros, and the scanner whose `ptr()` main took for `fmt::ptr`. */
const FMT = {
  'include/fmt/base.h': lines(
    '#define FMT_BEGIN_NAMESPACE namespace fmt { inline namespace v11 {',
    '#define FMT_END_NAMESPACE } }',
  ),
  'include/fmt/format.h': lines(
    '#include "fmt/base.h"',
    'FMT_BEGIN_NAMESPACE',
    'template <typename T> const void* ptr(T p) { return p; }',
    'FMT_END_NAMESPACE',
  ),
  'include/fmt/chrono.h': lines(
    '#include <chrono>',
    '#include "fmt/base.h"',
    'FMT_BEGIN_NAMESPACE',
    'using day = std::chrono::day;',
    'FMT_END_NAMESPACE',
  ),
  'test/scan.h': lines(
    '#include "fmt/base.h"',
    'FMT_BEGIN_NAMESPACE',
    'namespace detail {',
    'class scan_buffer {',
    ' public:',
    '  const char* ptr() const { return ptr_; }',
    ' private:',
    '  const char* ptr_;',
    '};',
    '}  // namespace detail',
    'FMT_END_NAMESPACE',
  ),
  'test/util.h': lines(
    'namespace date {',
    'class day {',
    ' public:',
    '  explicit day(unsigned d) : d_(d) {}',
    ' private:',
    '  unsigned d_;',
    '};',
    '}  // namespace date',
  ),
};

describe('a C++ call through a namespace', () => {
  it('reproduction: `fmt::ptr(p)` is fmt\'s own `ptr`, not a scanner\'s `ptr()` method', async () => {
    const cg = await indexed({
      ...FMT,
      'test/format-test.cc': lines(
        '#include "fmt/format.h"',
        '#include "scan.h"',
        'const void* Pointer(int* p) { return fmt::ptr(p); }',
      ),
    });
    try {
      expect(calls(cg, 'Pointer')).toEqual(['function ptr (include/fmt/format.h)']);
    } finally {
      cg.close();
    }
  });

  it('a type a namespace macro puts in fmt: `fmt::day(1)` is fmt\'s alias, not a test\'s `date::day`', async () => {
    const cg = await indexed({
      ...FMT,
      'test/chrono-test.cc': lines(
        '#include "fmt/chrono.h"',
        '#include "util.h"',
        'void Days() { auto d = fmt::day(1); }',
      ),
    });
    try {
      expect(calls(cg, 'Days')).toEqual(['type_alias day (include/fmt/chrono.h)']);
    } finally {
      cg.close();
    }
  });

  it('an outside library\'s namespace: `absl::StripPrefix` and `absl::Status` link nothing', async () => {
    const cg = await indexed({
      'src/google/protobuf/compiler/rust/naming.h': lines(
        '#include <string>',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'namespace rust {',
        'class MultiCasePrefixStripper {',
        ' public:',
        '  std::string StripPrefix(std::string name) const { return name; }',
        '};',
        '}  // namespace rust',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'hpb/status.h': lines(
        'namespace upb {',
        'class Status {',
        ' public:',
        '  Status() : ok_(true) {}',
        ' private:',
        '  bool ok_;',
        '};',
        '}  // namespace upb',
      ),
      'src/google/protobuf/compiler/python/generator.cc': lines(
        '#include <string>',
        '#include "absl/status/status.h"',
        '#include "absl/strings/strip.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'namespace python {',
        'std::string ModuleName(std::string name) {',
        '  auto status = absl::Status();',
        '  return absl::StripPrefix(name, "google.protobuf.");',
        '}',
        '}  // namespace python',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::compiler::python::ModuleName')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('every name strategy steps aside for a namespace', () => {
  it('the class named like the namespace, the best word guess, and a namespace the calling file opens', async () => {
    const cg = await indexed({
      'src/internal.h': lines(
        'namespace leveldb {',
        'class Internal {',
        ' public:',
        '  static void Fill(int n) {}',
        '};',
        'class LogWriter {',
        ' public:',
        '  void Flush() {}',
        '};',
        'class TableBuilder {',
        ' public:',
        '  void Flush() {}',
        '};',
        'class PyGenerator {',
        ' public:',
        '  static int Escape(int n) { return n; }',
        '};',
        '}  // namespace leveldb',
      ),
      'src/use.cc': lines(
        '#include "src/internal.h"',
        'namespace leveldb {',
        'namespace python {',
        'void Use(int n) {',
        '  internal::Fill(n);',
        '  log::Flush();',
        '  python::Escape(n);',
        '}',
        '}  // namespace python',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::python::Use')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('the constructor of a class a call names in its namespace', () => {
  it('is kept: protobuf\'s `internal::SourceWrapper<absl::Cord>(&data)` constructs the specialization', async () => {
    const cg = await indexed({
      'src/google/protobuf/message_lite.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'template <typename T>',
        'struct SourceWrapper;',
        '}  // namespace internal',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/message_lite.cc': lines(
        '#include "google/protobuf/message_lite.h"',
        '#include "absl/strings/cord.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'template <>',
        'struct SourceWrapper<absl::Cord> {',
        '  explicit SourceWrapper(const absl::Cord* c) : cord(c) {}',
        '  const absl::Cord* cord;',
        '};',
        '}  // namespace internal',
        'int ParseCord(const absl::Cord& data) {',
        '  auto source = internal::SourceWrapper<absl::Cord>(&data);',
        '  return source.cord == nullptr;',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      const constructors = cg.getNodesByKind('method').filter((n) => n.name === 'SourceWrapper');
      expect(constructors).toHaveLength(1);
      expect(calls(cg, 'google::protobuf::ParseCord')).toEqual([`method ${constructors[0]!.qualifiedName} (src/google/protobuf/message_lite.cc)`]);
    } finally {
      cg.close();
    }
  });

  it('but not a method of another template\'s specialization: `fmt::scan<int>(…)` is no `scanner<num>::scan`', async () => {
    const cg = await indexed({
      'include/fmt/base.h': FMT['include/fmt/base.h'],
      'test/scan.h': lines(
        '#include "fmt/base.h"',
        'FMT_BEGIN_NAMESPACE',
        'template <typename T> struct scanner;',
        'template <typename... T> int scan(const char* input) { return 0; }',
        'FMT_END_NAMESPACE',
      ),
      'test/scan-test.cc': lines(
        '#include "scan.h"',
        'struct num {',
        '  int value;',
        '};',
        'namespace fmt {',
        'template <> struct scanner<num> {',
        '  int scan(num& n) const { return n.value; }',
        '};',
        '}  // namespace fmt',
        'int Scan() { return fmt::scan<int>("42"); }',
      ),
    });
    try {
      expect(calls(cg, 'Scan')).toEqual(['function scan (test/scan.h)']);
    } finally {
      cg.close();
    }
  });
});

describe('a lowercase qualifier that is a type is untouched', () => {
  it('a typedef the class declares: rocksdb\'s `hash_table::Insert` is HashTable::Insert', async () => {
    const cg = await indexed({
      'utilities/persistent_cache/hash_table_evictable.h': lines(
        'namespace rocksdb {',
        'template <class T, class Hash, class Equal>',
        'class HashTable {',
        ' public:',
        '  bool Insert(const T& t) { return true; }',
        '};',
        'template <class T, class Hash, class Equal>',
        'class EvictableHashTable : private HashTable<T*, Hash, Equal> {',
        ' public:',
        '  typedef HashTable<T*, Hash, Equal> hash_table;',
        '  bool Insert(T* t) { return hash_table::Insert(t); }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::EvictableHashTable::Insert')).toEqual([
        'method rocksdb::HashTable::Insert (utilities/persistent_cache/hash_table_evictable.h)',
      ]);
    } finally {
      cg.close();
    }
  });

  it('an alias the calling function declares, a template parameter\'s default, and a class', async () => {
    const cg = await indexed({
      'util/ring.h': lines(
        'namespace rocksdb {',
        'class RingBuffer {',
        ' public:',
        '  static int Capacity() { return 8; }',
        '};',
        'struct default_policy {',
        '  static int apply() { return 1; }',
        '};',
        'class string_buffer {',
        ' public:',
        '  static int initial_size() { return 500; }',
        '};',
        'using ring_buffer = RingBuffer;',
        '}  // namespace rocksdb',
      ),
      'util/ring.cc': lines(
        '#include "util/ring.h"',
        'namespace rocksdb {',
        'int Capacity() {',
        '  using ring = RingBuffer;',
        '  return ring::Capacity();',
        '}',
        'int HeaderCapacity() { return ring_buffer::Capacity(); }',
        'template <typename policy = default_policy>',
        'int Apply() { return policy::apply(); }',
        'int InitialSize() { return string_buffer::initial_size(); }',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Capacity')).toEqual(['method rocksdb::RingBuffer::Capacity (util/ring.h)']);
      expect(calls(cg, 'rocksdb::HeaderCapacity')).toEqual(['method rocksdb::RingBuffer::Capacity (util/ring.h)']);
      expect(calls(cg, 'rocksdb::Apply')).toEqual(['method rocksdb::default_policy::apply (util/ring.h)']);
      expect(calls(cg, 'rocksdb::InitialSize')).toEqual(['method rocksdb::string_buffer::initial_size (util/ring.h)']);
    } finally {
      cg.close();
    }
  });
});
