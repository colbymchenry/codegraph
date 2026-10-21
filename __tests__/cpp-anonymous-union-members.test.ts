/**
 * The members of a C++ anonymous union are the members of the class it is
 * declared in: protobuf's generated messages hold their fields in `union {
 * Impl_ _impl_; };`, and fmt's `value` its argument in a union of `string`,
 * `custom` and the rest. The union's lines were read as a nested class's, so
 * a call through `_impl_.type_url_` or `value_.string` was guessed by the
 * method's name: `this_._impl_.type_url_.Destroy()` reached `Arena::Destroy`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call through a member of an anonymous union', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-anonymous-union-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // Each namesake sits where a call matched by its bare name lands on it.
    write('src/arenastring.h', lines(
      'namespace google {',
      'namespace protobuf {',
      'class StringNamesake {',
      ' public:',
      '  void ClearToEmpty() {}',
      '};',
      'class Arena {',
      ' public:',
      '  static void Destroy() {}',
      '};',
      'class SizeNamesake {',
      ' public:',
      '  int Get() const { return 0; }',
      '};',
      'namespace internal {',
      'class ArenaStringPtr {',
      ' public:',
      '  void ClearToEmpty() {}',
      '  void Destroy() {}',
      '};',
      'class CachedSize {',
      ' public:',
      '  int Get() const { return 1; }',
      '};',
      '}  // namespace internal',
      '}  // namespace protobuf',
      '}  // namespace google',
    ));
    write('src/any.pb.h', lines(
      '#include "src/arenastring.h"',
      'namespace google {',
      'namespace protobuf {',
      'class Any final {',
      ' public:',
      '  void clear_type_url();',
      '  int GetCachedSize() const { return _impl_._cached_size_.Get(); }',
      '  static void SharedDtor(Any& this_);',
      ' private:',
      '  struct Impl_ {',
      '    ::google::protobuf::internal::ArenaStringPtr type_url_;',
      '    ::google::protobuf::internal::CachedSize _cached_size_;',
      '  };',
      '  union { Impl_ _impl_; };',
      '};',
      'inline void Any::clear_type_url() { _impl_.type_url_.ClearToEmpty(); }',
      '}  // namespace protobuf',
      '}  // namespace google',
    ));
    write('src/any.pb.cc', lines(
      '#include "src/any.pb.h"',
      'namespace google {',
      'namespace protobuf {',
      'void Any::SharedDtor(Any& this_) { this_._impl_.type_url_.Destroy(); }',
      '}  // namespace protobuf',
      '}  // namespace google',
    ));
    write('src/value.h', lines(
      'class Inner {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class Other {',
      ' public:',
      '  void Flush() {}',
      '};',
      'class string_value {',
      ' public:',
      '  const char* data() const { return ""; }',
      '};',
      'class StrNamesake {',
      ' public:',
      '  const char* data() const { return ""; }',
      '};',
      'class value {',
      ' public:',
      '  union {',
      '    int int_value;',
      '    string_value text;',
      '  };',
      '};',
      'struct Arg {',
      '  value value_;',
      '  const char* Data() { return value_.text.data(); }',
      '};',
      'struct Tagged {',
      '  union { Inner a; } u;',
      '  Other a;',
      '};',
      'void UseTagged(Tagged& t) { t.a.Flush(); }',
      'struct Outer {',
      '  struct Named { Inner b; } named;',
      '  Other b;',
      '};',
      'void UseOuter(Outer& o) { o.b.Flush(); }',
      // The index keeps a partial specialization as `<anonymous>` too.
      'struct Box {',
      '  template <typename T> struct Helper { Other h; };',
      '  template <typename T> struct Helper<T*> {',
      '    Inner h;',
      '  };',
      '  Other h;',
      '};',
      'void UseBox(Box& b) { b.h.Flush(); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function or method `qualifiedName`, as `qualifiedName`. */
  const calls = (qualifiedName: string): string[] => {
    const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
      .find((n: Node) => n.qualifiedName === qualifiedName);
    expect(caller, qualifiedName).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName).sort();
  };

  it("a method defined outside its class reaches the class's union member", () => {
    expect(calls('google::protobuf::Any::clear_type_url')).toEqual(['google::protobuf::internal::ArenaStringPtr::ClearToEmpty']);
  });

  it('a method inside the class reaches a union member declared below it', () => {
    expect(calls('google::protobuf::Any::GetCachedSize')).toEqual(['google::protobuf::internal::CachedSize::Get']);
  });

  it("a chain through an object's union member", () => {
    expect(calls('google::protobuf::Any::SharedDtor')).toEqual(['google::protobuf::internal::ArenaStringPtr::Destroy']);
  });

  it("a union member of a class-typed member of the caller's class", () => {
    expect(calls('Arg::Data')).toEqual(['string_value::data']);
  });

  it('a union with a declarator, a named nested struct or a specialization keeps its members to itself', () => {
    expect(calls('UseTagged')).toEqual(['Other::Flush']);
    expect(calls('UseOuter')).toEqual(['Other::Flush']);
    expect(calls('UseBox')).toEqual(['Other::Flush']);
  });
});
