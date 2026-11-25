/**
 * A C or C++ file is part of every translation unit that includes it, whatever
 * its name says. protobuf's conformance framework lives in
 * `conformance/conformance_test.h` / `.cc` (`ConformanceTestSuite`) and
 * `conformance/test_runner.h`, named like test suites, and the suites and
 * runners that use it include them: `suite_.ReportFailure(…)` in
 * binary_json_conformance_suite.cc is `ConformanceTestSuite::ReportFailure`.
 * The test-suite rule ("production code never names a test suite's symbol")
 * dropped that edge. A test-named file no production file includes stays out
 * of reach, and so does a test that only includes the header it tests.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-included-test-'));
  const files: Record<string, string> = {
    'conformance/test_runner.h': `#ifndef CONFORMANCE_TEST_RUNNER_H
#define CONFORMANCE_TEST_RUNNER_H

#include <string>

namespace conformance {

class ConformanceTestRunner {
 public:
  virtual ~ConformanceTestRunner() = default;
  virtual void RunTest(const std::string& test_name, const std::string& input, std::string* output) = 0;
};

}  // namespace conformance

#endif
`,
    'conformance/conformance_test.h': `#ifndef CONFORMANCE_CONFORMANCE_TEST_H
#define CONFORMANCE_CONFORMANCE_TEST_H

#include <string>

#include "conformance/test_runner.h"

namespace conformance {

class ConformanceTestSuite {
 public:
  virtual ~ConformanceTestSuite() = default;
  bool RunSuite(ConformanceTestRunner* runner, std::string* output);
  void ReportFailure(int test, int level);

 protected:
  virtual void RunSuiteImpl() = 0;
  int failures_ = 0;
};

int FailureCount(const ConformanceTestSuite& suite);

}  // namespace conformance

#endif
`,
    'conformance/conformance_test.cc': `#include "conformance/conformance_test.h"

namespace conformance {

bool ConformanceTestSuite::RunSuite(ConformanceTestRunner* runner, std::string* output) {
  RunSuiteImpl();
  return failures_ == 0;
}

void ConformanceTestSuite::ReportFailure(int test, int level) {
  failures_ += test + level;
}

int FailureCount(const ConformanceTestSuite& suite) {
  return 0;
}

}  // namespace conformance
`,
    // Another class's ReportFailure: where the call went by guess before.
    'conformance/fork_pipe_runner.h': `#include <string>

#include "conformance/test_runner.h"

namespace conformance {

class ForkPipeRunner : public ConformanceTestRunner {
 public:
  void RunTest(const std::string& test_name, const std::string& input, std::string* output) override;

 private:
  std::string ReportFailure(bool timed_out, const std::string& what_failed);
};

}  // namespace conformance
`,
    'conformance/fork_pipe_runner.cc': `#include "conformance/fork_pipe_runner.h"

namespace conformance {

void ForkPipeRunner::RunTest(const std::string& test_name, const std::string& input, std::string* output) {
  *output = ReportFailure(false, test_name);
}

std::string ForkPipeRunner::ReportFailure(bool timed_out, const std::string& what_failed) {
  return what_failed;
}

}  // namespace conformance
`,
    'conformance/binary_json_conformance_suite.h': `#include "conformance/conformance_test.h"

namespace conformance {

class BinaryAndJsonConformanceSuite : public ConformanceTestSuite {
 private:
  void RunSuiteImpl() override;
};

class BinaryAndJsonConformanceSuiteImpl {
 public:
  explicit BinaryAndJsonConformanceSuiteImpl(BinaryAndJsonConformanceSuite* suite);
  void RunValidBinaryInputTest(int test);

 private:
  BinaryAndJsonConformanceSuite& suite_;
};

}  // namespace conformance
`,
    'conformance/binary_json_conformance_suite.cc': `#include "conformance/binary_json_conformance_suite.h"

namespace conformance {

void BinaryAndJsonConformanceSuite::RunSuiteImpl() {
  BinaryAndJsonConformanceSuiteImpl impl(this);
  impl.RunValidBinaryInputTest(1);
}

void BinaryAndJsonConformanceSuiteImpl::RunValidBinaryInputTest(int test) {
  suite_.ReportFailure(test, 0);
}

}  // namespace conformance
`,
    'conformance/conformance_test_main.cc': `#include "conformance/binary_json_conformance_suite.h"
#include "conformance/conformance_test.h"

int RunConformance(const conformance::BinaryAndJsonConformanceSuite& suite) {
  return FailureCount(suite);
}
`,
    // Production code that does not include conformance_test.h.
    'tools/report.cc': `int Summarize(int suite) {
  return FailureCount(suite);
}
`,
    // A C test-named file a production file includes (redis' expr.c includes
    // fastjson_test.c for its test build).
    'modules/fastjson_test.c': `int run_fastjson_test(void) {
  return 0;
}
`,
    'modules/expr.c': `#include "fastjson_test.c"

int expr_selftest(void) {
  return run_fastjson_test();
}
`,
    // A real test suite nothing includes: its helper is not production's.
    'src/db.h': `int open_db(void);
`,
    'src/db.c': `#include "db.h"

int open_db(void) {
  return make_options();
}
`,
    'src/db_test.c': `#include "db.h"

int make_options(void) {
  return 1;
}
`,
    // A test that includes the header it tests, named like it, does not
    // implement it: jemalloc's test/unit/hash.c and its hash.h.
    'include/hash.h': `unsigned hash(const char* key);
`,
    'src/hash.c': `#include "hash.h"

unsigned hash(const char* key) {
  return hash_selftest();
}
`,
    'test/unit/hash.c': `#include "hash.h"

unsigned hash_selftest(void) {
  return hash("abc");
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

describe('a C/C++ file named like a test that the program includes', () => {
  it('links a call through the base class its suite derives from', () => {
    const calls = callsFrom('conformance/binary_json_conformance_suite.cc');
    expect(calls).toContain('conformance::ConformanceTestSuite::ReportFailure (conformance/conformance_test.cc)');
    expect(calls).not.toContain('conformance::ForkPipeRunner::ReportFailure (conformance/fork_pipe_runner.cc)');
  });

  it('links a free function the included header declares', () => {
    expect(callsFrom('conformance/conformance_test_main.cc')).toContain('conformance::FailureCount (conformance/conformance_test.cc)');
  });

  it('links a test-named source file that a production file includes', () => {
    expect(callsFrom('modules/expr.c')).toContain('run_fastjson_test (modules/fastjson_test.c)');
  });

  it('keeps it out of reach of a file that does not include it', () => {
    expect(callsFrom('tools/report.cc').some((c) => c.includes('conformance_test.cc'))).toBe(false);
  });
});

describe('a C/C++ test suite nothing in the program includes', () => {
  it('is still out of reach of production code', () => {
    expect(callsFrom('src/db.c').some((c) => c.includes('src/db_test.c'))).toBe(false);
  });

  it('does not implement the production header it includes to test', () => {
    expect(callsFrom('src/hash.c').some((c) => c.includes('test/unit/hash.c'))).toBe(false);
    // The test still reaches the code it tests.
    expect(callsFrom('test/unit/hash.c')).toContain('hash (src/hash.c)');
  });
});
