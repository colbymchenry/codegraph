/**
 * A qualified name matches a declaration's qualified name only at a scope
 * boundary: `Status::OK` is `rocksdb::Status::OK`, never `rocksdb::IOStatus::OK`,
 * and `CacheShard::ComputeHash` is never `…::ClockCacheShard::ComputeHash`.
 *
 * The partial qualified-name match took any declaration whose qualified name
 * ended with the written text. facebook/rocksdb sent about 4,000 calls to its
 * most common functions (`Status::OK()`, `Status::InvalidArgument(…)`) to
 * `IOStatus`'s namesakes, a base-class call from an override (leveldb's
 * `return DB::Put(…)` in `ModelDB::Put`) to the override itself, and
 * BurntSushi/ripgrep's `Path::new(…)` (std's `Path`) to its own `PrinterPath::new`.
 *
 * A C++ name qualified by a template parameter — `CacheShard::ComputeHash(…)`
 * in `template <class CacheShard> class ShardedCache` — is a member of whatever
 * type the template is instantiated with, so it gets no edge, from this match
 * or from a guess by the receiver's name.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qualified-boundary-'));
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

describe('a partial qualified-name match starts at a scope boundary', () => {
  it('reproduction: `CacheShard::ComputeHash` on a template parameter is not ClockCacheShard::ComputeHash', async () => {
    const cg = await indexed({
      'cache/sharded_cache.h': lines(
        'namespace rocksdb {',
        'template <class CacheShard>',
        'class ShardedCache {',
        ' public:',
        '  unsigned long Lookup(const char* key) {',
        '    return CacheShard::ComputeHash(key, hash_seed_);',
        '  }',
        ' private:',
        '  unsigned hash_seed_ = 0;',
        '};',
        '}  // namespace rocksdb',
      ),
      'cache/clock_cache.h': lines(
        'namespace rocksdb {',
        'namespace clock_cache {',
        'class ClockCacheShard {',
        ' public:',
        '  static unsigned long ComputeHash(const char* key, unsigned seed) { return seed; }',
        '};',
        '}  // namespace clock_cache',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::ShardedCache::Lookup')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('`Status::OK()` is Status::OK, not IOStatus::OK declared before it', async () => {
    const cg = await indexed({
      'include/rocksdb/status.h': lines(
        'namespace rocksdb {',
        'class IOStatus {',
        ' public:',
        '  static IOStatus OK() { return IOStatus(); }',
        '};',
        'class Status {',
        ' public:',
        '  static Status OK() { return Status(); }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/db_impl.cc': lines(
        '#include "include/rocksdb/status.h"',
        'namespace rocksdb {',
        'Status Flush() {',
        '  return Status::OK();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Flush')).toEqual(['rocksdb::Status::OK']);
    } finally {
      cg.close();
    }
  });

  it('an override calling `DB::Put(…)` reaches the base method, not itself', async () => {
    const cg = await indexed({
      'include/leveldb/db.h': lines(
        'namespace leveldb {',
        'class DB {',
        ' public:',
        '  virtual int Put(int k, int v);',
        '};',
        '}  // namespace leveldb',
      ),
      'db/db_impl.cc': lines(
        '#include "include/leveldb/db.h"',
        'namespace leveldb {',
        'int DB::Put(int k, int v) { return k + v; }',
        '}  // namespace leveldb',
      ),
      'db/db_test.cc': lines(
        '#include "include/leveldb/db.h"',
        'namespace leveldb {',
        'class ModelDB : public DB {',
        ' public:',
        '  int Put(int k, int v) override {',
        '    return DB::Put(k, v);',
        '  }',
        '};',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::ModelDB::Put')).toEqual(['leveldb::DB::Put']);
    } finally {
      cg.close();
    }
  });

  it('a C++ `DescriptorPool::generated_pool()` reaches the C++ class, not a Ruby namesake indexed first', async () => {
    const cg = await indexed({
      'lib/google/protobuf/descriptor_pool.rb': lines(
        'module Google',
        '  module Protobuf',
        '    class DescriptorPool',
        '      def self.generated_pool',
        '        @generated_pool ||= new',
        '      end',
        '    end',
        '  end',
        'end',
      ),
      'src/google/protobuf/descriptor.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class DescriptorPool {',
        ' public:',
        '  static const DescriptorPool* generated_pool() { return nullptr; }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/compiler/main.cc': lines(
        '#include "src/google/protobuf/descriptor.h"',
        'namespace google {',
        'namespace protobuf {',
        'const DescriptorPool* Pool() {',
        '  return DescriptorPool::generated_pool();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Pool')).toEqual(['google::protobuf::DescriptorPool::generated_pool']);
    } finally {
      cg.close();
    }
  });

  it('Rust: `Path::new` on std\'s Path is not the project\'s PrinterPath::new', async () => {
    const cg = await indexed({
      'Cargo.toml': lines('[package]', 'name = "rg"', 'version = "0.1.0"', 'edition = "2021"'),
      'src/printer.rs': lines(
        'pub struct PrinterPath(Vec<u8>);',
        '',
        'impl PrinterPath {',
        '    pub fn new(path: &std::path::Path) -> PrinterPath {',
        '        PrinterPath(path.to_string_lossy().as_bytes().to_vec())',
        '    }',
        '}',
      ),
      'src/main.rs': lines(
        'mod printer;',
        'use std::path::Path;',
        '',
        'fn resolve(program: &str) -> bool {',
        '    let bin = Path::new(program);',
        '    bin.exists()',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'resolve')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('a C++ name qualified by a template parameter gets no edge', () => {
  it('a function template\'s `Hasher::Hash(k)` is neither MurmurHasher::Hash by suffix nor by the receiver\'s name', async () => {
    const cg = await indexed({
      'util/hash.h': lines(
        'namespace rocksdb {',
        'struct MurmurHasher {',
        '  static unsigned Hash(int k) { return k * 31u; }',
        '};',
        'template <typename Hasher>',
        'unsigned HashOf(int k) {',
        '  return Hasher::Hash(k);',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::HashOf')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a mixin\'s `Txn::Put(k)` on the base it is given is not WriteCommittedTxn::Put', async () => {
    const cg = await indexed({
      'utilities/transactions/txn.h': lines(
        'namespace rocksdb {',
        'class WriteCommittedTxn {',
        ' public:',
        '  int Put(int k) { return k; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'utilities/secondary_index/secondary_index_mixin.h': lines(
        'namespace rocksdb {',
        'template <typename Txn>',
        'class SecondaryIndexMixin : public Txn {',
        ' public:',
        '  int AddPrimaryEntry(int k) {',
        '    return Txn::Put(k);',
        '  }',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::SecondaryIndexMixin::AddPrimaryEntry')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a parameter with a default, `typename Parser = TcParser`, still reaches the default\'s `Parser::ParseLoop`', async () => {
    const cg = await indexed({
      'src/parse_context.h': lines(
        'namespace pb {',
        'class TcParser {',
        ' public:',
        '  static const char* ParseLoop(const char* ptr) { return ptr; }',
        '};',
        'class ParseContext {',
        ' public:',
        '  template <typename Parser = TcParser>',
        '  const char* ParseMessage(const char* ptr) {',
        '    return Parser::ParseLoop(ptr);',
        '  }',
        '};',
        '}  // namespace pb',
      ),
    });
    try {
      expect(calls(cg, 'pb::ParseContext::ParseMessage')).toEqual(['pb::TcParser::ParseLoop']);
    } finally {
      cg.close();
    }
  });

  it('a non-type parameter is named by its last word: `WireFormatLite::FieldType kKeyFieldType` leaves WireFormatLite a class', async () => {
    const cg = await indexed({
      'src/wire_format_lite.h': lines(
        'namespace pb {',
        'class WireFormatLite {',
        ' public:',
        '  enum FieldType { TYPE_INT32 = 1 };',
        '  static int WriteTagToArray(int tag) { return tag; }',
        '};',
        '}  // namespace pb',
      ),
      'src/map_type_handler.h': lines(
        '#include "src/wire_format_lite.h"',
        'namespace pb {',
        'template <typename Key, WireFormatLite::FieldType kKeyFieldType>',
        'struct MapEntryFuncs {',
        '  static int InternalSerialize(int tag) {',
        '    return WireFormatLite::WriteTagToArray(tag);',
        '  }',
        '};',
        '}  // namespace pb',
      ),
    });
    try {
      expect(calls(cg, 'pb::MapEntryFuncs::InternalSerialize')).toEqual(['pb::WireFormatLite::WriteTagToArray']);
    } finally {
      cg.close();
    }
  });

  it('an explicit specialization\'s arguments are not parameters: `ReadPrimitive<int, WireFormatLite::TYPE_INT32>` still calls WireFormatLite', async () => {
    const cg = await indexed({
      'src/wire_format_lite.h': lines(
        'namespace pb {',
        'class WireFormatLite {',
        ' public:',
        '  enum FieldType { TYPE_INT32 = 5 };',
        '  template <typename CType, FieldType DeclaredType>',
        '  static bool ReadPrimitive(int* value);',
        '  static int ReadVarint(int* value) { return *value; }',
        '};',
        'template <>',
        'inline bool WireFormatLite::ReadPrimitive<int, WireFormatLite::TYPE_INT32>(int* value) {',
        '  return WireFormatLite::ReadVarint(value) > 0;',
        '}',
        '}  // namespace pb',
      ),
    });
    try {
      expect(calls(cg, 'pb::WireFormatLite::ReadPrimitive')).toEqual(['pb::WireFormatLite::ReadVarint']);
    } finally {
      cg.close();
    }
  });
});
