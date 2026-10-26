/**
 * A C or C++ name written from the global scope — `::store::Repair(…)`,
 * protobuf's `::_pbi::PrivateAccess::GenerateParseTable(…)` through
 * `namespace _pbi = ::google::protobuf::internal;` — never got past the
 * resolver's name-existence pre-filter, which read no leading `::`. protobuf's
 * calls resolved only because it ships a few Swift and Objective-C files, and
 * the Swift ↔ Objective-C bridge claimed every name with a `:` in it; C++-only
 * rocksdb, leveldb and fmt dropped theirs. Past the pre-filter, the name is the
 * declaration of exactly that qualified name: never one nested in another
 * namespace or class, as the wrapper `int open(…) { return ::open(…); }` and an
 * external `::testing::` call show.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

function writeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/**
 * `name -> target qualified name` for every reference the named function or
 * method in `file` resolves — a call to a struct is an `instantiates` edge.
 */
function callsFrom(cg: CodeGraph, file: string, name: string): string[] {
  const from = cg.getNodesInFile(file).filter((n) => n.name === name && (n.kind === 'function' || n.kind === 'method'));
  expect(from.length).toBeGreaterThan(0);
  return cg
    .getOutgoingEdgesFrom(from.map((n) => n.id))
    .flatMap((e) => {
      const refName = (e.metadata as { refName?: string } | undefined)?.refName;
      return refName ? [`${refName} -> ${cg.getNode(e.target)!.qualifiedName}`] : [];
    })
    .sort();
}

const PB_INTERNAL = `#pragma once
namespace pb {
namespace internal {
inline int Prefetch(const void* ptr) { return ptr != nullptr; }
}  // namespace internal
}  // namespace pb

namespace _pbi = ::pb::internal;
`;

describe('C++ names written from the global scope', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-global-', {
      'src/store/repair.cc': `namespace store {
int Repair(const char* name) { return name != nullptr; }
int move(int value) { return value; }

namespace testing {
const char* TempDir() { return "/tmp/store"; }
}  // namespace testing
}  // namespace store
`,
      'src/pb/internal.h': PB_INTERNAL,
      'src/store/posix.cc': `#include <unistd.h>

namespace store {
namespace posix {
int close(int fd) { return ::close(fd); }
}  // namespace posix
}  // namespace store
`,
      'tools/repair_tool.cc': `#include <utility>
#include "pb/internal.h"

namespace tools {
namespace store {
int Repair(const char* name) { return 0; }
}  // namespace store

int Run(const char* name) {
  int fixed = ::store::Repair(name);
  int warmed = ::_pbi::Prefetch(name);
  return ::std::move(fixed) + warmed;
}
}  // namespace tools
`,
      'include/lib/os.h': `#pragma once
#define LIB_BEGIN_NAMESPACE \\
  namespace lib {           \\
  inline namespace v1 {
#define LIB_END_NAMESPACE \\
  }                       \\
  }

LIB_BEGIN_NAMESPACE
struct pipe {
  int read_end;
  int write_end;
};
LIB_END_NAMESPACE
`,
      'tests/posix-mock.cc': `#include <unistd.h>
#include "lib/os.h"

namespace test {
int pipe(int fds[2]) { return ::pipe(fds); }
}  // namespace test
`,
      'tests/repair_test.cc': `#include <gtest/gtest.h>

class RepairTest : public ::testing::Test {};

int RunAll(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return ::testing::TempDir() != nullptr;
}
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links `::ns::f()` to the global namespace’s f, and an alias’s call to the aliased namespace', () => {
    // Inside `namespace tools`, `store::Repair` would be tools' own; `::store::Repair` is the global one.
    expect(callsFrom(cg, 'tools/repair_tool.cc', 'Run')).toEqual([
      '::_pbi::Prefetch -> pb::internal::Prefetch',
      '::store::Repair -> store::Repair',
    ]);
  });

  it('never links a global name to a namesake nested in a namespace or class', () => {
    // The wrapper calls the C library's `close`, not itself.
    expect(callsFrom(cg, 'src/store/posix.cc', 'close')).toEqual([]);
    // Nor `lib::pipe`, whose namespace a macro opens (fmt's FMT_BEGIN_NAMESPACE):
    // the index cannot see it, so the struct only looks global there.
    expect(callsFrom(cg, 'tests/posix-mock.cc', 'pipe')).toEqual([]);
    // gtest is not in the project: `::testing::TempDir` is not `store::testing::TempDir`.
    expect(callsFrom(cg, 'tests/repair_test.cc', 'RunAll')).toEqual([]);
  });

  it('leaves an external `::testing::Test` base unresolved', () => {
    const test = cg.getNodesInFile('tests/repair_test.cc').find((n) => n.name === 'RepairTest')!;
    expect(test).toBeDefined();
    expect(cg.getOutgoingEdges(test.id).filter((e) => e.kind === 'extends' || e.kind === 'implements')).toEqual([]);
  });
});

describe('C++ global names beside Swift and Objective-C (protobuf)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-global-objc-', {
      'objectivec/GPBLegacy.m': `#import <Foundation/Foundation.h>

@interface GPBLegacy : NSObject
- (void)start;
@end

@implementation GPBLegacy
- (void)start {}
@end
`,
      'swift/Bridge.swift': `import Foundation

final class Bridge: NSObject {
  func run() {}
}
`,
      'src/pb/internal.h': PB_INTERNAL,
      'src/message.cc': `#include "pb/internal.h"

int Parse(const void* data) { return ::_pbi::Prefetch(data); }
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('still links a C++ `::_pbi::` call, which no longer rides the Swift ↔ Objective-C bridge’s claim', () => {
    expect(callsFrom(cg, 'src/message.cc', 'Parse')).toEqual(['::_pbi::Prefetch -> pb::internal::Prefetch']);
  });
});
