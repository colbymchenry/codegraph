/**
 * When a C++ call's receiver can't be typed, matchMethodCall guesses its
 * class from the receiver's name: the class it names exactly (`Outer::Count()`)
 * or its capitalized form (`arena.get()` → `Arena`). It then took any method
 * of the call's name in that class's file whose qualified name merely
 * contained the class's name. Once out-of-line nested classes were named,
 * protocolbuffers/protobuf's `arena.get()` on a `std::unique_ptr<Arena>`
 * reached `Arena::UniquePtr::get`, a class nested in `Arena`, at 0.8; and a
 * namesake like `ThreadSafeArena::get` matched the same way. In C and C++ the
 * method must now be a member of exactly that class.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-class-receiver-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What the calls at `line` of the function or method `qualifiedName` reach, as `qualifiedName @confidence`. */
function callsAt(cg: CodeGraph, qualifiedName: string, line: number): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .filter((e) => e.line === line)
    .map((e) => `${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const ARENA = lines(
  'namespace google {',
  'namespace protobuf {',
  'class Arena {',
  ' public:',
  '  template <typename T> class UniquePtr;',
  '  void* AllocateAligned(int n) { return nullptr; }',
  '};',
  'template <typename T>',
  'class Arena::UniquePtr {',
  ' public:',
  '  T* get() const { return nullptr; }',
  '};',
  'class ThreadSafeArena {',
  ' public:',
  '  int get() const { return 0; }',
  '};',
  '}  // namespace protobuf',
  '}  // namespace google',
);

describe('C++ calls on a receiver named like a class', () => {
  it("take only that class's own method, not a nested class's or a namesake's", async () => {
    const cg = await indexed({
      'arena.h': ARENA,
      'arena_test.cc': lines(
        '#include "arena.h"',
        'namespace google {',
        'namespace protobuf {',
        'void* Run() {',
        '  auto arena = MakeArena();',
        '  Use(arena.get());',
        '  return arena.AllocateAligned(8);',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(callsAt(cg, 'google::protobuf::Run', 6).filter((t) => /UniquePtr|ThreadSafeArena/.test(t) && t.endsWith('@0.8'))).toEqual([]);
      expect(callsAt(cg, 'google::protobuf::Run', 7)).toEqual(['google::protobuf::Arena::AllocateAligned @0.8']);
    } finally {
      cg.close();
    }
  });

  it('reach a method the named class inherits before a nested class of the same name', async () => {
    const cg = await indexed({
      'outer.h': lines(
        'class Base {',
        ' public:',
        '  static int Count() { return 0; }',
        '};',
        'class Outer : public Base {',
        ' public:',
        '  class Inner {',
        '   public:',
        '    static int Count() { return 1; }',
        '  };',
        '};',
      ),
      'main.cc': lines(
        '#include "outer.h"',
        'int Total() { return Outer::Count(); }',
      ),
    });
    try {
      expect(callsAt(cg, 'Total', 2)).toEqual(['Base::Count @0.8']);
    } finally {
      cg.close();
    }
  });
});
