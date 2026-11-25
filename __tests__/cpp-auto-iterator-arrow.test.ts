/**
 * A `->` call on a C++ `auto` local that a library container's member or a
 * standard search hands an iterator, like rocksdb's `auto it =
 * logs_.begin(); it->IsSyncing()`, calls a member of the container's
 * element, as on an iterator declared with its type. The local had no type,
 * so the call was matched by the method's name alone.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-auto-iterator-'));
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

describe('a `->` call on a C++ `auto` local holding a library container\'s iterator', () => {
  it('reproduction: rocksdb\'s `auto it = logs_.begin(); it->IsSyncing()`', async () => {
    const cg = await indexed({
      'db/log_writer.h': lines(
        'class Writer {',
        ' public:',
        '  bool IsSyncing() const { return false; }',
        '};',
      ),
      'db/db_impl.h': lines(
        '#include <deque>',
        'class DBImpl {',
        ' public:',
        '  struct LogWriterNumber {',
        '    bool IsSyncing() const { return true; }',
        '    void ReleaseWriter() {}',
        '  };',
        '  void MarkLogsSynced();',
        ' private:',
        '  std::deque<LogWriterNumber> logs_;',
        '};',
      ),
      'db/db_impl.cc': lines(
        '#include "db/db_impl.h"',
        '#include "db/log_writer.h"',
        'void DBImpl::MarkLogsSynced() {',
        '  auto it = logs_.begin();',
        '  if (it->IsSyncing()) it->ReleaseWriter();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'DBImpl::MarkLogsSynced')).toEqual(['DBImpl::LogWriterNumber::IsSyncing', 'DBImpl::LogWriterNumber::ReleaseWriter']);
    } finally {
      cg.close();
    }
  });

  it('from a standard search, and a reverse iterator', async () => {
    const cg = await indexed({
      'util/entries.h': lines(
        'class Entry {',
        ' public:',
        '  const char* name() const { return nullptr; }',
        '};',
        'class Column {',
        ' public:',
        '  const char* name() const { return nullptr; }',
        '};',
      ),
      'util/lookup.cc': lines(
        '#include <algorithm>',
        '#include <vector>',
        '#include "util/entries.h"',
        'const char* Find(const std::vector<Entry>& entries, const Entry& key) {',
        '  auto it = std::lower_bound(entries.begin(), entries.end(), key);',
        '  return it->name();',
        '}',
        'const char* Last(std::vector<Entry>& entries) {',
        '  auto it = entries.rbegin();',
        '  return it->name();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Find')).toEqual(['Entry::name']);
      expect(calls(cg, 'Last')).toEqual(['Entry::name']);
    } finally {
      cg.close();
    }
  });

  it('the element is looked up where the container\'s type is written', async () => {
    const cg = await indexed({
      'db/version_set.h': lines(
        '#include <vector>',
        'struct ObsoleteFile {',
        '  void DeleteFile() {}',
        '};',
        'class VersionSet {',
        ' public:',
        '  struct ObsoleteFile {',
        '    void DeleteFile() {}',
        '  };',
        '  std::vector<ObsoleteFile> obsolete_files_;',
        '};',
      ),
      'db/purge.cc': lines(
        '#include "db/version_set.h"',
        'void Purge(VersionSet* vs) {',
        '  auto it = vs->obsolete_files_.begin();',
        '  it->DeleteFile();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Purge')).toEqual(['VersionSet::ObsoleteFile::DeleteFile']);
    } finally {
      cg.close();
    }
  });

  it('a smart pointer member\'s type is still looked up where the call is: a pimpl defined in the source file', async () => {
    const cg = await indexed({
      'db/database.h': lines(
        '#include <memory>',
        'class SimpleDatabase {',
        ' public:',
        '  class DescriptorIndex {',
        '   public:',
        '    bool AddFile() { return false; }',
        '  };',
        '};',
        'class EncodedDatabase {',
        ' public:',
        '  bool Add();',
        ' private:',
        '  class DescriptorIndex;',
        '  std::unique_ptr<DescriptorIndex> index_;',
        '};',
      ),
      'db/database.cc': lines(
        '#include "db/database.h"',
        'class EncodedDatabase::DescriptorIndex {',
        ' public:',
        '  bool AddFile() { return true; }',
        '};',
        'bool EncodedDatabase::Add() {',
        '  return index_->AddFile();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'EncodedDatabase::Add')).toEqual(['EncodedDatabase::DescriptorIndex::AddFile']);
    } finally {
      cg.close();
    }
  });

  it('an element of a library type has no project method to call', async () => {
    const cg = await indexed({
      'util/library.h': lines(
        'class ObjectLibrary {',
        ' public:',
        '  ObjectLibrary* get() { return this; }',
        '};',
      ),
      'util/registry.cc': lines(
        '#include <memory>',
        '#include <vector>',
        '#include "util/library.h"',
        'class Registry {',
        ' public:',
        '  bool Newest() const {',
        '    auto iter = libraries_.crbegin();',
        '    return iter->get() != nullptr;',
        '  }',
        ' private:',
        '  std::vector<std::shared_ptr<ObjectLibrary>> libraries_;',
        '};',
      ),
    });
    try {
      expect(calls(cg, 'Registry::Newest')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a project class named like a library container keeps what its own `begin()` returns', async () => {
    const cg = await indexed({
      'util/span.h': lines(
        'class Foo {',
        ' public:',
        '  void Bar() {}',
        '};',
        'class Baz {',
        ' public:',
        '  void Bar() {}',
        '};',
        'namespace util {',
        'class span {',
        ' public:',
        '  Foo* begin() { return nullptr; }',
        '};',
        '}  // namespace util',
      ),
      'util/use.cc': lines(
        '#include "util/span.h"',
        'void Use(util::span s) {',
        '  auto it = s.begin();',
        '  it->Bar();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['Foo::Bar', 'util::span::begin']);
    } finally {
      cg.close();
    }
  });
});
