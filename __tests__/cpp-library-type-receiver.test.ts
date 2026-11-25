/**
 * A C++ receiver declared as a type from outside the project with a lowercase
 * name — `std::string`, `std::vector<…>`, `absl::flat_hash_set<…>` — calls
 * that type's own member, not a project method.
 *
 * google/leveldb's `DBIter` declares `std::string saved_key_;` and calls
 * `saved_key_.clear()`. Receiver inference read the type as `string`, which
 * names no project class, and the check for a type from outside the project
 * only caught capitalized names (`List`, `String`), so the call fell through
 * to a guess by the method's name: `Slice::clear`, the one project `clear`.
 * protocolbuffers/protobuf had about 900 such edges (`std::string proto;
 * proto.append(…)` reached `LeftoverBuffer::append`).
 *
 * When the calling function or its class declares the receiver that way, a
 * `.` call — or a `->` through a raw pointer, `std::string* out` — gets no
 * project edge. A `->` on a smart pointer, iterator or optional still goes to
 * the element type, and a call that contradicts its declaration (`.` on a
 * pointer) keeps its guess, since that declaration is another variable's.
 * Comments no longer pass for declarations in the scan: `// … non-null imm_`
 * read as `imm_`'s declaration, with the type `null`.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-library-'));
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

/** leveldb's Slice and its namesakes elsewhere: every method a library type's call could be mistaken for. */
const PROJECT = {
  'include/leveldb/slice.h': lines(
    'namespace leveldb {',
    'class Slice {',
    ' public:',
    '  const char* data() const { return data_; }',
    '  unsigned size() const { return size_; }',
    '  void clear() { size_ = 0; }',
    '  const char* begin() const { return data_; }',
    '  void remove_prefix(unsigned n) { size_ -= n; }',
    ' private:',
    '  const char* data_;',
    '  unsigned size_;',
    '};',
    '}  // namespace leveldb',
  ),
  'util/buffers.h': lines(
    'namespace leveldb {',
    'class LeftoverBuffer {',
    ' public:',
    '  void append(const char* s, unsigned n) {}',
    '};',
    'class Arena {',
    ' public:',
    '  void insert(int block) {}',
    '};',
    'class Cache {',
    ' public:',
    '  void reset() {}',
    '};',
    'class Iterator {',
    ' public:',
    '  void SeekToFirst() {}',
    '};',
    '}  // namespace leveldb',
  ),
};

