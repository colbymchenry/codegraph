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
import { isTestFile } from '../src/search/query-utils';

describe('isTestFile', () => {
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
