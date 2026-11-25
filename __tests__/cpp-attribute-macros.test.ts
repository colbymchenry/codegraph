/**
 * Attribute macros tree-sitter-cpp can't read, in the places the C++ preParse
 * did not yet blank them:
 *
 * - several macros, or one with arguments, between `class` and the name
 *   (protobuf's generated `class PROTOBUF_EXPORT
 *   PROTOBUF_FUTURE_ADD_EARLY_WARN_UNUSED Any final : public Message`,
 *   rocksdb's `struct ALIGN_AS(64U) HandleImpl`), and one before a partial
 *   specialization's name;
 * - a macro between a pointer and the declared name (`const Descriptor*
 *   PROTOBUF_NONNULL descriptor()`), after a parameter list
 *   (`unknown_fields() const ABSL_ATTRIBUTE_LIFETIME_BOUND {`, leveldb's
 *   `LOCKS_EXCLUDED(mu_) {`), after a declared name (`int count_
 *   GUARDED_BY(mu_);`), or opening a declaration
 *   (`PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view name() const`);
 * - a lone macro line with a comment under it ({fmt}'s `FMT_BEGIN_EXPORT`).
 *
 * Each misparsed the class around it: protobuf's generated messages had their
 * members indexed as namespace-level functions, and leveldb's annotated
 * methods became phantoms named after the annotation.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  blankCppExportMacros,
  blankCppPointerAnnotationMacros,
  blankCppTrailingAttributeMacros,
  blankCppDeclaratorAttributeMacros,
  blankCppLeadingAttributeMacros,
  blankLoneMacroLines,
  cppExtractor,
} from '../src/extraction/languages/c-cpp';

/** Assert `blank` removes exactly `macros` from `input` and nothing else, offsets kept. */
function expectBlanked(blank: (s: string) => string, input: string, macros: string[]): void {
  const out = blank(input);
  expect(out.length).toBe(input.length);
  let expected = input;
  for (const macro of macros) {
    const at = expected.indexOf(macro);
    expect(at, `${macro} in ${input}`).toBeGreaterThanOrEqual(0);
    expected = expected.slice(0, at) + macro.replace(/[^\r\n]/g, ' ') + expected.slice(at + macro.length);
  }
  expect(out).toBe(expected);
}

