/**
 * A C++ declaration that lists several names — `ByteBuffer symbols_found,
 * strings_found;` — gives every one of them its type.
 *
 * google/breakpad's macho_reader_unittest.cc declares `ByteBuffer
 * symbols_found, strings_found;` and calls `symbols_found.Size()` and
 * `strings_found.Size()`. Receiver inference reads a declaration with a
 * pattern that wants the type right before the name, and a list writes the
 * type once, before the first name. So only `symbols_found` was typed:
 * `strings_found.Size()` went on to a guess by the receiver's name, which
 * found nothing to tell ByteBuffer's `Size` from test_assembler.h's
 * `Section::Size`, or, when an earlier function declared a variable of the
 * same name, took that variable's type.
 *
 * A name later in a list has the type the declaration opens with, plus its
 * own `*`s and `&`s: `T *a, *b;` declares two pointers, `T *a, b;` one. The
 * names are told apart by the commas between them only: a comma inside
 * template arguments (`std::map<K, V> m;`), a call's or a constructor's
 * arguments, a constructor's initializer list or an expression lists no
 * name, and the receiver's own declaration further up still decides.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-listed-'));
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

/**
 * `calls` callees of a function or method, constructors aside, as
 * `qualifiedName @confidence`, one per callee. A guess can land on the right
 * method by elimination, so the confidence shows how the edge was made: 0.9
 * is the declared type's.
 */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .filter((r) => {
      const [owner, name] = r.node.qualifiedName.split('::').slice(-2);
      return owner !== name;
    })
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** breakpad's ByteBuffer, and test_assembler.h's Section with a `Size` of its own. */
const BREAKPAD = {
  'src/common/byte_cursor.h': lines(
    'namespace google_breakpad {',
    'class ByteBuffer {',
    ' public:',
    '  unsigned Size() const { return end - start; }',
    '  const unsigned char* start;',
    '  const unsigned char* end;',
    '};',
    '}  // namespace google_breakpad',
  ),
  'src/common/test_assembler.h': lines(
    'namespace google_breakpad {',
    'namespace test_assembler {',
    'class Section {',
    ' public:',
    '  unsigned Size() const { return size_; }',
    ' private:',
    '  unsigned size_;',
    '};',
    '}  // namespace test_assembler',
    '}  // namespace google_breakpad',
  ),
};

/** Three classes with a `Get` each, so a receiver given the wrong one of them goes to the wrong `Get`. */
const STORE = {
  'store/table.h': lines(
    'namespace store {',
    'class Table {',
    ' public:',
    '  Table() {}',
    '  explicit Table(int shard) {}',
    '  static Table Open(int shard) { return Table(shard); }',
    '  int Get(int key) const { return key; }',
    '};',
    'class Log {};',
    'class Writer {',
    ' public:',
    '  Writer(Log* log, const Table& table, int level) {}',
    '  int Get(int key) const { return 0; }',
    '};',
    'template <typename K, typename V>',
    'class Cache {',
    ' public:',
    '  V* Get(const K& key) { return nullptr; }',
    '};',
    'Table Make(int shard, int replicas);',
    'Writer Wrap(Log* log, const Table& table, int level);',
    'void Use(const Writer& writer, const Table& table, int level);',
    '}  // namespace store',
  ),
};