describe('a C++ receiver declared as a library type with a lowercase name', () => {
  it('reproduction: `std::string saved_key_; saved_key_.clear()` is not Slice::clear', async () => {
    const cg = await indexed({
      ...PROJECT,
      'db/db_iter.cc': lines(
        '#include <string>',
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'class DBIter {',
        ' public:',
        '  void Next();',
        ' private:',
        '  std::string saved_key_;    // == current key when direction_==kReverse',
        '};',
        'void DBIter::Next() {',
        '  saved_key_.clear();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::DBIter::Next')).toEqual([]);
      expect(cg.getCallers(callable(cg, 'leveldb::Slice::clear').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a local, a parameter, a raw pointer, nested template arguments and an abseil container', async () => {
    const cg = await indexed({
      ...PROJECT,
      'db/encode.cc': lines(
        '#include <string>',
        '#include <vector>',
        '#include "absl/container/flat_hash_set.h"',
        '#include "include/leveldb/slice.h"',
        '#include "util/buffers.h"',
        'namespace leveldb {',
        'void Encode(std::string* dst, const Slice& value) {',
        '  dst->clear();',
        '  dst->append(value.data(), value.size());',
        '}',
        'std::string Render(const std::vector<std::pair<int, Slice>>& files) {',
        '  std::string proto;',
        '  proto.append("x", 1);',
        '  absl::flat_hash_set<int> seen;',
        '  seen.insert(1);',
        '  const char* first = proto.data();',
        '  return files.begin() == files.end() ? proto : std::string(first);',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      // `value` is a Slice; `dst`, `proto`, `seen` and `files` are not.
      expect(calls(cg, 'leveldb::Encode')).toEqual(['leveldb::Slice::data', 'leveldb::Slice::size']);
      expect(calls(cg, 'leveldb::Render')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a `std::` name beside a project alias of the same name elsewhere', async () => {
    // facebook/rocksdb vendors googletest, whose `typedef ::std::string
    // string;` in `testing::internal` is a project type named `string`.
    const cg = await indexed({
      ...PROJECT,
      'third_party/gtest.h': lines(
        '#include <string>',
        'namespace testing {',
        'namespace internal {',
        'typedef ::std::string string;',
        '}  // namespace internal',
        '}  // namespace testing',
      ),
      'tools/trim.cc': lines(
        '#include <string>',
        '#include "include/leveldb/slice.h"',
        'void Trim(std::string& text) {',
        '  text.clear();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Trim')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a smart pointer: `.` is its own member, `->` reaches the element type', async () => {
    const cg = await indexed({
      ...PROJECT,
      'db/scan.cc': lines(
        '#include <memory>',
        '#include "util/buffers.h"',
        'namespace leveldb {',
        'void Scan(Iterator* raw) {',
        '  std::unique_ptr<Iterator> iter(raw);',
        '  iter->SeekToFirst();',
        '  iter.reset();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      // `iter.reset()` is unique_ptr's, not Cache::reset.
      expect(calls(cg, 'leveldb::Scan')).toEqual(['leveldb::Iterator::SeekToFirst']);
    } finally {
      cg.close();
    }
  });

  it('a std trait or member type names another type, maybe the project\'s', async () => {
    // facebook/rocksdb's compression.cc: `std::conditional_t<kIsDigestedDict,
    // void*, Slice> dict` is a Slice when the flag is off.
    const cg = await indexed({
      ...PROJECT,
      'util/compression.cc': lines(
        '#include <type_traits>',
        '#include <vector>',
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'template <bool kIsDigestedDict>',
        'unsigned DictSize(std::conditional_t<kIsDigestedDict, void*, Slice> dict) {',
        '  return dict.size();',
        '}',
        'void Drop(const std::vector<Slice>& slices) {',
        '  std::vector<Slice>::value_type first = slices[0];',
        '  first.remove_prefix(1);',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::DictSize')).toEqual(['leveldb::Slice::size']);
      expect(calls(cg, 'leveldb::Drop')).toEqual(['leveldb::Slice::remove_prefix']);
    } finally {
      cg.close();
    }
  });

  it('a project type with a lowercase name is still the project\'s', async () => {
    const cg = await indexed({
      ...PROJECT,
      'util/arena.h': lines(
        'namespace util {',
        'class arena {',
        ' public:',
        '  void* allocate(unsigned n) { return 0; }',
        '};',
        '}  // namespace util',
      ),
      'util/use.cc': lines(
        '#include "util/arena.h"',
        'void Use(util::arena& a) {',
        '  a.allocate(8);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['util::arena::allocate']);
    } finally {
      cg.close();
    }
  });
});

describe('a declaration that is not the receiver\'s does not rule a guess out', () => {
  it('a range-for variable, or an `auto` one, hides an earlier library-typed one of the same name', async () => {
    const cg = await indexed({
      ...PROJECT,
      'db/shadow.cc': lines(
        '#include <string>',
        '#include <vector>',
        '#include "include/leveldb/slice.h"',
        '#include "util/buffers.h"',
        'namespace leveldb {',
        'void Trim(const std::vector<Slice>& slices) {',
        '  std::string key;',
        '  for (const Slice& key : slices) {',
        '    key.remove_prefix(1);',
        '  }',
        '}',
        'void Flush(Cache* caches) {',
        '  { std::string buf; buf.clear(); }',
        '  auto buf = caches[0];',
        '  buf.reset();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Trim')).toEqual(['leveldb::Slice::remove_prefix']);
      // The block's `buf.clear()` is the string's; the `auto` one's `reset` is a guess left alone.
      expect(calls(cg, 'leveldb::Flush')).toEqual(['leveldb::Cache::reset']);
    } finally {
      cg.close();
    }
  });

  it('a call that contradicts the declaration it found: `.` on what reads as a pointer', async () => {
    // As in fmtlib/fmt's bigint, where `carry = (upper * bigits_[i] …` reads
    // as a declaration `upper* bigits_[…]`: the product here reads as
    // `absl::kWeightScale* key[…]`, but `key.size()` is a `.` call.
    const cg = await indexed({
      ...PROJECT,
      'util/weight.cc': lines(
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'unsigned Weight(const Slice& key) {',
        '  unsigned w = absl::kWeightScale * key[0];',
        '  return w + key.size();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Weight')).toEqual(['leveldb::Slice::size']);
    } finally {
      cg.close();
    }
  });

  it('a constant of a project class read as a type, and a scalar', async () => {
    const cg = await indexed({
      ...PROJECT,
      'util/mask.cc': lines(
        '#include <cstddef>',
        '#include "include/leveldb/slice.h"',
        '#define SLICE_AT(var, list, i) const Slice& var = list[i]',
        'namespace leveldb {',
        'unsigned Mask(const Slice& key) {',
        // reads like `Slice::kMask& key[…]`
        '  unsigned m = Slice::kMask & key[0];',
        '  return m + key.size();',
        '}',
        'void Visit(const Slice* slices) {',
        '  std::size_t key = 0;',
        '  {',
        // the macro declares the `key` the call is made on
        '    SLICE_AT(key, slices, 0);',
        '    key.remove_prefix(1);',
        '  }',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Mask')).toEqual(['leveldb::Slice::size']);
      expect(calls(cg, 'leveldb::Visit')).toEqual(['leveldb::Slice::remove_prefix']);
    } finally {
      cg.close();
    }
  });

  it('a member of another class in the file', async () => {
    // google/leveldb's db/log_test.cc: StringDest's `std::string contents_`
    // sits above StringSource, whose own `Slice contents_` comes after its methods.
    const cg = await indexed({
      ...PROJECT,
      'db/log_test.cc': lines(
        '#include <string>',
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'class StringDest {',
        ' public:',
        '  std::string contents_;',
        '};',
        'class StringSource {',
        ' public:',
        '  void Skip(unsigned n) { contents_.remove_prefix(n); }',
        ' private:',
        '  Slice contents_;',
        '};',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::StringSource::Skip')).toEqual(['leveldb::Slice::remove_prefix']);
    } finally {
      cg.close();
    }
  });

  it('the last line of a declaration that starts on an earlier one', async () => {
    // facebook/rocksdb's BlobFileReader: `autovector<std::pair<…,` ends one
    // line and `std::unique_ptr<BlobContents>>>& blob_reqs` starts the next.
    const cg = await indexed({
      'util/autovector.h': lines(
        'namespace rocksdb {',
        'template <class T>',
        'class autovector {',
        ' public:',
        '  unsigned size() const { return 0; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/blob/blob_file_reader.cc': lines(
        '#include <memory>',
        '#include "util/autovector.h"',
        'namespace rocksdb {',
        'class BlobFileReader {',
        ' public:',
        '  unsigned MultiGetBlob(autovector<std::pair<int*,',
        '                                 std::unique_ptr<int>>>& blob_reqs);',
        '};',
        'unsigned BlobFileReader::MultiGetBlob(autovector<std::pair<int*,',
        '                                      std::unique_ptr<int>>>& blob_reqs) {',
        '  return blob_reqs.size();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::BlobFileReader::MultiGetBlob')).toEqual(['rocksdb::autovector::size']);
    } finally {
      cg.close();
    }
  });

  it('a member of a class nested in the caller\'s', async () => {
    // facebook/rocksdb's MultiScan: its nested MultiScanIterator declares a
    // `scan_opts_` of its own, above MultiScan's.
    const cg = await indexed({
      'include/rocksdb/multi_scan.h': lines(
        '#include <vector>',
        'namespace rocksdb {',
        'struct ScanOptions {};',
        'class MultiScanArgs {',
        ' public:',
        '  int GetScanRanges() const { return 0; }',
        '};',
        'class MultiScan {',
        ' public:',
        '  class MultiScanIterator {',
        '   private:',
        '    const std::vector<ScanOptions>& scan_opts_;',
        '  };',
        '  int begin() { return scan_opts_.GetScanRanges(); }',
        ' private:',
        '  const MultiScanArgs scan_opts_;',
        '};',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::MultiScan::begin')).toEqual(['rocksdb::MultiScanArgs::GetScanRanges']);
    } finally {
      cg.close();
    }
  });
});

describe('comments in the declaration scan', () => {
  it('a comment that mentions the receiver is not its declaration', async () => {
    // google/leveldb's db_impl.cc: `// … since there is a non-null imm_`
    // above `imm_->…` read as `imm_`'s declaration, with the type `null`.
    const cg = await indexed({
      'db/memtable.h': lines(
        'namespace leveldb {',
        'class MemTable {',
        ' public:',
        '  unsigned ApproximateMemoryUsage() { return 0; }',
        '};',
        'class Arena {',
        ' public:',
        '  unsigned ApproximateMemoryUsage() { return 0; }',
        '};',
        '}  // namespace leveldb',
      ),
      'db/db_impl.h': lines(
        '#include "db/memtable.h"',
        'namespace leveldb {',
        'class DBImpl {',
        ' public:',
        '  unsigned MemoryUsage();',
        ' private:',
        '  MemTable* imm_;',
        '};',
        '}  // namespace leveldb',
      ),
      'db/db_impl.cc': lines(
        '#include "db/db_impl.h"',
        'namespace leveldb {',
        'unsigned DBImpl::MemoryUsage() {',
        '  // Count the memtable being compacted, since there is a non-null imm_',
        '  return imm_->ApproximateMemoryUsage();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::DBImpl::MemoryUsage')).toEqual(['leveldb::MemTable::ApproximateMemoryUsage']);
    } finally {
      cg.close();
    }
  });

  it('a parameter after a leading `/* static */` is the caller\'s own', async () => {
    const cg = await indexed({
      ...PROJECT,
      'util/status.cc': lines(
        '#include <string>',
        '#include "include/leveldb/slice.h"',
        'namespace leveldb {',
        'class Status {',
        ' public:',
        '  static bool Check(const std::string& msg);',
        '};',
        '/* static */ bool Status::Check(const std::string& msg) {',
        '  return msg.begin() != nullptr;',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Status::Check')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