describe('C++ attribute-macro blanks', () => {
  it('blanks every macro between class and the name, and before a specialization', () => {
    expectBlanked(
      blankCppExportMacros,
      'class PROTOBUF_EXPORT  PROTOBUF_FUTURE_ADD_EARLY_WARN_UNUSED Any final : public ::google::protobuf::Message {};',
      ['PROTOBUF_EXPORT  PROTOBUF_FUTURE_ADD_EARLY_WARN_UNUSED']
    );
    expectBlanked(
      blankCppExportMacros,
      'template <typename Element>\nclass ABSL_ATTRIBUTE_WARN_UNUSED PROTOBUF_DECLSPEC_EMPTY_BASES\n    RepeatedField final\n    : private internal::RepeatedFieldBase {};',
      ['ABSL_ATTRIBUTE_WARN_UNUSED', 'PROTOBUF_DECLSPEC_EMPTY_BASES']
    );
    expectBlanked(
      blankCppExportMacros,
      'template <typename T, bool kOrProxy>\nclass PROTOBUF_DECLSPEC_EMPTY_BASES RepeatedFieldProxyWithSet<\n    T, kOrProxy,\n    std::enable_if_t<IsMessage<T>>> {};',
      ['PROTOBUF_DECLSPEC_EMPTY_BASES']
    );
    expectBlanked(blankCppExportMacros, 'struct ALIGN_AS(64U) HandleImpl : public ClockHandle {};', ['ALIGN_AS(64U)']);
    // An all-caps class name after a macro is the name, `final` included.
    expectBlanked(blankCppExportMacros, 'class FOO_API BAR_IMPL final : public X {};', ['FOO_API']);
  });

  it('leaves class heads alone when nothing is defined there', () => {
    for (const c of [
      'class FOO_API Name;',
      'class FOO_API Name<int> var;',
      'struct STAT_T st = {0};',
      'class GTEST_1_TUPLE_(T) {',
      '// class PROTOBUF_EXPORT Any final : public Message {',
      'const char* s = "class FOO Bar {";',
    ]) {
      expect(blankCppExportMacros(c)).toBe(c);
    }
  });

  it('blanks annotations between a pointer or reference and the declared name', () => {
    expectBlanked(
      blankCppPointerAnnotationMacros,
      'static const Descriptor* PROTOBUF_NONNULL descriptor() { return d; }',
      ['PROTOBUF_NONNULL']
    );
    expectBlanked(
      blankCppPointerAnnotationMacros,
      'void Any::InternalSwap(Any* PROTOBUF_RESTRICT PROTOBUF_NONNULL other) {}',
      ['PROTOBUF_RESTRICT PROTOBUF_NONNULL']
    );
    expectBlanked(
      blankCppPointerAnnotationMacros,
      'void f(const FieldDescriptor * PROTOBUF_NULLABLE *\n    PROTOBUF_NONNULL field, const T& ABSL_ATTRIBUTE_LIFETIME_BOUND v);',
      ['PROTOBUF_NULLABLE', 'PROTOBUF_NONNULL', 'ABSL_ATTRIBUTE_LIFETIME_BOUND']
    );
    expectBlanked(
      blankCppPointerAnnotationMacros,
      'static constexpr const EnumDescriptor* PROTOBUF_NONNULL* PROTOBUF_NULLABLE\n    file_level_enum_descriptors = nullptr;',
      ['PROTOBUF_NONNULL', 'PROTOBUF_NULLABLE']
    );
  });

  it('leaves products, bit tests, unnamed parameters and comments alone', () => {
    for (const c of [
      'int n = count * MAX_LEN + 1;',
      'bool b = (flags & FOO_BIT) != 0;',
      'bool b = flags & FOO_BIT\n    && enabled;',
      'bool b = flags & FOO_BIT and enabled;',
      'void f(Foo* PROTOBUF_NONNULL);',
      '/**\n * NOTE_THIS applies\n * TODO_LATER fix it\n */',
      'const char* s = "a * PROTOBUF_NONNULL b";',
      'int digits10 = int(sizeof(int) * CHAR_BIT * 3 / 10);',
      'int n = 2 * PAGE_SIZE * pages;',
      '#define PTR_T int *\nFOO_BAR name;',
    ]) {
      expect(blankCppPointerAnnotationMacros(c)).toBe(c);
    }
  });

  it('blanks attribute macros after a parameter list', () => {
    expectBlanked(
      blankCppTrailingAttributeMacros,
      'const UnknownFieldSet& unknown_fields() const\n      ABSL_ATTRIBUTE_LIFETIME_BOUND {\n  return f;\n}',
      ['ABSL_ATTRIBUTE_LIFETIME_BOUND']
    );
    expectBlanked(blankCppTrailingAttributeMacros, '~Any() PROTOBUF_FINAL;', ['PROTOBUF_FINAL']);
    expectBlanked(
      blankCppTrailingAttributeMacros,
      'void Lock() EXCLUSIVE_LOCK_FUNCTION() { mu_.lock(); }\nvoid Wait() LOCKS_EXCLUDED(mu_);',
      ['EXCLUSIVE_LOCK_FUNCTION()', 'LOCKS_EXCLUDED(mu_)']
    );
    expectBlanked(
      blankCppTrailingAttributeMacros,
      'explicit MutexLock(port::Mutex* mu) EXCLUSIVE_LOCK_FUNCTION(mu) : mu_(mu) {}',
      ['EXCLUSIVE_LOCK_FUNCTION(mu)']
    );
    expectBlanked(
      blankCppTrailingAttributeMacros,
      'bool operator==(const A& a) const ABSL_MUST_USE_RESULT;',
      ['ABSL_MUST_USE_RESULT']
    );
  });

  it('leaves statements, casts and macro calls followed by macros alone', () => {
    for (const c of [
      'if (x) RETURN_FALSE;',
      'while (busy) SPIN_PAUSE;',
      'int v = (int) MAX_VALUE;',
      'FMT_PRAGMA_CLANG(diagnostic ignored "-Wbit-int-extension")\n\nTEST(std_test, bitint) {\n}',
      'DECLARE_FOO(a) DECLARE_BAR(b);',
      'void f()\n\nBAR_BAZ;',
      'bool b = f(x) == FOO_BAR;',
      // A directive's `)` closes no parameter list.
      '#  if FMT_USE_FCNTL && !defined(__MINGW32__)\nTEST(file_test, open_windows_file) {\n}',
      'if constexpr (POS + 1 == str.size())\n  FMT_THROW(format_error("unmatched brace"));',
    ]) {
      expect(blankCppTrailingAttributeMacros(c)).toBe(c);
    }
  });

  it('blanks attribute macros after a declared name or its brackets', () => {
    expectBlanked(blankCppDeclaratorAttributeMacros, 'port::CondVar cv GUARDED_BY(mu);', ['GUARDED_BY(mu)']);
    expectBlanked(blankCppDeclaratorAttributeMacros, 'int refs_ GUARDED_BY(refs_mutex_);', ['GUARDED_BY(refs_mutex_)']);
    expectBlanked(blankCppDeclaratorAttributeMacros, 'Version* const version GUARDED_BY(mu);', ['GUARDED_BY(mu)']);
    expectBlanked(
      blankCppDeclaratorAttributeMacros,
      'std::map<int, int> cache_ ABSL_GUARDED_BY(mutex_) = {};',
      ['ABSL_GUARDED_BY(mutex_)']
    );
    expectBlanked(
      blankCppDeclaratorAttributeMacros,
      'const AnyGlobalsTypeInternal Any_globals_\n    PROTOBUF_MESSAGE_GLOBALS_SECTION(.data.rel.ro);',
      ['PROTOBUF_MESSAGE_GLOBALS_SECTION(.data.rel.ro)']
    );
    expectBlanked(
      blankCppDeclaratorAttributeMacros,
      'const ::uint32_t Table::offsets[] ABSL_ATTRIBUTE_SECTION_VARIABLE(\n    protodesc_cold) = {1, 2};',
      ['ABSL_ATTRIBUTE_SECTION_VARIABLE(\n    protodesc_cold)']
    );
    expectBlanked(
      blankCppDeclaratorAttributeMacros,
      'explicit CordInputStream(const absl::Cord* cord ABSL_ATTRIBUTE_LIFETIME_BOUND);',
      ['ABSL_ATTRIBUTE_LIFETIME_BOUND']
    );
  });

  it('leaves variables named in capitals and names without a type before them alone', () => {
    for (const c of [
      'Foo DEFAULT_OPTIONS;',
      'static Foo DEFAULT_OPTIONS;',
      'const Foo DEFAULT_OPTIONS = Make();',
      'ns::Foo DEFAULT_OPTIONS;',
      'typedef Foo BAR_T;',
      'template <typename T> T MAX_VALUE;',
      'return x FOO_SUFFIX;',
      'f(a, b FOO_FLAG);',
      'x = rate FOO_UNITS;',
      'EXPECT_EQ(2 SECS_X, d);',
    ]) {
      expect(blankCppDeclaratorAttributeMacros(c)).toBe(c);
    }
  });

  it('blanks attribute macros that open a declaration', () => {
    expectBlanked(
      blankCppLeadingAttributeMacros,
      '  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view name() const { return n; }',
      ['PROTOBUF_FUTURE_ADD_EARLY_NODISCARD']
    );
    expectBlanked(
      blankCppLeadingAttributeMacros,
      '  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD static constexpr size_t\n  kMax = 3;',
      ['PROTOBUF_FUTURE_ADD_EARLY_NODISCARD']
    );
    expectBlanked(
      blankCppLeadingAttributeMacros,
      '  ABSL_ATTRIBUTE_REINITIALIZES void Clear() final;',
      ['ABSL_ATTRIBUTE_REINITIALIZES']
    );
    expectBlanked(
      blankCppLeadingAttributeMacros,
      '  [[nodiscard]] PROTOBUF_NDEBUG_INLINE Ptr<T> Make(Args&&... args) {}',
      ['PROTOBUF_NDEBUG_INLINE']
    );
    expectBlanked(
      blankCppLeadingAttributeMacros,
      'GTEST_API_ std::string JoinAsTuple(const Strings& fields);',
      ['GTEST_API_']
    );
    expectBlanked(blankCppLeadingAttributeMacros, 'FMT_EXPORT struct as_identifiers_t {};', ['FMT_EXPORT']);
    expectBlanked(
      blankCppLeadingAttributeMacros,
      'PROTOBUF_NDEBUG_INLINE Any::Impl_::Impl_(Arena* arena) : x_(arena) {}',
      ['PROTOBUF_NDEBUG_INLINE']
    );
    expectBlanked(
      blankCppLeadingAttributeMacros,
      'PROTOBUF_ATTRIBUTE_NO_DESTROY PROTOBUF_CONSTINIT\n    PROTOBUF_ATTRIBUTE_INIT_PRIORITY1 const AnyGlobals Any_globals_;',
      ['PROTOBUF_ATTRIBUTE_NO_DESTROY PROTOBUF_CONSTINIT\n    PROTOBUF_ATTRIBUTE_INIT_PRIORITY1']
    );
  });

  it('leaves a type in capitals alone', () => {
    for (const c of [
      'DWORD_PTR value = 0;',
      'SIZE_T const n = 3;',
      'UINT_PTR const* p = q;',
      'HANDLE_T Open(int flags);',
      'UINT_PTR Foo::Bar() { return 0; }',
      'RESULT_T operator==(const A& a);',
      'RESULT_T\nGnuStyle(int x) {}',
      'int x = a |\n    SOME_CONST\n    | OTHER;',
      '// PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view name() const;',
      // A macro inside a string concatenation, with a declaration after it.
      'static const char kHelp[] =\n    "using " GTEST_NAME_\n    ". You can use the\\n"\n    "  --" GTEST_FLAG_PREFIX_\n    "list_tests\\n";\nstatic bool g_help = false;',
    ]) {
      expect(blankCppLeadingAttributeMacros(c)).toBe(c);
    }
  });

  it('blanks only the macros of a run, not a comment between them', () => {
    expectBlanked(
      blankCppLeadingAttributeMacros,
      'PROTOBUF_ATTRIBUTE_NO_DESTROY /* keep */ PROTOBUF_CONSTINIT const Foo kFoo;',
      ['PROTOBUF_ATTRIBUTE_NO_DESTROY', 'PROTOBUF_CONSTINIT']
    );
  });

  it('blanks a lone macro line with comments under it, but not an operand', () => {
    const fmt = 'FMT_BEGIN_EXPORT\n\n// A generic formatting context with custom output iterator and character\n/* (code unit) support. */\ntemplate <typename OutputIt, typename Char> class generic_context {};\n';
    expectBlanked(blankLoneMacroLines, fmt, ['FMT_BEGIN_EXPORT']);
    // A string literal continues the expression, comment or not.
    const operand = 'const char* s =\n  "x"\n  FOO_PREFIX\n  // comment\n  "y";\n';
    expect(blankLoneMacroLines(operand)).toBe(operand);
  });

  it('keeps every offset through the whole C++ preParse', () => {
    const src = 'class PROTOBUF_EXPORT X final : public Y {\n  const D* PROTOBUF_NONNULL d() const ABSL_ATTRIBUTE_LIFETIME_BOUND;\n  int n_ GUARDED_BY(mu_);\n};\r\n';
    const out = cppExtractor.preParse!(src, 'x.h');
    expect(out.length).toBe(src.length);
    expect(out.split(/\r?\n/).map((l) => l.length)).toEqual(src.split(/\r?\n/).map((l) => l.length));
    expect(out).not.toMatch(/PROTOBUF_|ABSL_|GUARDED_BY/);
  });
});

