/**
 * A C++ call on a variable, parameter or member whose declaration puts
 * qualifiers or annotations around its name reaches the method of the
 * declared type.
 *
 * Receiver inference reads a declaration as a type followed by the name.
 * What may stand between them was read as the type: in facebook/rocksdb's
 * `Iterator* const iter = iter_guard.get();` the type was `const`, which
 * names nothing, so the scan went on to an earlier function's `iter` and
 * guessed by its type's last name. The same held for a type written before
 * its `const` (`Slice const& key`), for protobuf's nullability annotations
 * (`Arena* PROTOBUF_NULLABLE arena`, read as a type named
 * `PROTOBUF_NULLABLE`), and for an annotation after the name (leveldb's
 * `VersionSet* const versions_ GUARDED_BY(mutex_);`, not read at all).
 *
 * A guess can land on the right method by a shared word, so these tests
 * check the confidence, not only the target.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-qualified-'));
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

/** `calls` callees of a function or method, as `qualifiedName @confidence`, one per call site. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** rocksdb's two `Iterator`s: the public one and the nested `MemTableRep::Iterator`. */
const ITERATORS = lines(
  'namespace rocksdb {',
  'class Iterator {',
  ' public:',
  '  virtual ~Iterator() {}',
  '  virtual void SeekToFirst() = 0;',
  '  virtual bool Valid() const = 0;',
  '};',
  'class MemTableRep {',
  ' public:',
  '  class Iterator {',
  '   public:',
  '    void SeekToFirst() {}',
  '    bool Valid() const { return false; }',
  '  };',
  '};',
  '}  // namespace rocksdb',
);

/** A class the calls are in the namespace of, declared in a header. */
const UI_WIDGET = lines(
  'namespace ui {',
  'class Widget {',
  ' public:',
  '  void Draw() {}',
  '};',
  '}  // namespace ui',
);

/** A namesake beside the calls, which a guess by the type's last name prefers. */
const LEGACY_WIDGET = lines(
  'namespace legacy {',
  'class Widget {',
  ' public:',
  '  void Draw() {}',
  '};',
  '}  // namespace legacy',
);

