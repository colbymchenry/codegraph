/**
 * A C++ base class — `class DynamicMessage final : public Message` — is the
 * class C++ name lookup finds from where the deriving class is declared.
 *
 * The base was matched by its name alone, so one named like a class of
 * another namespace bound to whichever namesake ranked first.
 * protocolbuffers/protobuf's `google::protobuf::DynamicMessage` derived from
 * `json_internal::ResolverPool::Message` (and, before #2397, from the PHP
 * extension's C struct `Message`); google/leveldb's iterators derived from
 * `SkipList::Iterator`, and its test comparators from a struct
 * `skiplist_test.cc` declares for itself. The wrong supertype then fed the
 * type hierarchy, the cpp-override edges from a base method to its overrides,
 * and the supertype walk that resolves a call to an inherited method.
 *
 * The lookup goes outwards from the scope the class is declared in: a class
 * scope with its bases, a qualified name a segment at a time, an alias
 * followed to the class it names, `::Base` from the global scope. Then
 * through what the file writes before the class: a namespace alias, a
 * using-declaration, a using-directive. A class a source file defines is that
 * translation unit's own. A template parameter names no class. When none of
 * that finds it, a class of that name the file can see is taken only when it
 * is the only one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  // protocolbuffers/protobuf: the real `Message`, a nested namesake in
  // json_internal, and the PHP extension's C struct.
  'src/google/protobuf/message_lite.h': [
    'namespace google {',
    'namespace protobuf {',
    'namespace internal {',
    'class MessageGlobalsBase {',
    ' public:',
    '  int default_instance() const { return 0; }',
    '};',
    '}  // namespace internal',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'src/google/protobuf/message.h': [
    '#include "google/protobuf/message_lite.h"',
    'namespace google {',
    'namespace protobuf {',
    'class Message {',
    ' public:',
    '  virtual ~Message();',
    '  virtual int ByteSizeLong() const = 0;',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'src/google/protobuf/json/internal/untyped_message.h': [
    'namespace google {',
    'namespace protobuf {',
    'namespace json_internal {',
    'class ResolverPool {',
    ' public:',
    '  class Message {',
    '   public:',
    '    int ByteSizeLong() const { return 0; }',
    '  };',
    '};',
    '}  // namespace json_internal',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'php/ext/google/protobuf/message.c': [
    'typedef struct {',
    '  int std;',
    '} Message;',
    '',
  ].join('\n'),
  'src/google/protobuf/dynamic_message.cc': [
    '#include "google/protobuf/message.h"',
    'namespace google {',
    'namespace protobuf {',
    'class DynamicMessage final : public Message {',
    ' public:',
    '  int ByteSizeLong() const override { return 1; }',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'src/google/protobuf/generated_message_bases.h': [
    '#include "google/protobuf/message.h"',
    'namespace google {',
    'namespace protobuf {',
    'namespace internal {',
    'class ZeroFieldsBase : public Message {',
    ' public:',
    '  int ByteSizeLong() const override { return 0; }',
    '};',
    '}  // namespace internal',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  // Generated code names its bases through a namespace alias.
  'src/google/protobuf/any.pb.cc': [
    '#include "google/protobuf/message_lite.h"',
    'namespace _pbi = ::google::protobuf::internal;',
    'namespace google {',
    'namespace protobuf {',
    'struct AnyGlobalsTypeInternal : ::_pbi::MessageGlobalsBase {',
    '  int x;',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),

  // google/leveldb: the public iterator, the skip list's nested one, a test's
  // own `Comparator`, and the C API's using-declarations.
  'include/leveldb/iterator.h': [
    'namespace leveldb {',
    'class Iterator {',
    ' public:',
    '  virtual ~Iterator();',
    '  virtual bool Valid() const = 0;',
    '  virtual void Next() = 0;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/skiplist.h': [
    'namespace leveldb {',
    'template <typename Key, class Comparator>',
    'class SkipList {',
    ' public:',
    '  class Iterator {',
    '   public:',
    '    bool Valid() const { return node_ != nullptr; }',
    '    void Next() { node_ = nullptr; }',
    '    void SeekToFirst() { node_ = nullptr; }',
    '   private:',
    '    const char* node_;',
    '  };',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/db_iter.cc': [
    '#include "include/leveldb/iterator.h"',
    'namespace leveldb {',
    'class DBIter : public Iterator {',
    ' public:',
    '  bool Valid() const override { return valid_; }',
    '  void Next() override { valid_ = false; }',
    ' private:',
    '  bool valid_;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'include/leveldb/comparator.h': [
    'namespace leveldb {',
    'class Comparator {',
    ' public:',
    '  virtual int Compare(const char* a, const char* b) const = 0;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/skiplist_test.cc': [
    'namespace leveldb {',
    'struct Comparator {',
    '  int operator()(const int& a, const int& b) const { return a - b; }',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/db_test.cc': [
    '#include "include/leveldb/comparator.h"',
    'namespace leveldb {',
    'class NumberComparator : public Comparator {',
    ' public:',
    '  int Compare(const char* a, const char* b) const override { return 0; }',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'include/leveldb/filter_policy.h': [
    'namespace leveldb {',
    'class FilterPolicy {',
    ' public:',
    '  virtual const char* Name() const = 0;',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'db/c.cc': [
    '#include "include/leveldb/filter_policy.h"',
    'using leveldb::FilterPolicy;',
    'struct leveldb_filterpolicy_t : public FilterPolicy {',
    '  const char* Name() const override { return "c"; }',
    '};',
    '',
  ].join('\n'),

  // facebook/rocksdb: a nested class's base is a member its outer class
  // inherits; a base named through an alias; a using-directive.
  'cache/clock_cache.h': [
    'namespace rocksdb {',
    'namespace clock_cache {',
    'class BaseClockTable {',
    ' public:',
    '  struct BaseOpts {',
    '    int eviction_effort_cap;',
    '  };',
    '};',
    'class AutoHyperClockTable : public BaseClockTable {',
    ' public:',
    '  struct Opts : public BaseOpts {',
    '    int min_avg_value_size;',
    '  };',
    '};',
    '}  // namespace clock_cache',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'cache/lru_cache.h': [
    'namespace rocksdb {',
    'namespace lru_cache {',
    'struct BaseOpts {',
    '  int capacity;',
    '};',
    '}  // namespace lru_cache',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'table/internal_iterator.h': [
    'namespace rocksdb {',
    'class Slice {};',
    'template <class TValue>',
    'class InternalIteratorBase {',
    ' public:',
    '  virtual void Next() = 0;',
    '  void SeekToFirst() {}',
    '};',
    'using InternalIterator = InternalIteratorBase<Slice>;',
    'template <bool B> using bool_constant = std::integral_constant<bool, B>;',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'table/merging_iterator.cc': [
    '#include "table/internal_iterator.h"',
    'namespace rocksdb {',
    'class MergingIterator : public InternalIterator {',
    ' public:',
    '  void Next() override {}',
    '};',
    'void Rewind(MergingIterator* iter) {',
    '  iter->SeekToFirst();',
    '}',
    'template <typename T>',
    'struct is_fast_float : bool_constant<sizeof(T) <= sizeof(double)> {};',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'include/rocksdb/listener.h': [
    'namespace rocksdb {',
    'class EventListener {',
    ' public:',
    '  virtual void OnFlushCompleted() {}',
    '};',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'examples/compact_files_example.cc': [
    '#include "include/rocksdb/listener.h"',
    'using namespace rocksdb;',
    'class Compactor : public EventListener {',
    ' public:',
    '  void OnFlushCompleted() override {}',
    '};',
    '',
  ].join('\n'),

  // googletest: a base named from the global scope.
  'test/gtest/gtest.h': [
    'namespace testing {',
    'class Test {',
    ' public:',
    '  virtual void TestBody() = 0;',
    '};',
    'namespace internal {',
    'class SuiteApiResolver {',
    ' public:',
    '  typedef int Test;',
    '};',
    '}  // namespace internal',
    '}  // namespace testing',
    '',
  ].join('\n'),
  'test/gtest-extra-test.cc': [
    '#include "test/gtest/gtest.h"',
    'class single_evaluation_test : public ::testing::Test {',
    ' protected:',
    '  void TestBody() override {}',
    '};',
    '',
  ].join('\n'),

  // A template parameter names no class, whatever the project declares.
  'util/mixin.h': [
    'class Base {',
    ' public:',
    '  void Run() {}',
    '};',
    'template <class Base>',
    'class Logged : public Base {',
    ' public:',
    '  void Log() {}',
    '};',
    '',
  ].join('\n'),

  // A header's using-directive the file itself does not repeat.
  'util/testharness.h': [
    '#include "include/leveldb/env.h"',
    'using namespace leveldb;',
    '',
  ].join('\n'),
  'include/leveldb/env.h': [
    'namespace leveldb {',
    'class EnvWrapper {',
    ' public:',
    '  virtual int NowMicros() { return 0; }',
    '};',
    '}  // namespace leveldb',
    '',
  ].join('\n'),
  'util/env_test.cc': [
    '#include "util/testharness.h"',
    'class SleepingEnv : public EnvWrapper {',
    ' public:',
    '  int NowMicros() override { return 1; }',
    '};',
    '',
  ].join('\n'),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-bases-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function node(qualifiedName: string, file: string): Node {
  const name = qualifiedName.split('::').pop()!;
  const found = cg.getNodesByName(name).filter((n) => n.qualifiedName === qualifiedName && n.filePath === file && n.kind !== 'import');
  expect(found, `${qualifiedName} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** The supertypes of a class, as `kind qualifiedName (file) resolvedBy`. */
