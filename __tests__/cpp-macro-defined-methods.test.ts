/**
 * A C++ method a function-like macro defines, like protobuf's
 * `PROTOBUF_DEFINE_ACCESSOR(FieldDescriptor, number, int)` expanding to
 * `inline int FieldDescriptor::number() const { … }`, is a method node where
 * the file invokes the macro. Its class only declares it (`int number()
 * const;`), which mints no node, so it had none at all and no call to it
 * linked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction/tree-sitter';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-macro-methods-'));
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

/** `calls` callees of a function or method, as `qualifiedName@file:line`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName}@${r.node.filePath}:${r.node.startLine}`)
    .sort();
}

/** The methods of a file, as `qualifiedName:line`. */
function methodsIn(cg: CodeGraph, file: string): string[] {
  return cg.getNodesByKind('method').filter((n) => n.filePath === file).map((n) => `${n.qualifiedName}:${n.startLine}`).sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** protobuf's descriptor.h, in small: accessors declared in the class, defined by macros below it. */
const DESCRIPTOR_H = lines(
  'namespace google {',
  'namespace protobuf {',
  'class FieldDescriptor;',
  'class Descriptor {',
  ' public:',
  '  absl::string_view name() const;',
  '  absl::string_view full_name() const;',
  '  int field_count() const;',
  '  const FieldDescriptor* field(int index) const;',
  '  const Descriptor* containing_type() const;',
  ' private:',
  '  int field_count_;',
  '  const FieldDescriptor* fields_;',
  '  const Descriptor* containing_type_;',
  '};',
  'class FieldDescriptor {',
  ' public:',
  '  int number() const;',
  '  const Descriptor* containing_type() const;',
  ' private:',
  '  int number_;',
  '  const Descriptor* containing_type_;',
  '};',
  '',
  '#define PROTOBUF_DEFINE_ACCESSOR(CLASS, FIELD, TYPE) \\',
  '  inline TYPE CLASS::FIELD() const { return FIELD##_; }',
  '',
  '// Name and full name are stored in a single array to save space.',
  '#define PROTOBUF_DEFINE_NAME_ACCESSOR(CLASS)                                 \\',
  '  inline absl::string_view CLASS::name() const { return all_names_.name(); } \\',
  '  inline absl::string_view CLASS::full_name() const {                        \\',
  '    return all_names_.full_name();                                           \\',
  '  }',
  '',
  '#define PROTOBUF_DEFINE_ARRAY_ACCESSOR(CLASS, FIELD, TYPE) \\',
  '  inline TYPE CLASS::FIELD(int index) const {              \\',
  '    return FIELD##s_ + index;                              \\',
  '  }',
  '',
  'PROTOBUF_DEFINE_NAME_ACCESSOR(Descriptor)',
  'PROTOBUF_DEFINE_ACCESSOR(Descriptor, field_count, int)',
  'PROTOBUF_DEFINE_ARRAY_ACCESSOR(Descriptor, field, const FieldDescriptor*)',
  'PROTOBUF_DEFINE_ACCESSOR(Descriptor, containing_type,',
  '                         const Descriptor*)',
  'PROTOBUF_DEFINE_ACCESSOR(FieldDescriptor, number, int)',
  'PROTOBUF_DEFINE_ACCESSOR(FieldDescriptor, containing_type, const Descriptor*)',
  '',
  '#undef PROTOBUF_DEFINE_ACCESSOR',
  '}  // namespace protobuf',
  '}  // namespace google',
);

describe('a C++ method a macro defines', () => {
  it('reproduction: protobuf descriptor accessors, and calls through what they return', async () => {
    const cg = await indexed({
      // A namesake of the class an accessor returns: the type is read as written.
      'src/legacy.h': lines(
        'namespace legacy {',
        'class Descriptor {',
        ' public:',
        '  absl::string_view full_name() const { return ""; }',
        '};',
        '}  // namespace legacy',
      ),
      'src/descriptor.h': DESCRIPTOR_H,
      'src/printer.cc': lines(
        '#include "src/legacy.h"',
        '#include "src/descriptor.h"',
        'namespace google {',
        'namespace protobuf {',
        'int Number(const FieldDescriptor* field) { return field->number(); }',
        'int Count(const Descriptor& d) { return d.field_count(); }',
        'absl::string_view Owner(const FieldDescriptor* field) { return field->containing_type()->full_name(); }',
        'int First(const Descriptor* d) { return d->field(0)->number(); }',
        'absl::string_view Parent(const FieldDescriptor* field) {',
        '  auto parent = field->containing_type();',
        '  return parent->full_name();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(methodsIn(cg, 'src/descriptor.h')).toEqual([
        'google::protobuf::Descriptor::containing_type:43',
        'google::protobuf::Descriptor::field:42',
        'google::protobuf::Descriptor::field_count:41',
        'google::protobuf::Descriptor::full_name:40',
        'google::protobuf::Descriptor::name:40',
        'google::protobuf::FieldDescriptor::containing_type:46',
        'google::protobuf::FieldDescriptor::number:45',
      ]);
      expect(calls(cg, 'google::protobuf::Number')).toEqual(['google::protobuf::FieldDescriptor::number@src/descriptor.h:45']);
      expect(calls(cg, 'google::protobuf::Count')).toEqual(['google::protobuf::Descriptor::field_count@src/descriptor.h:41']);
      expect(calls(cg, 'google::protobuf::Owner')).toEqual([
        'google::protobuf::Descriptor::full_name@src/descriptor.h:40',
        'google::protobuf::FieldDescriptor::containing_type@src/descriptor.h:46',
      ]);
      expect(calls(cg, 'google::protobuf::First')).toEqual([
        'google::protobuf::Descriptor::field@src/descriptor.h:42',
        'google::protobuf::FieldDescriptor::number@src/descriptor.h:45',
      ]);
      expect(calls(cg, 'google::protobuf::Parent')).toEqual([
        'google::protobuf::Descriptor::full_name@src/descriptor.h:40',
        'google::protobuf::FieldDescriptor::containing_type@src/descriptor.h:46',
      ]);
      const number = callable(cg, 'google::protobuf::FieldDescriptor::number');
      expect(number.signature).toBe('inline int FieldDescriptor::number() const');
      expect(number.returnType).toBeUndefined();
      expect(callable(cg, 'google::protobuf::FieldDescriptor::containing_type').returnType).toBe('Descriptor');
      const holders = cg.getIncomingEdgesTo([number.id], ['contains']);
      expect(holders.map((e) => cg.getNode(e.source)?.qualifiedName).sort()).toEqual(['google::protobuf::FieldDescriptor', 'src/descriptor.h']);
    } finally {
      cg.close();
    }
  });

  it('a macro of a source file that pastes the method name, for a class its header declares', async () => {
    const cg = await indexed({
      'src/reflection.h': lines(
        'class Reflection {',
        ' public:',
        '  int GetInt32(int index) const;',
        '  void SetInt32(int index, int value) const;',
        '  bool GetBool(int index) const;',
        '  void SetBool(int index, bool value) const;',
        '};',
      ),
      'src/reflection.cc': lines(
        '#include "src/reflection.h"',
        '#define DEFINE_PRIMITIVE_ACCESSORS(TYPENAME, TYPE)          \\',
        '  TYPE Reflection::Get##TYPENAME(int index) const {         \\',
        '    return TYPE();                                          \\',
        '  }                                                         \\',
        '  void Reflection::Set##TYPENAME(int index, TYPE value) const {}',
        '',
        'DEFINE_PRIMITIVE_ACCESSORS(Int32, int)',
        'DEFINE_PRIMITIVE_ACCESSORS(Bool, bool)',
        '#undef DEFINE_PRIMITIVE_ACCESSORS',
        'namespace {',
        'class Local {',
        ' public:',
        '  int Get() const;',
        '};',
        '#define DEFINE_LOCAL_GET(C) inline int C::Get() const { return 1; }',
        'DEFINE_LOCAL_GET(Local)',
        '}  // namespace',
      ),
      'src/use.cc': lines(
        '#include "src/reflection.h"',
        'int Read(const Reflection& r) { r.SetBool(0, true); return r.GetInt32(1); }',
      ),
    });
    try {
      // An anonymous namespace qualifies nothing, as for a definition written out.
      expect(methodsIn(cg, 'src/reflection.cc')).toEqual([
        'Local::Get:17',
        'Reflection::GetBool:9',
        'Reflection::GetInt32:8',
        'Reflection::SetBool:9',
        'Reflection::SetInt32:8',
      ]);
      expect(calls(cg, 'Read')).toEqual(['Reflection::GetInt32@src/reflection.cc:8', 'Reflection::SetBool@src/reflection.cc:9']);
    } finally {
      cg.close();
    }
  });

  it('a macro-defined overload is picked by the parameters its expansion writes, and is never a deleted one', async () => {
    const cg = await indexed({
      'src/getter.h': lines(
        'class Getter {',
        ' public:',
        '  int Get(int index) const;',
        '  int Get(const char* key) const;',
        '};',
        '#define DEFINE_GET(PARAM) \\',
        '  inline int Getter::Get(PARAM) const { return 0; }',
        'DEFINE_GET(int index)',
        '// Between two invocations, another class deletes a method of the same name.',
        'class Blocked {',
        ' public:',
        '  int Get(double value) = delete;',
        '};',
        'DEFINE_GET(const char* key)',
      ),
      'src/use.cc': lines(
        '#include "src/getter.h"',
        'int ByKey(const Getter& g) { return g.Get("key"); }',
        'int ByIndex(const Getter& g) { return g.Get(1); }',
      ),
    });
    try {
      expect(calls(cg, 'ByKey')).toEqual(['Getter::Get@src/getter.h:14']);
      expect(calls(cg, 'ByIndex')).toEqual(['Getter::Get@src/getter.h:8']);
    } finally {
      cg.close();
    }
  });

  it('an explicit specialization a macro defines is named without its template arguments', async () => {
    const cg = await indexed({
      'src/wire.h': lines(
        'class Wire {',
        ' public:',
        '  template <typename T, int Kind> static bool Read(T* value);',
        '};',
        '#define READ_PRIMITIVE(CPPTYPE, KIND) \\',
        '  template <> inline bool Wire::Read<CPPTYPE, KIND>(CPPTYPE* value) { return true; }',
        'READ_PRIMITIVE(int, 1)',
        'READ_PRIMITIVE(double, 2)',
      ),
      'src/use.cc': lines(
        '#include "src/wire.h"',
        'bool Use(int* value) { return Wire::Read<int, 1>(value); }',
      ),
    });
    try {
      expect(methodsIn(cg, 'src/wire.h')).toEqual(['Wire::Read:7', 'Wire::Read:8']);
      expect(calls(cg, 'Use')).toHaveLength(1);
      expect(calls(cg, 'Use')[0]).toMatch(/^Wire::Read@src\/wire\.h:[78]$/);
    } finally {
      cg.close();
    }
  });

  it('what is not a method a macro defines', async () => {
    const cg = await indexed({
      'src/other.h': lines(
        'class Widget {',
        ' public:',
        '  Widget();',
        '  void Draw() const;',
        '  void Paint() const;',
        '  int Size() const;',
        '  static void Log(int x);',
        '};',
        '/*',
        '#define COMMENTED(C) inline void C::Draw() const {}',
        '*/',
        '#define DEFINE_DRAW(C) inline void C::Draw() const {}',
        '#define DEFINE_CTOR(C) inline C::C() {}',
        '#define DEFINE_FREE(NAME) inline void NAME##_fn() {}',
        '#define CALL_LOG(x) Widget::Log(x);',
        '#define DECLARE_SIZE(C) int C::Size() const;',
        'COMMENTED(Widget)',
        'DEFINE_CTOR(Widget)',
        'DEFINE_FREE(widget)',
        'DECLARE_SIZE(Widget)',
        'inline void Use() {',
        '  DEFINE_DRAW(Widget)',
        '  CALL_LOG(1)',
        '}',
        'struct Holder {',
        '  DEFINE_DRAW(Widget)',
        '};',
        '#undef DEFINE_DRAW',
        'DEFINE_DRAW(Widget)',
        '#define DEFINE_DRAW(C) inline void C::Paint() const {}',
        'DEFINE_DRAW(Widget)',
      ),
    });
    try {
      // Only the invocation of the redefined macro, at namespace scope, defines one.
      expect(methodsIn(cg, 'src/other.h')).toEqual(['Widget::Paint:31', 'Widget::Widget:3']);
    } finally {
      cg.close();
    }
  });

  it('is minted alike whether the kernel or the wasm extractor reads the file', () => {
    const minted = (kernel: boolean): string[] => {
      const saved = process.env.CODEGRAPH_KERNEL;
      if (kernel) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = '0';
      try {
        const result = extractFromSource('src/descriptor.h', DESCRIPTOR_H, 'cpp');
        const byId = new Map(result.nodes.map((n) => [n.id, n]));
        return result.nodes
          .filter((n) => n.kind === 'method' && n.signature?.includes('::'))
          .map((n) => {
            const holders = result.edges.filter((e) => e.kind === 'contains' && e.target === n.id).map((e) => byId.get(e.source)?.qualifiedName);
            return `${n.id} ${n.qualifiedName} ${n.startLine}:${n.startColumn}-${n.endLine}:${n.endColumn} ${n.returnType ?? '-'} ${n.signature} <- ${holders.sort().join(',')}`;
          })
          .sort();
      } finally {
        if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
        else process.env.CODEGRAPH_KERNEL = saved;
      }
    };
    const wasm = minted(false);
    expect(wasm).toHaveLength(7);
    expect(minted(true)).toEqual(wasm);
  });
});
