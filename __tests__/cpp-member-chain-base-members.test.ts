/**
 * A C++ call on a data member that the object's class inherits, reached
 * through a member chain, calls a method of the member's class. rocksdb's
 * `Options` declares no members of its own: `options.statistics` and
 * `options.table_factory` are `DBOptions`' and `ColumnFamilyOptions`'. Only
 * the object's own class was read for the member, so such calls were guessed
 * by the method's name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call on a member chain through an inherited member', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-member-chain-base-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // Each namesake comes first: a call matched by its bare name lands on it.
    write('src/types.h', lines(
      'class ArenaStats {',
      ' public:',
      '  long getTickerCount(int t) const { return 0; }',
      '};',
      'class Statistics {',
      ' public:',
      '  virtual long getTickerCount(int t) const { return 1; }',
      '};',
      'class BlockNamesake {',
      ' public:',
      '  const char* Name() const { return "block"; }',
      '};',
      'class TableFactory {',
      ' public:',
      '  virtual const char* Name() const { return "table"; }',
      '};',
      'class MemTableNamesake {',
      ' public:',
      '  void CreateMemTableRep() {}',
      '};',
      'class MemTableRepFactory {',
      ' public:',
      '  virtual void CreateMemTableRep() {}',
      '};',
      'class FilePtr {',
      ' public:',
      '  void reset() {}',
      '};',
      'class Other {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class Inner {',
      ' public:',
      '  void Flush() {}',
      '};',
    ));
    write('src/options.h', lines(
      '#include <memory>',
      '#include "src/types.h"',
      'struct DBOptions {',
      '  Statistics* statistics = nullptr;',
      '};',
      'struct AdvancedColumnFamilyOptions {',
      '  MemTableRepFactory* memtable_factory = nullptr;',
      '};',
      'struct ColumnFamilyOptions : public AdvancedColumnFamilyOptions {',
      '  std::shared_ptr<TableFactory> table_factory;',
      '};',
      'struct Options : public DBOptions, public ColumnFamilyOptions {};',
      'struct Shadowing : public DBOptions {',
      '  Inner statistics;',
      '};',
    ));
    write('src/use.cc', lines(
      '#include "src/options.h"',
      'void Stats(Options& options) { options.statistics->getTickerCount(0); }',
      'void Table(Options* options) { options->table_factory->Name(); }',
      'void Memtable(const Options& opts) { opts.memtable_factory->CreateMemTableRep(); }',
      'void HolderOwn(Options& options) { options.table_factory.reset(); }',
      'void Shadowed(Shadowing& s) { s.statistics.Flush(); }',
      'struct Holder {',
      '  Options opts;',
      '};',
      'void Deep(Holder* h) { h->opts.statistics->getTickerCount(1); }',
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

  it("a member the object's class inherits from either base", () => {
    expect(calls('Stats')).toEqual(['Statistics::getTickerCount']);
    expect(calls('Table')).toEqual(['TableFactory::Name']);
  });

  it('a member inherited through two levels', () => {
    expect(calls('Memtable')).toEqual(['MemTableRepFactory::CreateMemTableRep']);
  });

  it("an inherited library member's own method calls none of the project's", () => {
    expect(calls('HolderOwn')).toEqual([]);
  });

  it("the class's own member before a base's of the same name", () => {
    expect(calls('Shadowed')).toEqual(['Inner::Flush']);
  });

  it('an inherited member further down a chain', () => {
    expect(calls('Deep')).toEqual(['Statistics::getTickerCount']);
  });
});
