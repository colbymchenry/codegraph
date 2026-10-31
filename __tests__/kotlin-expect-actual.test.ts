/**
 * A call into a Kotlin Multiplatform object reaches the `actual` the caller
 * can see, never the commonMain `expect` (#3033): an `expect` declaration
 * compiles to nothing in JVM bytecode, so a Java caller — and a Kotlin caller
 * in a platform source set — can only reach the platform `actual`, the one in
 * the caller's own source set when there is one. A commonMain caller compiles
 * against the `expect`, and keeps it. The import's declaration is whatever
 * the platform artifact provides: timber's Java sample calling
 * `Timber.plant(...)` reaches the `androidMain` actual, and `extends
 * Timber.Tree` the actual's nested type.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kmp-expect-actual-'));
  const write = (rel: string, source: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), source);
  };
  write('lib/src/commonMain/kotlin/a/Util.kt', `package a

expect object Util {
    fun go()
}
`);
  write('lib/src/androidMain/kotlin/a/Util.kt', `package a

actual object Util {
    @JvmStatic
    actual fun go() { println("android") }
}
`);
  write('lib/src/commonMain/kotlin/t/Timber.kt', `package t

expect class Timber {
    class Tree
    companion object {
        fun plant(tree: Tree)
    }
}
`);
  write('lib/src/androidMain/kotlin/t/Timber.kt', `package t

actual class Timber {
    actual class Tree {
        fun uproot(): Int = 1
    }
    actual companion object {
        @JvmStatic
        actual fun plant(tree: Tree) {}
    }
}
`);
  // A Java caller in an app module: the issue's repro, and timber's shape.
  write('app/src/main/java/b/App.java', `package b;
import a.Util;
import t.Timber;
class App {
    void run() { Util.go(); }
    void grow() { Timber.plant(new Timber.Tree()); }
}

class Log extends Timber.Tree { }
}
`);
  // A Kotlin caller in a platform source set, another package, through the import.
  write('lib/src/androidMain/kotlin/c/Caller.kt', `package c

import a.Util

fun callUtil() = Util.go()
`);
  // A commonMain Kotlin caller: only the expect is in its compile's sight.
  write('lib/src/commonMain/kotlin/c/CommonCaller.kt', `package c

import a.Util

fun callCommon() = Util.go()
`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg.close();
  fs.rmSync(root, { recursive: true, force: true });
});


/** The `go`/`plant`/`Tree` targets one caller's edges land on, by file. */
function targetsOf(name: string, member: string): string[] {
  const fn = cg.getNodesByKind('function').find((n) => n.name === name) ??
    cg.getNodesByKind('method').find((n) => n.name === name)!;
  expect(fn, `${name} should be in the index`).toBeDefined();
  return cg
    .getOutgoingEdges(fn.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references' || e.kind === 'instantiates')
    .map((e) => cg.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n && n.name === member)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

describe('a Kotlin Multiplatform import reaches the actual the caller sees (#3033)', () => {
  it("the issue's repro: a Java caller's `Util.go()` reaches the androidMain actual", () => {
    expect(targetsOf('run', 'go')).toEqual(['method:go@lib/src/androidMain/kotlin/a/Util.kt']);
  });

  it("timber's shape: a Java caller's `Timber.plant` reaches the actual's companion method", () => {
    expect(targetsOf('grow', 'plant')).toEqual(['method:plant@lib/src/androidMain/kotlin/t/Timber.kt']);
  });

  it("the issue's `extends Timber.Tree` reaches the actual's nested type", () => {
    const log = cg.getNodesByKind('class').find((n) => n.name === 'Log')!;
    expect(log, 'Log should be in the index').toBeDefined();
    const tree = cg
      .getOutgoingEdges(log.id)
      .filter((e) => e.kind === 'extends')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => `${n.kind}:${n.name}@${n.filePath}`);
    expect(tree).toEqual(['class:Tree@lib/src/androidMain/kotlin/t/Timber.kt']);
  });

  it('a Kotlin caller in a platform source set reaches the actual in its own source set', () => {
    expect(targetsOf('callUtil', 'go')).toEqual(['method:go@lib/src/androidMain/kotlin/a/Util.kt']);
  });

  it('a commonMain caller keeps the expect its compile sees', () => {
    expect(targetsOf('callCommon', 'go')).toEqual(['method:go@lib/src/commonMain/kotlin/a/Util.kt']);
  });
});
