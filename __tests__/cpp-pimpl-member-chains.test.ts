/**
 * A C++ call through a member of a pimpl's `Rep` — rocksdb's
 * `rep_->index_builder->IndexSize()`, leveldb's `rep_->options.comparator` —
 * calls a method of that member's class. The class declares `struct Rep;` and
 * `std::unique_ptr<Rep> rep_;` (or `Rep* rep_;`) in its header, and the source
 * file that calls through it defines `struct Table::Rep { … }`. The member's
 * type was looked up from the header, which sees no source file's classes, so
 * the call was guessed by the method's name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call through a member of a pimpl Rep', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-pimpl-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write('include/table.h', lines(
      '#include <memory>',
      'namespace ns {',
      'class Table {',
      ' public:',
      '  int Size();',
      '  void Flush();',
      ' private:',
      '  struct Rep;',
      '  std::unique_ptr<Rep> rep_;',
      '};',
      'class Builder {',
      ' public:',
      '  int Count();',
      ' private:',
      '  struct Rep;',
      '  Rep* rep_;',
      '};',
      '}  // namespace ns',
    ));
    write('src/table.cc', lines(
      '#include "include/table.h"',
      'namespace ns {',
      'class Block {',
      ' public:',
      '  int size() const { return 1; }',
      '  void Flush() {}',
      '};',
      'struct Table::Rep {',
      '  Block block;',
      '  Block* index;',
      '};',
      // Each namesake sits where a call matched by its bare name lands on it.
      'class Columns {',
      ' public:',
      '  int size() const { return 0; }',
      '  void Flush() {}',
      '};',
      'int Table::Size() { return rep_->block.size(); }',
      'void Table::Flush() { rep_->index->Flush(); }',
      '}  // namespace ns',
    ));
    write('src/builder.cc', lines(
      '#include "include/table.h"',
      'namespace ns {',
      'class Counter {',
      ' public:',
      '  int size() const { return 2; }',
      '};',
      'struct Builder::Rep {',
      '  Counter counter;',
      '};',
      'class Tally {',
      ' public:',
      '  int size() const { return 3; }',
      '};',
      'int Builder::Count() { return rep_->counter.size(); }',
      '}  // namespace ns',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function or method `qualifiedName`, as `qualifiedName`. */
  const calls = (qualifiedName: string): string[] => {
    const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
      .find((n: Node) => n.qualifiedName === qualifiedName);
    expect(caller, qualifiedName).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName).sort();
  };

  it("a member of the Rep a smart pointer holds, defined in the calling file", () => {
    expect(calls('ns::Table::Size')).toEqual(['ns::Block::size']);
  });

  it("a pointer member of the Rep", () => {
    expect(calls('ns::Table::Flush')).toEqual(['ns::Block::Flush']);
  });

  it('a raw Rep pointer', () => {
    expect(calls('ns::Builder::Count')).toEqual(['ns::Counter::size']);
  });
});
