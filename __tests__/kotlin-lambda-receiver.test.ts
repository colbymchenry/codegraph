/**
 * A Kotlin lambda runs on the receiver its function's parameter type names —
 * directly (`Scope.() -> T`) or through a typealias (koin's `definition:
 * Definition<T>` with `typealias Definition<T> = Scope.(ParametersHolder) ->
 * T`) — and the members the code around a bare call reaches come before
 * those only some other lambda type in the project could: koin's
 * `single { C51(get(), get()) }` and `Scope.new(…)`'s `get()` are Scope's,
 * not Koin's (2,190 of them).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-lambda-'));
  const files: Record<string, string> = {
    'src/main/kotlin/org/koin/core/Koin.kt': `package org.koin.core

class Koin {
    fun <T> get(): T = TODO()
}

fun koinTest(block: Koin.() -> Unit) { }
`,
    'src/main/kotlin/org/koin/core/scope/Scope.kt': `package org.koin.core.scope

class Scope {
    fun <T> get(): T = TODO()
}
`,
    'src/main/kotlin/org/koin/core/definition/Definition.kt': `package org.koin.core.definition

import org.koin.core.scope.Scope

typealias Definition<T> = Scope.(Int) -> T
`,
    'src/main/kotlin/org/koin/core/module/Module.kt': `package org.koin.core.module

import org.koin.core.definition.Definition

class Module {
    fun <T> single(definition: Definition<T>) { }
}
`,
    'src/main/kotlin/org/koin/dsl/New.kt': `package org.koin.dsl

import org.koin.core.scope.Scope

inline fun <reified R, reified T1, reified T2> Scope.new(
    constructor: (T1, T2) -> R,
): R = constructor(get(), get())
`,
    'src/test/kotlin/app/Perfs.kt': `package app

import org.koin.core.module.Module

class C51(a: Int, b: Int)

fun perfModule(m: Module) {
    m.single { C51(get(), get()) }
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

const getTargets = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return [...new Set(cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'get').map((t) => t.qualifiedName))];
};

describe('Kotlin lambda receivers', () => {
  it('a lambda passed through a typealiased function type runs on its receiver', () => {
    expect(getTargets('src/test/kotlin/app/Perfs.kt')).toEqual(['org.koin.core.scope::Scope::get']);
  });

  it('an extension function’s receiver beats a lambda type elsewhere', () => {
    expect(getTargets('src/main/kotlin/org/koin/dsl/New.kt')).toEqual(['org.koin.core.scope::Scope::get']);
  });
});
