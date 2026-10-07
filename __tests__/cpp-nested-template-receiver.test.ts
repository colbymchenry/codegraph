/**
 * A C++ receiver declared with template arguments nested in its template
 * arguments calls its own class's method.
 *
 * Receiver inference reduced a declared type to its last name by cutting each
 * `<…>` at its first `>`, so `autovector<std::pair<int, FileMetaData*>>` came
 * out as `autovector >` and `Striped<CacheAlignedWrapper<port::Mutex>>` as
 * `Striped >` — names no class has. facebook/rocksdb's
 * `files_marked_for_compaction_.clear()` on such an `autovector` was then
 * guessed by the receiver's words to be `CompactionInputFiles::clear`, and
 * `mutex_.Get(key)` on a `Striped` got no edge at all: a capitalized type no
 * class declares is taken to be from outside the project. Template arguments
 * now go with the ones nested in them, so both calls reach their own class.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stripCppTemplateArguments } from '../src/resolution/cpp-type-aliases';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-nested-'));
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

/** `calls` callees of a function or method, as `qualifiedName (file)`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} (${r.node.filePath})`)
    .sort();
}

/** `calls` callees with how each was resolved: `qualifiedName resolvedBy@confidence`. */
function resolvedCalls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} ${String(r.edge.metadata?.resolvedBy)}@${String(r.edge.metadata?.confidence)}`)
    .sort();
}

/** facebook/rocksdb's shapes, trimmed: the small vector, and the class whose words the receivers share. */
const ROCKSDB = {
  'util/autovector.h': [
    'namespace rocksdb {',
    'template <class T, size_t kSize = 8>',
    'class autovector {',
    ' public:',
    '  size_t size() const { return 0; }',
    '  void clear() {}',
    '  void push_back(const T& item) {}',
    '};',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'db/compaction/compaction.h': [
    'namespace rocksdb {',
    'struct FileMetaData {};',
    'struct CompactionInputFiles {',
    '  size_t size() const { return 0; }',
    '  void clear() {}',
    '};',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'db/version_set.h': [
    '#include "util/autovector.h"',
    '#include "db/compaction/compaction.h"',
    'namespace rocksdb {',
    'class VersionEdit {};',
    'class VersionStorageInfo {',
    ' public:',
    '  void ComputeFilesMarkedForCompaction();',
    '  size_t CountEditLists(VersionEdit* edit);',
    ' private:',
    '  autovector<std::pair<int, FileMetaData*>> files_marked_for_compaction_;',
    '};',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
  'db/version_set.cc': [
    '#include "db/version_set.h"',
    'namespace rocksdb {',
    'void VersionStorageInfo::ComputeFilesMarkedForCompaction() {',
    '  files_marked_for_compaction_.clear();',
    '}',
    'size_t VersionStorageInfo::CountEditLists(VersionEdit* edit) {',
    '  autovector<autovector<VersionEdit*>> edit_lists;',
    '  edit_lists.push_back(autovector<VersionEdit*>());',
    '  return edit_lists.size();',
    '}',
    '}  // namespace rocksdb',
    '',
  ].join('\n'),
};

describe('a C++ receiver declared with nested template arguments', () => {
  it('reproduction: a member of the class reaches the class\'s own method, not one named after the receiver\'s words', async () => {
    const cg = await indexed(ROCKSDB);
    try {
      expect(calls(cg, 'rocksdb::VersionStorageInfo::ComputeFilesMarkedForCompaction')).toEqual([
        'rocksdb::autovector::clear (util/autovector.h)',
      ]);
      expect(cg.getCallers(callable(cg, 'rocksdb::CompactionInputFiles::clear').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a local of a class template nested in its own template arguments', async () => {
    const cg = await indexed(ROCKSDB);
    try {
      // Both calls are the declared type's. `size` has two owners and the
      // receiver's words name neither, so no guess reached it; the one
      // `push_back` was a guess for being the only method of its name.
      expect(resolvedCalls(cg, 'rocksdb::VersionStorageInfo::CountEditLists')).toEqual([
        'rocksdb::autovector::push_back instance-method@0.9',
        'rocksdb::autovector::size instance-method@0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a capitalized class template is the project\'s own, not a type from outside it', async () => {
    const cg = await indexed({
      'util/mutexlock.h': [
        'namespace rocksdb {',
        'namespace port {',
        'class Mutex {',
        ' public:',
        '  void Lock() {}',
        '};',
        '}  // namespace port',
        'template <class T>',
        'struct CacheAlignedWrapper {',
        '  T obj_;',
        '};',
        'template <class T, class Key = int>',
        'class Striped {',
        ' public:',
        '  T& Get(const Key& key) { return *data_; }',
        ' private:',
        '  T* data_;',
        '};',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
      'db/blob/blob_file_cache.h': [
        '#include "util/mutexlock.h"',
        'namespace rocksdb {',
        'class BlobFileCache {',
        ' public:',
        '  void Evict(int key);',
        ' private:',
        '  Striped<CacheAlignedWrapper<port::Mutex>> mutex_;',
        '};',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
      'db/blob/blob_file_cache.cc': [
        '#include "db/blob/blob_file_cache.h"',
        'namespace rocksdb {',
        'void BlobFileCache::Evict(int key) {',
        '  mutex_.Get(key);',
        '}',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'rocksdb::BlobFileCache::Evict')).toEqual(['rocksdb::Striped::Get (util/mutexlock.h)']);
    } finally {
      cg.close();
    }
  });

  it('the end of a declaration begun on the line above names no type, not even its template argument\'s', async () => {
    // rocksdb's blob_file_reader.h breaks `autovector<std::pair<…,` and
    // `std::unique_ptr<BlobContents>>>& blob_reqs` over two lines. The second
    // line alone, read as a type, is a `CachableEntry` here: the receiver's
    // type is the `autovector` on the line above.
    const cg = await indexed({
      ...ROCKSDB,
      'table/block_based/cachable_entry.h': [
        'namespace rocksdb {',
        'template <class T>',
        'class CachableEntry {',
        ' public:',
        '  size_t size() const { return 0; }',
        '};',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
      'db/blob/blob_file_reader.cc': [
        '#include "util/autovector.h"',
        '#include "table/block_based/cachable_entry.h"',
        'namespace rocksdb {',
        'struct BlobContents {};',
        'struct BlobReadRequest {};',
        'size_t MultiGetBlob(',
        '    autovector<std::pair<BlobReadRequest*,',
        '                         CachableEntry<BlobContents>>>& blob_reqs) {',
        '  return blob_reqs.size();',
        '}',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiGetBlob')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a declaration begun on the line above still hides a member of the same name', async () => {
    // The parameter's type is not on the line that names it, but the
    // parameter is still what the call is on: the class's `std::string
    // blob_reqs` member it hides says nothing about the call.
    const cg = await indexed({
      'util/autovector.h': ROCKSDB['util/autovector.h'],
      'db/blob/blob_file_reader.cc': [
        '#include <string>',
        '#include "util/autovector.h"',
        'namespace rocksdb {',
        'struct BlobContents {};',
        'class BlobFileReader {',
        ' public:',
        '  size_t MultiGetBlob(autovector<std::pair<int*,',
        '                                           std::unique_ptr<BlobContents>>>& blob_reqs) const;',
        ' private:',
        '  std::string blob_reqs;',
        '};',
        'size_t BlobFileReader::MultiGetBlob(autovector<std::pair<int*,',
        '                                           std::unique_ptr<BlobContents>>>& blob_reqs) const {',
        '  return blob_reqs.size();',
        '}',
        '}  // namespace rocksdb',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'rocksdb::BlobFileReader::MultiGetBlob')).toEqual(['rocksdb::autovector::size (util/autovector.h)']);
    } finally {
      cg.close();
    }
  });
});

describe('stripCppTemplateArguments', () => {
  it('drops template arguments together with the ones nested in them', () => {
    expect(stripCppTemplateArguments('autovector<std::pair<int, FileMetaData*>>')).toBe('autovector');
    expect(stripCppTemplateArguments('Striped<CacheAlignedWrapper<port::Mutex>>')).toBe('Striped');
    expect(stripCppTemplateArguments('const std::map<int, std::vector<int> >&')).toBe('const std::map&');
    expect(stripCppTemplateArguments('SkipList<const char*, Cmp<int>>::Iterator')).toBe('SkipList::Iterator');
  });
});