const PB_H = `// Generated by the protocol buffer compiler.  DO NOT EDIT!
#ifndef GOOGLE_PROTOBUF_INCLUDED_any_2eproto
#define GOOGLE_PROTOBUF_INCLUDED_any_2eproto

#include "google/protobuf/message.h"

namespace google {
namespace protobuf {

class PROTOBUF_EXPORT  PROTOBUF_FUTURE_ADD_EARLY_WARN_UNUSED Any final : public ::google::protobuf::Message
/* @@protoc_insertion_point(class_definition:google.protobuf.Any) */ {
 public:
  Any() : Any(nullptr) {}
  ~Any() PROTOBUF_FINAL;

  [[nodiscard]] const ::google::protobuf::UnknownFieldSet& unknown_fields() const
      ABSL_ATTRIBUTE_LIFETIME_BOUND {
    return _internal_metadata_.unknown_fields();
  }
  [[nodiscard]] ::google::protobuf::UnknownFieldSet* PROTOBUF_NONNULL mutable_unknown_fields()
      ABSL_ATTRIBUTE_LIFETIME_BOUND {
    return _internal_metadata_.mutable_unknown_fields();
  }

  [[nodiscard]] static const ::google::protobuf::Descriptor* PROTOBUF_NONNULL descriptor() {
    return GetDescriptor();
  }
  [[nodiscard]] static const ::google::protobuf::Descriptor* PROTOBUF_NONNULL
  GetDescriptor() {
    return default_instance().GetMetadata().descriptor;
  }
  [[nodiscard]] static const ::google::protobuf::Reflection* PROTOBUF_NONNULL GetReflection() {
    return default_instance().GetMetadata().reflection;
  }
  void Swap(Any* PROTOBUF_NONNULL other) {
    InternalSwap(other);
  }
  [[nodiscard]] ::std::string* PROTOBUF_NONNULL mutable_type_url();

 private:
  void InternalSwap(Any* PROTOBUF_NONNULL other);
};

inline ::std::string* PROTOBUF_NONNULL Any::mutable_type_url() {
  return _impl_.type_url_.Mutable();
}

}  // namespace protobuf
}  // namespace google

#endif  // GOOGLE_PROTOBUF_INCLUDED_any_2eproto
`;

