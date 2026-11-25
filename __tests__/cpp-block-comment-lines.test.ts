/**
 * The C++ declaration scans read source a line at a time and took any line
 * starting with `*` for the middle of a block comment, and any other line
 * for code. So a declaration continued onto a line starting with `*` was
 * missed — `Widget` above `*widget_;` — and code commented out inside
 * `/* … *\/` without leading stars was read as a declaration. Block comments
 * are now found by reading the file once, as raw strings are, and blanked,
 * with the contents of string literals, in every scan that reads lines.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-block-comments-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What a function's or method's calls reach, as `qualifiedName @confidence`. */
function callees(cg: CodeGraph, qualifiedName: string): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .map((e) => `${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

/** The same, with how each call was resolved. */
function resolutions(cg: CodeGraph, qualifiedName: string): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .map((e) => {
      const meta = e.metadata as { confidence?: number; resolvedBy?: string } | undefined;
      return `${cg.getNode(e.target)?.qualifiedName} @${meta?.confidence} ${meta?.resolvedBy}`;
    })
    .sort();
}

const SHAPES = lines(
  'class Widget {',
  ' public:',
  '  void Draw() {}',
  '};',
  'class Canvas {',
  ' public:',
  '  void Draw() {}',
  '};',
);

describe('C++ declarations around block comments', () => {
  it('reads a declaration continued on a line that starts with `*`', async () => {
    const cg = await indexed({
      'shapes.h': SHAPES,
      'painter.h': lines(
        '#include "shapes.h"',
        'class Painter {',
        ' public:',
        '  void Paint() { widget_->Draw(); }',
        ' private:',
        '  Widget',
        '      *widget_;',
        '};',
      ),
    });
    try {
      expect(callees(cg, 'Painter::Paint')).toEqual(['Widget::Draw @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads no declaration from code commented out in a block comment', async () => {
    const cg = await indexed({
      'shapes.h': SHAPES,
      'run.cc': lines(
        '#include "shapes.h"',
        'void Run(Canvas* c) {',
        '  /*',
        '  Widget* c = nullptr;',
        '  */',
        '  c->Draw();',
        '}',
        'void Doc(Canvas* w) {',
        '  /*',
        '   * Widget* w = nullptr;',
        '   */',
        '  w->Draw();',
        '}',
      ),
    });
    try {
      expect(callees(cg, 'Run')).toEqual(['Canvas::Draw @0.9']);
      expect(callees(cg, 'Doc')).toEqual(['Canvas::Draw @0.9']);
    } finally {
      cg.close();
    }
  });

  it("reads no member, base, using-declaration or local from a class's or function's comments", async () => {
    const cg = await indexed({
      'others.h': lines(
        'class HolderBase {',
        ' public:',
        '  void GetMessage() {}',
        '};',
        'class Old {',
        ' public:',
        '  void OnlyOld() {}',
        '};',
        'class Base {};',
        'class Other {};',
        'template <typename T> class TBase {',
        ' public:',
        '  void Insert(int x) {}',
        '};',
      ),
      'holders.h': lines(
        '#include "others.h"',
        'class Holder : public HolderBase {',
        ' public:',
        '  /*',
        '  LOCAL_VAR_ACCESSOR(Message*, Message);',
        '  */',
        '  void Run() { GetMessage(); }',
        '};',
        'class Derived : public Base,',
        '    /*',
        '    public Old,',
        '    */',
        '    public Other {',
        '};',
        'template <typename T> class TDerived : public TBase<T> {',
        ' public:',
        '  /*',
        '  using TBase<T>::Insert;',
        '  */',
        '  void Add() { Insert(1); }',
        '};',
        'class Db {',
        ' public:',
        '  void Flush() {}',
        '  void Run() {',
        '    /*',
        '    auto Flush = [] {};',
        '    */',
        '    Flush();',
        '  }',
        '};',
        'void UseDerived(Derived* d) { d->OnlyOld(); }',
      ),
    });
    try {
      // No macro of `Holder`'s might declare `GetMessage`: C++ lookup goes
      // on to the base's.
      expect(resolutions(cg, 'Holder::Run')).toEqual(['HolderBase::GetMessage @0.9 instance-method']);
      // `Derived`'s bases are `Base` and `Other`, the two the index links,
      // neither with an `OnlyOld`: the call is not guessed onto `Old`'s.
      expect(resolutions(cg, 'UseDerived')).toEqual([]);
      // No using-declaration brings the dependent base's `Insert` in: only
      // its name, which nothing else declares, links it.
      expect(resolutions(cg, 'TDerived::Add')).toEqual(['TBase::Insert @0.9 exact-match']);
      // `Flush` is no local: C++ lookup finds the member.
      expect(resolutions(cg, 'Db::Run')).toEqual(['Db::Flush @0.9 instance-method']);
    } finally {
      cg.close();
    }
  });

  it('reads no local from a string literal', async () => {
    // protobuf's `[[deprecated("Please use SpaceUsedLong() instead")]]` and
    // rocksdb's `"Unknown code(%d): "` read as declarations of a local.
    const cg = await indexed({
      'status.h': lines(
        'class Status {',
        ' public:',
        '  int code() const { return 0; }',
        '  [[deprecated("Please use code() instead")]] int Code() const { return code(); }',
        '  void ToString() const;',
        '};',
      ),
      'status.cc': lines(
        '#include "status.h"',
        'void Status::ToString() const {',
        '  char tmp[30];',
        '  snprintf(tmp, sizeof(tmp), "Unknown code(%d): ", code());',
        '}',
      ),
    });
    try {
      expect(resolutions(cg, 'Status::Code')).toEqual(['Status::code @0.9 instance-method']);
      expect(resolutions(cg, 'Status::ToString')).toEqual(['Status::code @0.9 instance-method']);
    } finally {
      cg.close();
    }
  });
});
