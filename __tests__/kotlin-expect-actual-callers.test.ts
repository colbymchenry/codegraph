/**
 * A Kotlin Multiplatform `expect` and its `actual`s share one qualified name, so
 * a reference through an import had to choose, and the nearest declaration with
 * the `expect` on a tie suits only common code (#3033). What a caller reaches is
 * what its compilation sees: common code the `expect`; a platform's source sets
 * that platform's `actual`, or one of a target they build on; Java, and a plain
 * Kotlin module, JVM bytecode, in which no `expect` exists and no `iosMain` lives.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const CALLER = (pkg: string, fn: string): string => `package ${pkg}\n\nimport a.Util\n\nfun ${fn}() = Util.go()\n`;

const FILES: Record<string, string> = {
  'lib/src/commonMain/kotlin/a/Util.kt': 'package a\n\nexpect object Util {\n    fun go()\n}\n',
  'lib/src/androidMain/kotlin/a/Util.kt': 'package a\n\nactual object Util {\n    @JvmStatic\n    actual fun go() {}\n}\n',
  'lib/src/iosMain/kotlin/a/Util.kt': 'package a\n\nactual object Util {\n    actual fun go() {}\n}\n',
  // timber's shape: a class with a nested type and a companion.
  'lib/src/commonMain/kotlin/t/Timber.kt': 'package t\n\nexpect class Timber {\n    class Tree\n    companion object {\n        fun plant(tree: Tree)\n    }\n}\n',
  'lib/src/androidMain/kotlin/t/Timber.kt': 'package t\n\nactual class Timber {\n    actual class Tree\n    actual companion object {\n        @JvmStatic\n        actual fun plant(tree: Tree) {}\n    }\n}\n',
  // Only one target that isn't the JVM has an `actual`.
  'lib/src/commonMain/kotlin/n/OnlyNative.kt': 'package n\n\nexpect object OnlyNative {\n    fun go()\n}\n',
  'lib/src/iosMain/kotlin/n/OnlyNative.kt': 'package n\n\nactual object OnlyNative {\n    actual fun go() {}\n}\n',
  // okhttp's shape: an intermediate source set declares the `expect`, and two JVM targets have an `actual`.
  'lib/src/commonJvmAndroid/kotlin/s/Version.kt': 'package s\n\nexpect object Version {\n    fun name(): String\n}\n',
  'lib/src/androidMain/kotlin/s/Version.android.kt': 'package s\n\nactual object Version {\n    actual fun name() = "android"\n}\n',
  'lib/src/jvmMain/kotlin/s/Version.jvm.kt': 'package s\n\nactual object Version {\n    actual fun name() = "jvm"\n}\n',
  'samples/survey/src/main/kotlin/e/Clients.kt': 'package e\n\nimport s.Version\n\nfun jvmSample() = Version.name()\n',
  'android-test/src/main/kotlin/e/Screen.kt': 'package e\n\nimport s.Version\n\nfun androidApp() = Version.name()\n',
  'lib/src/commonJvmAndroid/kotlin/e/Shared.kt': 'package e\n\nimport s.Version\n\nfun sharedCode() = Version.name()\n',
  'app/src/main/java/b/App.java': 'package b;\n\nimport a.Util;\nimport t.Timber;\n\nclass App {\n    void run() { Util.go(); }\n    void grow() { Timber.plant(new Timber.Tree()); }\n}\n\nclass Log extends Timber.Tree {\n}\n',
  'app/src/main/java/b/Native.java': 'package b;\n\nimport n.OnlyNative;\n\nclass Native {\n    void run() { OnlyNative.go(); }\n}\n',
  'app/src/main/kotlin/d/Plain.kt': CALLER('d', 'plainModule'),
  'lib/src/commonMain/kotlin/c/Common.kt': CALLER('c', 'inCommonMain'),
  'lib/src/commonTest/kotlin/c/CommonTest.kt': CALLER('c', 'inCommonTest'),
  'lib/src/androidMain/kotlin/c/Android.kt': CALLER('c', 'inAndroidMain'),
  'lib/src/androidUnitTest/kotlin/c/AndroidTest.kt': CALLER('c', 'inAndroidUnitTest'),
  'lib/src/iosMain/kotlin/c/Ios.kt': CALLER('c', 'inIosMain'),
  'lib/src/iosArm64Main/kotlin/c/Arm.kt': CALLER('c', 'inIosArm64Main'),
  'lib/src/nativeMain/kotlin/c/Native.kt': CALLER('c', 'inNativeMain'),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kmp-callers-'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The files a function or method calls `callee` in. */
