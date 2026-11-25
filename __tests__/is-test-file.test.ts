/**
 * isTestFile heuristic — test-file detection used to deprioritize test code in
 * search/explore ranking.
 *
 * Regression coverage for the cold-query fix: the heuristic previously only
 * knew Java/JS/Python conventions, so Kotlin (`*Test.kt`, `jvmTest/`), Swift
 * (`*Tests.swift`), and camelCase test source-set dirs slipped through — which
 * let OkHttp's tests flood `codegraph_explore` results on a plain-language
 * query. The false-positive guards matter just as much: `latest.kt` /
 * `manifest.kt` / a `RealCall.kt` production file must NOT be flagged.
 */
import { describe, it, expect } from 'vitest';
import { isTestFile, isTestPath } from '../src/search/query-utils';

describe('isTestFile', () => {
  it('flags test-support modules and doubles by directory name', () => {
    expect(isTestFile('core/data-test/src/main/kotlin/com/example/FakeUserDataRepository.kt')).toBe(true);
    expect(isTestFile('core/datastore-test/src/main/kotlin/com/example/InMemoryDataStore.kt')).toBe(true);
    expect(isTestFile('core/testing/src/main/kotlin/com/example/TestUserDataRepository.kt')).toBe(true);
    expect(isTestFile('pkg/testdata/fixture.go')).toBe(true);
    expect(isTestFile('src/__mocks__/api.ts')).toBe(true);
    expect(isTestFile('internal/testutil/helpers.go')).toBe(true);
  });

  it('does NOT flag production code whose package path runs through a samples or examples segment', () => {
    // Only the project layout above `src/` decides; the package path below it never does.
    expect(isTestFile('core/data/src/main/kotlin/com/google/samples/apps/nowinandroid/core/data/SyncUtilities.kt')).toBe(false);
    expect(isTestFile('feature/foryou/impl/src/main/kotlin/com/google/samples/apps/ForYouViewModel.kt')).toBe(false);
    expect(isTestFile('src/samples/demo.ts')).toBe(false);
    // …while a real examples folder in the layout still counts.
    expect(isTestFile('examples/basic/src/index.ts')).toBe(true);
    expect(isTestFile('packages/x/examples/basic.ts')).toBe(true);
    expect(isTestFile('benchmarks/run.py')).toBe(true);
  });

  it('flags Kotlin test files and source sets', () => {
    expect(isTestFile('okhttp/src/jvmTest/kotlin/okhttp3/CallTest.kt')).toBe(true);
    expect(isTestFile('okhttp/src/commonTest/kotlin/okhttp3/CompressionInterceptorTest.kt')).toBe(true);
    expect(isTestFile('app/src/androidTest/java/com/example/FooTest.kt')).toBe(true);
    expect(isTestFile('module/src/integrationTest/kotlin/BarSpec.kt')).toBe(true);
  });

  it('flags Swift test files', () => {
    expect(isTestFile('Tests/SessionTests.swift')).toBe(true);
    expect(isTestFile('Sources/FooTest.swift')).toBe(true);
  });

  it('still flags the previously-supported conventions', () => {
    expect(isTestFile('foo/test_bar.py')).toBe(true);
    expect(isTestFile('pkg/bar_test.go')).toBe(true);
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.ts')).toBe(true);
    expect(isTestFile('com/example/FooTest.java')).toBe(true);
    expect(isTestFile('com/example/FooTestCase.java')).toBe(true);
    expect(isTestFile('project/__tests__/foo.ts')).toBe(true);
    expect(isTestFile('project/tests/foo.rb')).toBe(true);
  });

  it("flags Google's unittest-named files as tests", () => {
    // protobuf's 62 and Chromium's: `wire_format_unittest.cc` is a suite, not
    // the code it tests, even with no `test/` directory above it.
    for (const suite of [
      'src/google/protobuf/wire_format_unittest.cc',
      'src/google/protobuf/wire_format_unittest.h',
      'src/compiler/register-allocator-unittest.cpp',
      'lib/parser.unittest.js',
      'tools/run_all_unittests.cc',
      'build/android/pylib/device_unittest.py',
    ]) {
      expect(isTestPath(suite), suite).toBe(true);
      expect(isTestFile(suite), suite).toBe(true);
    }
  });

  it('does NOT flag a file merely named unittest', () => {
    // promtool's `unittest.go` is the code that runs rule tests, and
    // CPython's `unittest` package is the framework itself.
    expect(isTestPath('cmd/promtool/unittest.go')).toBe(false);
    expect(isTestPath('Lib/unittest/case.py')).toBe(false);
    expect(isTestFile('cmd/promtool/unittest.go')).toBe(false);
  });

  it('flags everything in a unittests/ or foo_unittest/ directory', () => {
    // LLVM's and Breakpad's unit-test trees hold helpers with no test-like
    // name, and glog builds each `*_unittest/` directory as a test program.
    for (const file of [
      'llvm/unittests/ADT/CountCopyAndMove.h',
      'unittests/ADT/FoldingSet.cpp',
      'clang-tools-extra/clangd/unittests/Annotations.cpp',
      'src/client/windows/unittests/dump_analysis.cc',
      'src/dcheck_unittest/glog_dcheck.cc',
      'src/includes_unittest/glog_includes_logging.cc',
      'tools/net-unittests/fake_socket.py',
    ]) {
      expect(isTestPath(file), file).toBe(true);
      expect(isTestFile(file), file).toBe(true);
    }
  });

  it('does NOT flag a bare unittest/ directory', () => {
    // CPython's `Lib/unittest/` is the framework, and so is the googletest LLVM
    // vendors under `third-party/unittest/`; `unittest2` is the framework's backport.
    for (const file of [
      'Lib/unittest/mock.py',
      'Lib/unittest/__init__.py',
      'third-party/unittest/googletest/src/gtest.cc',
      'unittest2/case.py',
    ]) {
      expect(isTestPath(file), file).toBe(false);
      expect(isTestFile(file), file).toBe(false);
    }
  });

  it('does NOT flag production files that merely contain "test" lowercase', () => {
    // The fix is capital-led so camelCase boundaries distinguish these.
    expect(isTestFile('src/latest/loader.kt')).toBe(false);
    expect(isTestFile('lib/manifest.kt')).toBe(false);
    expect(isTestFile('okhttp/src/jvmMain/kotlin/okhttp3/internal/connection/RealCall.kt')).toBe(false);
    expect(isTestFile('src/contestEntry.ts')).toBe(false);
    expect(isTestFile('pkg/greatest.go')).toBe(false);
  });

  it('does NOT flag ordinary production source', () => {
    expect(isTestFile('src/flask/app.py')).toBe(false);
    expect(isTestFile('src/vs/workbench/api/common/extensionHostMain.ts')).toBe(false);
    expect(isTestFile('okhttp/src/commonJvmAndroid/kotlin/okhttp3/OkHttpClient.kt')).toBe(false);
  });
});
