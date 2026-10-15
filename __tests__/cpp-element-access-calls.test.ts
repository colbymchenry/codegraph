/**
 * A C++ call on a subscripted element, like `statuses[i].IsNotFound()` over
 * a `std::vector<Status>`, `m[k].Flush()` over a map, or `iters[i]->Valid()`
 * over owning pointers, calls a member of the element's class. The
 * extractor records such a call by its bare name, which went to whichever
 * class had a method of that name, and a local an element initializes
 * (`auto& s = statuses[i]`) had no type. An array's element is the type the
 * array is declared with (`Row rows[2]`), however many dimensions it has.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-element-access-'));
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

/** `calls` callees of a function or method, as `qualifiedName:startLine`, which tells overloads apart. */
function callsAt(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName}:${r.node.startLine}`)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** `Other` comes first: a call matched by its bare name lands on it. */
const TYPES = {
  'src/types.h': lines(
    'class Other {',
    ' public:',
    '  bool IsNotFound() const { return false; }',
    '  bool ok() const { return false; }',
    '  void Flush() {}',
    '  bool Valid() const { return false; }',
    '  int size() const { return 0; }',
    '  void Print() const {}',
    '  int Size() const { return 0; }',
    '};',
    'class Status {',
    ' public:',
    '  bool IsNotFound() const { return true; }',
    '  bool ok() const { return true; }',
    '};',
    'class Buffer {',
    ' public:',
    '  void Flush() {}',
    '};',
    'class Iterator {',
    ' public:',
    '  bool Valid() const { return true; }',
    '};',
    'class Cell {',
    ' public:',
    '  void Print() const {}',
    '};',
    'class Row {',
    ' public:',
    '  Cell& operator[](int i) { return cells_[i]; }',
    '  int Size() const { return 4; }',
    ' private:',
    '  Cell cells_[4];',
    '};',
  ),
};

describe('a C++ call on a subscripted element', () => {
  it('reproduction: a vector\'s, a map\'s, and owning pointers\' elements', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/access.cc': lines(
        '#include <map>',
        '#include <memory>',
        '#include <vector>',
        '#include "src/types.h"',
        'bool Missing(std::vector<Status>& statuses, int i) { return statuses[i].IsNotFound(); }',
        'void FlushOne(std::map<int, Buffer>& buffers, int k) { buffers[k].Flush(); }',
        'bool AnyValid(std::vector<std::unique_ptr<Iterator>>& iters, int i) { return iters[i]->Valid(); }',
      ),
    });
    try {
      expect(calls(cg, 'Missing')).toEqual(['Status::IsNotFound']);
      expect(calls(cg, 'FlushOne')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'AnyValid')).toEqual(['Iterator::Valid']);
    } finally {
      cg.close();
    }
  });

  it('a raw array, a pointer, two subscripts, a pair\'s member, and a local the element initializes', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/more.cc': lines(
        '#include <utility>',
        '#include <vector>',
        '#include "src/types.h"',
        'bool Array() { Status statuses[3]; return statuses[0].ok(); }',
        'bool Pointer(Status* statuses, int i) { return statuses[i].ok(); }',
        'void Grid(std::vector<std::vector<Buffer>>& table) { table[0][1].Flush(); }',
        'void Pairs(std::vector<std::pair<Buffer, int>>& cfs, int i) { cfs[i].first.Flush(); }',
        'bool Bound(std::vector<Status>& statuses, int i) {',
        '  auto& s = statuses[i];',
        '  return s.ok();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Array')).toEqual(['Status::ok']);
      expect(calls(cg, 'Pointer')).toEqual(['Status::ok']);
      expect(calls(cg, 'Grid')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'Pairs')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'Bound')).toEqual(['Status::ok']);
    } finally {
      cg.close();
    }
  });

  it('a class\'s `operator[]`, a key with a `]` in it, and an element of a library type', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/rows.cc': lines(
        '#include <map>',
        '#include <string>',
        '#include <vector>',
        '#include "src/types.h"',
        'void Show(Row& row) { row[0].Print(); }',
        'void Named(std::map<std::string, Buffer>& buffers) { buffers["a]b"].Flush(); }',
        'int Length(std::vector<std::string>& values, int i) { return values[i].size(); }',
      ),
    });
    try {
      expect(calls(cg, 'Show')).toEqual(['Cell::Print']);
      expect(calls(cg, 'Named')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'Length')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('an array is of the type it is declared with, however many dimensions it has', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/arrays.cc': lines(
        '#include <vector>',
        '#include "src/types.h"',
        'class Shards {',
        ' public:',
        '  bool Second() { return statuses_[1].ok(); }',
        ' private:',
        '  Status statuses_[2];',
        '};',
        'int Rows() { Row rows[2]; return rows[1].Size(); }',
        'using Line = Row;',
        'int Lines() { Line lines[2]; return lines[1].Size(); }',
        'bool Grid() { Status grid[2][3]; return grid[1][2].ok(); }',
        'void Pools() { std::vector<Buffer> pools[2]; pools[1][0].Flush(); }',
        'bool First() { Status statuses[2]; return (*statuses).ok(); }',
        'bool Each() {',
        '  Status statuses[2];',
        '  for (auto& s : statuses) {',
        '    if (!s.ok()) return false;',
        '  }',
        '  return true;',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Shards::Second')).toEqual(['Status::ok']);
      expect(calls(cg, 'Rows')).toEqual(['Row::Size']);
      expect(calls(cg, 'Lines')).toEqual(['Row::Size']);
      expect(calls(cg, 'Grid')).toEqual(['Status::ok']);
      expect(calls(cg, 'Pools')).toEqual(['Buffer::Flush']);
      expect(calls(cg, 'First')).toEqual(['Status::ok']);
      expect(calls(cg, 'Each')).toEqual(['Status::ok']);
    } finally {
      cg.close();
    }
  });

  it('an element read by subscript picks the overload it is passed to', async () => {
    const cg = await indexed({
      ...TYPES,
      'src/sink.cc': lines(
        '#include <map>',
        '#include "src/types.h"',
        'class Sink {',
        ' public:',
        '  void Put(const Other& o) {}',
        '  void Put(const Buffer& b) {}',
        '};',
        'void Drain(Sink& sink, std::map<int, Buffer>& buffers) { sink.Put(buffers[1]); }',
      ),
    });
    try {
      expect(callsAt(cg, 'Drain')).toEqual(['Sink::Put:6']);
    } finally {
      cg.close();
    }
  });
});
