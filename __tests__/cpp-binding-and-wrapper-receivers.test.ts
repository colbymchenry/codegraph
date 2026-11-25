/**
 * A C++ call on a name a structured binding declares, or on what a
 * `std::function` returns, links to the method of the type C++ gives it.
 *
 * facebook/rocksdb's MultiCfIteratorImpl writes `for (auto& [cfh, iter] :
 * cfh_iter_pairs_) { iter->Valid(); … }` over a member declared, across two
 * lines, as a `std::vector<std::pair<ColumnFamilyHandle*,
 * std::unique_ptr<Iterator>>>`; a binding's names had no type, so the calls
 * were guessed by the method's name. `iter` is the pair's second element, a
 * `std::unique_ptr<Iterator>`, and `->` reaches `Iterator`'s method. A map's
 * elements pair its key and value; a declaration's (`auto [a, b] = f();`)
 * are what its initializer returns, a `std::pair` or `std::tuple`. And a
 * call through a `std::function<Iterator*()>`, or the other wrappers, has
 * the type the function type returns.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-binding-'));
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

/** `calls` edges of a function or method, as `qualifiedName @confidence`, one per call. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getOutgoingEdgesFrom([callable(cg, caller).id], ['calls'])
    .map((e) => `${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

// `Valid` is also a namesake class's, so a guess by the name can miss.
const ITERATORS = lines(
  '#include <memory>',
  'namespace rocksdb {',
  'class ColumnFamilyHandle {};',
  'class IteratorBase {',
  ' public:',
  '  virtual bool Valid() const { return false; }',
  '};',
  'class Iterator : public IteratorBase {};',
  'class MemTableIterator {',
  ' public:',
  '  bool Valid() const { return true; }',
  '};',
  '}  // namespace rocksdb',
);

describe('C++ structured bindings and function wrappers as receivers', () => {
  it("is the pair element a range-for's binding names, over a member declared across two lines", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/multi_cf_iterator_impl.h': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'class MultiCfIteratorImpl {',
        ' public:',
        '  void SeekToFirst() {',
        '    for (auto& [cfh, iter] : cfh_iter_pairs_) {',
        '      iter->Valid();',
        '    }',
        '  }',
        ' private:',
        '  std::vector<std::pair<ColumnFamilyHandle*, std::unique_ptr<Iterator>>>',
        '      cfh_iter_pairs_;',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiCfIteratorImpl::SeekToFirst')).toEqual(['rocksdb::IteratorBase::Valid @0.9']);
    } finally {
      cg.close();
    }
  });

  it("is a map's value, and a declaration's pair or tuple element", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/use.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'std::pair<ColumnFamilyHandle*, Iterator*> MakePair() { return {nullptr, nullptr}; }',
        'std::tuple<int, Iterator*, bool> MakeTuple() { return {0, nullptr, false}; }',
        'void ByName(const absl::flat_hash_map<std::string, Iterator*>& iters) {',
        '  for (const auto& [name, iter] : iters) {',
        '    iter->Valid();',
        '  }',
        '}',
        'void ByPair() {',
        '  auto [cfh, iter] = MakePair();',
        '  iter->Valid();',
        '}',
        'void ByTuple() {',
        '  const auto& [count, iter, done] = MakeTuple();',
        '  iter->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      for (const caller of ['ByName', 'ByPair', 'ByTuple']) {
        expect(calls(cg, `rocksdb::${caller}`).filter((c) => c.includes('Valid'))).toEqual(['rocksdb::IteratorBase::Valid @0.9']);
      }
    } finally {
      cg.close();
    }
  });

  it("is what a std::function's function type returns, called or as an auto local's initializer", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/scan.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'void Scan(std::function<Iterator*()> create_iterator) {',
        '  create_iterator()->Valid();',
        '  auto* it = create_iterator();',
        '  it->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Scan')).toEqual(['rocksdb::IteratorBase::Valid @0.85', 'rocksdb::IteratorBase::Valid @0.9']);
    } finally {
      cg.close();
    }
  });

  it("gives no type from another function's binding, or a template's arguments that aren't a pair's", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/use.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'MemTableIterator* iter = nullptr;',
        'std::pair<ColumnFamilyHandle*, Iterator*> MakePair() { return {nullptr, nullptr}; }',
        '// Members in another order than the template parameters.',
        'template <class A, class B> struct Duo { B second; A first; };',
        'Duo<Iterator*, MemTableIterator*> MakeDuo() { return {}; }',
        'void Earlier() {',
        '  auto [cfh, iter] = MakePair();',
        '}',
        'void Later() {',
        '  iter->Valid();',
        '}',
        'void Unpack() {',
        '  auto [p, q] = MakeDuo();',
        '  p->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Later').filter((c) => c === 'rocksdb::IteratorBase::Valid @0.9')).toEqual([]);
      expect(calls(cg, 'rocksdb::Unpack').filter((c) => c === 'rocksdb::IteratorBase::Valid @0.9')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it("reads a member's type from the line above only when that line is a type", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/reader.h': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'class Reader {',
        ' public:',
        '  bool Check() const { return it_->Valid(); }',
        ' private:',
        '  bool flag_ = true;',
        '  // A default member initializer continued on the next line.',
        '  bool ready_ = flag_ &&',
        '      it_;',
        '  MemTableIterator* it_ = nullptr;',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Reader::Check')).toEqual(['rocksdb::MemTableIterator::Valid @0.9']);
    } finally {
      cg.close();
    }
  });

  it("gives no type for a call outside the loop, or a binding of something that isn't a pair or tuple", async () => {
    const cg = await indexed({
      'include/rocksdb/iterator.h': ITERATORS,
      'db/use.cc': lines(
        '#include "include/rocksdb/iterator.h"',
        'namespace rocksdb {',
        'struct Point { Iterator* first; Iterator* second; };',
        'void After(const std::vector<std::pair<ColumnFamilyHandle*, Iterator*>>& pairs, MemTableIterator* iter) {',
        '  for (const auto& [cfh, iter] : pairs) {',
        '  }',
        '  iter->Valid();',
        '}',
        'void Aggregate(Point point) {',
        '  auto [x, y] = point;',
        '  y->Valid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::After').filter((c) => c === 'rocksdb::IteratorBase::Valid @0.9')).toEqual([]);
      expect(calls(cg, 'rocksdb::Aggregate').filter((c) => c === 'rocksdb::IteratorBase::Valid @0.9')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
