/**
 * A C++ explicit specialization of a function or member function template is
 * named after its template, without its template arguments:
 *
 *   template <> bool WireFormatLite::ReadPrimitive<int32_t, WireFormatLite::TYPE_INT32>(…) { … }
 *   template <> int WireFormatLite::get<int>() const { … }
 *   template <> void Swap<Foo>(Foo& a, Foo& b) { … }
 *
 * The first was named `TYPE_INT32>` and qualified
 * `…::WireFormatLite::ReadPrimitive::TYPE_INT32>`: the qualified id was split
 * at every `::`, the one inside its template arguments too. The others were
 * named `get<int>` and `Swap<Foo>`. A call writes the bare name, so none
 * linked to them. Extraction runs against the native kernel (when built)
 * and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** protobuf's wire_format_lite.h, in small, with a free function template and a class template. */
const WIRE_H = lines(
  'namespace pb {',
  'class WireFormatLite {',
  ' public:',
  '  enum FieldType { TYPE_INT32 = 1, TYPE_INT64 = 2 };',
  '  template <typename CType, enum FieldType DeclaredType>',
  '  static bool ReadPrimitive(int* input, CType* value);',
  '  template <typename T> T get() const;',
  '  bool operator<(const WireFormatLite& other) const;',
  '};',
  '',
  'template <>',
  'inline bool WireFormatLite::ReadPrimitive<int, WireFormatLite::TYPE_INT32>(int* input, int* value) {',
  '  return true;',
  '}',
  'template <>',
  'inline bool WireFormatLite::ReadPrimitive<long, WireFormatLite::TYPE_INT64>(int* input, long* value) {',
  '  return false;',
  '}',
  'template <>',
  'inline int WireFormatLite::get<int>() const { return 1; }',
  'inline bool WireFormatLite::operator<(const WireFormatLite& other) const { return false; }',
  '',
  'template <typename T> void Swap(T& a, T& b) {}',
  'template <> void Swap<WireFormatLite>(WireFormatLite& a, WireFormatLite& b) {}',
  'template <typename T> T* Make() { return nullptr; }',
  'template <> WireFormatLite* Make<WireFormatLite>() { return nullptr; }',
  '',
  'template <typename T> struct Box { T get() const; };',
  'template <> int Box<int>::get() const { return 0; }',
  'template <typename T> T Box<T>::get() const { return T(); }',
  '}  // namespace pb',
);

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<kind> <name> <qualified name> <line>` of every function and method, sorted. */
function callables(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind === 'method' || n.kind === 'function')
    .map((n) => `${n.kind} ${n.name} ${n.qualifiedName} ${n.startLine}`)
    .sort();
}

describe('a C++ explicit specialization is named after its template', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('src/wire.h', source, 'cpp');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('src/wire.h', source, 'cpp');
    expect(result, 'kernel extraction of src/wire.h').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const source = crlf ? WIRE_H.replace(/\n/g, '\r\n') : WIRE_H;
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`member and function specializations, beside what was already right: %s${label}`, (backend) => {
      const result = extract(backend, source);
      expect(callables(result)).toEqual([
        'function Make pb::Make 25',
        'function Make pb::Make 26',
        'function Swap pb::Swap 23',
        'function Swap pb::Swap 24',
        'method get pb::Box::get 29',
        'method get pb::Box::get 30',
        'method get pb::WireFormatLite::get 20',
        'method operator< pb::WireFormatLite::operator< 21',
        'method ReadPrimitive pb::WireFormatLite::ReadPrimitive 12',
        'method ReadPrimitive pb::WireFormatLite::ReadPrimitive 16',
      ].sort());
      // The class the receiver names holds them, as it holds any out-of-line definition.
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      const held = result.edges
        .filter((e) => e.kind === 'contains' && byId.get(e.source)?.name === 'WireFormatLite')
        .map((e) => `${byId.get(e.target)?.name} ${byId.get(e.target)?.startLine}`)
        .sort();
      expect(held).toEqual(expect.arrayContaining(['ReadPrimitive 12', 'ReadPrimitive 16', 'get 20']));
    });
  }
});

/**
 * A specialization now shares its template's name, so a call meets both
 * among that name's candidates. The template arguments a call writes pick
 * between them: the specialization written with the same ones, else the
 * template itself or an ordinary overload, else nothing. A call that writes
 * none reaches a specialization only when there is nothing else.
 */
describe('a C++ call reaches the specialization its template arguments name', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-specialization-calls-'));
    const write = (file: string, text: string): void => fs.writeFileSync(path.join(root, 'src', file), text);
    fs.mkdirSync(path.join(root, 'src'));
    write('wire.h', WIRE_H);
    write('use.cc', lines(
      '#include "src/wire.h"',
      'namespace pb {',
      'bool Read(int* in, int* v) { return WireFormatLite::ReadPrimitive<int, WireFormatLite::TYPE_INT32>(in, v); }',
      'bool ReadLong(int* in, long* v) { return WireFormatLite::ReadPrimitive<long, WireFormatLite::TYPE_INT64>(in, v); }',
      'bool ReadLongQualified(int* in, long* v) { return WireFormatLite::ReadPrimitive<long, pb::WireFormatLite::TYPE_INT64>(in, v); }',
      'int Get(const WireFormatLite& w) { return w.get<int>(); }',
      'void SwapWire(WireFormatLite& a, WireFormatLite& b) { Swap<WireFormatLite>(a, b); }',
      'void SwapInts(int& x, int& y) { Swap<int>(x, y); }',
      'void SwapDeduced(int& x, int& y) { Swap(x, y); }',
      'int* MakeInt() { return Make<int>(); }',
      'WireFormatLite* MakeWire() { return Make<WireFormatLite>(); }',
      '}  // namespace pb',
    ));
    // Inside the class: a call written with no receiver, its arguments
    // unqualified; one in a template, whose arguments name its parameters.
    write('reader.h', lines(
      '#include "src/wire.h"',
      'namespace pb {',
      'class Reader : public WireFormatLite {',
      ' public:',
      '  bool ReadLong(int* in) { return ReadPrimitive<long, TYPE_INT64>(in, nullptr); }',
      '  template <typename C, FieldType D> bool ReadAny(int* in, C* v) { return ReadPrimitive<C, D>(in, v); }',
      '};',
      '}  // namespace pb',
    ));
    // rocksdb's cassandra serialize.h: the template is declared, its specializations defined.
    write('serialize.h', lines(
      'namespace ns {',
      'template <typename T> void Serialize(T val, char* dest);',
      'template <> inline void Serialize<char>(char t, char* dest) {}',
      'template <> inline void Serialize<long>(long t, char* dest) {}',
      'template <> inline void Serialize<const char*>(const char* t, char* dest) {}',
      'inline void WriteLocal(char* dest) { ns::Serialize<long>(1, dest); }',
      '}  // namespace ns',
    ));
    write('format.cc', lines(
      '#include "src/serialize.h"',
      'namespace ns {',
      'void Write(char* dest) { ns::Serialize<long>(1, dest); }',
      'void WriteShort(char* dest) { ns::Serialize<short>(1, dest); }',
      "void WriteDeduced(char* dest) { ns::Serialize('c', dest); }",
      "void WriteBrackets(char* dest) { ns::Serialize<>('c', dest); }",
      'void WriteText(char* dest) { ns::Serialize<const char *>("x", dest); }',
      'void WriteGlobal(char* dest) { ::ns::Serialize<long>(1, dest); }',
      '}  // namespace ns',
    ));
    // Only a specialization, of a template declared without a body.
    write('parse.h', lines(
      'namespace fmt {',
      'template <typename T> T parse(const char* text);',
      'template <> int parse<int>(const char* text) { return 0; }',
      'inline long parse_long(const char* t) { return parse<long>(t); }',
      '}  // namespace fmt',
    ));
    // fmt's namespace, opened by a macro.
    write('digits.h', lines(
      '#define MY_BEGIN_NAMESPACE namespace mylib {',
      '#define MY_END_NAMESPACE }',
      'MY_BEGIN_NAMESPACE',
      'template <typename T> constexpr int digits() { return 1; }',
      'template <> constexpr int digits<long>() { return 19; }',
      'MY_END_NAMESPACE',
    ));
    write('digits.cc', lines(
      '#include "src/digits.h"',
      'int long_digits() { return mylib::digits<long>(); }',
      'int char_digits() { return mylib::digits<char>(); }',
    ));
    // gmock's converting constructor, which names its class template in its parameter.
    write('action.h', lines(
      'namespace gm {',
      'template <typename F> class ActionInterface {};',
      'template <typename F> class Action {',
      ' public:',
      '  explicit Action(ActionInterface<F>* impl) {}',
      '  template <typename Func> explicit Action(const Action<Func>& action) {}',
      '};',
      'template <typename F> Action<F> Convert(const Action<long>& from) { return Action<F>(from); }',
      '}  // namespace gm',
    ));
    // A specialization whose return type begins with its name.
    write('get.h', lines(
      'namespace kv {',
      'struct GetResult {};',
      'template <typename T> GetResult Get(int key) { return GetResult(); }',
      'template <> GetResult Get<long>(int key) { return GetResult(); }',
      'inline GetResult GetInt() { return Get<int>(1); }',
      '}  // namespace kv',
    ));
    // protobuf's arena.h, whose tests specialize `DefaultConstruct` to hook
    // it — with a parameter the call's argument fits as well as the template's.
    write('arena.h', lines(
      'namespace pb {',
      'class Arena;',
      'typedef Arena* ArenaPtr;',
      'class Arena {',
      ' public:',
      '  template <typename T> static void* DefaultConstruct(ArenaPtr arena);',
      '  template <typename T> static T* Create(Arena* arena) { return static_cast<T*>(DefaultConstruct<T>(arena)); }',
      '};',
      'template <typename T> void* Arena::DefaultConstruct(ArenaPtr arena) { return nullptr; }',
      '}  // namespace pb',
    ));
    // A specialization whose parameter is written through a typedef: the
    // call's argument fits the template's parameter better.
    write('registry.h', lines(
      'namespace pb {',
      'class Handle;',
      'typedef Handle* HandlePtr;',
      'class Registry {',
      ' public:',
      '  template <typename T> void Add(Handle* h) {}',
      '};',
      'template <> inline void Registry::Add<int>(HandlePtr h) {}',
      'class Pool : public Registry {',
      ' public:',
      '  void AddInt(Handle* h) { Add<int>(h); }',
      '};',
      'inline void Register(Registry& r, Handle* h) { r.Add<int>(h); }',
      '}  // namespace pb',
    ));
    // fmt's format.h: a call beside the specializations, nearer them than the template.
    write('bits.h', lines(
      'namespace fmt {',
      'template <typename T> constexpr int num_bits() { return 8; }',
      'template <> constexpr int num_bits<long>() { return 64; }',
      'template <> constexpr int num_bits<short>() { return 16; }',
      'inline int char_bits() { return num_bits<char>(); }',
      'inline int long_bits() { return num_bits<long>(); }',
      'template <typename T> int width(T value) { return 1; }',
      'template <> int width<long>(long value) { return 8; }',
      'inline int int_width(int v) { return width(v); }',
      'inline int named_long_bits() { const char* unit = "größe"; return num_bits<long>(); }',
      'template <typename T, bool zigzag = false> T decode(T v) { return v; }',
      'template <> int decode<int, true>(int v) { return -v; }',
      'inline int plain(int v) { return decode<int>(v); }',
      'template <typename T> int scale(T v);',
      'template <> int scale<long>(long v) { return 2; } template <typename T> int scale(T v) { return 1; }',
      'inline int int_scale() { return scale<int>(1); }',
      'template <> long decode<long>(long v) { return 2 * v; }',
      'inline long zigzag(long v) { return decode<long, true>(v); }',
      '}  // namespace fmt',
    ));
    // A member template's specialization, and one called through another call.
    write('codec.h', lines(
      '#include "src/wire.h"',
      'namespace pb {',
      'class Codec {',
      ' public:',
      '  template <typename T> void Put(T v) {}',
      '};',
      'class IntCodec : public Codec {',
      ' public:',
      '  template <typename T> void Put(T v);',
      '  WireFormatLite& target() { return w_; }',
      '  WireFormatLite w_;',
      '};',
      'template <> inline void IntCodec::Put<int>(int v) {}',
      'inline void PutInt(IntCodec& c) { c.Put<int>(1); }',
      'inline void PutLong(IntCodec& c) { c.Put<long>(1L); }',
      'inline long LongFromCodec(IntCodec& codec) { return codec.target().get<long>(); }',
      '}  // namespace pb',
    ));
    // protobuf's generated_message_reflection.cc: a macro defines the specializations.
    write('reflection.h', lines(
      'namespace pb {',
      'class Reflection {',
      ' public:',
      '  template <typename T> const T& GetField(int index) const;',
      '};',
      'template <typename T> const T& Reflection::GetField(int index) const { static T t; return t; }',
      '#define DEFINE_FIELD_GETTER(TYPE) \\',
      '  template <> const TYPE& Reflection::GetField<TYPE>(int index) const { static TYPE t; return t; }',
      'DEFINE_FIELD_GETTER(int)',
      'DEFINE_FIELD_GETTER(long)',
      'inline long GetLong(const Reflection& r) { return r.GetField<long>(0); }',
      'inline double GetDouble(const Reflection& r) { return r.GetField<double>(0); }',
      '}  // namespace pb',
    ));
    write('arena_test.cc', lines(
      '#include "src/arena.h"',
      'namespace pb {',
      'struct Hooked {};',
      'template <> void* Arena::DefaultConstruct<Hooked>(Arena* arena) { return nullptr; }',
      'void* MakeHooked(Arena* a) { return Arena::DefaultConstruct<Hooked>(a); }',
      '}  // namespace pb',
    ));
    // A base class's member template, specialized, beside a derived class's namesake.
    write('repeated.h', lines(
      'namespace pb {',
      'class FieldBase {',
      ' public:',
      '  template <typename T> void MergeFrom(const FieldBase& from) {}',
      '  virtual void Visit(int value) {}',
      '};',
      'template <> inline void FieldBase::MergeFrom<int>(const FieldBase& from) {}',
      'class Field : public FieldBase {',
      ' public:',
      '  void MergeFrom(const Field& other) {}',
      '  template <typename T> void Visit(T value) {}',
      '};',
      'template <> inline void Field::Visit<int>(int value) {}',
      '}  // namespace pb',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<qualified name>@<line>` of what the function or method `name` (at `line`, if given) calls. */
  const calls = (name: string, line?: number): string[] => {
    const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
      .find((n: Node) => n.qualifiedName === name && (line === undefined || n.startLine === line))!;
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller.id).filter((r) => r.edge.kind === 'calls').map((r) => `${r.node.qualifiedName}@${r.node.startLine}`);
  };

  it('the specialization the call writes the arguments of', () => {
    expect(calls('pb::Read')).toEqual(['pb::WireFormatLite::ReadPrimitive@12']);
    expect(calls('pb::ReadLong')).toEqual(['pb::WireFormatLite::ReadPrimitive@16']);
    expect(calls('pb::Get')).toEqual(['pb::WireFormatLite::get@20']);
    expect(calls('pb::SwapWire')).toEqual(['pb::Swap@24']);
    expect(calls('pb::MakeWire')).toEqual(['pb::Make@26']);
    expect(calls('ns::Write')).toEqual(['ns::Serialize@4']);
    expect(calls('pb::MakeHooked')).toEqual(['pb::Arena::DefaultConstruct@4']);
    expect(calls('fmt::long_bits')).toEqual(['fmt::num_bits@3']);
    expect(calls('pb::Register')).toEqual(['pb::Registry::Add@8']);
    expect(calls('pb::Pool::AddInt')).toEqual(['pb::Registry::Add@8']);
    expect(calls('pb::PutInt')).toEqual(['pb::IntCodec::Put@13']);
    // The call's column counts the bytes of the wider characters before it.
    expect(calls('fmt::named_long_bits')).toEqual(['fmt::num_bits@3']);
    // An argument qualified further than the specialization writes it, or spaced otherwise.
    expect(calls('pb::ReadLongQualified')).toEqual(['pb::WireFormatLite::ReadPrimitive@16']);
    expect(calls('ns::WriteText')).toEqual(['ns::Serialize@5']);
    // From the global scope, and beside the specializations.
    expect(calls('ns::WriteGlobal')).toEqual(['ns::Serialize@4']);
    expect(calls('ns::WriteLocal')).toEqual(['ns::Serialize@4']);
    // In a namespace a macro opens.
    expect(calls('long_digits')).toEqual(['digits@5']);
  });

  it('the specializations a macro defines', () => {
    expect(calls('pb::GetLong')).toEqual(['pb::Reflection::GetField@10']);
    expect(calls('pb::GetDouble')).toEqual(['pb::Reflection::GetField@6']);
  });

  it('a specialization when nothing else is there', () => {
    expect(calls('ns::WriteDeduced')).toEqual(['ns::Serialize@3']);
    expect(calls('ns::WriteBrackets')).toEqual(['ns::Serialize@3']);
  });

  it('the template itself for arguments no specialization writes', () => {
    expect(calls('pb::SwapInts')).toEqual(['pb::Swap@23']);
    expect(calls('pb::MakeInt')).toEqual(['pb::Make@25']);
    expect(calls('fmt::char_bits')).toEqual(['fmt::num_bits@2']);
    // protobuf's `Arena::Create<T>` calls `DefaultConstruct<T>`, not the tests' hook.
    expect(calls('pb::Arena::Create')).toEqual(['pb::Arena::DefaultConstruct@9']);
    // `decode<int>` leaves `zigzag` at its default; `decode<long>` is `decode<long, false>`.
    expect(calls('fmt::plain')).toEqual(['fmt::decode@11']);
    expect(calls('fmt::zigzag')).toEqual(['fmt::decode@11']);
    // The template defined after its specialization on one line.
    expect(calls('fmt::int_scale')).toEqual(['fmt::scale@15']);
    expect(calls('char_digits')).toEqual(['digits@4']);
    expect(calls('kv::GetInt')).toEqual(['kv::Get@3']);
  });

  it('a constructor is no specialization', () => {
    expect(calls('gm::Convert')).toEqual(['gm::Action::Action@6']);
  });

  it('the template itself for a call that writes no arguments', () => {
    expect(calls('pb::SwapDeduced')).toEqual(['pb::Swap@23']);
    expect(calls('fmt::int_width')).toEqual(['fmt::width@7']);
  });

  it('a call inside the class, its arguments written unqualified', () => {
    expect(calls('pb::Reader::ReadLong')).toEqual(['pb::WireFormatLite::ReadPrimitive@16']);
  });

  it('nothing when only specializations are there and none is the one called', () => {
    expect(calls('pb::Reader::ReadAny')).toEqual([]);
    expect(calls('ns::WriteShort')).toEqual([]);
    // `IntCodec::Put` hides `Codec::Put`.
    expect(calls('pb::PutLong')).toEqual([]);
    expect(calls('pb::LongFromCodec')).toEqual(['pb::IntCodec::target@10']);
    expect(calls('fmt::parse_long')).toEqual([]);
  });

  it("a derived class's namesake overrides the template, not its specialization", () => {
    const overriders = (name: string, line: number): string[] => {
      const method = cg.getNodesByKind('method').find((n: Node) => n.qualifiedName === name && n.startLine === line)!;
      expect(method, `${name}@${line}`).toBeDefined();
      return cg.getCallers(method.id).filter((r) => r.edge.kind === 'calls').map((r) => `${r.node.qualifiedName}@${r.node.startLine}`);
    };
    expect(overriders('pb::Field::MergeFrom', 10)).toEqual(['pb::FieldBase::MergeFrom@4']);
    expect(overriders('pb::Field::Visit', 11)).toEqual(['pb::FieldBase::Visit@5']);
    expect(overriders('pb::Field::Visit', 13)).toEqual([]);
  });
});