const MESSAGE_H = `namespace google {
namespace protobuf {

class Message {
 public:
  virtual ~Message();
};

}  // namespace protobuf
}  // namespace google
`;

const PB_CC = `#include "google/protobuf/any.pb.h"

namespace google {
namespace protobuf {

PROTOBUF_ATTRIBUTE_NO_DESTROY PROTOBUF_CONSTINIT PROTOBUF_EXPORT
    PROTOBUF_ATTRIBUTE_INIT_PRIORITY1 const AnyGlobalsTypeInternal Any_globals_
        PROTOBUF_MESSAGE_GLOBALS_SECTION(.data.rel.ro);

void Any::InternalSwap(Any* PROTOBUF_RESTRICT PROTOBUF_NONNULL other) {
  _impl_.type_url_.InternalSwap(&other->_impl_.type_url_);
}

}  // namespace protobuf
}  // namespace google
`;

const REPEATED_H = `#include <cstddef>

namespace google {
namespace protobuf {

template <typename Element>
class ABSL_ATTRIBUTE_WARN_UNUSED PROTOBUF_DECLSPEC_EMPTY_BASES
    RepeatedField final
    : private internal::RepeatedFieldBase {
 public:
  int size() const { return size_; }

 private:
  int size_;
};

}  // namespace protobuf
}  // namespace google
`;

