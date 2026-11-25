/**
 * Two ways a C++ call reached an overload no call that compiles reaches:
 * - A `nullptr` argument fitted any pointer parameter as well as it could fit
 *   anything, and a `std::nullptr_t` parameter no better than a class, so
 *   protocolbuffers/protobuf's `ptr.reset(nullptr)` on an
 *   `Arena::UniquePtr<int>` took `reset(T*)` over `reset(std::nullptr_t)`.
 *   `nullptr` is a `std::nullptr_t` exactly, and a pointer by conversion.
 * - That `reset(T*)` is declared `= delete`. A deleted overload is now taken
 *   only when every overload is.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-nullptr-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What the calls at `line` of the function or method `qualifiedName` reach, as `target:its first line @confidence`. */
function callsAt(cg: CodeGraph, qualifiedName: string, line: number): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .filter((e) => e.line === line)
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${t.qualifiedName}:${t.startLine} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`;
    })
    .sort();
}

describe('C++ overloads for nullptr, and deleted ones', () => {
  it("takes protobuf's reset(std::nullptr_t) for reset(nullptr), not the deleted reset(T*)", async () => {
    const cg = await indexed({
      'arena.h': lines(
        '#include <cstddef>',
        'namespace google {',
        'namespace protobuf {',
        'class Arena {',
        ' public:',
        '  template <typename T>',
        '  class UniquePtr {',
        '   public:',
        '    void reset() {}',
        '    void reset(std::nullptr_t) {}',
        '    void reset(T* PROTOBUF_NULLABLE) = delete;',
        '  };',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'arena_unittest.cc': lines(
        '#include "arena.h"',
        'namespace google {',
        'namespace protobuf {',
        'void Reset() {',
        '  Arena::UniquePtr<int> ptr;',
        '  ptr.reset(nullptr);',
        '  ptr.reset();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(callsAt(cg, 'google::protobuf::Reset', 6)).toEqual(['google::protobuf::Arena::UniquePtr::reset:10 @0.9']);
      expect(callsAt(cg, 'google::protobuf::Reset', 7)).toEqual(['google::protobuf::Arena::UniquePtr::reset:9 @0.9']);
    } finally {
      cg.close();
    }
  });

  it('fits nullptr to std::nullptr_t before a pointer, and 0 to an int before both', async () => {
    const cg = await indexed({
      'canvas.h': lines(
        '#include <cstddef>',
        'class Widget {};',
        'class Canvas {',
        ' public:',
        '  void Set(Widget* w) {}',
        '  void Set(std::nullptr_t) {}',
        '  void Set(int v) {}',
        '  void Run() {',
        '    Set(nullptr);',
        '    Set(0);',
        '  }',
        '};',
      ),
    });
    try {
      expect(callsAt(cg, 'Canvas::Run', 9)).toEqual(['Canvas::Set:6 @0.9']);
      expect(callsAt(cg, 'Canvas::Run', 10)).toEqual(['Canvas::Set:7 @0.9']);
    } finally {
      cg.close();
    }
  });

  it('takes no deleted overload while another fits, reading each declaration to its own end', async () => {
    const cg = await indexed({
      'meter.h': lines(
        'class Meter {',
        ' public:',
        '  void Scale(double factor) = delete;',
        '  void Scale(int factor) {}',
        '  void Scale(',
        '      long factor) = delete;',
        '  void Run() { Scale(2); }',
        '};',
      ),
    });
    try {
      expect(callsAt(cg, 'Meter::Run', 7)).toEqual(['Meter::Scale:4 @0.9']);
    } finally {
      cg.close();
    }
  });
});
