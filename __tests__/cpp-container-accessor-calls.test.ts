/**
 * A C++ call on what a library container or holder hands out, like
 * `bufs.front().Flush()` over a `std::vector<Buffer>`, `by_id.at(1)->Flush()`
 * over a map, `pending.top()->Valid()` over a `std::stack`, `iter.get()->Valid()`
 * on a `std::unique_ptr` or `table.value().Size()` on a `std::optional`, calls
 * a member of the element's class. The library's member returned nothing the
 * index could read, so such calls linked to nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call on what a library container or holder hands out', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-container-accessors-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // `Other` comes first: a call matched by its bare name lands on it.
    write('src/types.h', lines(
      'class Other {',
      ' public:',
      '  void Flush() {}',
      '  bool Valid() const { return false; }',
      '  int Size() const { return 0; }',
      '};',
      'class Buffer {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class Iterator {',
      ' public:',
      '  bool Valid() const { return true; }',
      '};',
      'class Table {',
      ' public:',
      '  int Size() const { return 1; }',
      '};',
      // A project class named like a standard container is that class.
      'class list {',
      ' public:',
      '  Other front() { return Other(); }',
      '};',
    ));
    write('src/autovector.h', lines(
      'namespace rocksdb {',
      'template <class T, int kSize = 8>',
      'class autovector {',
      ' public:',
      '  T& front() { return values_[0]; }',
      '  T& back() { return values_[kSize - 1]; }',
      ' private:',
      '  T values_[kSize];',
      '};',
      '}  // namespace rocksdb',
    ));
    write('src/use.cc', lines(
      '#include <map>',
      '#include <memory>',
      '#include <optional>',
      '#include <queue>',
      '#include <stack>',
      '#include <string>',
      '#include <vector>',
      '#include "src/autovector.h"',
      '#include "src/types.h"',
      'void Front(std::vector<Buffer>& bufs) { bufs.front().Flush(); }',
      'void Back(std::vector<Iterator*>* iters) { iters->back()->Valid(); }',
      'void At(const std::vector<Table>& tables) { tables.at(0).Size(); }',
      'void MapAt(std::map<int, Buffer*>& by_id) { by_id.at(1)->Flush(); }',
      'void Top(std::stack<Iterator*>& pending) { pending.top()->Valid(); }',
      'void QueueFront(std::queue<Buffer>& queue) { queue.front().Flush(); }',
      'void Get(const std::unique_ptr<Iterator>& iter) { iter.get()->Valid(); }',
      'void Value(const std::optional<Table>& table) { table.value().Size(); }',
      'void StatusOrValue(absl::StatusOr<Buffer>& buf) { buf.value().Flush(); }',
      'void Owned(std::vector<std::unique_ptr<Iterator>>& iters) { iters.back()->Valid(); }',
      'void Local(std::vector<Buffer>& bufs) { auto& last = bufs.back(); last.Flush(); }',
      'void ProjectSequence(rocksdb::autovector<Buffer*>& bufs) { bufs.front()->Flush(); }',
      'void ProjectList(list& l) { l.front().Flush(); }',
      'void Strings(std::vector<std::string>& names) { names.front().size(); }',
      'template <typename T>',
      'void Generic(std::vector<T>& items) { items.front().Flush(); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function `name`, as `qualifiedName`. */
  const calls = (name: string): string[] => {
    const caller = cg.getNodesByKind('function').find((n: Node) => n.name === name);
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName).sort();
  };

  it("a sequence's front(), back() and at(i)", () => {
    expect(calls('Front')).toEqual(['Buffer::Flush']);
    expect(calls('Back')).toEqual(['Iterator::Valid']);
    expect(calls('At')).toEqual(['Table::Size']);
    expect(calls('Owned')).toEqual(['Iterator::Valid']);
  });

  it("a map's at(key), a stack's top() and a queue's front()", () => {
    expect(calls('MapAt')).toEqual(['Buffer::Flush']);
    expect(calls('Top')).toEqual(['Iterator::Valid']);
    expect(calls('QueueFront')).toEqual(['Buffer::Flush']);
  });

  it("a smart pointer's get() and an optional's or a StatusOr's value()", () => {
    expect(calls('Get')).toEqual(['Iterator::Valid']);
    expect(calls('Value')).toEqual(['Table::Size']);
    expect(calls('StatusOrValue')).toEqual(['Buffer::Flush']);
  });

  it('a local the accessor initializes, and a project sequence', () => {
    expect(calls('Local')).toEqual(['Buffer::Flush']);
    expect(calls('ProjectSequence')).toEqual(['Buffer::Flush', 'rocksdb::autovector::front']);
  });

  it("a project class of a container's name, a library element and a template's own", () => {
    expect(calls('ProjectList')).toEqual(['Other::Flush', 'list::front']);
    expect(calls('Strings')).toEqual([]);
    expect(calls('Generic')).toEqual([]);
  });
});