const DESCRIPTOR_H = `#include <string>

namespace google {
namespace protobuf {

class PROTOBUF_EXPORT Descriptor : private internal::SymbolBase {
 public:
  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view name() const {
    return all_names_[0];
  }
  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD absl::string_view full_name() const {
    return all_names_[1];
  }
  PROTOBUF_FUTURE_ADD_EARLY_NODISCARD const FileDescriptor* file() const;
};

}  // namespace protobuf
}  // namespace google
`;

const FMT_H = `#include <string>

#define FMT_BEGIN_EXPORT
FMT_BEGIN_NAMESPACE

FMT_BEGIN_EXPORT

// A generic formatting context with custom output iterator and character
// (code unit) support.
template <typename OutputIt, typename Char> class generic_context {
 private:
  OutputIt out_;

 public:
  constexpr auto out() -> OutputIt { return out_; }
};

FMT_END_EXPORT
FMT_END_NAMESPACE
`;

const LEVELDB_CC = `#include "port/port.h"

namespace leveldb {

class Counter {
 public:
  void IncrementBy(int count) LOCKS_EXCLUDED(mu_) {
    MutexLock l(&mu_);
    count_ += count;
  }
  void Lock() EXCLUSIVE_LOCK_FUNCTION() { mu_.Lock(); }

 private:
  port::Mutex mu_;
  int count_ GUARDED_BY(mu_);
};

}  // namespace leveldb
`;