function supertypes(qualifiedName: string, file: string): string[] {
  return cg
    .getOutgoingEdgesFrom([node(qualifiedName, file).id], ['extends', 'implements'])
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${e.kind} ${target?.qualifiedName} (${target?.filePath}) ${String(e.metadata?.resolvedBy)}`;
    })
    .sort();
}

/** The base names a class's file names that stay unresolved. */
function unresolved(qualifiedName: string, file: string): string[] {
  return cg
    .getUnresolvedReferencesFrom(node(qualifiedName, file).id)
    .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
    .map((r) => r.referenceName)
    .sort();
}

describe('a C++ base class is the one name lookup finds from the deriving class', () => {
  it('finds the base in the namespaces around the class, not a namesake elsewhere', () => {
    expect(supertypes('google::protobuf::DynamicMessage', 'src/google/protobuf/dynamic_message.cc')).toEqual([
      'extends google::protobuf::Message (src/google/protobuf/message.h) qualified-name',
    ]);
    expect(supertypes('google::protobuf::internal::ZeroFieldsBase', 'src/google/protobuf/generated_message_bases.h')).toEqual([
      'extends google::protobuf::Message (src/google/protobuf/message.h) qualified-name',
    ]);
    expect(supertypes('leveldb::DBIter', 'db/db_iter.cc')).toEqual([
      'extends leveldb::Iterator (include/leveldb/iterator.h) qualified-name',
    ]);
  });

  it('never takes a class another source file defines for its own translation unit', () => {
    expect(supertypes('leveldb::NumberComparator', 'db/db_test.cc')).toEqual([
      'extends leveldb::Comparator (include/leveldb/comparator.h) qualified-name',
    ]);
  });

  it('looks a nested class base up in its outer class and the classes that one inherits', () => {
    expect(supertypes('rocksdb::clock_cache::AutoHyperClockTable::Opts', 'cache/clock_cache.h')).toEqual([
      'extends rocksdb::clock_cache::BaseClockTable::BaseOpts (cache/clock_cache.h) qualified-name',
    ]);
  });

  it('reads the namespace aliases, using-declarations and using-directives the file writes', () => {
    expect(supertypes('google::protobuf::AnyGlobalsTypeInternal', 'src/google/protobuf/any.pb.cc')).toEqual([
      'extends google::protobuf::internal::MessageGlobalsBase (src/google/protobuf/message_lite.h) qualified-name',
    ]);
    expect(supertypes('leveldb_filterpolicy_t', 'db/c.cc')).toEqual([
      'extends leveldb::FilterPolicy (include/leveldb/filter_policy.h) qualified-name',
    ]);
    expect(supertypes('Compactor', 'examples/compact_files_example.cc')).toEqual([
      'extends rocksdb::EventListener (include/rocksdb/listener.h) qualified-name',
    ]);
  });

  it('finds `::testing::Test` from the global scope, not a nested `Test` typedef', () => {
    expect(supertypes('single_evaluation_test', 'test/gtest-extra-test.cc')).toEqual([
      'extends testing::Test (test/gtest/gtest.h) qualified-name',
    ]);
  });

  it('follows an alias to the class it names, and links an alias of an outside type itself', () => {
    expect(supertypes('rocksdb::MergingIterator', 'table/merging_iterator.cc')).toEqual([
      'extends rocksdb::InternalIteratorBase (table/internal_iterator.h) qualified-name',
    ]);
    // `bool_constant<sizeof(T) <= sizeof(double)>`: the comparison is no template bracket.
    expect(supertypes('rocksdb::is_fast_float', 'table/merging_iterator.cc')).toEqual([
      'extends rocksdb::bool_constant (table/internal_iterator.h) qualified-name',
    ]);
  });

  it('leaves a template parameter unresolved', () => {
    expect(supertypes('Logged', 'util/mixin.h')).toEqual([]);
    expect(unresolved('Logged', 'util/mixin.h')).toEqual(['Base']);
  });

  it('takes the only class of that name the file can see when the lookup finds none', () => {
    // `using namespace leveldb;` is in a header the file includes.
    expect(supertypes('SleepingEnv', 'util/env_test.cc')).toEqual([
      'extends leveldb::EnvWrapper (include/leveldb/env.h) exact-match',
    ]);
  });

  it('never resolves a C or C++ base through a framework resolver or to another language', () => {
    const bases = cg
      .getNodesByKind('class')
      .concat(cg.getNodesByKind('struct'))
      .filter((n) => n.language === 'cpp' || n.language === 'c');
    const edges = cg.getOutgoingEdgesFrom(bases.map((n) => n.id), ['extends', 'implements']);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      const target = cg.getNode(e.target);
      expect(e.metadata?.resolvedBy, `${cg.getNode(e.source)?.qualifiedName} → ${target?.qualifiedName}`).not.toBe('framework');
      expect(['c', 'cpp']).toContain(target?.language);
    }
    expect(cg.getIncomingEdgesTo([node('Message', 'php/ext/google/protobuf/message.c').id], ['extends'])).toEqual([]);
  });
});

describe('what the hierarchy feeds', () => {
  it('links each base method to the overrides of the right subclasses', () => {
    const overrides = (qualifiedName: string, file: string): string[] =>
      cg
        .getOutgoingEdgesFrom([node(qualifiedName, file).id], ['calls'])
        .filter((e) => e.metadata?.synthesizedBy === 'cpp-override')
        .map((e) => cg.getNode(e.target)?.qualifiedName ?? '')
        .sort();
    expect(overrides('leveldb::Iterator::Next', 'include/leveldb/iterator.h')).toEqual(['leveldb::DBIter::Next']);
    expect(overrides('leveldb::SkipList::Iterator::Next', 'db/skiplist.h')).toEqual([]);
    expect(overrides('google::protobuf::Message::ByteSizeLong', 'src/google/protobuf/message.h')).toEqual([
      'google::protobuf::DynamicMessage::ByteSizeLong',
      'google::protobuf::internal::ZeroFieldsBase::ByteSizeLong',
    ]);
    expect(overrides('google::protobuf::json_internal::ResolverPool::Message::ByteSizeLong', 'src/google/protobuf/json/internal/untyped_message.h')).toEqual([]);
    // Through the alias: InternalIterator is InternalIteratorBase.
    expect(overrides('rocksdb::InternalIteratorBase::Next', 'table/internal_iterator.h')).toEqual(['rocksdb::MergingIterator::Next']);
  });

  it('resolves a call to an inherited method on the base an alias names', () => {
    const callees = cg
      .getOutgoingEdgesFrom([node('rocksdb::Rewind', 'table/merging_iterator.cc').id], ['calls'])
      .map((e) => `${cg.getNode(e.target)?.qualifiedName} (${cg.getNode(e.target)?.filePath})`);
    expect(callees).toEqual(['rocksdb::InternalIteratorBase::SeekToFirst (table/internal_iterator.h)']);
  });

  it('shows the real ancestors in the type hierarchy', () => {
    const ancestors = (qualifiedName: string, file: string): string[] =>
      (buildTypeHierarchy(cg, node(qualifiedName, file))?.ancestors ?? []).map((a) => `${a.relation} ${a.node.qualifiedName} (${a.node.filePath})`);
    expect(ancestors('google::protobuf::DynamicMessage', 'src/google/protobuf/dynamic_message.cc')).toEqual([
      'extends google::protobuf::Message (src/google/protobuf/message.h)',
    ]);
    expect(ancestors('leveldb::DBIter', 'db/db_iter.cc')).toEqual(['extends leveldb::Iterator (include/leveldb/iterator.h)']);
  });
});