function callsFrom(name: string, callee: string): string[] {
  const from = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find((n) => n.name === name);
  expect(from, name).toBeDefined();
  return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
    .filter((n) => n.name === callee).map((n) => n.filePath).sort();
}

const COMMON = 'lib/src/commonMain/kotlin/a/Util.kt';
const ANDROID = 'lib/src/androidMain/kotlin/a/Util.kt';
const IOS = 'lib/src/iosMain/kotlin/a/Util.kt';

describe('a Kotlin Multiplatform import reaches what the caller compiles against (#3033)', () => {
  it('takes a Java call to the JVM `actual`', () => {
    expect(callsFrom('run', 'go')).toContain(ANDROID);
    expect(callsFrom('run', 'go')).not.toContain(COMMON);
    expect(callsFrom('grow', 'plant')).toEqual(['lib/src/androidMain/kotlin/t/Timber.kt']);
  });

  it('takes a Java `extends` through the type to the `actual`\'s nested type', () => {
    const log = cg.getNodesByKind('class').find((n) => n.name === 'Log')!;
    const supers = cg.getOutgoingEdges(log.id).filter((e) => e.kind === 'extends').map((e) => cg.getNode(e.target)!);
    expect(supers.map((n) => `${n.name} ${n.filePath}`)).toEqual(['Tree lib/src/androidMain/kotlin/t/Timber.kt']);
  });

  it('takes the import of a Java file to the `actual` as well', () => {
    const imported = cg.getNodesInFile('app/src/main/java/b/App.java').find((n) => n.kind === 'namespace')!;
    const targets = cg.getOutgoingEdges(imported.id).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)!);
    expect(targets.map((n) => n.filePath).sort()).toEqual([ANDROID, 'lib/src/androidMain/kotlin/t/Timber.kt']);
  });

  it('takes Java to the one `actual` there is, when no JVM target has one', () => {
    const native = cg.getNodesInFile('app/src/main/java/b/Native.java').find((n) => n.name === 'run')!;
    const targets = cg.getOutgoingEdges(native.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).toContain('lib/src/iosMain/kotlin/n/OnlyNative.kt');
  });

  it('takes a plain Kotlin module to the JVM `actual`', () => {
    expect(callsFrom('plainModule', 'go')).toEqual([ANDROID]);
  });

  it('keeps common code on the `expect`', () => {
    expect(callsFrom('inCommonMain', 'go')).toEqual([COMMON]);
    expect(callsFrom('inCommonTest', 'go')).toEqual([COMMON]);
  });

  it('takes a platform\'s source sets to that platform\'s `actual`', () => {
    expect(callsFrom('inAndroidMain', 'go')).toEqual([ANDROID]);
    expect(callsFrom('inAndroidUnitTest', 'go')).toEqual([ANDROID]);
    expect(callsFrom('inIosMain', 'go')).toEqual([IOS]);
  });

  it('takes a plain module to the JVM target its path names, and Android only by name', () => {
    expect(callsFrom('jvmSample', 'name')).toEqual(['lib/src/jvmMain/kotlin/s/Version.jvm.kt']);
    expect(callsFrom('androidApp', 'name')).toEqual(['lib/src/androidMain/kotlin/s/Version.android.kt']);
  });

  it('keeps a common source set of another name on the `expect`', () => {
    expect(callsFrom('sharedCode', 'name')).toEqual(['lib/src/commonJvmAndroid/kotlin/s/Version.kt']);
  });

  it('takes a target to the `actual` of a target it builds on, and an intermediate set to the `expect`', () => {
    expect(callsFrom('inIosArm64Main', 'go')).toEqual([IOS]);
    expect(callsFrom('inNativeMain', 'go')).toEqual([COMMON]);
  });
});
