/**
 * A C++ `->` call on an `absl::StatusOr`, an `absl::optional` or an
 * `absl::NoDestructor` calls a member of the type it holds, as one on a
 * `std::unique_ptr` or `std::optional` does; and a bare call in a class
 * template finds a member its dependent base declares when the class brings
 * the name in with a using-declaration.
 *
 * In protocolbuffers/protobuf, `absl::StatusOr<FeatureResolver> resolver =
 * FeatureResolver::Create(…); resolver->MergeFeatures(…)` was guessed by the
 * method's name: the declared type's last name, `StatusOr`, is no class of
 * the project's. In facebook/rocksdb's typed_cache.h, `using
 * BasicTypedCacheHelperFns<TValue>::DownCastValue;` makes a bare
 * `DownCastValue(v)` the base's, which C++ doesn't look in otherwise: the
 * base depends on the class's template parameters.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-absl-held-'));
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

/** `calls` callees of a function or method, as `qualifiedName @confidence`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

// Two classes with a method of each name, so a guess by the name can miss.
const RESOLVERS = lines(
  'namespace google {',
  'namespace protobuf {',
  'class FeatureResolver {',
  ' public:',
  '  int MergeFeatures(int parent, int child) const { return parent; }',
  '};',
  'class FeatureSetResolver {',
  ' public:',
  '  int MergeFeatures(int parent, int child) const { return child; }',
  '};',
  '}  // namespace protobuf',
  '}  // namespace google',
);

describe('C++ absl holders and using-declared members of dependent bases', () => {
  it("is the held class's method for `->` on an absl::StatusOr, absl::optional or absl::NoDestructor", async () => {
    const cg = await indexed({
      'src/feature_resolver.h': RESOLVERS,
      'src/feature_resolver_test.cc': lines(
        '#include "src/feature_resolver.h"',
        'namespace google {',
        'namespace protobuf {',
        'int Merge(absl::StatusOr<FeatureResolver> resolver) {',
        '  return resolver->MergeFeatures(1, 2);',
        '}',
        'int MergeOptional(absl::optional<FeatureResolver> resolver) {',
        '  return resolver->MergeFeatures(1, 2);',
        '}',
        'int MergeStatic() {',
        '  static absl::NoDestructor<FeatureResolver> resolver;',
        '  return resolver->MergeFeatures(1, 2);',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      for (const caller of ['Merge', 'MergeOptional', 'MergeStatic']) {
        expect(calls(cg, `google::protobuf::${caller}`)).toEqual(['google::protobuf::FeatureResolver::MergeFeatures @0.9']);
      }
    } finally {
      cg.close();
    }
  });

  it("is not a project's own StatusOr, nor what a StatusOr of a pointer holds", async () => {
    const cg = await indexed({
      'src/feature_resolver.h': RESOLVERS,
      // protobuf's hpb declares a `StatusOr` of its own.
      'hpb/status.h': lines(
        'namespace absl {',
        'template <typename T>',
        'class StatusOr {',
        ' public:',
        '  T value() const;',
        '};',
        '}  // namespace absl',
      ),
      'src/use.cc': lines(
        '#include "src/feature_resolver.h"',
        '#include "hpb/status.h"',
        'namespace google {',
        'namespace protobuf {',
        'int Merge(absl::StatusOr<FeatureResolver> resolver) {',
        '  return resolver->MergeFeatures(1, 2);',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Merge').filter((c) => c.startsWith('google::protobuf::FeatureResolver::') && c.endsWith('@0.9'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('is the member of the base the using-declaration names, of two dependent bases', async () => {
    const cg = await indexed({
      'util/runner.h': lines(
        'namespace rocksdb {',
        'template <class T>',
        'class Second {',
        ' public:',
        '  void Run() {}',
        '};',
        'template <class T>',
        'class First {',
        ' public:',
        '  void Run() {}',
        '};',
        'template <class T>',
        'class Both : public Second<T>, public First<T> {',
        ' public:',
        '  using First<T>::Run;',
        '  void Go() { Run(); }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Both::Go')).toEqual(['rocksdb::First::Run @0.9']);
    } finally {
      cg.close();
    }
  });

  it('is the dependent base member a using-declaration brings in, for a bare call and a data member', async () => {
    const cg = await indexed({
      // (The base in a header of its own, where the derived class's file doesn't write its member.)
      'cache/typed_cache_base.h': lines(
        'namespace rocksdb {',
        'class Cache {',
        ' public:',
        '  int Insert(int key) { return key; }',
        '};',
        'class Other {',
        ' public:',
        '  int Insert(int key) { return 0; }',
        '};',
        'template <class TValue>',
        'class BasicTypedCacheHelperFns {',
        ' public:',
        '  static TValue* DownCastValue(void* v) { return nullptr; }',
        ' protected:',
        '  Cache* cache_;',
        '};',
        '}  // namespace rocksdb',
      ),
      'cache/typed_cache.h': lines(
        '#include "cache/typed_cache_base.h"',
        'namespace rocksdb {',
        'inline int* DownCastValue(void* v) { return nullptr; }',
        'template <class TValue, class TCreateContext>',
        'class FullTypedCacheHelperFns : public BasicTypedCacheHelperFns<TValue> {',
        ' public:',
        '  using BasicTypedCacheHelperFns<TValue>::DownCastValue;',
        '  using BasicTypedCacheHelperFns<TValue>::cache_;',
        '  static void Delete(void* v) {',
        '    DownCastValue(v);',
        '  }',
        '  int Store(int key) {',
        '    return cache_->Insert(key);',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      // (Without the using-declarations C++ finds the namespace's `DownCastValue`, as before.)
      expect(calls(cg, 'rocksdb::FullTypedCacheHelperFns::Delete')).toEqual(['rocksdb::BasicTypedCacheHelperFns::DownCastValue @0.9']);
      expect(calls(cg, 'rocksdb::FullTypedCacheHelperFns::Store')).toEqual(['rocksdb::Cache::Insert @0.9']);
    } finally {
      cg.close();
    }
  });
});
