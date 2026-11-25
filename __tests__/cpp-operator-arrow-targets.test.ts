/**
 * A C++ `->` on a value of one of the project's classes calls that class's
 * `operator->`, and the member is looked up on what it returns: rocksdb's
 * `MultiGetContext::Range::Iterator` declares `KeyContext* operator->()`, its
 * `UnownedPtr<T>` a `T* operator->()`, and its `FileSystemPtr` returns a
 * `std::shared_ptr<FileSystem>`, which `->` is applied to again. Only a
 * library holder's or container iterator's `->` was read, so such calls were
 * guessed by the method's name: `iter->lkey->user_key()` reached
 * `BlobCountingIterator::user_key`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe("a C++ `->` through a project class's operator->", () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-operator-arrow-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write('src/types.h', lines(
      '#include <memory>',
      'namespace ns {',
      'class LookupKey {',
      ' public:',
      '  int user_key() const { return 0; }',
      '};',
      'struct KeyContext {',
      '  LookupKey* k;',
      '};',
      'class Range {',
      ' public:',
      '  class Iterator {',
      '   public:',
      '    KeyContext* operator->() const { return ctx_; }',
      '    KeyContext& operator*() const { return *ctx_; }',
      '   private:',
      '    KeyContext* ctx_;',
      '  };',
      '  Iterator begin() const { return Iterator(); }',
      '};',
      'class Cursor {',
      ' public:',
      '  KeyContext& operator*() const { return *ctx_; }',
      ' private:',
      '  KeyContext* ctx_;',
      '};',
      'template <typename T>',
      'class UnownedPtr {',
      ' public:',
      '  T* operator->() const { return p_; }',
      ' private:',
      '  T* p_;',
      '};',
            'class DB {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class Handle {',
      ' public:',
      '  UnownedPtr<DB> operator->() const { return p_; }',
      ' private:',
      '  UnownedPtr<DB> p_;',
      '};',
      'class FileSystem {',
      ' public:',
      '  void Sync() {}',
      '};',
      'class FileSystemPtr {',
      ' public:',
      '  const std::shared_ptr<FileSystem>& operator->() const { return fs_; }',
      ' private:',
      '  std::shared_ptr<FileSystem> fs_;',
      '};',
      '}  // namespace ns',
    ));
    write('src/use.cc', lines(
      '#include "src/types.h"',
      'namespace ns {',
      // Each namesake sits where a call matched by its bare name lands on it.
      'class KeyNamesake {',
      ' public:',
      '  int user_key() const { return 1; }',
      '};',
      'class FlushNamesake {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class SyncNamesake {',
      ' public:',
      '  void Sync() {}',
      '};',
      'int Chain(const Range& range) {',
      '  auto i = range.begin();',
      '  return i->k->user_key();',
      '}',
      'int Star(const Cursor& c) {',
      '  auto& kc = *c;',
      '  return kc.k->user_key();',
      '}',
      'void Template(UnownedPtr<DB> h) { h->Flush(); }',
      'void Holder(FileSystemPtr h) { h->Sync(); }',
      'void Twice(Handle h) { h->Flush(); }',
      'template <typename T>',
      'void Unbound(UnownedPtr<T> p) { p->Flush(); }',
      '}  // namespace ns',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function `qualifiedName`, as `qualifiedName`. */
  const calls = (qualifiedName: string): string[] => {
    const caller = cg.getNodesByKind('function').find((n: Node) => n.qualifiedName === qualifiedName);
    expect(caller, qualifiedName).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName)
      .filter((q) => !q.endsWith('::begin')).sort();
  };

  it("a chain through an iterator class's operator->", () => {
    expect(calls('ns::Chain')).toEqual(['ns::LookupKey::user_key']);
  });

  it("a chain through a class's operator*, when it has no operator->", () => {
    expect(calls('ns::Star')).toEqual(['ns::LookupKey::user_key']);
  });

  it("a class template's operator-> returning its parameter, bound by the written argument", () => {
    expect(calls('ns::Template')).toEqual(['ns::DB::Flush']);
  });

  it('an operator-> returning a library holder is applied again', () => {
    expect(calls('ns::Holder')).toEqual(['ns::FileSystem::Sync']);
  });

  it('a class an operator-> returns has its own operator-> applied', () => {
    expect(calls('ns::Twice')).toEqual(['ns::DB::Flush']);
  });

  it("a parameter the written type doesn't bind names no particular class", () => {
    expect(calls('ns::Unbound')).toEqual([]);
  });
});
