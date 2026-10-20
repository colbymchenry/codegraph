/**
 * A C++ call whose argument fits a function's const and non-const overloads
 * alike — protobuf's `DynamicCastMessage<T>(ptr.get())` beside `const T*
 * DynamicCastMessage(const MessageLite*)` and `T* DynamicCastMessage(MessageLite*)`
 * — reaches the one C++ picks: the non-const overload for a non-const object,
 * the const one for a const object or for a value a call returns. Before, the
 * overload declared first won the tie.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe("a C++ call picks between const and non-const overloads by its argument's constness", () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-overload-constness-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // The const overloads come first, as in protobuf's message_lite.h.
    write('src/message_lite.h', lines(
      '#include <memory>',
      'class MessageLite {',
      ' public:',
      '  virtual ~MessageLite() {}',
      '};',
      'class Message : public MessageLite {};',
      'template <typename T>',
      'const T* DynamicCastMessage(const MessageLite* from) { return nullptr; }',
      'template <typename T>',
      'T* DynamicCastMessage(MessageLite* from) { return nullptr; }',
      'template <typename T>',
      'const T& DynamicCastMessage(const MessageLite& from) { return *static_cast<const T*>(&from); }',
      'template <typename T>',
      'T& DynamicCastMessage(MessageLite& from) { return *static_cast<T*>(&from); }',
      'class Buffer {};',
      'class Writer {',
      ' public:',
      '  void Write(const Buffer* buffer) {}',
      '  void Write(Buffer* buffer) {}',
      '};',
      'Message MakeMessage() { return Message(); }',
      // The non-const overload first.
      'class Reader {',
      ' public:',
      '  void Read(Buffer* buffer) {}',
      '  void Read(const Buffer* buffer) {}',
      '};',
      // Overloads that differ by more than a `const`, as fmt's `to_string` do.
      'template <typename T>',
      'int to_text(T value) { return 0; }',
      'template <typename T>',
      'int to_text(const T& value) { return 1; }',
      // An array is a pointer to its element, as fmt's `Char buf[8]`.
      'template <typename OutputIt>',
      'OutputIt format_hex(OutputIt out, unsigned value) { return out; }',
      'template <typename Char>',
      'Char* format_hex(Char* out, unsigned value) { return out; }',
      // rocksdb's static_cast_with_check: the template's own `Src` takes the argument's `const`.
      'template <class Dest, class Src>',
      'Dest* checked_cast(Src* x) { return nullptr; }',
      'template <class Dest, class Src>',
      'std::shared_ptr<Dest> checked_cast(std::shared_ptr<Src>&& x) { return nullptr; }',
      // fmt's to_string_view: an argument of a template parameter's type could be a pointer.
      'template <typename T>',
      'int view_of(const T* s) { return 0; }',
      'template <typename T>',
      'int view_of(const T& s) { return 1; }',
      // rocksdb's Put: characters are no ColumnFamilyHandle.
      'class Handle {};',
      'class Slice {',
      ' public:',
      '  Slice(const char* data) {}',
      '};',
      'class Store {',
      ' public:',
      '  int Put(Handle* handle, const Slice& key) { return 0; }',
      '  int Put(const Slice& key, const Slice& value) { return 1; }',
      '};',
      // ...but a template's own `T*` takes them.
      'template <typename T>',
      'int sink(T* p) { return 0; }',
      'int sink(const Slice& s) { return 1; }',
      // A pointer is no characters, a `constexpr` array is const, and a long header is still a header.
      'int Emit(const char* text) { return 0; }',
      'int Emit(const Slice& text) { return 1; }',
      'int Take(char* p) { return 0; }',
      'int Take(const char* p) { return 1; }',
      'template <typename T,',
      '          typename A,',
      '          typename B,',
      '          typename C = int>',
      'int peek(T* p) { return 0; }',
      'int peek(const Slice& s) { return 1; }',
    ));
    write('src/use.cc', lines(
      '#include "src/message_lite.h"',
      'void NonConstHolder(std::shared_ptr<Message> ptr) { DynamicCastMessage<Message>(ptr.get()); }',
      'void ConstHolder(std::shared_ptr<const Message> ptr) { DynamicCastMessage<Message>(ptr.get()); }',
      'void NonConstPointer(Message* m) { DynamicCastMessage<Message>(m); }',
      'void ConstPointer(const Message* m) { DynamicCastMessage<Message>(m); }',
      'void NonConstReference(Message& m) { DynamicCastMessage<Message>(m); }',
      'void ConstReference(const Message& m) { DynamicCastMessage<Message>(m); }',
      'void Temporary() { DynamicCastMessage<Message>(MakeMessage()); }',
      'void WriteNonConst(Writer& w, Buffer* b) { w.Write(b); }',
      'void WriteConst(Writer& w, const Buffer* b) { w.Write(b); }',
      'void WriteConstPointer(Writer& w, Buffer* const b) { w.Write(b); }',
      'void ReadNonConst(Reader& r, Buffer* b) { r.Read(b); }',
      'void ReadConst(Reader& r, const Buffer* b) { r.Read(b); }',
      'void Show(Buffer& b) { to_text(b); }',
      'template <typename Char>',
      'void WriteHex(unsigned v) { Char buf[8]; format_hex(buf, v); }',
      'void Merge(const Buffer& other) { checked_cast<const Buffer>(&other); }',
      'template <typename S>',
      'void Format(const S& fmt) { view_of(fmt); }',
      // A header over several lines, as fmt's `join` writes.
      'template <typename It,',
      '          typename Sentinel,',
      '          typename S,',
      '          typename Char = char>',
      'void Join(It begin, Sentinel end, S&& sep) { view_of(sep); }',
      'void Save(Store& s) {',
      '  char key[] = "key";',
      '  char value[] = "value";',
      '  s.Put(key, value);',
      '}',
      'void Drain() { char buf[4]; sink(buf); }',
      'void Send(Buffer* b) { Emit(b); }',
      'void Keep() {',
      '  constexpr char name[] = "name";',
      '  Take(name);',
      '}',
      'void Look(const Buffer* b) { peek(b); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** The `name` overloads a function calls, as `name:startLine`. */
  const calls = (caller: string, name: string): string[] => {
    const fn = cg.getNodesByKind('function').find((n: Node) => n.name === caller);
    expect(fn, caller).toBeDefined();
    return cg.getCallees(fn!.id).filter((r) => r.edge.kind === 'calls' && r.node.name === name).map((r) => `${r.node.name}:${r.node.startLine}`);
  };

  it('a pointer to a non-const object takes the non-const overload, to a const one the const overload', () => {
    expect(calls('NonConstHolder', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:10']);
    expect(calls('ConstHolder', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:8']);
    expect(calls('NonConstPointer', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:10']);
    expect(calls('ConstPointer', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:8']);
  });

  it('a non-const object takes the non-const reference, a const object or a temporary the const one', () => {
    expect(calls('NonConstReference', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:14']);
    expect(calls('ConstReference', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:12']);
    expect(calls('Temporary', 'DynamicCastMessage')).toEqual(['DynamicCastMessage:12']);
  });

  it("a class's own overloads, whichever comes first", () => {
    expect(calls('WriteNonConst', 'Write')).toEqual(['Write:19']);
    expect(calls('WriteConst', 'Write')).toEqual(['Write:18']);
    // A pointer's own `const` is not its object's.
    expect(calls('WriteConstPointer', 'Write')).toEqual(['Write:19']);
    expect(calls('ReadNonConst', 'Read')).toEqual(['Read:24']);
    expect(calls('ReadConst', 'Read')).toEqual(['Read:25']);
  });

  it('no overload that differs by more than a `const`, and an array as a pointer', () => {
    expect(calls('Show', 'to_text')).toEqual(['to_text:28']);
    expect(calls('WriteHex', 'format_hex')).toEqual(['format_hex:34']);
  });

  it("a template's own parameter, an argument of a template parameter's type, and characters for a class pointer", () => {
    expect(calls('Merge', 'checked_cast')).toEqual(['checked_cast:36']);
    expect(calls('Format', 'view_of')).toEqual(['view_of:40']);
    expect(calls('Join', 'view_of')).toEqual(['view_of:40']);
    expect(calls('Save', 'Put')).toEqual(['Put:51']);
    expect(calls('Drain', 'sink')).toEqual(['sink:54']);
    expect(calls('Send', 'Emit')).toEqual(['Emit:57']);
    expect(calls('Keep', 'Take')).toEqual(['Take:59']);
    expect(calls('Look', 'peek')).toEqual(['peek:64']);
  });
});
