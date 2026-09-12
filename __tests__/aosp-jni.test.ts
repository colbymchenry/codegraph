/**
 * AOSP extension — find_jni_bridge.
 *
 * Unlike find_aidl_impl, this does NOT reuse `unresolved_refs` (a `native`/
 * `external` declaration is a leaf, not a broken extends/implements clause —
 * there's nothing for the resolver to fail to resolve). The primary signal
 * is reading the declaration directly (CodeGraph's Kotlin/Java extractors
 * don't record the modifier on the node) and pairing it, independently,
 * with a JNI naming-convention match on the C/C++ side and an explicit
 * `RegisterNatives` registration. `found` requires BOTH; a name match alone
 * is `convention_derived_candidate` — the two states must stay distinct
 * (Codex's review, 2026-09-02).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findJniBridge } from '../src/aosp/jni';

describe('AOSP extension: findJniBridge', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-jni-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports "found" when a native declaration, its JNI-convention match, and an explicit RegisterNatives registration all agree', async () => {
    write(
      'src/Foo.kt',
      'package com.example.jni\n\n' + 'class Foo {\n' + '    external fun nativeGreet(): String\n' + '}\n'
    );
    write(
      'src/foo_native.cpp',
      '#include <jni.h>\n\n' +
        'extern "C" JNIEXPORT jstring JNICALL\n' +
        'Java_com_example_jni_Foo_nativeGreet(JNIEnv* env, jobject) {\n' +
        '    return env->NewStringUTF("hi");\n' +
        '}\n\n' +
        'void registerFoo(JNIEnv* env) {\n' +
        '    RegisterNatives(env, Foo, methods, 1);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Foo');

    expect(result.nativeDeclarations).toHaveLength(1);
    expect(result.nativeDeclarations[0]?.methodName).toBe('nativeGreet');
    expect(result.nativeDeclarations[0]?.declarationStyle).toBe('kotlin_external');

    expect(result.registerNativesHits.length).toBeGreaterThan(0);
    expect(result.nativeImplementations).toHaveLength(1);
    expect(result.nativeImplementations[0]?.name).toBe('Java_com_example_jni_Foo_nativeGreet');
    expect(result.status).toBe('found');
  });

  it('reports "found" via a JNINativeMethod registration table even with no Java_pkg_Class_method symbol (real AOSP platform shape)', async () => {
    // AOSP platform JNI almost never uses the Java_pkg_Class_method naming
    // convention the primary signal above searches for; it registers an
    // explicit table of {"javaName", "sig", (void*)nativeFn} entries via
    // RegisterMethodsOrDie/RegisterNatives/jniRegisterNativeMethods (verified
    // against a real frameworks/base core/jni/ checkout, 2026-09-06: 119 of
    // 119 registration sites use this shape, 0 use Java_*). Without reading
    // the table, `found` was structurally unreachable for any real AOSP
    // platform bridge.
    write(
      'src/Baz.java',
      'package com.example.jni;\n\n' +
        'public class Baz {\n' +
        '    native int nativeGetUid(String name);\n' +
        '}\n'
    );
    write(
      'src/baz_native.cpp',
      '#include <jni.h>\n\n' +
        'static jint android_example_Baz_getUid(JNIEnv* env, jobject, jstring name) {\n' +
        '    return 0;\n' +
        '}\n\n' +
        'static const JNINativeMethod gMethods[] = {\n' +
        '    {"nativeGetUid", "(Ljava/lang/String;)I", (void*)android_example_Baz_getUid},\n' +
        '};\n\n' +
        'void register_baz(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/Baz", gMethods, 1);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Baz');

    expect(result.nativeImplementations).toHaveLength(1);
    expect(result.nativeImplementations[0]?.name).toBe('android_example_Baz_getUid');
    expect(result.status).toBe('found');
  });

  it('ignores a JNINativeMethod table entry for a method this class never declared, even in a file that DOES register this class (Codex review finding, 2026-09-06)', async () => {
    write(
      'src/Qux.java',
      'package com.example.jni;\n\n' +
        'public class Qux {\n' +
        '    native int nativeQux();\n' +
        '}\n'
    );
    write(
      'src/qux_native.cpp',
      '#include <jni.h>\n\n' +
        // Real implementation, but for a method Qux never declared: a
        // same-named collision from an unrelated bridge in the same file.
        'static jint some_unrelated_getUid(JNIEnv* env, jobject, jstring name) {\n' +
        '    return 0;\n' +
        '}\n\n' +
        'static const JNINativeMethod gMethods[] = {\n' +
        '    {"nativeGetUid", "(Ljava/lang/String;)I", (void*)some_unrelated_getUid},\n' +
        '};\n\n' +
        'void register_qux(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/Qux", gMethods, 1);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Qux');

    expect(result.nativeImplementations).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not use a same-named entry from an unrelated table for the registered class', async () => {
    write(
      'src/Target.java',
      'package com.example.jni;\n\n' +
        'public class Target {\n' +
        '    native int foo();\n' +
        '}\n'
    );
    write(
      'src/target_native.cpp',
      '#include <jni.h>\n\n' +
        'static jint unrelatedNative(JNIEnv* env, jobject) {\n' +
        '    return 0;\n' +
        '}\n\n' +
        'static const JNINativeMethod unrelatedMethods[] = {\n' +
        '    {"foo", "()I", (void*)unrelatedNative},\n' +
        '};\n\n' +
        'static const JNINativeMethod targetMethods[] = {};\n\n' +
        'void register_target(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/Target", targetMethods, 0);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Target');

    expect(result.nativeImplementations).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not promote a table entry whose native function name has duplicate definitions', async () => {
    write(
      'src/DuplicateTarget.java',
      'package com.example.jni;\n\n' +
        'public class DuplicateTarget {\n' +
        '    native int foo();\n' +
        '}\n'
    );
    write(
      'src/duplicate_target_native.cpp',
      'static jint sharedNative(JNIEnv* env, jobject) { return 0; }\n' +
        'static const JNINativeMethod targetMethods[] = {\n' +
        '    {"foo", "()I", (void*)sharedNative},\n' +
        '};\n' +
        'void register_duplicate_target(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/DuplicateTarget", targetMethods, 1);\n' +
        '}\n'
    );
    write(
      'src/duplicate_other_native.cpp',
      'static jint sharedNative(JNIEnv* env, jobject) { return 1; }\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'DuplicateTarget');

    expect(result.nativeImplementations).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('ignores a JNINativeMethod table entry sitting in a comment (Codex review finding, 2026-09-06)', async () => {
    write(
      'src/Comment.java',
      'package com.example.jni;\n\n' +
        'public class Comment {\n' +
        '    native int nativeGetUid(String name);\n' +
        '}\n'
    );
    write(
      'src/comment_native.cpp',
      '#include <jni.h>\n\n' +
        'static jint android_example_Comment_getUid(JNIEnv* env, jobject, jstring name) {\n' +
        '    return 0;\n' +
        '}\n\n' +
        '// static const JNINativeMethod gMethods[] = {\n' +
        '//     {"nativeGetUid", "(Ljava/lang/String;)I", (void*)android_example_Comment_getUid},\n' +
        '// };\n\n' +
        'void register_comment(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/Comment", gMethods, 1);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Comment');

    expect(result.nativeImplementations).toHaveLength(0);
  });

  it('does not count commented native declarations as JNI declarations', async () => {
    write(
      'src/Commented.java',
      'package com.example.jni;\n\n' +
        'public class Commented {\n' +
        '    // native int ghost();\n' +
        '    /* native int phantom(); */\n' +
        '}\n'
    );
    write(
      'src/commented_native.cpp',
      'static jint ghostNative(JNIEnv* env, jobject) { return 0; }\n' +
        'static const JNINativeMethod methods[] = {\n' +
        '    {"ghost", "()I", (void*)ghostNative},\n' +
        '};\n' +
        'void register_commented(JNIEnv* env) {\n' +
        '    RegisterMethodsOrDie(env, "com/example/jni/Commented", methods, 1);\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Commented');

    expect(result.nativeDeclarations).toHaveLength(0);
    expect(result.status).toBe('no_bridge_found');
  });

  it('reports "no_bridge_found" for a class with no native/external declarations', async () => {
    write('src/Plain.kt', 'package com.example.jni\n\n' + 'class Plain {\n' + '    fun greet(): String = "hi"\n' + '}\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Plain');

    expect(result.status).toBe('no_bridge_found');
    expect(result.nativeDeclarations).toHaveLength(0);
  });

  it('reports "convention_derived_candidate", not "found", when only a name match exists with no RegisterNatives registration', async () => {
    write(
      'src/Bar.kt',
      'package com.example.jni\n\n' + 'class Bar {\n' + '    external fun nativeDoStuff()\n' + '}\n'
    );
    write(
      'src/bar_native.cpp',
      '#include <jni.h>\n\n' +
        'extern "C" JNIEXPORT void JNICALL\n' +
        'Java_com_example_jni_Bar_nativeDoStuff(JNIEnv* env, jobject) {}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'Bar');

    expect(result.registerNativesHits).toHaveLength(0);
    expect(result.nativeImplementations).toHaveLength(1);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "class_not_found" for a class name absent from the index', async () => {
    write('src/Empty.kt', 'package com.example.jni\n\nclass Empty\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    const result = findJniBridge(cg, dir, 'DoesNotExist');
    expect(result.status).toBe('class_not_found');
  });

  // Regression coverage for the 2026-09-04 code review.
  describe('code review fixes (2026-09-04)', () => {
    it('mangles a literal underscore in the package name per the JNI spec (not the previous bare passthrough)', async () => {
      write(
        'src/Qux.kt',
        'package com.example.my_pkg\n\n' + 'class Qux {\n' + '    external fun nativeThing()\n' + '}\n'
      );
      // Real JNI mangling: a literal `_` in an identifier becomes `_1` so it
      // is not confused with the `.` -> `_` package separator. The old
      // jniMangle() left it as a bare `_`, which would have matched THIS
      // symbol name instead: Java_com_example_my_pkg_Qux_nativeThing.
      write(
        'src/qux_native.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_my_1pkg_Qux_nativeThing(JNIEnv* env, jobject) {}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Qux');

      expect(result.nativeImplementations).toHaveLength(1);
      expect(result.nativeImplementations[0]?.name).toBe('Java_com_example_my_1pkg_Qux_nativeThing');
    });

    it('does NOT report "found" when the RegisterNatives hit is in a different file than the native-impl match', async () => {
      write(
        'src/Baz.kt',
        'package com.example.jni\n\n' + 'class Baz {\n' + '    external fun nativeBaz()\n' + '}\n'
      );
      write(
        'src/baz_impl.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_jni_Baz_nativeBaz(JNIEnv* env, jobject) {}\n'
      );
      // A RegisterNatives call mentioning "Baz" in an UNRELATED file (a
      // registration table for a different overload set that happens to
      // share the name) must not corroborate this specific bridge —
      // same-file correlation is the bar for "found" now (the previous
      // version accepted a registration hit anywhere in the repo).
      write(
        'src/unrelated_registrations.cpp',
        'static const JNINativeMethod kBazOtherSubsystemMethods[] = {};\n' +
          'void registerOtherSubsystem(JNIEnv* env) {\n' +
          '    env->RegisterNatives(bazOtherSubsystemClass, kBazOtherSubsystemMethods, 0);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Baz');

      expect(result.nativeImplementations.length).toBeGreaterThan(0);
      expect(result.registerNativesHits.length).toBeGreaterThan(0);
      expect(result.status).toBe('convention_derived_candidate');
    });

    it('matches an overloaded native method via the long-form JNI symbol (short-name-only search used to miss this)', async () => {
      write(
        'src/Ovl.kt',
        'package com.example.jni\n\n' +
          'class Ovl {\n' +
          '    external fun nativeCompute()\n' +
          '}\n'
      );
      // Real javac/JNI emits the long form (short name + `__` + mangled
      // signature) when the native method is overloaded in source; the
      // short-name-only search the previous version used would find nothing
      // here and report no_bridge_found for a real bridge.
      write(
        'src/ovl_native.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_jni_Ovl_nativeCompute__I(JNIEnv* env, jobject, jint) {}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Ovl');

      expect(result.nativeImplementations).toHaveLength(1);
      expect(result.nativeImplementations[0]?.name).toBe('Java_com_example_jni_Ovl_nativeCompute__I');
      expect(result.nativeImplementations[0]?.matchedPattern).toContain('long-form');
    });

    it('reports class_not_found rather than silently substituting a fuzzy match (e.g. a differently-named class)', async () => {
      write('src/FooManager.kt', 'package com.example.jni\n\nclass FooManager\n');
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();

      // "Foo" has no exact match — only the unrelated "FooManager" fuzzy-matches.
      const result = findJniBridge(cg, dir, 'Foo');
      expect(result.status).toBe('class_not_found');
    });

    it('does not throw on a class name containing regex metacharacters (Codex 3rd-pass review, 2026-09-04: the aidl.ts fix had a regression test but jni.ts did not)', async () => {
      write('src/Unrelated.kt', 'package com.example.jni\n\nclass Unrelated\n');
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();

      expect(() => findJniBridge(cg, dir, 'Foo[Bar')).not.toThrow();
      expect(findJniBridge(cg, dir, 'Foo[Bar').status).toBe('class_not_found');
    });
  });

  // Regression coverage for the 2026-09-04 Red Team round-1 finding.
  describe('same-file, different-package same-name class (Red Team round-1, 2026-09-04)', () => {
    it('does NOT report "found" from a RegisterNatives hit whose FindClass(...) argument names an unrelated package\'s same-named class', async () => {
      write(
        'src/Shared.kt',
        'package com.example.a\n\n' + 'class Shared {\n' + '    external fun nativeThing()\n' + '}\n'
      );
      // One .cpp file legitimately implements com.example.a.Shared's native
      // method (so the name-convention match is real), but its ONLY
      // RegisterNatives call actually targets a completely different
      // package's same-named class — the previous version would have
      // accepted this same-file hit as corroboration purely by class name.
      write(
        'src/shared_native.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_a_Shared_nativeThing(JNIEnv* env, jobject) {}\n\n' +
          // grepIndexedSources matches "RegisterNatives.*Shared" on a single
          // LINE (it's a plain text scan, not a lexer) — the class name must
          // be on the RegisterNatives line itself for the existing grep to
          // even produce a hit, which is exactly the FindClass(...)-inline
          // shape this fix targets.
          'void registerOther(JNIEnv* env) {\n' +
          '    env->RegisterNatives(env, env->FindClass("com/example/b/Shared"), kOtherMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Shared');

      expect(result.nativeImplementations.length).toBeGreaterThan(0);
      expect(result.registerNativesHits.length).toBeGreaterThan(0);
      const hit = result.registerNativesHits[0];
      expect(hit?.packageVerified).toBe('mismatch');
      expect(result.status).toBe('convention_derived_candidate');
      expect(result.evidence.some((e) => e.includes('a different package'))).toBe(true);
    });

    it('reports "found" via FindClass(...) verification even when the registration is in a DIFFERENT file than the native-impl match', async () => {
      write(
        'src/Cross.kt',
        'package com.example.jni\n\n' + 'class Cross {\n' + '    external fun nativeGo()\n' + '}\n'
      );
      write(
        'src/cross_impl.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_jni_Cross_nativeGo(JNIEnv* env, jobject) {}\n'
      );
      // The registration lives in a separate registration-table file, a
      // common AOSP shape — but its FindClass(...) argument names the EXACT
      // package+class this bridge is about, which is a stronger, positive
      // signal than same-file correlation and should corroborate regardless
      // of which file it's in.
      write(
        'src/registrations.cpp',
        'void registerAll(JNIEnv* env) {\n' +
          '    jclass clazz = env->FindClass("com/example/jni/Cross");\n' +
          '    env->RegisterNatives(env, clazz, kCrossMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Cross');

      const hit = result.registerNativesHits.find((c) => c.filePath === 'src/registrations.cpp');
      expect(hit?.packageVerified).toBe('verified');
      expect(result.status).toBe('found');
    });

    it('still requires same-file correlation (as before) when a RegisterNatives hit has no nearby FindClass(...) to verify against', async () => {
      write(
        'src/Legacy.kt',
        'package com.example.jni\n\n' + 'class Legacy {\n' + '    external fun nativeOld()\n' + '}\n'
      );
      write(
        'src/legacy_native.cpp',
        '#include <jni.h>\n\n' +
          'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_jni_Legacy_nativeOld(JNIEnv* env, jobject) {}\n\n' +
          '// jclass built elsewhere (e.g. a cached global ref) — nothing for\n' +
          '// the lightweight FindClass(...) scan to verify against.\n' +
          'void registerLegacy(JNIEnv* env, jclass clazz) {\n' +
          '    env->RegisterNatives(env, clazz, kLegacyMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Legacy');

      const hit = result.registerNativesHits[0];
      expect(hit?.packageVerified).toBe('unverifiable');
      expect(result.status).toBe('found');
    });
  });

  describe('round-4 JNI refactor regressions', () => {
    it('matches a native method declared inside a nested Kotlin class using the JNI inner-class mangling', async () => {
      write(
        'src/Outer.kt',
        'package com.example\n\n' +
          'class Outer {\n' +
          '    class Inner {\n' +
          '        external fun nativeFoo()\n' +
          '    }\n' +
          '}\n'
      );
      write(
        'src/outer_native.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_Outer_00024Inner_nativeFoo(JNIEnv* env, jobject) {}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Inner');

      expect(result.nativeImplementations).toHaveLength(1);
      expect(result.nativeImplementations[0]?.name).toBe('Java_com_example_Outer_00024Inner_nativeFoo');
    });

    it('recognizes RegisterMethodsOrDie and jniRegisterNativeMethods wrapper registrations', async () => {
      write(
        'src/Foo.kt',
        'package com.example\n\n' + 'class Foo {\n' + '    external fun nativeFoo()\n' + '}\n'
      );
      write(
        'src/foo_wrapper.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_Foo_nativeFoo(JNIEnv* env, jobject) {}\n\n' +
          'void registerFoo(JNIEnv* env) {\n' +
          '    RegisterMethodsOrDie(env, "com/example/Foo", gMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Foo');

      expect(result.registerNativesHits).toHaveLength(1);
      expect(result.registerNativesHits[0]?.matchedPattern).toContain('RegisterMethodsOrDie');
    });

    it('reports whether a nearby registration table mentions a declared native method', async () => {
      write(
        'src/Mentioned.kt',
        'package com.example\n\n' + 'class Mentioned {\n' + '    external fun nativeA()\n' + '}\n'
      );
      write(
        'src/NotMentioned.kt',
        'package com.example\n\n' + 'class NotMentioned {\n' + '    external fun nativeA()\n' + '}\n'
      );
      write(
        'src/mentioned_methods.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_Mentioned_nativeA(JNIEnv* env, jobject) {}\n' +
          'static JNINativeMethod mentionedMethods[] = {{"nativeA", "()V", nullptr}};\n' +
          'void registerMentioned(JNIEnv* env) {\n' +
          '    RegisterNatives(env, Mentioned, mentionedMethods, 1);\n' +
          '}\n'
      );
      write(
        'src/not_mentioned_methods.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_NotMentioned_nativeA(JNIEnv* env, jobject) {}\n' +
          'static JNINativeMethod otherMethods[] = {{"nativeB", "()V", nullptr}};\n' +
          'void registerNotMentioned(JNIEnv* env) {\n' +
          '    RegisterNatives(env, NotMentioned, otherMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const mentioned = findJniBridge(cg, dir, 'Mentioned');
      const notMentioned = findJniBridge(cg, dir, 'NotMentioned');

      expect(mentioned.registerNativesHits[0]?.methodMentioned).toBe(true);
      expect(notMentioned.registerNativesHits[0]?.methodMentioned).toBe(false);
    });

    it('evaluates same-named classes independently and selects the strongest JNI bridge', async () => {
      write('src/A.Foo.kt', 'package com.example.a\n\nclass Foo\n');
      write(
        'src/B.Foo.kt',
        'package com.example.b\n\n' + 'class Foo {\n' + '    external fun nativeFoo()\n' + '}\n'
      );
      write(
        'src/b_foo_native.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_b_Foo_nativeFoo(JNIEnv* env, jobject) {}\n\n' +
          'void registerFoo(JNIEnv* env) {\n' +
          '    env->RegisterNatives(env, env->FindClass("com/example/b/Foo"), kFooMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Foo');

      expect(result.status).toBe('found');
      expect(result.evidence.some((e) => e.includes('2 class(es) named'))).toBe(true);
      expect(result.evidence.some((e) => e.includes('selected candidate'))).toBe(true);
    });

    it('uses the closest FindClass when verifying a later RegisterNatives call', async () => {
      write(
        'src/Bar.kt',
        'package com.example.b\n\n' + 'class Bar {\n' + '    external fun nativeBar()\n' + '}\n'
      );
      write(
        'src/bar_impl.cpp',
        'extern "C" JNIEXPORT void JNICALL\n' +
          'Java_com_example_b_Bar_nativeBar(JNIEnv* env, jobject) {}\n'
      );
      write(
        'src/registrations.cpp',
        'void registerBoth(JNIEnv* env) {\n' +
          '    jclass foo = env->FindClass("com/example/a/Foo");\n' +
          '    env->RegisterNatives(env, foo, kFooMethods, 1);\n' +
          '    jclass bar = env->FindClass("com/example/b/Bar");\n' +
          '    env->RegisterNatives(env, bar, kBarMethods, 1);\n' +
          '}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findJniBridge(cg, dir, 'Bar');

      const hit = result.registerNativesHits.find((c) => c.filePath === 'src/registrations.cpp');
      expect(hit?.packageVerified).toBe('verified');
    });
  });

  it('keeps the AOSP changelog entry user-facing instead of exposing implementation APIs', () => {
    const changelog = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
    const entries = changelog.split('\n').filter((line) => line.includes('Analyze Android platform code'));

    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      expect(entry).not.toMatch(/JNINativeMethod|ServiceManager\.addService|publishBinderService|Java_pkg_Class_method/);
      expect(entry).not.toContain('Stub-implementation-registration chains');
    }
  });
});
