/**
 * A C or C++ name is one its translation unit declares, in production code
 * as in tests (cpp-test-translation-unit.test.ts). Of several same-named
 * candidates, what the file's includes declare goes first: protobuf's Python
 * extension calls `upb_Encode()` from upb/wire/encode.h, not the copy the PHP
 * extension bundles in php-upb.c; its Java generator calls the `HasHasbit()`
 * helpers.h declares, not `ImmutableFieldGenerator::HasHasbit`, a method
 * beside the caller. A source implements the header beside it (the
 * Python extension's pyext/message.cc is no implementation of
 * google/protobuf/message.h), even one it reaches only through other
 * headers (upb's reflection/field_def.c includes
 * reflection/internal/field_def.h, which reaches reflection/field_def.h
 * through def.h), a header's inline overload reaches the
 * definition its own source holds, and a call keeps a function outside the
 * unit that takes its arguments over one inside that can't (glog's
 * three-argument `GetStackTrace(…)` is not utilities.h's `GetStackTrace()`).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-tu-'));
  const files: Record<string, string> = {
    // upb's encoder, and the copy the PHP extension's amalgamation carries.
    'upb/wire/encode.h': `#ifndef UPB_WIRE_ENCODE_H_
#define UPB_WIRE_ENCODE_H_

#include <stddef.h>

int upb_Encode(const void* msg, int options, char** buf, size_t* size);

#endif
`,
    'upb/wire/encode.c': `#include "upb/wire/encode.h"

int upb_Encode(const void* msg, int options, char** buf, size_t* size) {
  *size = 0;
  return 0;
}
`,
    'php/ext/google/protobuf/php-upb.h': `#include <stddef.h>

int upb_Encode(const void* msg, int options, char** buf, size_t* size);
int upb_FieldDef_Number(const void* f);
`,
    'php/ext/google/protobuf/php-upb.c': `#include "php-upb.h"

int upb_Encode(const void* msg, int options, char** buf, size_t* size) {
  *size = 0;
  return 0;
}

int upb_FieldDef_Number(const void* f) { return 0; }
`,
    // upb's reflection/field_def.c implements reflection/field_def.h, which
    // it reaches only through its internal header and def.h.
    'upb/reflection/field_def.h': `typedef struct upb_FieldDef upb_FieldDef;

int upb_FieldDef_Number(const upb_FieldDef* f);
`,
    'upb/reflection/def.h': `#include "upb/reflection/field_def.h"
`,
    'upb/reflection/internal/field_def.h': `#include "upb/reflection/def.h"

int _upb_FieldDef_Index(const upb_FieldDef* f);
`,
    'upb/reflection/field_def.c': `#include "upb/reflection/internal/field_def.h"

int upb_FieldDef_Number(const upb_FieldDef* f) { return 1; }
`,
    'python/convert.c': `#include "upb/reflection/def.h"

int PyUpb_FieldNumber(const upb_FieldDef* f) {
  return upb_FieldDef_Number(f);
}
`,
    'python/message.c': `#include "upb/wire/encode.h"

int PyUpb_Message_Serialize(const void* msg) {
  char* buf;
  size_t size;
  return upb_Encode(msg, 0, &buf, &size);
}
`,
    // A free function the Java generator's helpers.h declares, and a field
    // generator's method of the same name beside the caller.
    'src/google/protobuf/compiler/java/helpers.h': `namespace google {
namespace protobuf {
class FieldDescriptor;
namespace compiler {
namespace java {

inline bool HasHasbit(const FieldDescriptor* descriptor) {
  return descriptor != nullptr;
}

}  // namespace java
}  // namespace compiler
}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/compiler/java/full/field_generator.h': `namespace google {
namespace protobuf {
class FieldDescriptor;
namespace compiler {
namespace java {

class ImmutableFieldGenerator {
 public:
  bool HasHasbit() const;

 private:
  const FieldDescriptor* descriptor_;
};

}  // namespace java
}  // namespace compiler
}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/compiler/java/full/field_generator.cc': `#include "google/protobuf/compiler/java/full/field_generator.h"

#include "google/protobuf/compiler/java/helpers.h"

namespace google {
namespace protobuf {
namespace compiler {
namespace java {

bool ImmutableFieldGenerator::HasHasbit() const {
  return ::google::protobuf::compiler::java::HasHasbit(descriptor_);
}

}  // namespace java
}  // namespace compiler
}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/compiler/java/full/enum_field.cc': `#include "google/protobuf/compiler/java/helpers.h"
#include "google/protobuf/compiler/java/full/field_generator.h"

namespace google {
namespace protobuf {
namespace compiler {
namespace java {

namespace {

int SetEnumVariables(const FieldDescriptor* descriptor) {
  if (HasHasbit(descriptor)) {
    return 1;
  }
  return 0;
}

}  // namespace

}  // namespace java
}  // namespace compiler
}  // namespace protobuf
}  // namespace google
`,
    // A header's template overload calls the one its own source defines.
    'conformance/binary_wireformat.h': `#include <cstdint>
#include <string>

namespace google {
namespace protobuf {
namespace conformance {

using Wire = std::string;

Wire Varint(uint64_t x);

// Overloads to avoid forcing sign/size conversion warnings on call-sites.
template <typename T>
Wire Varint(T x) {
  return Varint(static_cast<uint64_t>(x));
}

}  // namespace conformance
}  // namespace protobuf
}  // namespace google
`,
    'conformance/binary_wireformat.cc': `#include "conformance/binary_wireformat.h"

namespace google {
namespace protobuf {
namespace conformance {

Wire Varint(uint64_t x) {
  return std::string(1, static_cast<char>(x));
}

}  // namespace conformance
}  // namespace protobuf
}  // namespace google
`,
    // glog's three-parameter GetStackTrace is declared in stacktrace.h and
    // defined in a header stacktrace.cc includes; utilities.h declares a
    // GetStackTrace() of no parameters.
    'src/stacktrace.h': `namespace google {
namespace glog_internal_namespace_ {

int GetStackTrace(void** result, int max_depth, int skip_count);

}  // namespace glog_internal_namespace_
}  // namespace google
`,
    'src/stacktrace_generic-inl.h': `#include "stacktrace.h"

namespace google {
namespace glog_internal_namespace_ {

int GetStackTrace(void** result, int max_depth, int skip_count) {
  return 0;
}

}  // namespace glog_internal_namespace_
}  // namespace google
`,
    'src/stacktrace.cc': `#include "stacktrace.h"

#include "stacktrace_generic-inl.h"
`,
    'src/utilities.h': `#include <string>

namespace google {

std::string GetStackTrace();

}  // namespace google
`,
    'src/utilities.cc': `#include "utilities.h"

namespace google {

std::string GetStackTrace() {
  return "";
}

}  // namespace google
`,
    'src/logging.cc': `#include <string>

#include "stacktrace.h"
#include "utilities.h"

namespace google {

using namespace glog_internal_namespace_;

int RecordCrashReason(void** stack) {
  std::string trace = GetStackTrace();
  int depth = GetStackTrace(stack, 32, 4);
  return depth + static_cast<int>(trace.size());
}

}  // namespace google
`,
    // The Python extension's message.cc implements pyext/message.h beside
    // it, though it includes google/protobuf/message.h too.
    'src/google/protobuf/message.h': `namespace google {
namespace protobuf {

class Message {
 public:
  virtual ~Message() {}
};

}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/any.pb.h': `#include "google/protobuf/message.h"

namespace google {
namespace protobuf {

class Any : public Message {
 public:
  void MergeFrom(const Any& from) {}
};

}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/descriptor.pb.h': `#include "google/protobuf/message.h"

namespace google {
namespace protobuf {

class FileDescriptorSet : public Message {
 public:
  void CopyFrom(const FileDescriptorSet& from);
};

}  // namespace protobuf
}  // namespace google
`,
    'src/google/protobuf/descriptor.pb.cc': `#include "google/protobuf/descriptor.pb.h"

namespace google {
namespace protobuf {

void FileDescriptorSet::CopyFrom(const FileDescriptorSet& from) {
  if (&from == this) return;
  MergeFrom(from);
}

}  // namespace protobuf
}  // namespace google
`,
    'python/google/protobuf/pyext/message.h': `namespace google {
namespace protobuf {
namespace python {
namespace cmessage {

int MergeFrom(void* self, void* arg);

}  // namespace cmessage
}  // namespace python
}  // namespace protobuf
}  // namespace google
`,
    'python/google/protobuf/pyext/message.cc': `#include "google/protobuf/message.h"
#include "google/protobuf/pyext/message.h"

namespace google {
namespace protobuf {
namespace python {
namespace cmessage {

int MergeFrom(void* self, void* arg) { return 0; }

}  // namespace cmessage
}  // namespace python
}  // namespace protobuf
}  // namespace google
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `qualifiedName (file)` of every call the file's symbols make. */
const callsFrom = (file: string): string[] => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => {
    const target = cg.getNode(e.target)!;
    return `${target.qualifiedName} (${target.filePath})`;
  });
};

