/**
 * A C or C++ test is a program of its own, so a name it uses is one its
 * translation unit declares. Of several same-named candidates, a test suite
 * the test does not include is not one of them (protobuf's csharp generator
 * tests called `TestSourceDir()`, which googletest.h declares, and
 * test_util2.h's `TestUtil::TestSourceDir`, included by none of them, took
 * the calls), and what the unit includes goes before what it doesn't (a test
 * of the hpb backend calls upb's `upb_Arena_New()` from upb/mem/arena.h, not
 * the copies php-upb.h and ruby-upb.h bundle; rocksdb's histogram test sleeps
 * on a `SystemClock`, not on emulated_clock.h's `EmulatedSystemClock`). A
 * test whose includes don't resolve (jemalloc's tests include a generated
 * header) keeps the one candidate there is, and a definition in the test's
 * own file still comes first (#1079).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-test-tu-'));
  const files: Record<string, string> = {
    // googletest.h declares TestSourceDir(); googletest.cc defines it.
    'src/google/protobuf/testing/googletest.h': `#ifndef GOOGLE_PROTOBUF_TESTING_GOOGLETEST_H__
#define GOOGLE_PROTOBUF_TESTING_GOOGLETEST_H__

#include <string>

namespace google {
namespace protobuf {

std::string TestSourceDir();

}  // namespace protobuf
}  // namespace google

#endif
`,
    'src/google/protobuf/testing/googletest.cc': `#include "google/protobuf/testing/googletest.h"

namespace google {
namespace protobuf {

std::string TestSourceDir() { return "src"; }

}  // namespace protobuf
}  // namespace google
`,
    // A test suite's header no csharp test includes.
    'src/google/protobuf/test_util2.h': `#ifndef GOOGLE_PROTOBUF_TEST_UTIL2_H__
#define GOOGLE_PROTOBUF_TEST_UTIL2_H__

#include <string>

namespace google {
namespace protobuf {
namespace TestUtil {

inline std::string TestSourceDir() { return "src/google/protobuf"; }

}  // namespace TestUtil
}  // namespace protobuf
}  // namespace google

#endif
`,
    'src/google/protobuf/compiler/csharp/csharp_bootstrap_unittest.cc': `#include <string>

#include "google/protobuf/testing/googletest.h"

namespace google {
namespace protobuf {
namespace compiler {
namespace csharp {

int GeneratedDescriptorsAreUpToDate() {
  std::string dir = TestSourceDir();
  return static_cast<int>(dir.size());
}

}  // namespace csharp
}  // namespace compiler
}  // namespace protobuf
}  // namespace google
`,
    // A receiver whose type isn't read is guessed by its name, among the
    // classes the test includes: rocksdb's histogram test sleeps on its
    // clock, which no emulated_clock.h include of its declares.
    'include/rocksdb/system_clock.h': `namespace rocksdb {

class SystemClock {
 public:
  virtual ~SystemClock() {}
  virtual void SleepForMicroseconds(int micros) = 0;
};

class SystemClockWrapper : public SystemClock {
 public:
  void SleepForMicroseconds(int micros) override { target_->SleepForMicroseconds(micros); }

 private:
  SystemClock* target_;
};

}  // namespace rocksdb
`,
    'env/emulated_clock.h': `#include "rocksdb/system_clock.h"

namespace rocksdb {

class EmulatedSystemClock : public SystemClockWrapper {
 public:
  void SleepForMicroseconds(int micros) override {}
};

}  // namespace rocksdb
`,
    'test_util/mock_time_env.h': `#include <memory>

#include "rocksdb/system_clock.h"

namespace rocksdb {

class MockSystemClock : public SystemClockWrapper {
 public:
  void MockSleepForMicroseconds(int micros) {}
};

}  // namespace rocksdb
`,
    'monitoring/histogram_test.cc': `#include <memory>

#include "rocksdb/system_clock.h"
#include "test_util/mock_time_env.h"

namespace rocksdb {

namespace {
std::shared_ptr<MockSystemClock> clock = std::make_shared<MockSystemClock>();
}  // namespace

void PopulateHistogram(int low, int high) {
  for (int i = low; i <= high; i++) {
    clock->SleepForMicroseconds(i);
  }
}

}  // namespace rocksdb
`,
    // A test that declares the class it calls on: its own file comes first,
    // whatever it includes (#1079).
    'src/util/collector.h': `#include <string>

class Collector {
 public:
  std::string last_error() const { return error_; }

 private:
  std::string error_;
};
`,
    // upb's arena, and the copy a bundled amalgamation carries.
    'php/ext/google/protobuf/php-upb.h': `typedef struct upb_Arena upb_Arena;

static inline upb_Arena* upb_Arena_New(void) { return 0; }
`,
    'upb/mem/arena.h': `typedef struct upb_Arena upb_Arena;

static inline upb_Arena* upb_Arena_New(void) { return 0; }
`,
    'hpb/backend/upb/interop_test.cc': `#include "upb/mem/arena.h"

int ArenaInterop() {
  upb_Arena* arena = upb_Arena_New();
  return arena == 0;
}
`,
    'src/util/own_collector_unittest.cc': `#include "util/collector.h"

namespace {
class Collector {
 public:
  int last_error() const { return 0; }
};
}  // namespace

int OwnCollector() {
  Collector collector;
  return collector.last_error();
}
`,
    // jemalloc's tests include a header the build generates, so nothing
    // shows the test includes its helpers: the one helper there is stays.
    'deps/jemalloc/test/src/SFMT.c': `unsigned gen_rand32(void* ctx) {
  return 4;
}
`,
    'deps/jemalloc/test/unit/SFMT.c': `#include "test/jemalloc_test.h"

unsigned test_gen_rand32(void* ctx) {
  return gen_rand32(ctx);
}
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

describe('a C/C++ test links what its translation unit declares', () => {
  it('passes over a test suite it does not include for the declaration it does', () => {
    const calls = callsFrom('src/google/protobuf/compiler/csharp/csharp_bootstrap_unittest.cc');
    expect(calls).toContain('google::protobuf::TestSourceDir (src/google/protobuf/testing/googletest.cc)');
    expect(calls.some((c) => c.includes('test_util2.h'))).toBe(false);
  });

  it('guesses a receiver among the classes its includes declare', () => {
    const calls = callsFrom('monitoring/histogram_test.cc');
    expect(calls).toContain('rocksdb::SystemClock::SleepForMicroseconds (include/rocksdb/system_clock.h)');
    expect(calls.some((c) => c.includes('emulated_clock.h'))).toBe(false);
  });

  it('calls the copy of a function its includes declare', () => {
    expect(callsFrom('hpb/backend/upb/interop_test.cc')).toContain('upb_Arena_New (upb/mem/arena.h)');
  });

  it('still prefers a declaration in the test file itself', () => {
    const calls = callsFrom('src/util/own_collector_unittest.cc');
    expect(calls.some((c) => c.endsWith('(src/util/own_collector_unittest.cc)') && c.includes('last_error'))).toBe(true);
    expect(calls.some((c) => c.includes('(src/util/collector.h)'))).toBe(false);
  });

  it('keeps the only candidate when its includes do not show the unit', () => {
    expect(callsFrom('deps/jemalloc/test/unit/SFMT.c')).toContain('gen_rand32 (deps/jemalloc/test/src/SFMT.c)');
  });
});
