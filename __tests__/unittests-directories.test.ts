/**
 * LLVM keeps its unit tests in `unittests/` (`llvm/unittests/`,
 * `clang/unittests/`, clangd's `unittests/`), Breakpad in
 * `src/client/windows/unittests/`, and glog builds each `foo_unittest/`
 * directory as a test program of its own. The test-file check knew `tests/`
 * but not these, so a helper there with no test-like name read as production
 * code, and none of the tree counted as a test suite: production locals named
 * `Ctx` or `OpInfo` linked to a test's own `LLVMContext Ctx;`, and a test
 * fixture's method kept a production call from resolving at all.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unittests-dirs-'));
  const files: Record<string, string> = {
    // A call the receiver's type doesn't settle, so its method is guessed by
    // name — and LLVM's SelectionDAGTestBase.h, a test fixture, has a method of
    // that name too.
    'include/llvm/CodeGen/TargetLowering.h': `#pragma once

namespace llvm {

class TargetLoweringBase {
 public:
  int getTypeToTransformTo(int VT) const { return VT * 2; }
};

class TargetLowering : public TargetLoweringBase {};

}  // namespace llvm
`,
    'lib/CodeGen/SelectionDAG/LegalizeTypes.h': `#pragma once

#include "llvm/CodeGen/TargetLowering.h"

namespace llvm {

class DAGTypeLegalizer {
  const TargetLowering &TLI;

 public:
  explicit DAGTypeLegalizer(const TargetLowering &T) : TLI(T) {}
  int softenFloat(int VT);
};

}  // namespace llvm
`,
    'lib/CodeGen/SelectionDAG/LegalizeFloatTypes.cpp': `#include "LegalizeTypes.h"

namespace llvm {

int DAGTypeLegalizer::softenFloat(int VT) {
  return TLI.getTypeToTransformTo(VT);
}

}  // namespace llvm
`,
    'unittests/CodeGen/SelectionDAGTestBase.h': `#pragma once

#include "llvm/CodeGen/TargetLowering.h"

namespace llvm {

class SelectionDAGTestBase {
 protected:
  const TargetLowering *Lowering = nullptr;
  int getTypeToTransformTo(int VT) { return Lowering->getTypeToTransformTo(VT); }
};

}  // namespace llvm
`,
    // A production parameter named like a variable a unittest declares.
    'lib/Object/WasmObjectFile.cpp': `namespace llvm {

struct ReadContext {
  const unsigned char *Ptr;
  const unsigned char *End;
};

unsigned readByte(ReadContext &Ctx) {
  if (Ctx.Ptr == Ctx.End) return 0;
  return *Ctx.Ptr++;
}

}  // namespace llvm
`,
    'unittests/FuzzMutate/RandomIRBuilderTest.cpp': `namespace {

struct LLVMContext {
  int Kind = 0;
};

LLVMContext Ctx;

}  // namespace

int RandomIRBuilderTestKind() { return Ctx.Kind; }
`,
    // The same through one of glog's test programs.
    'src/logging.cc': `struct LogSeverityNames {
  const char *Name;
};

const char *SeverityName(const LogSeverityNames &Severity) {
  return Severity.Name;
}
`,
    'src/log_severity_unittest/glog_log_severity_constants.cc': `struct Severity {
  int Value;
};

static Severity Fatal{3};

int main() { return Fatal.Value == 3 ? 0 : 1; }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const edgesFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!);
};

describe('unittests/ and foo_unittest/ directories are test suites', () => {
  it("production code never resolves into a unit test's own declarations", () => {
    for (const file of ['lib/Object/WasmObjectFile.cpp', 'src/logging.cc']) {
      const intoTests = edgesFrom(file).map((n) => n.filePath).filter((f) => /unittests?\//.test(f));
      expect(intoTests, file).toEqual([]);
    }
  });

  it("a test fixture's method no longer keeps a production call from resolving", () => {
    expect(edgesFrom('lib/CodeGen/SelectionDAG/LegalizeFloatTypes.cpp').map((n) => n.qualifiedName))
      .toContain('llvm::TargetLoweringBase::getTypeToTransformTo');
  });
});
