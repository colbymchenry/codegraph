/**
 * A C++ call to a free function picks among the function's overloads by its
 * arguments, as a call to a method already does: their count, then the
 * types they have where the call writes them. The name strategies pick a
 * function by where it is, so protobuf's
 *
 *   int32_t result;
 *   ParseWithLimit(limit, data, result);
 *
 * reached the `ParseWithLimit(…, int64_t& res)` overload defined nearer the
 * call, not the `int32_t&` one. Only overloads the call's file can see
 * compete: a `static` one in another source file never does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call picks the free-function overload its arguments fit', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-free-overloads-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, 'src', file)), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', file), text);
    };
    // protobuf's varint_shuffle_test.cc: each call sits nearer the overload it doesn't take.
    write('varint.cc', lines(
      'namespace pb {',
      'const char* ParseWithLimit(int rtlimit, const char* data, int32_t& res) { return data; }',
      'const char* ParseWithLimit(int rtlimit, const char* data, int64_t& res) { return data; }',
      'void Parse32(const char* data) { int32_t result; ParseWithLimit(1, data, result); }',
      'int Scale(int x, int y) { return x * y; }',
      'int Scale(int x) { return x; }',
      'int Twice(int v) { return Scale(v, 2); }',
      'void Put(const char* text) {}',
      'void Put(int value) {}',
      'void PutText() { Put("text"); }',
      'template <typename T> void Store(T value) {}',
      'void Store(int value) {}',
      'void StoreName(const std::string& name) { Store(name); }',
      'void StoreCount() { Store(1); }',
      '}  // namespace pb',
    ));
    // Arguments both overloads fit alike; a namesake in another namespace, no overload.
    write('render.cc', lines(
      'namespace pb {',
      'struct Circle {}; struct Square {}; struct Shape {};',
      'void Render(const Circle& c) {}',
      'void Render(const Square& s) {}',
      'void Draw(const Shape& shape) { Render(shape); }',
      '}  // namespace pb',
    ));
    write('print.cc', lines(
      'namespace a {',
      'struct Message { Message(const char* text) {} };',
      'void Print(const Message& m) {}',
      'void Hello() { Print("hi"); }',
      '}  // namespace a',
      'namespace b {',
      'void Print(const char* text) {}',
      '}  // namespace b',
    ));
    // Qualified calls: from another file, from the overloads' own file, from the global scope.
    write('codec.h', lines(
      'namespace codec {',
      'inline void Encode(const char* text, char* out) {}',
      'inline void Encode(long value, char* out) {}',
      'inline void EncodeHere(char* out) { codec::Encode(7L, out); }',
      '}  // namespace codec',
    ));
    write('codec.cc', lines(
      '#include "src/codec.h"',
      'void EncodeThere(char* out) { codec::Encode(7L, out); }',
      'void EncodeGlobal(char* out) { ::codec::Encode(7L, out); }',
    ));
    // A function with only specializations: deduction picks one.
    write('serialize.h', lines(
      'namespace ns {',
      'template <typename T> void Serialize(T val, char* dest);',
      'template <> inline void Serialize<char>(char t, char* dest) {}',
      'template <> inline void Serialize<long>(long t, char* dest) {}',
      '}  // namespace ns',
    ));
    write('serialize.cc', lines(
      '#include "src/serialize.h"',
      'void WriteLong(char* dest) { ns::Serialize(1L, dest); }',
    ));
    // An overload only another source file sees, which the arguments fit
    // better: indexed after the one the call sees (`Log`), and before it (`Warn`).
    write('log.h', lines(
      'namespace lg {',
      'struct Status { Status(int code) {} };',
      'void Log(const Status& status);',
      'void Warn(const Status& status);',
      '}  // namespace lg',
    ));
    write('log.cc', lines(
      '#include "src/log.h"',
      'namespace lg {',
      'void Log(const Status& status) {}',
      'void Warn(const Status& status) {}',
      '}  // namespace lg',
    ));
    write('log_private.cc', lines(
      'namespace lg {',
      'static void Log(int level) {}',
      '}  // namespace lg',
    ));
    write('a_private.cc', lines(
      'namespace lg {',
      'static void Warn(int level) {}',
      '}  // namespace lg',
    ));
    write('log_use.cc', lines(
      '#include "src/log.h"',
      'void LogCode() { lg::Log(3); }',
      'void WarnCode() { lg::Warn(3); }',
    ));
    // protobuf's conformance suite: a parameter named like its function.
    write('wire.h', lines(
      'namespace wire {',
      'struct Wire {};',
      'Wire Fixed64(uint64_t x);',
      'template <typename T> Wire Fixed64(T x) { return Fixed64(static_cast<uint64_t>(x)); }',
      '}  // namespace wire',
    ));
    write('wire.cc', lines(
      '#include "src/wire.h"',
      'namespace wire {',
      'Wire Fixed64(uint64_t x) { return Wire(); }',
      '}  // namespace wire',
    ));
    write('wire_use.cc', lines(
      '#include "src/wire.h"',
      'std::string u64(uint64_t u64) {',
      '  wire::Fixed64(u64);',
      '  return "";',
      '}',
      'struct Counter { Counter(int n) {} int value() const { return 0; } };',
      'struct Gauge { int value() const { return 1; } };',
      'int count(int n) {',
      '  Counter count(n);',
      '  return count.value();',
      '}',
    ));
    // A struct and a function of one name: the function hides the struct in a call.
    write('stat.h', lines(
      'namespace sys {',
      'struct stat { long size; };',
      'inline int stat(const char* path, struct stat* out) { return 0; }',
      '}  // namespace sys',
    ));
    write('stat.cc', lines(
      '#include "src/stat.h"',
      'long FileSize(const char* path) { sys::stat st; sys::stat(path, &st); return st.size; }',
      'struct Sized : sys::stat {};',
    ));
    // protobuf's Rust bindings: a Rust call to the C function its `extern` block declares.
    write('rust/upb/lib.rs', lines('mod sys;', 'mod wire;'));
    write('rust/upb/sys/mod.rs', lines('pub mod wire;'));
    write('rust/upb/sys/wire/mod.rs', lines('pub mod wire;'));
    write('rust/upb/sys/wire/wire.rs', lines('extern "C" {', '    pub fn upb_encode(msg: *const u8, len: usize) -> i32;', '}'));
    write('rust/upb/wire.rs', lines(
      'use super::sys::wire::wire::{upb_encode};',
      'pub fn encode(msg: *const u8) -> i32 {',
      '    unsafe { upb_encode(msg, 0) }',
      '}',
    ));
    write('upb/wire/encode.c', lines('int upb_encode(const char* msg, unsigned long len) { return 0; }'));
    // fmt's namespace, opened by a macro: the overloads take as many arguments.
    write('fmtlike.h', lines(
      '#define MY_BEGIN_NAMESPACE namespace mylib {',
      '#define MY_END_NAMESPACE }',
      'MY_BEGIN_NAMESPACE',
      'inline void write(char* out, const char* text) {}',
      'inline void write(char* out, int value) {}',
      'MY_END_NAMESPACE',
    ));
    write('fmtlike.cc', lines(
      '#include "src/fmtlike.h"',
      'void WriteCount(char* out, int count) { mylib::write(out, count); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<qualified name>@<file>:<line>` of what the function `name` calls. */
  const calls = (name: string): string[] => {
    const caller = cg.getNodesByKind('function').find((n: Node) => n.qualifiedName === name)!;
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller.id).filter((r) => r.edge.kind === 'calls')
      .map((r) => `${r.node.qualifiedName}@${path.basename(r.node.filePath)}:${r.node.startLine}`);
  };

  it('by the types of its arguments', () => {
    expect(calls('pb::Parse32')).toEqual(['pb::ParseWithLimit@varint.cc:2']);
    expect(calls('pb::StoreName')).toEqual(['pb::Store@varint.cc:11']);
    expect(calls('pb::StoreCount')).toEqual(['pb::Store@varint.cc:12']);
    // The parameter, not the function it belongs to; a local declared like a call, as before.
    expect(calls('u64')).toEqual(['wire::Fixed64@wire.cc:3']);
    expect(calls('count')).toContain('Counter::value@wire_use.cc:6');
  });

  it('a function, not the struct of its name; the struct where a type is named', () => {
    expect(calls('FileSize')).toEqual(['sys::stat@stat.h:3']);
    const sized = cg.getNodesByKind('struct').find((n: Node) => n.qualifiedName === 'Sized')!;
    expect(cg.getOutgoingEdgesFrom([sized.id], ['extends']).map((e) => `${cg.getNode(e.target)?.kind} ${cg.getNode(e.target)?.qualifiedName}`))
      .toEqual(['struct sys::stat']);
  });

  it('by how many arguments it passes, and its string literals', () => {
    expect(calls('pb::Twice')).toEqual(['pb::Scale@varint.cc:5']);
    expect(calls('pb::PutText')).toEqual(['pb::Put@varint.cc:8']);
  });

  it('through a qualified name', () => {
    expect(calls('EncodeThere')).toEqual(['codec::Encode@codec.h:3']);
    expect(calls('codec::EncodeHere')).toEqual(['codec::Encode@codec.h:3']);
    expect(calls('EncodeGlobal')).toEqual(['codec::Encode@codec.h:3']);
    expect(calls('WriteCount')).toEqual(['write@fmtlike.h:5']);
  });

  it('among the specializations deduction chooses from', () => {
    expect(calls('WriteLong')).toEqual(['ns::Serialize@serialize.h:4']);
  });

  it('the one picked by where it is, when the arguments fit both alike', () => {
    expect(calls('pb::Draw')).toEqual(['pb::Render@render.cc:4']);
  });

  it("never another namespace's function of the name", () => {
    expect(calls('a::Hello')).toEqual(['a::Print@print.cc:3']);
  });

  it('only for a C++ call: a Rust call keeps the declaration it names', () => {
    const encode = cg.getNodesByKind('function').find((n: Node) => n.name === 'encode')!;
    expect(encode).toBeDefined();
    expect(cg.getCallees(encode.id).filter((r) => r.edge.kind === 'calls')
      .map((r) => `${r.node.name}@${r.node.filePath}:${r.node.startLine}`)).toEqual(['upb_encode@src/rust/upb/sys/wire/wire.rs:2']);
  });

  it('never an overload only another source file sees', () => {
    expect(calls('LogCode')).toEqual(['lg::Log@log.cc:3']);
    expect(calls('WarnCode')).toEqual(['lg::Warn@log.cc:4']);
  });
});
