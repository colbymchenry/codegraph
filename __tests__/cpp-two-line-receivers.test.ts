/**
 * A C++ receiver whose declaration is written over more than one line: its
 * type begun on a line above, or alone on the line above its name. Receiver
 * inference read a declaration a line at a time, so the line naming the
 * receiver declared nothing it could read, and the call fell to name matching:
 * protocolbuffers/protobuf's `extension.number()` on a `const
 * google::protobuf::internal::ExtensionIdentifier<` / `FeatureSet,
 * TypeTraitsT, field_type, is_packed>& extension` reached hpb's
 * `ExtensionIdentifier::number`. The lines are now read together.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-two-line-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What a function's or method's calls reach, as `qualifiedName resolvedBy@confidence`. */
function calls(cg: CodeGraph, qualifiedName: string): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .map((e) => {
      const meta = e.metadata as { confidence?: number; resolvedBy?: string } | undefined;
      return `${cg.getNode(e.target)?.qualifiedName} ${meta?.resolvedBy}@${meta?.confidence}`;
    })
    .sort();
}

const TABLES = lines(
  '#include <memory>',
  '#include <string>',
  'template <typename K, typename V>',
  'class Table {',
  ' public:',
  '  int size() const { return 0; }',
  '};',
  'class Index {',
  ' public:',
  '  int size() const { return 0; }',
  '};',
);

describe('C++ receivers declared over more than one line', () => {
  it("reads a type begun on a line above: protobuf's ExtensionIdentifier parameter", async () => {
    const cg = await indexed({
      'src/google/protobuf/extension_set.h': lines(
        '#include <cstdint>',
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'template <typename ExtendeeType, typename TypeTraitsType, uint8_t field_type, bool is_packed>',
        'class ExtensionIdentifier {',
        ' public:',
        '  int number() const { return 0; }',
        '};',
        '}  // namespace internal',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'hpb/extension.h': lines(
        'namespace hpb {',
        'namespace internal {',
        'template <typename T>',
        'class ExtensionIdentifier {',
        ' public:',
        '  int number() const { return 0; }',
        '};',
        '}  // namespace internal',
        '}  // namespace hpb',
      ),
      'src/google/protobuf/descriptor.h': lines(
        '#include "src/google/protobuf/extension_set.h"',
        'namespace google {',
        'namespace protobuf {',
        'class FeatureSet {};',
        'class DescriptorPool {',
        ' public:',
        '  template <typename TypeTraitsT, uint8_t field_type, bool is_packed>',
        '  bool ResolvesFeaturesFor(',
        '      const google::protobuf::internal::ExtensionIdentifier<',
        '          FeatureSet, TypeTraitsT, field_type, is_packed>& extension) const {',
        '    return extension.number() > 0;',
        '  }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::DescriptorPool::ResolvesFeaturesFor'))
        .toEqual(['google::protobuf::internal::ExtensionIdentifier::number instance-method@0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a type whose template arguments run over several lines above', async () => {
    const cg = await indexed({
      'tables.h': TABLES,
      'visit.cc': lines(
        '#include "tables.h"',
        'int Visit(',
        '    const Table<',
        '        std::string,',
        '        std::shared_ptr<const Index>>& table) {',
        '  return table.size();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Visit')).toEqual(['Table::size instance-method@0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a type written alone on the line above the name, and no expression continued there', async () => {
    const cg = await indexed({
      'tables.h': TABLES,
      'build.cc': lines(
        '#include "tables.h"',
        'struct Meters {',
        '  int value() const { return 0; }',
        '};',
        'Meters operator*(int k, const Meters& m);',
        'int Build() {',
        '  Table<std::string, std::shared_ptr<const Index>>',
        '      table;',
        '  Table<int, int>',
        '      *table_ptr = nullptr;',
        '  return table.size() + table_ptr->size();',
        '}',
        'int Scaled(int factor, const Meters& length) {',
        '  Meters total = factor',
        '      * length;',
        '  return length.value() + total.value();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Build')).toEqual(['Table::size instance-method@0.9', 'Table::size instance-method@0.9']);
      // `* length;` continues `Meters total = factor`: `length` is the parameter.
      expect(calls(cg, 'Scaled')).toEqual(['Meters::value instance-method@0.9', 'Meters::value instance-method@0.9']);
    } finally {
      cg.close();
    }
  });
});
