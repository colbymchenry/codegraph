/**
 * A C++ receiver declared as a member type of a class template, like
 * google/leveldb's and facebook/rocksdb's `SkipList<Key,
 * Comparator>::Iterator iter(&list);`. The declaration was read from its
 * last name alone, `Iterator`, which C++ lookup from the calling function
 * then found in the enclosing namespace: leveldb's skip-list tests linked
 * `iter.Valid()` to `leveldb::Iterator::Valid`, and rocksdb's to
 * `IteratorBase::Valid`, instead of the skip list's own iterator. The type is
 * now read whole, and the member found in the class template it is written in.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-template-member-'));
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

/** `calls` callees of a function or method, as `qualifiedName`, without constructors. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls' && !/::(\w+)::\1$/.test(r.node.qualifiedName))
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

const SKIPLIST = {
  'include/iterator.h': lines(
    'namespace leveldb {',
    'class Iterator {',
    ' public:',
    '  virtual ~Iterator() {}',
    '  virtual bool Valid() const { return false; }',
    '  virtual void SeekToFirst() {}',
    '};',
    '}  // namespace leveldb',
  ),
  'db/skiplist.h': lines(
    '#include "include/iterator.h"',
    'namespace leveldb {',
    'template <typename Key, class Comparator>',
    'class SkipList {',
    ' public:',
    '  class Iterator {',
    '   public:',
    '    explicit Iterator(const SkipList* list) : list_(list) {}',
    '    bool Valid() const { return true; }',
    '    void SeekToFirst() {}',
    '   private:',
    '    const SkipList* list_;',
    '  };',
    '};',
    '}  // namespace leveldb',
  ),
};

describe('a C++ receiver declared as a member type of a class template', () => {
  it('reproduction: `SkipList<Key, Comparator>::Iterator iter` is the skip list\'s iterator', async () => {
    const cg = await indexed({
      ...SKIPLIST,
      'db/skiplist_test.cc': lines(
        '#include "db/skiplist.h"',
        'namespace leveldb {',
        'typedef unsigned long Key;',
        'struct Comparator {};',
        'void Empty() {',
        '  SkipList<Key, Comparator> list;',
        '  SkipList<Key, Comparator>::Iterator iter(&list);',
        '  if (!iter.Valid()) iter.SeekToFirst();',
        '}',
        'void Split() {',
        '  SkipList<Key, Comparator> list;',
        '  SkipList<Key, Comparator>::Iterator',
        '      iter(&list);',
        '  iter.Valid();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Empty')).toEqual(['leveldb::SkipList::Iterator::SeekToFirst', 'leveldb::SkipList::Iterator::Valid']);
      expect(calls(cg, 'leveldb::Split')).toEqual(['leveldb::SkipList::Iterator::Valid']);
    } finally {
      cg.close();
    }
  });

  it('written with `typename` in a template, and through a pointer', async () => {
    const cg = await indexed({
      ...SKIPLIST,
      'db/concurrent_test.cc': lines(
        '#include "db/skiplist.h"',
        'namespace leveldb {',
        'template <typename Key, class Comparator>',
        'class ConcurrentTest {',
        ' public:',
        '  void ReadStep() {',
        '    typename SkipList<Key, Comparator>::Iterator iter(&list_);',
        '    iter.SeekToFirst();',
        '  }',
        '  bool Check(typename SkipList<Key, Comparator>::Iterator* it) {',
        '    return it->Valid();',
        '  }',
        ' private:',
        '  SkipList<Key, Comparator> list_;',
        '};',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::ConcurrentTest::ReadStep')).toEqual(['leveldb::SkipList::Iterator::SeekToFirst']);
      expect(calls(cg, 'leveldb::ConcurrentTest::Check')).toEqual(['leveldb::SkipList::Iterator::Valid']);
    } finally {
      cg.close();
    }
  });

  it('a standard container\'s iterator is the library\'s, not a project class named `iterator`', async () => {
    const cg = await indexed({
      'util/ring.h': lines(
        'class Ring {',
        ' public:',
        '  class iterator {',
        '   public:',
        '    int base() const { return 0; }',
        '  };',
        '};',
      ),
      'src/touch.cc': lines(
        '#include <vector>',
        '#include "util/ring.h"',
        'void Touch(std::vector<int>::iterator it) {',
        '  it.base();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Touch')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a library template\'s member that names another type may be one of the project\'s', async () => {
    const cg = await indexed({
      'include/slice.h': lines(
        'class Slice {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
      ),
      'src/keys.cc': lines(
        '#include <vector>',
        '#include "include/slice.h"',
        'int First(const std::vector<Slice>& keys) {',
        '  std::vector<Slice>::value_type key = keys[0];',
        '  return key.size();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'First')).toEqual(['Slice::size']);
    } finally {
      cg.close();
    }
  });

  it('a member alias of a class template is the class it names', async () => {
    const cg = await indexed({
      'cache/clock_cache.h': lines(
        'class Shard {',
        ' public:',
        '  int GetTable() const { return 0; }',
        '};',
        'namespace cache {',
        'template <class Table>',
        'class ClockCacheShard {',
        ' public:',
        '  int GetTable() const { return 1; }',
        '};',
        'template <class Table>',
        'class BaseHyperClockCache {',
        ' public:',
        '  using Shard = ClockCacheShard<Table>;',
        '  int Report(const BaseHyperClockCache<Table>::Shard* shard) const {',
        '    return shard->GetTable();',
        '  }',
        '};',
        '}  // namespace cache',
      ),
    });
    try {
      expect(calls(cg, 'cache::BaseHyperClockCache::Report')).toEqual(['cache::ClockCacheShard::GetTable']);
    } finally {
      cg.close();
    }
  });
});