describe('a C++ receiver declared later in a list of names', () => {
  it('reproduction: `ByteBuffer symbols_found, strings_found;` types strings_found too', async () => {
    const cg = await indexed({
      ...BREAKPAD,
      'src/common/mac/macho_reader_unittest.cc': lines(
        '#include "common/byte_cursor.h"',
        '#include "common/test_assembler.h"',
        'namespace google_breakpad {',
        'unsigned Symtab32() {',
        '  ByteBuffer symbols_found, strings_found;',
        '  return symbols_found.Size();',
        '}',
        'unsigned Symtab64() {',
        '  ByteBuffer symbols_found, strings_found;',
        '  return strings_found.Size();',
        '}',
        '}  // namespace google_breakpad',
      ),
    });
    try {
      expect(calls(cg, 'google_breakpad::Symtab32')).toEqual(['google_breakpad::ByteBuffer::Size @0.9']);
      expect(calls(cg, 'google_breakpad::Symtab64')).toEqual(['google_breakpad::ByteBuffer::Size @0.9']);
      expect(cg.getCallers(callable(cg, 'google_breakpad::test_assembler::Section::Size').id)
        .filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('initializers, braces and parentheses, template arguments, `auto`, a `for` header and a member list', async () => {
    const cg = await indexed({
      ...STORE,
      'store/store.h': lines(
        '#include "store/table.h"',
        'namespace store {',
        'class Store {',
        ' public:',
        '  int Flush();',
        ' private:',
        '  Table *index_, *data_;',
        '};',
        '}  // namespace store',
      ),
      'store/store.cc': lines(
        '#include "store/store.h"',
        'namespace store {',
        'int Store::Flush() {',
        '  return data_->Get(1);',
        '}',
        'int Initialized() {',
        '  Table first = Make(1, 2), table;',
        '  return table.Get(1);',
        '}',
        'int Constructed() {',
        '  Table first{1}, second(2);',
        '  return second.Get(2);',
        '}',
        'int Templated() {',
        '  Cache<int, Writer> writers, table;',
        '  return *table.Get(3);',
        '}',
        'int Deduced() {',
        '  auto first = Table::Open(1), second = Table::Open(2);',
        '  return second.Get(4);',
        '}',
        'int Looped(Table* head) {',
        '  int sum = 0;',
        '  for (Table *t = head, *u = nullptr; t; t = u) {',
        '    sum += u->Get(5);',
        '  }',
        '  return sum;',
        '}',
        '}  // namespace store',
      ),
    });
    try {
      expect(calls(cg, 'store::Store::Flush')).toEqual(['store::Table::Get @0.9']);
      expect(calls(cg, 'store::Initialized')).toContain('store::Table::Get @0.9');
      expect(calls(cg, 'store::Constructed')).toEqual(['store::Table::Get @0.9']);
      // The comma inside `Cache<int, Writer>` separates no names: `table` is a Cache, not a Writer.
      expect(calls(cg, 'store::Templated')).toEqual(['store::Cache::Get @0.9']);
      // Each name in an `auto` list has its own initializer's type.
      expect(calls(cg, 'store::Deduced')).toContain('store::Table::Get @0.9');
      expect(calls(cg, 'store::Looped')).toEqual(['store::Table::Get @0.9']);
      expect(cg.getCallers(callable(cg, 'store::Writer::Get').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the nearest declaration decides, not one of the same name in an earlier function', async () => {
    const cg = await indexed({
      ...STORE,
      'store/scan.cc': lines(
        '#include "store/table.h"',
        'namespace store {',
        'int Earlier(const Writer& table) {',
        '  return table.Get(1);',
        '}',
        'int Later() {',
        '  Table first, table;',
        '  return table.Get(2);',
        '}',
        '}  // namespace store',
      ),
    });
    try {
      expect(calls(cg, 'store::Earlier')).toEqual(['store::Writer::Get @0.9']);
      expect(calls(cg, 'store::Later')).toEqual(['store::Table::Get @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a pointer is each name\'s own: `std::string *out, text;` and `std::string text, *out;`', async () => {
    // A call on a std::string is the library's own member, and #2413's check
    // that says so needs the call's `.` or `->` to fit the declaration:
    // `text` is no pointer in either list, `out` is one in both.
    const cg = await indexed({
      'util/buffers.h': lines(
        'namespace util {',
        'class LeftoverBuffer {',
        ' public:',
        '  void append(const char* s, unsigned n) {}',
        '};',
        '}  // namespace util',
      ),
      'util/encode.cc': lines(
        '#include <string>',
        '#include "util/buffers.h"',
        'namespace util {',
        'void Encode(const char* data) {',
        '  std::string *out, text;',
        '  text.append(data, 4);',
        '}',
        'void EncodeTo(const char* data) {',
        '  std::string text, *out;',
        '  out->append(data, 4);',
        '}',
        '}  // namespace util',
      ),
    });
    try {
      expect(calls(cg, 'util::Encode')).toEqual([]);
      expect(calls(cg, 'util::EncodeTo')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a bare call on a name declared later in a list is a local\'s, as on the first name', async () => {
    // C++ lookup finds the local, not a member of the method's class, so a
    // bare call on either name calls the local and links nothing: `failed()`
    // reached Runner::failed as a call on `this`, while `done()` was a local's.
    const cg = await indexed({
      'jobs/runner.h': lines(
        '#include <functional>',
        'namespace jobs {',
        'class Runner {',
        ' public:',
        '  void Run();',
        '  void done() {}',
        '  void failed() {}',
        '};',
        'class Job {',
        ' public:',
        '  void done() {}',
        '  void failed() {}',
        '};',
        '}  // namespace jobs',
      ),
      'jobs/runner.cc': lines(
        '#include "jobs/runner.h"',
        'namespace jobs {',
        'void Runner::Run() {',
        '  std::function<void()> done, failed;',
        '  done();',
        '  failed();',
        '}',
        '}  // namespace jobs',
      ),
    });
    try {
      const run = calls(cg, 'jobs::Runner::Run');
      const howLinked = (method: string): string | undefined =>
        run.find((c) => c.startsWith(`jobs::Runner::${method} `))?.split('@')[1];
      expect(run).not.toContain('jobs::Runner::failed @0.9');
      expect(howLinked('failed')).toBe(howLinked('done'));
      expect(run).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a comma in arguments, an initializer list or an expression lists no name', async () => {
    const cg = await indexed({
      ...STORE,
      'store/reader.h': lines(
        '#include "store/table.h"',
        'namespace store {',
        'class Reader {',
        ' public:',
        '  Reader(Writer* w, Table* t);',
        '  int Run();',
        ' private:',
        '  Writer* writer_;',
        '  Table* table_;',
        '};',
        '}  // namespace store',
      ),
      'store/reader.cc': lines(
        '#include "store/reader.h"',
        'namespace store {',
        'Reader::Reader(Writer* w, Table* t) : writer_(w), table_(t) {}',
        'int Reader::Run() {',
        '  return table_->Get(1);',
        '}',
        'int Arguments(Log* log) {',
        '  Table table;',
        '  Writer writer(log, table, 3);',
        '  Writer copy = Wrap(log, table, 3);',
        '  Use(writer, table, 3);',
        '  return table.Get(2);',
        '}',
        'int Parameters(Writer writer, Table table) {',
        '  return table.Get(3);',
        '}',
        '}  // namespace store',
      ),
    });
    try {
      expect(calls(cg, 'store::Reader::Run')).toEqual(['store::Table::Get @0.9']);
      expect(calls(cg, 'store::Arguments')).toContain('store::Table::Get @0.9');
      expect(calls(cg, 'store::Parameters')).toEqual(['store::Table::Get @0.9']);
      expect(cg.getCallers(callable(cg, 'store::Writer::Get').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
