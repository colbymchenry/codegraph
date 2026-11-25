/**
 * A Java or Kotlin import names a declaration by its qualified name, whichever
 * JVM language declares it. Kotlin calls Java classes through their imports
 * (`JUtil.make()`, `JUtil.Nested.deep()`, `Outer.Inner()`), and Java calls a
 * Kotlin object through `INSTANCE`, a companion through `Companion`, and a
 * Kotlin file's top-level functions through the class named for the file
 * (`UtilsKt.helper()`). Before, the import was matched against a file path
 * with the calling file's own extension, so it never bound across languages:
 * the call went to a same-named class in another package, or nowhere. A
 * Kotlin extension declared in another package is in scope only through an
 * import of it or of its package.
 *
 * Cases from @mixxer's #1948 (and the T5 triage fixtures built on it).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-cross-imports-'));
  const files: Record<string, string> = {
    'p/JUtil.java': `package p;
public class JUtil {
    public static int make() { return 1; }
    public static class Nested { public static int deep() { return 2; } }
}
`,
    'other/JUtil.java': `package other;
public class JUtil {
    public static int make() { return 9; }
    public static class Nested { public static int deep() { return 9; } }
}
`,
    'p/Outer.java': `package p;
public class Outer { public static class Inner { public Inner() {} } }
`,
    'p/Plain.java': `package p;
public class Plain { public static class Nest { void run() {} } }
`,
    'p/KUtil.kt': `package p

object KUtil {
    fun kmake(): Int = 1
}

class KCompanion {
    companion object {
        fun make(): Int = 1
    }
}
`,
    'other/KUtil.kt': `package other

object KUtil {
    fun kmake(): Int = 9
}

class KCompanion {
    companion object {
        fun make(): Int = 9
    }
}
`,
    'p/Utils.kt': `package p

fun helper(): Int = 1
`,
    'other/Utils.kt': `package other

fun helper(): Int = 9
`,
    'p/Modes.kt': `package p

object Modes

fun Modes.shared() {}
`,
    'p/Ext.kt': `package p

fun Modes.extOther() {}
fun Modes.hidden() {}
`,
    'q/FromKotlin.kt': `package q

import p.JUtil
import p.Outer
import p.Plain
import p.Modes
import p.extOther

class FromKotlin {
    fun staticCall() { JUtil.make() }
    fun nestedStatic() { JUtil.Nested.deep() }
    fun javaCtor() { Outer.Inner() }
    fun javaNoCtor() { Plain.Nest() }
    fun importedExtension() { Modes.extOther() }
    fun unimportedExtension() { Modes.hidden() }
    fun besideTypeNotImported() { Modes.shared() }
}
`,
    'q2/Shared.kt': `package q2

import p.Modes
import p.shared

fun useShared() { Modes.shared() }
`,
    'q/FromJava.java': `package q;

import p.KUtil;
import p.KCompanion;
import p.UtilsKt;

public class FromJava {
    void objectCall() { KUtil.INSTANCE.kmake(); }
    void companionCall() { KCompanion.Companion.make(); }
    void topLevelCall() { UtilsKt.helper(); }
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

/** `kind qualified-name` of every call or instantiation `caller` makes. */
function callees(file: string, caller: string): string[] {
  const from = cg.getNodesInFile(file).find((n) => n.name === caller)!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

describe('Kotlin calls a Java class through its import', () => {
  it('reaches the imported package\'s class, not a same-named one elsewhere', () => {
    expect(callees('q/FromKotlin.kt', 'staticCall')).toEqual(['calls p::JUtil::make']);
  });

  it('walks a nested class', () => {
    expect(callees('q/FromKotlin.kt', 'nestedStatic')).toEqual(['calls p::JUtil::Nested::deep']);
  });

  it('builds a nested class through its own constructor, or instantiates one that declares none', () => {
    expect(callees('q/FromKotlin.kt', 'javaCtor')).toEqual(['calls p::Outer::Inner::Inner']);
    expect(callees('q/FromKotlin.kt', 'javaNoCtor')).toEqual(['instantiates p::Plain::Nest']);
  });
});

describe('Java calls Kotlin through its import', () => {
  it('reaches an object\'s member through INSTANCE', () => {
    expect(callees('q/FromJava.java', 'objectCall')).toEqual(['calls p::KUtil::kmake']);
  });

  it('reaches a companion\'s member through Companion', () => {
    expect(callees('q/FromJava.java', 'companionCall')).toEqual(['calls p::KCompanion::make']);
  });

  it('reaches a top-level function through its file\'s class, and the import links that file', () => {
    expect(callees('q/FromJava.java', 'topLevelCall')).toEqual(['calls p::helper']);
    const ids = cg.getNodesInFile('q/FromJava.java').map((n) => n.id);
    const imported = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!)
      .map((n) => (n.kind === 'file' ? `file ${n.filePath}` : `${n.kind} ${n.qualifiedName}`))
      .sort();
    expect(imported).toEqual(['class p::KCompanion', 'class p::KUtil', 'file p/Utils.kt']);
  });
});

describe('A Kotlin extension in another package', () => {
  it('is in scope through an import of it, and otherwise not', () => {
    expect(callees('q/FromKotlin.kt', 'importedExtension')).toEqual(['calls Modes::extOther']);
    expect(callees('q/FromKotlin.kt', 'unimportedExtension')).toEqual([]);
  });

  it('is not in scope through an import of its receiver type alone, even beside that type', () => {
    expect(callees('q/FromKotlin.kt', 'besideTypeNotImported')).toEqual([]);
    expect(callees('q2/Shared.kt', 'useShared')).toEqual(['calls Modes::shared']);
  });
});
