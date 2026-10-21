/**
 * A C++ call on a member of the `std::pair` a map's iterator points at, like
 * `it->second.Flush()`, or a range-for's `kv.second.Flush()`, calls a member
 * of the map's value (or key, for `first`). The extractor records such a
 * call by its bare name, which went to whichever class had a method of that
 * name, and a local the member initializes (`auto& v = it->second`) had no
 * type.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-map-iterator-'));
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

/** `Other` comes first: a call matched by its bare name lands on it. */
const TYPES = {
  'src/types.h': lines(
    'class Other {',
    ' public:',
    '  void Flush() {}',
    '  void Print() const {}',
    '  bool ok() const { return false; }',
    '  int size() const { return 0; }',
    '};',
    'class Writer {',
    ' public:',
    '  void Flush() {}',
    '};',
    'class Buffer {',
    ' public:',
    '  void Flush() {}',
    '};',
    'class Key {',
    ' public:',
    '  void Print() const {}',
    '};',
    'class Status {',
    ' public:',
    '  bool ok() const { return true; }',
    '};',
  ),
};

describe('a C++ call on the member of the pair a map\'s iterator points at', () => {
  it('reproduction: `it->second->Flush()` and `it->second.Flush()`', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/maps.cc': lines(
        '#include <map>',
        '#include <string>',
        '#include "src/types.h"',
        'void FlushAll(std::map<std::string, Writer*>& writers) {',
        '  for (auto it = writers.begin(); it != writers.end(); ++it) it->second->Flush();',
        '}',
        'void FlushOne(std::map<int, Buffer>& buffers, int k) {',
        '  auto it = buffers.find(k);',
        '  it->second.Flush();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'FlushAll')).toEqual(['Writer::Flush']);
      expect(calls(cg, 'FlushOne')).toEqual(['Buffer::Flush']);
    } finally {
      cg.close();
    }
  });

  it('a range-for\'s pair, a dereferenced iterator\'s, the key, and a local the member initializes', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/walk.cc': lines(
        '#include <map>',
        '#include "src/types.h"',
        'void Each(std::map<int, Buffer>& buffers) {',
        '  for (auto& kv : buffers) kv.second.Flush();',
        '}',
        'void Deref(std::map<int, Buffer>& buffers) {',
        '  auto it = buffers.begin();',
        '  (*it).second.Flush();',
        '}',
        'void Keys(std::map<Key, int>& counts) {',
        '  auto it = counts.begin();',
        '  it->first.Print();',
        '}',
        'void Bound(std::map<int, Buffer>& buffers, int k) {',
        '  auto it = buffers.find(k);',
        '  auto& v = it->second;',
        '  v.Flush();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Each')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'Deref')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'Keys')).toEqual(['Key::Print']);
      expect(calls(cg, 'Bound')).toEqual(['Buffer::Flush']);
    } finally {
      cg.close();
    }
  });

  it('a pair the code declares, and a member of a library type, which has no project method', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/pairs.cc': lines(
        '#include <map>',
        '#include <string>',
        '#include <utility>',
        '#include "src/types.h"',
        'bool Check() {',
        '  std::pair<Status, std::string> status_and_path;',
        '  return status_and_path.first.ok();',
        '}',
        'int Length(std::map<int, std::string>& names) {',
        '  auto it = names.begin();',
        '  return it->second.size();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Check')).toEqual(['Status::ok']);
      expect(calls(cg, 'Length')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a member another class template\'s parameter types goes on as before', async () => {
    const cg = await indexed({
      'util/core_local.h': lines(
        '#include <cstddef>',
        '#include <utility>',
        'template <typename T>',
        'class CoreLocalArray {',
        ' public:',
        '  std::pair<T*, size_t> AccessElementAndIndex() const { return {nullptr, 0}; }',
        '};',
      ),
      'util/cache.cc': lines(
        '#include "util/core_local.h"',
        'class ZSTDCachedData {',
        ' public:',
        '  int GetUncompressData(long idx) { return 0; }',
        '};',
        'class Rep {',
        ' public:',
        '  int Get() {',
        '    auto p = per_core_.AccessElementAndIndex();',
        '    return p.first->GetUncompressData(0);',
        '  }',
        ' private:',
        '  CoreLocalArray<ZSTDCachedData> per_core_;',
        '};',
      ),
    });
    try {
      expect(calls(cg, 'Rep::Get')).toEqual(['CoreLocalArray::AccessElementAndIndex', 'ZSTDCachedData::GetUncompressData']);
    } finally {
      cg.close();
    }
  });

  it('a call on `this` is still the class\'s own, whatever its members are named', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/holder.cc': lines(
        '#include "src/types.h"',
        'class Holder {',
        ' public:',
        '  void Flush() {}',
        '  void Run() { this->Flush(); }',
        '};',
      ),
    });
    try {
      expect(calls(cg, 'Holder::Run')).toEqual(['Holder::Flush']);
    } finally {
      cg.close();
    }
  });
});
