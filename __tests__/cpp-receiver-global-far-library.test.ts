/**
 * Two ways a C++ receiver's declared type reached a class it doesn't name.
 *
 * - A type written from the global scope. The declaration a call's receiver
 *   was read from lost its leading `::`, so `::upb::Arena& a` inside `namespace
 *   hpb` was looked up from `hpb` and found a namespace-local `hpb::upb::Arena`
 *   first; and a function-local `using Foo = Bar;` was taken for `::Foo`.
 * - A lowercase type from outside the project, declared outside the calling
 *   function (another function's variable of that name, a file's global): its
 *   last name still found a project class sharing it, as
 *   `util::flat_hash_set::insert` for an `absl::flat_hash_set<int>`, or a
 *   global `string` class's `clear` for a `std::string`. Such a declaration
 *   may be another variable's, so the call is guessed for as when no class
 *   shares the type's name, never linked to the namesake.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-global-far-'));
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

describe('a C++ receiver declared with a type written from the global scope', () => {
  const ARENAS = {
    'upb/mem/arena.hpp': lines(
      'namespace upb {',
      'class Arena {',
      ' public:',
      '  bool Fuse(Arena& other) { return true; }',
      '};',
      '}  // namespace upb',
    ),
    'hpb/upb_arena.h': lines(
      'namespace hpb {',
      'namespace upb {',
      'class Arena {',
      ' public:',
      '  bool Fuse(Arena& other) { return false; }',
      '};',
      '}  // namespace upb',
      '}  // namespace hpb',
    ),
  };

  it('reproduction: `::upb::Arena& a` inside `namespace hpb` is the global `upb::Arena`', async () => {
    const cg = await indexed({
      ...ARENAS,
      'hpb/join.cc': lines(
        '#include "upb/mem/arena.hpp"',
        '#include "hpb/upb_arena.h"',
        'namespace hpb {',
        'bool Join(::upb::Arena& a, ::upb::Arena& b) {',
        '  return a.Fuse(b);',
        '}',
        '}  // namespace hpb',
      ),
    });
    try {
      expect(calls(cg, 'hpb::Join')).toEqual(['upb::Arena::Fuse']);
    } finally {
      cg.close();
    }
  });

  it('declared over two lines, and as a range-based for loop\'s variable', async () => {
    const cg = await indexed({
      ...ARENAS,
      'hpb/fuse.cc': lines(
        '#include <vector>',
        '#include "upb/mem/arena.hpp"',
        '#include "hpb/upb_arena.h"',
        'namespace hpb {',
        'bool Pair(::upb::Arena& b) {',
        '  ::upb::Arena',
        '      paired;',
        '  return paired.Fuse(b);',
        '}',
        'void FuseAll(std::vector<::upb::Arena>& arenas, ::upb::Arena& b) {',
        '  for (::upb::Arena& each : arenas) {',
        '    each.Fuse(b);',
        '  }',
        '}',
        '}  // namespace hpb',
      ),
    });
    try {
      expect(calls(cg, 'hpb::Pair')).toEqual(['upb::Arena::Fuse']);
      expect(calls(cg, 'hpb::FuseAll')).toEqual(['upb::Arena::Fuse']);
    } finally {
      cg.close();
    }
  });

  it('a `::` after a template\'s arguments is no global scope: `Outer<T>::Iterator it` is Outer\'s', async () => {
    const cg = await indexed({
      'src/outer.h': lines(
        'class Iterator {',
        ' public:',
        '  bool Valid() const { return false; }',
        '};',
        'namespace ns {',
        'template <typename T>',
        'class Outer {',
        ' public:',
        '  class Iterator {',
        '   public:',
        '    bool Valid() const { return true; }',
        '  };',
        '  bool Scan() {',
        '    Outer<T>::Iterator it;',
        '    return it.Valid();',
        '  }',
        '};',
        '}  // namespace ns',
      ),
    });
    try {
      expect(calls(cg, 'ns::Outer::Scan')).toEqual(['ns::Outer::Iterator::Valid']);
    } finally {
      cg.close();
    }
  });

  it('is no alias of that name the calling function declares', async () => {
    const cg = await indexed({
      'src/use.cc': lines(
        'class Foo {',
        ' public:',
        '  void Run() {}',
        '};',
        'class Bar {',
        ' public:',
        '  void Run() {}',
        '};',
        'void Use() {',
        '  using Foo = Bar;',
        '  ::Foo f;',
        '  f.Run();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['Foo::Run']);
    } finally {
      cg.close();
    }
  });
});

describe('a lowercase outside type declared outside the calling function', () => {
  it('reproduction: an `absl::flat_hash_set` is not the project\'s `util::flat_hash_set`', async () => {
    const cg = await indexed({
      'util/hash_set.h': lines(
        'namespace util {',
        'template <class T>',
        'class flat_hash_set {',
        ' public:',
        '  void insert(const T& v) {}',
        '};',
        '}  // namespace util',
      ),
      'util/list.h': lines(
        'class List {',
        ' public:',
        '  void insert(int v) {}',
        '};',
      ),
      'db/seen.cc': lines(
        '#include "util/hash_set.h"',
        '#include "util/list.h"',
        'void Open() {',
        '  absl::flat_hash_set<int> seen;',
        '}',
        'void Mark(int v) {',
        '  seen.insert(v);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Mark')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a `std::string` is not a global project class named `string`', async () => {
    const cg = await indexed({
      'src/string.h': lines(
        'class string {',
        ' public:',
        '  void clear() {}',
        '};',
      ),
      'src/buffer.h': lines(
        'class Buffer {',
        ' public:',
        '  void clear() {}',
        '};',
      ),
      'src/text.cc': lines(
        '#include <string>',
        '#include "src/string.h"',
        '#include "src/buffer.h"',
        'void Load() {',
        '  std::string text;',
        '}',
        'void Reset() {',
        '  text.clear();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Reset')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the project\'s own lowercase type is still its own', async () => {
    const cg = await indexed({
      'util/hash_set.h': lines(
        'namespace util {',
        'template <class T>',
        'class flat_hash_set {',
        ' public:',
        '  void insert(const T& v) {}',
        '};',
        '}  // namespace util',
      ),
      'db/keep.cc': lines(
        '#include "util/hash_set.h"',
        'void Open() {',
        '  util::flat_hash_set<int> mine;',
        '}',
        'void Keep(int v) {',
        '  mine.insert(v);',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Keep')).toEqual(['util::flat_hash_set::insert']);
    } finally {
      cg.close();
    }
  });
});
