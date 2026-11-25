/**
 * A C++ call on a data member reached through a member chain, like rocksdb's
 * `thread->rnd.Next()` on a `Random rnd` or `meta.smallest.user_key()` on an
 * `InternalKey smallest`, calls the method of the class the member is
 * declared as, or of a class it derives from. The extractor records such a
 * call by its bare name, so it went to whichever class had a method of that
 * name: `ArenaWrappedDBIter::Next`, `ClippingIterator::user_key`, or the
 * calling method's own class.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call on a member chain of a project class', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-member-chain-project-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // Each namesake comes first: a call matched by its bare name lands on it.
    write('src/types.h', lines(
      'class ArenaWrappedDBIter {',
      ' public:',
      '  void Next() {}',
      '};',
      'class Random {',
      ' public:',
      '  unsigned Next() { return 0; }',
      '};',
      'class ClippingIterator {',
      ' public:',
      '  int user_key() const { return 1; }',
      '};',
      'class InternalKey {',
      ' public:',
      '  int user_key() const { return 0; }',
      '};',
      'class InMemoryEnv {',
      ' public:',
      '  void NewWritableFile() {}',
      '};',
      'class Env {',
      ' public:',
      '  virtual void NewWritableFile() {}',
      '};',
      'class Other {',
      ' public:',
      '  void Shared() {}',
      '};',
      'class Base {',
      ' public:',
      '  void Shared() {}',
      '};',
      'class Derived : public Base {};',
      'class Free {',
      ' public:',
      '  void Missing() {}',
      '};',
      'class Lacking {',
      ' public:',
      '  void Something() {}',
      '};',
      'class Cache {',
      ' public:',
      '  void Put(int k, int v) {}',
      '};',
      'class Table {',
      ' public:',
      '  void Put(int k) {}',
      '  void Put(int k, int v) {}',
      '};',
      'class Random64 {',
      ' public:',
      '  unsigned Next() { return 1; }',
      '};',
    ));
    // Two files each declare a `SharedState` of their own, with members of the same name.
    write('src/a_shared.h', lines(
      '#include "src/types.h"',
      'struct SharedState {',
      '  Random rand;',
      '};',
    ));
    write('src/bench.cc', lines(
      '#include "src/types.h"',
      'struct SharedState {',
      '  Random64 rand;',
      '};',
      'void Bench(SharedState* shared) { shared->rand.Next(); }',
    ));
    write('src/use.cc', lines(
      '#include "src/types.h"',
      'struct ThreadState {',
      '  Random rnd;',
      '};',
      'struct FileMeta {',
      '  InternalKey smallest;',
      '};',
      'struct Options {',
      '  Env* env;',
      '};',
      'struct Holder {',
      '  Derived d;',
      '  Lacking l;',
      '  Table table;',
      '};',
      'struct Outer {',
      '  ThreadState inner;',
      '};',
      'void Rand(ThreadState* thread) { thread->rnd.Next(); }',
      'void Key(FileMeta& meta) { meta.smallest.user_key(); }',
      'void EnvCall(Options& options) { options.env->NewWritableFile(); }',
      'void TwoHops(Outer* o) { o->inner.rnd.Next(); }',
      'void Inherited(Holder& h) { h.d.Shared(); }',
      'void Lacks(Holder& h) { h.l.Missing(); }',
      'void Overload(Holder& h) { h.table.Put(1, 2); }',
      'class Worker {',
      ' public:',
      '  void Next() {}',
      '  void Step() { this->state_.rnd.Next(); }',
      ' private:',
      '  ThreadState state_;',
      '};',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function or method `name`, as `qualifiedName` (`:line` with `withLine`). */
  const calls = (name: string, withLine = false): string[] => {
    const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find((n: Node) => n.name === name);
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls')
      .map((r) => (withLine ? `${r.node.qualifiedName}:${r.node.startLine}` : r.node.qualifiedName)).sort();
  };

  it("calls the method of the member's class, not a namesake's", () => {
    expect(calls('Rand')).toEqual(['Random::Next']);
    expect(calls('Key')).toEqual(['InternalKey::user_key']);
    expect(calls('EnvCall')).toEqual(['Env::NewWritableFile']);
  });

  it('through two members', () => {
    expect(calls('TwoHops')).toEqual(['Random::Next']);
  });

  it("a method the member's class inherits, and none when the class lacks it", () => {
    expect(calls('Inherited')).toEqual(['Base::Shared']);
    expect(calls('Lacks')).toEqual([]);
  });

  it("of the class's overloads, the one the arguments fit", () => {
    expect(calls('Overload', true)).toEqual(['Table::Put:49']);
  });

  it("a chain through `this` is no call on the calling method's own class", () => {
    expect(calls('Step')).toEqual(['Random::Next']);
  });

  it("a member of the file's own class, not of another file's class of that name", () => {
    expect(calls('Bench')).toEqual(['Random64::Next']);
  });
});
