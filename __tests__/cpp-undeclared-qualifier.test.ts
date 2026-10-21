/**
 * A C++ call through a class the index doesn't hold — `FeatureSet::descriptor()`
 * — gets no edge, rather than a guess by the words the qualifier shares with
 * some other class's name.
 *
 * protocolbuffers/protobuf declares `FeatureSet` in `descriptor.pb.h`, which is
 * over the indexer's file-size cap, so no class of that name is indexed. The
 * call fell through to the last strategy, which scores every method named
 * `descriptor` by the words its class shares with the qualifier, and picked
 * `pb::JavaFeatures_NestInFileClassFeature::descriptor` ("Feature"). The
 * Python extension's `OneofOptions::default_instance()` went to
 * `pb::file::CppFileOptions::default_instance` ("Options"). A class whose name
 * only shares a word with the qualifier is, by construction, another class:
 * one named like the qualifier would have been found first.
 *
 * Untouched: a qualifier the index holds (a class, a nested class, an alias),
 * a namespace, and a name the calling file makes something itself — a
 * template parameter, an alias it declares in a function body or through a
 * macro it expands, googletest's `TestFixture` in a typed test. So is the one
 * method of a name in the project, which is still taken: protobuf's
 * `MapTestPeer`, declared in a `.inc` file the index doesn't read as C++,
 * reaches the one `CalculateHiCutoff` there is, the `KeyMapBase` method it
 * hands on to.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-undeclared-'));
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

/** Where the `calls` edges written in `file` lead, as `name @ file:line` of each target. */
function callsFrom(cg: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const caller of [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')]) {
    if (caller.filePath !== file) continue;
    for (const r of cg.getCallees(caller.id)) {
      if (r.edge.kind === 'calls') out.push(`${r.node.name} @ ${r.node.filePath}:${r.node.startLine}`);
    }
  }
  return out.sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** protobuf's classes whose methods share their names with the generated messages' ones. */
const PROTOBUF = {
  'src/google/protobuf/compiler/java/java_features.pb.h': lines(
    'namespace pb {',
    'class JavaFeatures_NestInFileClassFeature {',
    ' public:',
    '  static const void* descriptor() { return nullptr; }',
    '  static const void* GetDescriptor() { return nullptr; }',
    '  static const JavaFeatures_NestInFileClassFeature& default_instance() { return *instance_; }',
    ' private:',
    '  static JavaFeatures_NestInFileClassFeature* instance_;',
    '};',
    '}  // namespace pb',
  ),
  'src/google/protobuf/cpp_file_options.pb.h': lines(
    'namespace pb {',
    'namespace file {',
    'class CppFileOptions {',
    ' public:',
    '  static const CppFileOptions& default_instance() { return *instance_; }',
    ' private:',
    '  static CppFileOptions* instance_;',
    '};',
    '}  // namespace file',
    '}  // namespace pb',
  ),
  'src/google/protobuf/compiler/plugin.pb.h': lines(
    'namespace google {',
    'namespace protobuf {',
    'namespace compiler {',
    'class CodeGeneratorResponse_File {',
    ' public:',
    '  static const CodeGeneratorResponse_File& default_instance() { return *instance_; }',
    ' private:',
    '  static CodeGeneratorResponse_File* instance_;',
    '};',
    '}  // namespace compiler',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  'src/google/protobuf/message.h': lines(
    'namespace google {',
    'namespace protobuf {',
    'class Message {',
    ' public:',
    '  const void* GetDescriptor() const { return nullptr; }',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  'src/google/protobuf/compiler/cpp/message.h': lines(
    'namespace google {',
    'namespace protobuf {',
    'namespace compiler {',
    'namespace cpp {',
    'class MessageGenerator {',
    ' public:',
    '  const void* descriptor() const { return descriptor_; }',
    ' private:',
    '  const void* descriptor_;',
    '};',
    '}  // namespace cpp',
    '}  // namespace compiler',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
  // `descriptor.pb.h`, which declares FeatureSet and the options messages, is
  // over the size cap; its `.cc` defines some of their methods out of line.
  'src/google/protobuf/descriptor.pb.cc': lines(
    '#include "google/protobuf/descriptor.pb.h"',
    'namespace google {',
    'namespace protobuf {',
    'void FeatureSet::Clear() {}',
    '}  // namespace protobuf',
    '}  // namespace google',
  ),
};

describe('a C++ call through a class the index does not hold', () => {
  it('reproduction: `FeatureSet::descriptor()` is no JavaFeatures_NestInFileClassFeature::descriptor', async () => {
    const cg = await indexed({
      ...PROTOBUF,
      'src/google/protobuf/compiler/code_generator.cc': lines(
        '#include "google/protobuf/compiler/code_generator.h"',
        '#include "google/protobuf/descriptor.pb.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace compiler {',
        'const void* FeatureSetDescriptor() {',
        '  return FeatureSet::descriptor();',
        '}',
        '}  // namespace compiler',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::compiler::FeatureSetDescriptor')).toEqual([]);
      const decoy = callable(cg, 'pb::JavaFeatures_NestInFileClassFeature::descriptor');
      expect(cg.getCallers(decoy.id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the Python extension\'s options and source-info defaults, and a message a using-declaration names', async () => {
    const cg = await indexed({
      ...PROTOBUF,
      'python/google/protobuf/pyext/descriptor.cc': lines(
        '#include "google/protobuf/descriptor.pb.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace python {',
        'const void* Defaults() {',
        '  const void* a = &OneofOptions::default_instance();',
        '  const void* b = &ServiceOptions::default_instance();',
        '  const void* c = &SourceCodeInfo::default_instance();',
        '  return FeatureSetDefaults::GetDescriptor() ? a : b ? b : c;',
        '}',
        '}  // namespace python',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'editions/generated_files_test.cc': lines(
        '#include "editions/golden/editions_default.pb.h"',
        'using ::protobuf_editions_test::EditionsDefaultMessage;',
        'namespace google {',
        'namespace protobuf {',
        'const void* DefaultDescriptor() {',
        '  return EditionsDefaultMessage::descriptor();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::python::Defaults')).toEqual([]);
      expect(calls(cg, 'google::protobuf::DefaultDescriptor')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a method the class defines out of line is still found by its qualified name', async () => {
    const cg = await indexed({
      ...PROTOBUF,
      'src/google/protobuf/descriptor.cc': lines(
        '#include "google/protobuf/descriptor.pb.h"',
        'namespace google {',
        'namespace protobuf {',
        'void ResetFeatures() {',
        '  FeatureSet::Clear();',
        '  FeatureSet::descriptor();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::ResetFeatures')).toEqual(['google::protobuf::FeatureSet::Clear']);
    } finally {
      cg.close();
    }
  });
});

describe('qualified calls the index can place are untouched', () => {
  it('a project class, and a nested class from inside its owner', async () => {
    const cg = await indexed({
      'arena.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class Arena {',
        ' public:',
        '  static void* Create(int n) { return nullptr; }',
        '};',
        'class ArenaStringPtr {',
        ' public:',
        '  static void* Create(int n) { return nullptr; }',
        '};',
        'class Outer {',
        ' public:',
        '  class Inner {',
        '   public:',
        '    static int Count() { return 0; }',
        '  };',
        '  int Total() { return Inner::Count(); }',
        '};',
        'class InnerCounter {',
        ' public:',
        '  static int Count() { return 1; }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'arena.cc': lines(
        '#include "arena.h"',
        'namespace google {',
        'namespace protobuf {',
        'void* Make() { return Arena::Create(1); }',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Make')).toEqual(['google::protobuf::Arena::Create']);
      expect(calls(cg, 'google::protobuf::Outer::Total')).toEqual(['google::protobuf::Outer::Inner::Count']);
    } finally {
      cg.close();
    }
  });

  it('a project namespace, a namespace alias, and abseil', async () => {
    const cg = await indexed({
      'util/strings.h': lines(
        'namespace Util {',
        'inline int Trim(int x) { return x; }',
        '}  // namespace Util',
        'namespace proto {',
        'namespace wire {',
        'inline int Format(int x) { return x; }',
        '}  // namespace wire',
        '}  // namespace proto',
      ),
      'util/use.cc': lines(
        '#include "util/strings.h"',
        '#include "absl/strings/str_cat.h"',
        'namespace Wire = proto::wire;',
        'int Use(int x) {',
        '  return Util::Trim(x) + Wire::Format(x) + absl::StrCat(x);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['Util::Trim', 'proto::wire::Format']);
    } finally {
      cg.close();
    }
  });
});

/** rocksdb's ribbon solutions: an alias named after one shares a word with it. */
const RIBBON = {
  'util/ribbon_impl.h': lines(
    'namespace rocksdb {',
    'namespace ribbon {',
    'template <class TypesAndSettings>',
    'class InMemSimpleSolution {',
    ' public:',
    '  static int RoundUpNumSlots(int n) { return n; }',
    '};',
    'template <class TypesAndSettings>',
    'class SerializableInterleavedSolution {',
    ' public:',
    '  static int RoundUpNumSlots(int n) { return n; }',
    '};',
    '}  // namespace ribbon',
    '}  // namespace rocksdb',
    '#define IMPORT_RIBBON_IMPL_TYPES(TypesAndSettings)                        \\',
    '  using SimpleSoln =                                                      \\',
    '      rocksdb::ribbon::InMemSimpleSolution<TypesAndSettings>;             \\',
    '  using InterleavedSoln =                                                 \\',
    '      rocksdb::ribbon::SerializableInterleavedSolution<TypesAndSettings>; \\',
    '  static_assert(sizeof(SimpleSoln) > 0, "semicolon expected after macro call")',
  ),
};

describe('a name the calling file makes something itself', () => {
  it('an alias a macro the file expands declares (rocksdb\'s IMPORT_RIBBON_IMPL_TYPES)', async () => {
    const cg = await indexed({
      ...RIBBON,
      'util/ribbon_test.cc': lines(
        '#include "util/ribbon_impl.h"',
        'template <typename TypeParam>',
        'int RoundUp(int n) {',
        '  IMPORT_RIBBON_IMPL_TYPES(TypeParam);',
        '  return SimpleSoln::RoundUpNumSlots(n) + InterleavedSoln::RoundUpNumSlots(n);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'RoundUp')).toEqual([
        'rocksdb::ribbon::InMemSimpleSolution::RoundUpNumSlots',
        'rocksdb::ribbon::SerializableInterleavedSolution::RoundUpNumSlots',
      ]);
    } finally {
      cg.close();
    }
  });

  it('an alias the calling function declares with `using` or `typedef`, and one the index holds', async () => {
    const cg = await indexed({
      ...RIBBON,
      'util/ribbon_alias.h': lines(
        '#include "util/ribbon_impl.h"',
        'namespace rocksdb {',
        'using InterleavedSoln = ribbon::SerializableInterleavedSolution<int>;',
        '}  // namespace rocksdb',
      ),
      'util/ribbon_bench.cc': lines(
        '#include "util/ribbon_alias.h"',
        'namespace rocksdb {',
        'int Slots(int n) {',
        '  using SimpleSoln = ribbon::InMemSimpleSolution<int>;',
        '  return SimpleSoln::RoundUpNumSlots(n) + InterleavedSoln::RoundUpNumSlots(n);',
        '}',
        'int OldStyleSlots(int n) {',
        '  typedef ribbon::InMemSimpleSolution<long> SimpleSolnT;',
        '  return SimpleSolnT::RoundUpNumSlots(n);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Slots')).toEqual([
        'rocksdb::ribbon::InMemSimpleSolution::RoundUpNumSlots',
        'rocksdb::ribbon::SerializableInterleavedSolution::RoundUpNumSlots',
      ]);
      expect(calls(cg, 'rocksdb::OldStyleSlots')).toEqual(['rocksdb::ribbon::InMemSimpleSolution::RoundUpNumSlots']);
    } finally {
      cg.close();
    }
  });

  it('a template parameter with a default argument (fmt\'s `Traits::count()`)', async () => {
    const cg = await indexed({
      'include/fmt/base.h': lines(
        'namespace fmt {',
        'namespace detail {',
        'class buffer_traits {',
        ' public:',
        '  static int count() { return 0; }',
        '};',
        'class fixed_buffer {',
        ' public:',
        '  static int count() { return 0; }',
        '};',
        'template <typename OutputIt, typename T,',
        '          typename Traits = buffer_traits>',
        'class iterator_buffer : public Traits {',
        ' public:',
        '  int count() const { return Traits::count() + 1; }',
        '};',
        '}  // namespace detail',
        '}  // namespace fmt',
      ),
    });
    try {
      expect(calls(cg, 'fmt::detail::iterator_buffer::count')).toEqual(['fmt::detail::buffer_traits::count']);
    } finally {
      cg.close();
    }
  });

  it('googletest\'s `TestFixture` in a typed test', async () => {
    const cg = await indexed({
      'upb/util/required_fields_test.cc': lines(
        '#include <gtest/gtest.h>',
        'template <typename T>',
        'class RequiredFieldsTest : public testing::Test {',
        ' public:',
        '  void CheckRequired(const char* json) {}',
        '};',
        'class FieldsChecker {',
        ' public:',
        '  void CheckRequired(const char* json) {}',
        '};',
        'TYPED_TEST_SUITE(RequiredFieldsTest, MyTypes);',
        'TYPED_TEST(RequiredFieldsTest, Empty) {',
        '  TestFixture::CheckRequired("{}");',
        '}',
      ),
    });
    try {
      const target = callable(cg, 'RequiredFieldsTest::CheckRequired');
      expect(callsFrom(cg, 'upb/util/required_fields_test.cc')).toEqual([`CheckRequired @ ${target.filePath}:${target.startLine}`]);
    } finally {
      cg.close();
    }
  });
});

describe('the one method of a name in the project', () => {
  it('is still taken, as before: protobuf\'s MapTestPeer, declared in a `.inc` file that is not read as C++', async () => {
    const cg = await indexed({
      'src/google/protobuf/map.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'class KeyMapBase {',
        ' public:',
        '  static unsigned long CalculateHiCutoff(unsigned long num_buckets) { return num_buckets * 3 / 4; }',
        '};',
        '}  // namespace internal',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      // `map_test.inc` declares MapTestPeer, whose CalculateHiCutoff hands on to KeyMapBase's.
      'src/google/protobuf/map_test.cc': lines(
        '#include "google/protobuf/map.h"',
        '#include "google/protobuf/map_test.inc"',
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'unsigned long HiCutoff(unsigned long capacity) {',
        '  return MapTestPeer::CalculateHiCutoff(capacity);',
        '}',
        '}  // namespace internal',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      const edges = cg.getCallees(callable(cg, 'google::protobuf::internal::HiCutoff').id).filter((r) => r.edge.kind === 'calls');
      expect(edges.map((r) => r.node.qualifiedName)).toEqual(['google::protobuf::internal::KeyMapBase::CalculateHiCutoff']);
      expect(edges[0]!.edge.metadata?.resolvedBy).toBe('instance-method');
    } finally {
      cg.close();
    }
  });
});
