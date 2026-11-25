/**
 * A C++ receiver declared with a namespace-qualified type calls a member of a
 * class that qualified name can be, never of a class that only shares its
 * last name. Three cases read that wrong:
 *
 * - A namespace a macro stands for. facebook/rocksdb declares its types in
 *   `namespace ROCKSDB_NAMESPACE` under `#define ROCKSDB_NAMESPACE rocksdb`,
 *   so the index names them `ROCKSDB_NAMESPACE::DB`. Code that writes
 *   `rocksdb::DB* db; db->Put(…)` read as a call on an outside type and got no
 *   edge, and `ROCKSDB_NAMESPACE::Cache` did the same where a file declares
 *   `namespace rocksdb` itself.
 * - A lowercase name a project type shares. `absl::flat_hash_set<int> seen;
 *   seen.insert(…)` reached the project's own `util::flat_hash_set::insert`:
 *   a lowercase outside type was told apart from the project's only when no
 *   project type had its name at all.
 * - A type whose last name finds only namesakes, where the receiver's
 *   declaration is none the call-site rules read (a macro body's, an `auto`
 *   variable's from another file's return type) or the type's namespace is
 *   one the project uses: protocolbuffers/protobuf's generated
 *   `DescriptorProto::ExtensionRange`, which the index doesn't hold, reached
 *   `Descriptor::ExtensionRange::options`, and `absl::Status _status` in a
 *   macro body `upb::Status::ok`.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-outside-'));
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

describe('a namespace a macro stands for is the project\'s', () => {
  const ROCKSDB = {
    'include/rocksdb/rocksdb_namespace.h': lines(
      '#ifndef ROCKSDB_NAMESPACE',
      '#define ROCKSDB_NAMESPACE rocksdb',
      '#endif',
    ),
    'include/rocksdb/db.h': lines(
      '#include "include/rocksdb/rocksdb_namespace.h"',
      'namespace ROCKSDB_NAMESPACE {',
      'class DB {',
      ' public:',
      '  int Put(int key) { return key; }',
      '};',
      '}  // namespace ROCKSDB_NAMESPACE',
    ),
    'upb/status.h': lines(
      'namespace upb {',
      'class Status {',
      ' public:',
      '  bool ok() const { return true; }',
      '};',
      '}  // namespace upb',
    ),
  };

  it('reproduction: `rocksdb::DB* db; db->Put(…)` is rocksdb\'s own DB', async () => {
    const cg = await indexed({
      ...ROCKSDB,
      'java/rocksjni/put.cc': lines(
        '#include "include/rocksdb/db.h"',
        'int Put(rocksdb::DB* db) {',
        '  return db->Put(1);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Put')).toEqual(['ROCKSDB_NAMESPACE::DB::Put']);
    } finally {
      cg.close();
    }
  });

  it('under either name, while a namespace the project declares nothing in stays outside', async () => {
    // This tree declares its types in `namespace rocksdb` itself, and code
    // names them through the macro.
    const cg = await indexed({
      'include/rocksdb/rocksdb_namespace.h': ROCKSDB['include/rocksdb/rocksdb_namespace.h'],
      'upb/status.h': ROCKSDB['upb/status.h'],
      'cache/cache.h': lines(
        'namespace rocksdb {',
        'class Cache {',
        ' public:',
        '  void Release(int handle) {}',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/release.cc': lines(
        '#include "include/rocksdb/rocksdb_namespace.h"',
        '#include "cache/cache.h"',
        '#include "upb/status.h"',
        'void Drop(ROCKSDB_NAMESPACE::Cache* cache) {',
        '  cache->Release(1);',
        '}',
        'bool Passed(const absl::Status& status) {',
        '  return status.ok();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Drop')).toEqual(['rocksdb::Cache::Release']);
      expect(calls(cg, 'Passed')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('a lowercase type from outside the project beside a namesake of the project\'s', () => {
  const UTIL = {
    'util/hash_set.h': lines(
      'namespace util {',
      'template <class T>',
      'class flat_hash_set {',
      ' public:',
      '  void insert(const T& v) {}',
      '};',
      '}  // namespace util',
    ),
  };

  it('reproduction: `absl::flat_hash_set<int> seen; seen.insert(…)` is not util::flat_hash_set\'s', async () => {
    const cg = await indexed({
      ...UTIL,
      'db/seen.cc': lines(
        '#include "absl/container/flat_hash_set.h"',
        '#include "util/hash_set.h"',
        'void Mark(int v) {',
        '  absl::flat_hash_set<int> seen;',
        '  seen.insert(v);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Mark')).toEqual([]);
      expect(cg.getCallers(callable(cg, 'util::flat_hash_set::insert').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the project\'s own, written with its namespace, a namespace alias, or one a macro opens', async () => {
    const cg = await indexed({
      ...UTIL,
      'include/fmt/format.h': lines(
        '#define FMT_BEGIN_NAMESPACE namespace fmt { inline namespace v11 {',
        '#define FMT_END_NAMESPACE } }',
        'FMT_BEGIN_NAMESPACE',
        'namespace detail {',
        'template <typename T>',
        'class buffer {',
        ' public:',
        '  void push_back(const T& value) {}',
        '};',
        '}  // namespace detail',
        'FMT_END_NAMESPACE',
      ),
      'other/buffer.h': lines(
        'namespace other {',
        'class buffer {',
        ' public:',
        '  void push_back(int value) {}',
        '};',
        '}  // namespace other',
      ),
      'db/keep.cc': lines(
        '#include "util/hash_set.h"',
        '#include "include/fmt/format.h"',
        'namespace u = util;',
        'void Keep(int v) {',
        '  util::flat_hash_set<int> mine;',
        '  mine.insert(v);',
        '}',
        'void Alias(int v) {',
        '  u::flat_hash_set<int> aliased;',
        '  aliased.insert(v);',
        '}',
        'void Append(fmt::detail::buffer<char>& buf) {',
        '  buf.push_back(\'x\');',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Keep')).toEqual(['util::flat_hash_set::insert']);
      expect(calls(cg, 'Alias')).toEqual(['util::flat_hash_set::insert']);
      expect(calls(cg, 'Append')).toEqual(['detail::buffer::push_back']);
    } finally {
      cg.close();
    }
  });
});

describe('a qualified type whose last name finds only namesakes', () => {
  /** protobuf's descriptor classes: `descriptor.pb.h` is too large to index, `descriptor.pb.cc` is not. */
  const DESCRIPTORS = {
    'src/google/protobuf/descriptor.h': lines(
      'namespace google {',
      'namespace protobuf {',
      'class Descriptor {',
      ' public:',
      '  class ExtensionRange {',
      '   public:',
      '    const int& options() const { return options_; }',
      '   private:',
      '    int options_;',
      '  };',
      '};',
      'namespace util {',
      'class SimpleFieldComparator {',
      ' public:',
      '  void set_treat_nan_as_equal(bool value) {}',
      '};',
      'class DefaultFieldComparator : public SimpleFieldComparator {};',
      '}  // namespace util',
      '}  // namespace protobuf',
      '}  // namespace google',
    ),
    'src/google/protobuf/descriptor.pb.cc': lines(
      'namespace google {',
      'namespace protobuf {',
      'class DescriptorProto::_Internal {',
      ' public:',
      '  using HasBits = int;',
      '};',
      'DescriptorProto::DescriptorProto() {}',
      'void DescriptorProto::Clear() {}',
      '}  // namespace protobuf',
      '}  // namespace google',
    ),
  };

  it('reproduction: a generated `DescriptorProto::ExtensionRange` is not `Descriptor::ExtensionRange`', async () => {
    const cg = await indexed({
      ...DESCRIPTORS,
      'src/google/protobuf/compiler/importer_unittest.cc': lines(
        '#include "src/google/protobuf/descriptor.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'int Options(const DescriptorProto::ExtensionRange& range) {',
        '  return range.options();',
        '}',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::compiler::Options')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a class whose methods alone are indexed, a base class\'s method, a template parameter\'s member', async () => {
    const cg = await indexed({
      ...DESCRIPTORS,
      // A namesake the written name can't be, beside the class only its methods show.
      'upb/reflection/descriptor_proto.h': lines(
        'namespace upb {',
        'class DescriptorProto {};',
        '}  // namespace upb',
      ),
      'hpb/iterator.h': lines(
        'namespace hpb {',
        'namespace internal {',
        'struct ScalarIteratorPolicy {',
        '  struct Payload {',
        '    void AddOffset(int n) {}',
        '  };',
        '};',
        'template <typename PolicyT>',
        'class Iterator {',
        ' private:',
        '  typename PolicyT::Payload it_;',
        ' public:',
        '  void Next() { it_.AddOffset(1); }',
        '};',
        '}  // namespace internal',
        '}  // namespace hpb',
      ),
      'src/google/protobuf/compiler/reset.cc': lines(
        '#include "src/google/protobuf/descriptor.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'void Reset(google::protobuf::DescriptorProto* proto) {',
        '  proto->Clear();',
        '}',
        'void Compare() {',
        '  google::protobuf::util::DefaultFieldComparator comparator;',
        '  comparator.set_treat_nan_as_equal(true);',
        '}',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::compiler::Reset')).toEqual(['google::protobuf::DescriptorProto::Clear']);
      expect(calls(cg, 'google::protobuf::compiler::Compare')).toEqual(['google::protobuf::util::SimpleFieldComparator::set_treat_nan_as_equal']);
      expect(calls(cg, 'hpb::internal::Iterator::Next')).toEqual(['hpb::internal::ScalarIteratorPolicy::Payload::AddOffset']);
    } finally {
      cg.close();
    }
  });

  it('a nested type a derived class inherits, named through the derived class', async () => {
    // Its namespace is a class of the project's, so the written name is never
    // judged: `ns::Derived::Node` is `ns::Base::Node`.
    const cg = await indexed({
      'src/tree.h': lines(
        'namespace ns {',
        'struct Base {',
        '  struct Node {',
        '    void Visit() {}',
        '  };',
        '};',
        'struct Derived : Base {};',
        '}  // namespace ns',
      ),
      'src/walk.cc': lines(
        '#include "src/tree.h"',
        'void Root() {',
        '  ns::Derived::Node node;',
        '}',
        'void Walk() {',
        '  node.Visit();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Walk')).toEqual(['ns::Base::Node::Visit']);
    } finally {
      cg.close();
    }
  });

  it('an outside type no project class shares a name with stays past guessing', async () => {
    // The declaration is another function's, so only the rule for a type no
    // class has decides: a `->` on it is no guess at the one project `Read`.
    const cg = await indexed({
      'src/stream.h': lines(
        'class Stream {',
        ' public:',
        '  bool Read(int n) { return n > 0; }',
        '};',
      ),
      'src/client.cc': lines(
        '#include "src/stream.h"',
        'void Open() {',
        '  grpc::ClientReader<int> reader;',
        '}',
        'bool Pump() {',
        '  return reader->Read(1);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Pump')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a `->` on an outside holder of a class the project shares a name with reaches what it holds', async () => {
    const cg = await indexed({
      'util/optional.h': lines(
        'namespace util {',
        'template <typename T>',
        'class Optional {',
        ' public:',
        '  bool has_value() const { return true; }',
        '};',
        '}  // namespace util',
      ),
      'src/widget.h': lines(
        'class Widget {',
        ' public:',
        '  void Draw() {}',
        '};',
      ),
      'src/paint.cc': lines(
        '#include "util/optional.h"',
        '#include "src/widget.h"',
        'void Load() {',
        '  folly::Optional<Widget> widget;',
        '}',
        'void Paint() {',
        '  widget->Draw();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Paint')).toEqual(['Widget::Draw']);
    } finally {
      cg.close();
    }
  });
});