describe('C++ declarations with qualifiers or annotations around the name', () => {
  it('reads `Iterator* const iter`, not an earlier function\'s `iter`', async () => {
    const cg = await indexed({
      'include/iterator.h': lines(
        'namespace rocksdb {',
        'class Iterator {',
        ' public:',
        '  virtual ~Iterator() {}',
        '  virtual void SeekToFirst() = 0;',
        '  virtual bool Valid() const = 0;',
        '};',
        '}  // namespace rocksdb',
      ),
      // As in rocksdb's memtable.cc, the nested namesake sits beside the calls.
      'db/memtable.cc': lines(
        '#include "include/iterator.h"',
        'namespace rocksdb {',
        'class MemTableRep {',
        ' public:',
        '  class Iterator {',
        '   public:',
        '    void SeekToFirst() {}',
        '    bool Valid() const { return false; }',
        '  };',
        '};',
        'void Earlier() {',
        '  MemTableRep::Iterator* iter = nullptr;',
        '  iter->SeekToFirst();',
        '}',
        'void Scan(Iterator* source) {',
        '  Iterator* const iter = source;',
        '  iter->SeekToFirst();',
        '  if (iter->Valid()) {}',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Scan')).toEqual(['rocksdb::Iterator::SeekToFirst @0.9', 'rocksdb::Iterator::Valid @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a type written before its `const` (`Slice const& key`)', async () => {
    const cg = await indexed({
      'util/slice.h': lines(
        'namespace leveldb {',
        'class Slice {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'namespace log {',
        'class Slice {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        '}  // namespace log',
        '}  // namespace leveldb',
      ),
      'util/length.cc': lines(
        '#include "util/slice.h"',
        'namespace leveldb {',
        'int Length(Slice const& key) {',
        '  return key.size();',
        '}',
        'int Count(Slice const* key) {',
        '  return key->size();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::Length')).toEqual(['leveldb::Slice::size @0.9']);
      expect(calls(cg, 'leveldb::Count')).toEqual(['leveldb::Slice::size @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads past a nullability annotation after the `*` (`Arena* PROTOBUF_NULLABLE arena`)', async () => {
    const cg = await indexed({
      'src/google/protobuf/arena.h': lines(
        '#define PROTOBUF_NULLABLE',
        '#define PROTOBUF_NONNULL',
        'namespace google {',
        'namespace protobuf {',
        'class Arena {',
        ' public:',
        '  void Reset() {}',
        '};',
        'class ArenaStringPtr {',
        ' public:',
        '  void Reset() {}',
        '};',
        'void Clear(Arena* PROTOBUF_NULLABLE arena) {',
        '  arena->Reset();',
        '}',
        'void ClearOwned(Arena* owner) {',
        '  Arena* absl_nonnull arena = owner;',
        '  arena->Reset();',
        '}',
        'class Printer {',
        ' public:',
        '  void Print() {}',
        '};',
        'class Generator {',
        ' public:',
        '  void Emit();',
        ' private:',
        '  Printer* PROTOBUF_NONNULL printer_;',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      // A member read from its class, in a file of another name.
      'src/google/protobuf/generator_emit.cc': lines(
        '#include "src/google/protobuf/arena.h"',
        'namespace google {',
        'namespace protobuf {',
        'class Formatter {',
        ' public:',
        '  void Print() {}',
        '};',
        'void Generator::Emit() {',
        '  printer_->Print();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Clear')).toEqual(['google::protobuf::Arena::Reset @0.9']);
      expect(calls(cg, 'google::protobuf::ClearOwned')).toEqual(['google::protobuf::Arena::Reset @0.9']);
      expect(calls(cg, 'google::protobuf::Generator::Emit')).toEqual(['google::protobuf::Printer::Print @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a member with an annotation after its name (`VersionSet* const versions_ GUARDED_BY(mutex_);`)', async () => {
    const cg = await indexed({
      'db/version_set.h': lines(
        'namespace leveldb {',
        'class VersionSet {',
        ' public:',
        '  int LogNumber() const { return 0; }',
        '};',
        'class VersionEdit {',
        ' public:',
        '  int LogNumber() const { return 0; }',
        '};',
        '}  // namespace leveldb',
      ),
      'db/db_impl.h': lines(
        '#include "db/version_set.h"',
        '#define GUARDED_BY(x)',
        'namespace leveldb {',
        'class DBImpl {',
        ' public:',
        '  void Recover();',
        ' private:',
        '  VersionSet* const versions_ GUARDED_BY(mutex_);',
        '};',
        '}  // namespace leveldb',
      ),
      'db/db_impl_open.cc': lines(
        '#include "db/db_impl.h"',
        'namespace leveldb {',
        'void DBImpl::Recover() {',
        '  versions_->LogNumber();',
        '}',
        '}  // namespace leveldb',
      ),
    });
    try {
      expect(calls(cg, 'leveldb::DBImpl::Recover')).toEqual(['leveldb::VersionSet::LogNumber @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads `auto* const` and smart-pointer locals, and range-for variables', async () => {
    const cg = await indexed({
      'ui/widget.h': UI_WIDGET,
      'ui/paint.cc': lines(
        '#include <memory>',
        '#include <vector>',
        '#include "ui/widget.h"',
        '#define PROTOBUF_NONNULL',
        LEGACY_WIDGET,
        'namespace ui {',
        'void Paint() {',
        '  auto* const w = new Widget();',
        '  w->Draw();',
        '}',
        'void PaintOwned(std::unique_ptr<Widget> const w) {',
        '  w->Draw();',
        '}',
        'void PaintAll(std::vector<Widget*>& ws) {',
        '  for (Widget* const w : ws) w->Draw();',
        '}',
        'void PaintEach(std::vector<std::unique_ptr<Widget>>& ws) {',
        '  for (std::unique_ptr<Widget> const& w : ws) w->Draw();',
        '}',
        'void PaintMarked(std::vector<Widget*>& ws) {',
        '  for (Widget* PROTOBUF_NONNULL w : ws) w->Draw();',
        '}',
        '}  // namespace ui',
      ),
    });
    try {
      expect(calls(cg, 'ui::Paint')).toEqual(['ui::Widget::Draw @0.9']);
      expect(calls(cg, 'ui::PaintOwned')).toEqual(['ui::Widget::Draw @0.9']);
      expect(calls(cg, 'ui::PaintAll')).toEqual(['ui::Widget::Draw @0.9']);
      expect(calls(cg, 'ui::PaintEach')).toEqual(['ui::Widget::Draw @0.9']);
      expect(calls(cg, 'ui::PaintMarked')).toEqual(['ui::Widget::Draw @0.9']);
    } finally {
      cg.close();
    }
  });

  it('keeps an ALL-CAPS type name, which is no annotation before a `*`', async () => {
    const cg = await indexed({
      'handle.cc': lines(
        'struct OS_HANDLE {',
        '  void Close() {}',
        '};',
        'struct FILE_HANDLE {',
        '  void Close() {}',
        '};',
        'void Shut(OS_HANDLE* const h) {',
        '  h->Close();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Shut')).toEqual(['OS_HANDLE::Close @0.9']);
    } finally {
      cg.close();
    }
  });

  it('keeps the operator a qualified declaration takes: `.` on a reference, `->` on a pointer', async () => {
    const cg = await indexed({
      'ui/widget.h': UI_WIDGET,
      'ui/draw.cc': lines(
        '#include "ui/widget.h"',
        LEGACY_WIDGET,
        'namespace ui {',
        'void ByRef(Widget const& w) { w.Draw(); }',
        'void ByPtr(Widget const* const w) { w->Draw(); }',
        '}  // namespace ui',
      ),
    });
    try {
      expect(calls(cg, 'ui::ByRef')).toEqual(['ui::Widget::Draw @0.9']);
      expect(calls(cg, 'ui::ByPtr')).toEqual(['ui::Widget::Draw @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads globals the same-named header declares with qualifiers', async () => {
    const cg = await indexed({
      'registry.h': lines(
        '#define PROTOBUF_NULLABLE',
        'class Registry {',
        ' public:',
        '  void Add() {}',
        '};',
        'extern Registry* const g_registry;',
        'extern Registry* PROTOBUF_NULLABLE g_fallback;',
      ),
      'registry.cc': lines(
        '#include "registry.h"',
        'class Catalog {',
        ' public:',
        '  void Add() {}',
        '};',
        'void Use() {',
        '  g_registry->Add();',
        '}',
        'void UseFallback() {',
        '  g_fallback->Add();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['Registry::Add @0.9']);
      expect(calls(cg, 'UseFallback')).toEqual(['Registry::Add @0.9']);
    } finally {
      cg.close();
    }
  });

  it('takes a parameter declared `std::function<void()> const Finish` for what a bare `Finish()` calls, not the method', async () => {
    // C++ lookup no longer claims the call for the class's method; the name
    // strategies decide, as for any parameter or local that shadows a member.
    const cg = await indexed({
      'job.cc': lines(
        '#include <functional>',
        'class Job {',
        ' public:',
        '  void Finish() {}',
        '  void Run(std::function<void()> const Finish) {',
        '    Finish();',
        '  }',
        '};',
      ),
    });
    try {
      const resolvedBy = cg
        .getCallees(callable(cg, 'Job::Run').id)
        .filter((r) => r.edge.kind === 'calls')
        .map((r) => (r.edge.metadata as { resolvedBy?: string } | undefined)?.resolvedBy);
      expect(resolvedBy).not.toContain('instance-method');
    } finally {
      cg.close();
    }
  });

  it('reads a declaration without qualifiers as before', async () => {
    const cg = await indexed({
      'include/iterator.h': ITERATORS,
      'db/plain.cc': lines(
        '#include "include/iterator.h"',
        'namespace rocksdb {',
        'void Plain(Iterator* iter) {',
        '  iter->SeekToFirst();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Plain')).toEqual(['rocksdb::Iterator::SeekToFirst @0.9']);
    } finally {
      cg.close();
    }
  });
});
