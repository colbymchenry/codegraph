/**
 * An `auto` local initialized from a call of a C++ member template with
 * explicit template arguments has the type the template returns for them.
 * A member call was read only when its callee ended in the method's name, so
 * `reflection->GetRaw<RepeatedPtrField<CPPTYPE>>(…)` was no call it could
 * read; and a return type that is the template's own parameter (`template
 * <typename Type> const Type& GetRaw(…)`) is what the arguments make it.
 * protocolbuffers/protobuf's `rep.size()` on such a local, in a macro whose
 * lines end in `\`, guessed `SooRep::size`; facebook/rocksdb's `auto bbto =
 * factory->GetOptions<BlockBasedTableOptions>();` gave `bbto` no type.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-member-template-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What a function's calls of `method` reach, as `qualifiedName resolvedBy@confidence`. */
function calls(cg: CodeGraph, qualifiedName: string, method: string): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .map((e) => {
      const meta = e.metadata as { confidence?: number; resolvedBy?: string } | undefined;
      return `${cg.getNode(e.target)?.qualifiedName} ${meta?.resolvedBy}@${meta?.confidence}`;
    })
    .filter((t) => t.split(' ')[0]!.endsWith(`::${method}`))
    .sort();
}

const SHAPES = lines(
  'class Widget {',
  ' public:',
  '  void Draw() {}',
  '};',
  'class Gadget {',
  ' public:',
  '  void Draw() {}',
  '};',
);

describe('C++ member templates called with explicit template arguments', () => {
  it("types protobuf's `const auto& rep =` from GetRaw<RepeatedPtrField<…>>, its line spliced with `\\`", async () => {
    const cg = await indexed({
      'src/google/protobuf/reflection.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class Message {};',
        'class FieldDescriptor {};',
        'template <typename Element>',
        'class RepeatedPtrField {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'class SooRep {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'class Reflection {',
        ' public:',
        '  template <typename Type>',
        '  const Type& GetRaw(const Message& message, const FieldDescriptor* field) const;',
        '};',
        'template <typename Type>',
        'const Type& Reflection::GetRaw(const Message& message, const FieldDescriptor* field) const {',
        '  static Type value;',
        '  return value;',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/google/protobuf/reflection_visit_fields.h': lines(
        '#include "src/google/protobuf/reflection.h"',
        'namespace google {',
        'namespace protobuf {',
        'int VisitFields(const Reflection* reflection, const Message& message,',
        '                const FieldDescriptor* field) {',
        // protobuf writes this in a macro, whose lines end in `\`.
        '  const auto& rep =                                                  \\',
        '      reflection->GetRaw<RepeatedPtrField<int>>(message, field);     \\',
        '      ;',
        '  return rep.size();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::VisitFields', 'size')).toEqual(['google::protobuf::RepeatedPtrField::size instance-method@0.9']);
    } finally {
      cg.close();
    }
  });

  it("types rocksdb's `auto bbto =` from GetOptions<BlockBasedTableOptions>(), const and not", async () => {
    const cg = await indexed({
      'include/rocksdb/configurable.h': lines(
        'namespace rocksdb {',
        'class Configurable {',
        ' public:',
        '  template <typename T>',
        '  const T* GetOptions() const { return nullptr; }',
        '  template <typename T>',
        '  T* GetOptions() { return nullptr; }',
        '};',
        'struct BlockBasedTableOptions {',
        '  bool IsValid() const { return true; }',
        '};',
        'struct PlainTableOptions {',
        '  bool IsValid() const { return true; }',
        '};',
        '}  // namespace rocksdb',
      ),
      'db/check.cc': lines(
        '#include "include/rocksdb/configurable.h"',
        'namespace rocksdb {',
        'bool Check(Configurable* factory) {',
        '  auto bbto = factory->GetOptions<BlockBasedTableOptions>();',
        '  return bbto->IsValid();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(calls(cg, 'rocksdb::Check', 'IsValid')).toEqual(['rocksdb::BlockBasedTableOptions::IsValid instance-method@0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a template overload only, a defaulted parameter by its name, and no guess between overloads', async () => {
    const cg = await indexed({
      'shapes.h': SHAPES,
      'store.cc': lines(
        '#include "shapes.h"',
        'class Store {',
        ' public:',
        '  Widget* Find() { return nullptr; }',
        '  template <typename T>',
        '  T* Find() { return nullptr; }',
        '  template <typename T = Widget>',
        '  T* Make() { return nullptr; }',
        '  template <typename A, typename B>',
        '  A* Get() { return nullptr; }',
        '  template <typename A, typename B>',
        '  B* Get(int key) { return nullptr; }',
        '};',
        'void Found(Store* store) {',
        '  auto found = store->Find<Gadget>();',
        '  found->Draw();',
        '}',
        'void Made(Store* store) {',
        '  auto made = store->Make<Gadget>();',
        '  made->Draw();',
        '}',
        'void Got(Store* store) {',
        '  auto got = store->Get<Widget, Gadget>(1);',
        '  got->Draw();',
        '}',
      ),
    });
    try {
      // Explicit template arguments call `T* Find()`, never `Widget* Find()`.
      expect(calls(cg, 'Found', 'Draw')).toEqual(['Gadget::Draw instance-method@0.9']);
      expect(calls(cg, 'Made', 'Draw')).toEqual(['Gadget::Draw instance-method@0.9']);
      // The overloads return different parameters; which one the call takes
      // isn't read, so neither is guessed.
      expect(calls(cg, 'Got', 'Draw').filter((t) => t.endsWith('@0.9'))).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