describe('C++ classes written around attribute macros', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-attr-macros-'));
    const files: Record<string, string> = {
      'src/google/protobuf/message.h': MESSAGE_H,
      'src/google/protobuf/any.pb.h': PB_H,
      'src/google/protobuf/any.pb.cc': PB_CC,
      'src/google/protobuf/repeated_field.h': REPEATED_H,
      'src/google/protobuf/descriptor.h': DESCRIPTOR_H,
      'include/fmt/format.h': FMT_H,
      'db/counter.cc': LEVELDB_CC,
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const nodes = (file: string) => cg.getNodesInFile(file);
  const qualified = (file: string, kind: string) =>
    nodes(file).filter((n) => n.kind === kind).map((n) => n.qualifiedName).sort();

  it('indexes a generated message class with its members as methods', () => {
    const file = 'src/google/protobuf/any.pb.h';
    expect(qualified(file, 'class')).toEqual(['google::protobuf::Any']);
    expect(qualified(file, 'method')).toEqual(
      expect.arrayContaining([
        'google::protobuf::Any::Any',
        'google::protobuf::Any::GetDescriptor',
        'google::protobuf::Any::GetReflection',
        'google::protobuf::Any::Swap',
        'google::protobuf::Any::descriptor',
        'google::protobuf::Any::mutable_type_url',
        'google::protobuf::Any::mutable_unknown_fields',
        'google::protobuf::Any::unknown_fields',
      ])
    );
    // No member is left at namespace level, and no node is named after a macro.
    expect(qualified(file, 'function')).toEqual([]);
    expect(nodes(file).filter((n) => /PROTOBUF_|ABSL_/.test(n.qualifiedName))).toEqual([]);
    const any = nodes(file).find((n) => n.kind === 'class')!;
    const bases = cg.getOutgoingEdges(any.id).filter((e) => e.kind === 'extends');
    expect(bases.map((e) => cg.getNode(e.target)?.qualifiedName)).toEqual(['google::protobuf::Message']);
  });

  it('indexes an out-of-line definition whose parameter carries an annotation', () => {
    expect(qualified('src/google/protobuf/any.pb.cc', 'method')).toEqual(['google::protobuf::Any::InternalSwap']);
  });

  it('indexes a class whose head stacks macros over several lines', () => {
    const file = 'src/google/protobuf/repeated_field.h';
    expect(qualified(file, 'class')).toEqual(['google::protobuf::RepeatedField']);
    expect(qualified(file, 'method')).toEqual(['google::protobuf::RepeatedField::size']);
  });

  it('indexes members that open with an attribute macro', () => {
    const file = 'src/google/protobuf/descriptor.h';
    expect(qualified(file, 'method')).toEqual([
      'google::protobuf::Descriptor::full_name',
      'google::protobuf::Descriptor::name',
    ]);
  });

  it('indexes a class under a lone macro line and a comment', () => {
    expect(qualified('include/fmt/format.h', 'method')).toEqual(['generic_context::out']);
    expect(qualified('include/fmt/format.h', 'function')).toEqual([]);
  });

  it('keeps annotated methods instead of phantoms named after the annotation', () => {
    const file = 'db/counter.cc';
    expect(qualified(file, 'method')).toEqual(['leveldb::Counter::IncrementBy', 'leveldb::Counter::Lock']);
    expect(nodes(file).filter((n) => /LOCKS|GUARDED/.test(n.name))).toEqual([]);
  });
});