describe('a C/C++ reference links what its translation unit declares', () => {
  it('calls the C function its includes declare, not a bundled copy', () => {
    const calls = callsFrom('python/message.c');
    expect(calls).toContain('upb_Encode (upb/wire/encode.c)');
    expect(calls.some((c) => c.includes('php-upb'))).toBe(false);
  });

  it('reads a source as implementing the header beside it that it reaches through others', () => {
    const calls = callsFrom('python/convert.c');
    expect(calls).toContain('upb_FieldDef_Number (upb/reflection/field_def.c)');
    expect(calls.some((c) => c.includes('php-upb'))).toBe(false);
  });

  it('calls the free function its includes declare, not a class\'s method beside it', () => {
    const calls = callsFrom('src/google/protobuf/compiler/java/full/enum_field.cc');
    expect(calls).toContain('google::protobuf::compiler::java::HasHasbit (src/google/protobuf/compiler/java/helpers.h)');
    expect(calls.some((c) => c.includes('ImmutableFieldGenerator'))).toBe(false);
  });

  it('lets a header\'s overload call the definition its own source holds', () => {
    const calls = callsFrom('conformance/binary_wireformat.h');
    expect(calls).toContain('google::protobuf::conformance::Varint (conformance/binary_wireformat.cc)');
  });

  it('keeps a call off a function its arguments cannot fill', () => {
    const calls = callsFrom('src/logging.cc');
    expect(calls).toContain('google::GetStackTrace (src/utilities.cc)');
    expect(calls).toContain('google::glog_internal_namespace_::GetStackTrace (src/stacktrace_generic-inl.h)');
  });

  it('reads a source as implementing the header beside it, not a namesake elsewhere', () => {
    const calls = callsFrom('src/google/protobuf/descriptor.pb.cc');
    expect(calls.some((c) => c.includes('pyext/message.cc'))).toBe(false);
  });
});
