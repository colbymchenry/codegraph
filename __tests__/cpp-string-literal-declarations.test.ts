/**
 * A declaration written inside a C++ string literal is text, not code, so
 * receiver inference doesn't take it for the receiver's declaration.
 *
 * protocolbuffers/protobuf's upb generator emits C code from raw string
 * templates: `GenerateRepeatedSetters(upb::FieldDefPtr field, …)` writes
 * `upb_MiniTableField field = $field_init$;` inside an `R"cc( … )cc"`, then
 * calls `field.ctype()` on its own parameter. Reading back from the call
 * found the template's line first, took `field` for a `upb_MiniTableField` —
 * a C struct with no methods — and the call got no edge (before #2493, a
 * guess by the method's name).
 *
 * A raw string can span many lines and hold quotes and comment markers, so
 * its lines are found by reading the file once, as the compiler does. An
 * ordinary string's contents are blanked on the line being read.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-strdecl-'));
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

/** upb's field wrapper, and the C struct a generated template declares. */
const UPB = {
  'upb/reflection/def.hpp': lines(
    'namespace upb {',
    'class FieldDefPtr {',
    ' public:',
    '  int ctype() const { return 0; }',
    '  const char* name() const { return ""; }',
    '};',
    '}  // namespace upb',
  ),
  'upb/mini_table/field.h': lines(
    'typedef struct upb_MiniTableField {',
    '  int number;',
    '} upb_MiniTableField;',
  ),
};

describe('a declaration inside a string literal is not the receiver\'s', () => {
  it('reproduction: upb\'s generator declares `field` in the C code a raw string emits', async () => {
    const cg = await indexed({
      ...UPB,
      'upb_generator/c/generator.cc': lines(
        '#include "upb/reflection/def.hpp"',
        '#include "upb/mini_table/field.h"',
        'namespace upb {',
        'namespace generator {',
        'void Emit(const char* text) {}',
        'void GenerateRepeatedSetters(upb::FieldDefPtr field) {',
        '  Emit(R"cc(',
        '        UPB_INLINE void $0_resize(void* msg, size_t size) {',
        '          upb_MiniTableField field = $1;',
        '          // "a quote" and ) in the template',
        '          upb_Message_Resize(msg, &field, size);',
        '        }',
        '      )cc");',
        '  if (field.ctype() == 1) Emit(field.name());',
        '}',
        '}  // namespace generator',
        '}  // namespace upb',
      ),
    });
    try {
      expect([...new Set(calls(cg, 'upb::generator::GenerateRepeatedSetters'))]).toEqual([
        'upb::FieldDefPtr::ctype',
        'upb::FieldDefPtr::name',
        'upb::generator::Emit',
      ]);
    } finally {
      cg.close();
    }
  });

  it('an ordinary string that reads like a declaration', async () => {
    const cg = await indexed({
      'src/runner.h': lines(
        'namespace demo {',
        'class Runner {',
        ' public:',
        '  void Run() {}',
        '};',
        'class Stub {',
        ' public:',
        '  void Run() {}',
        '};',
        'class Printer {',
        ' public:',
        '  void Print(const char* text) {}',
        '};',
        '}  // namespace demo',
      ),
      'src/generator.cc': lines(
        '#include "src/runner.h"',
        'namespace demo {',
        'void Generate(Printer* printer, Runner* runner) {',
        '  printer->Print("Stub* runner = nullptr;");',
        '  runner->Run();',
        '}',
        '}  // namespace demo',
      ),
    });
    try {
      expect(calls(cg, 'demo::Generate')).toEqual(['demo::Printer::Print', 'demo::Runner::Run']);
    } finally {
      cg.close();
    }
  });
});

describe('what a literal on the line does not hide', () => {
  it('a declaration after a character literal holding a quote, or after a comment holding `R"(`', async () => {
    const cg = await indexed({
      'src/runner.h': lines(
        'namespace demo {',
        'class Runner {',
        ' public:',
        '  void Run() {}',
        '};',
        'class Stub {',
        ' public:',
        '  void Run() {}',
        '};',
        'inline Runner* MakeRunner() { return nullptr; }',
        '}  // namespace demo',
      ),
      'src/quotes.cc': lines(
        '#include "src/runner.h"',
        'namespace demo {',
        'void Quote(Stub* runner) {',
        '  char q = \'"\'; int n = 1\'000; Runner* runner = MakeRunner();',
        '  runner->Run();',
        '}',
        'void Comment(Stub* runner) {',
        '  /* R"( not a raw string */ Runner* runner = MakeRunner();',
        '  runner->Run();',
        '}',
        '}  // namespace demo',
      ),
    });
    try {
      expect(calls(cg, 'demo::Quote')).toEqual(['demo::MakeRunner', 'demo::Runner::Run']);
      expect(calls(cg, 'demo::Comment')).toEqual(['demo::MakeRunner', 'demo::Runner::Run']);
    } finally {
      cg.close();
    }
  });
});
