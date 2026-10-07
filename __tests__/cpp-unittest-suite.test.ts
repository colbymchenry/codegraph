/**
 * Google's C++ tests are named `foo_unittest.cc`, not `foo_test.cc` —
 * protobuf's, Breakpad's, glog's, Chromium's. The test-file check wanted a
 * separator right before `test`, so every one of them read as production code
 * and the resolver's test rules ran backwards for it. A unittest could not
 * reach the test helpers it includes (protobuf's `TestUtil::SetAllFields` in
 * test_util.h), while production code resolved into a unittest's own
 * declarations: Breakpad's `handler_stack_->size()` went to a unittest's
 * `StackHelper::size`, and a template's `AddressType()` to the `typedef` one
 * unittest declares.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-unittest-'));
  const files: Record<string, string> = {
    'src/message.h': `#ifndef MESSAGE_H_
#define MESSAGE_H_

namespace protobuf {

class Message {
 public:
  void Clear();
};

}  // namespace protobuf

#endif
`,
    'src/message.cc': `#include "message.h"

namespace protobuf {

void Message::Clear() {}

}  // namespace protobuf
`,
    // A test helper: named like a test suite, so production code never sees it.
    'src/test_util.h': `#ifndef TEST_UTIL_H_
#define TEST_UTIL_H_

#include "message.h"

namespace protobuf {
namespace TestUtil {

inline void SetAllFields(Message* message) { message->Clear(); }

}  // namespace TestUtil
}  // namespace protobuf

#endif
`,
    'src/wire_format_unittest.cc': `#include "message.h"
#include "test_util.h"

namespace protobuf {

void ParsesAllFields() {
  Message message;
  TestUtil::SetAllFields(&message);
}

}  // namespace protobuf
`,
    // Production code whose calls name nothing in the project.
    'src/exception_handler.cc': `#include <vector>

bool HandleSignal(std::vector<int>* handler_stack_) {
  return handler_stack_->size() > 0;
}
`,
    'src/range_map-inl.h': `template <typename AddressType>
bool StoreRange(const AddressType& base) {
  AddressType high = AddressType();
  return base < high;
}
`,
    // A unittest's own declarations, named like what production code calls.
    'src/ptrace_dumper_unittest.cc': `class StackHelper {
 public:
  unsigned size() const { return 0; }
};

unsigned Depth() {
  StackHelper helper;
  return helper.size();
}
`,
    'src/address_map_unittest.cc': `typedef int AddressType;

AddressType Lookup() { return 0; }
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

const edgesFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!);
};

describe("Google's unittest files are tests", () => {
  it('a unittest reaches the test helpers it includes', () => {
    expect(edgesFrom('src/wire_format_unittest.cc').map((n) => n.qualifiedName))
      .toContain('protobuf::TestUtil::SetAllFields');
  });

  it("production code never resolves into a unittest's own declarations", () => {
    for (const file of ['src/exception_handler.cc', 'src/range_map-inl.h']) {
      expect(edgesFrom(file).map((n) => n.filePath).filter((f) => f.endsWith('_unittest.cc')), file).toEqual([]);
    }
  });
});
