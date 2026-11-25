/**
 * A bare Kotlin call reaches a member of a type around it — a class, an
 * anonymous `object : Base()`, an extension function's receiver — or of what
 * those inherit; a member of a type the project's function types take as a
 * lambda receiver (a DSL: koin's `single { get() }` runs on a Scope); or an
 * object member the file imports. It never reaches another class's member by
 * name: koin's `error("…")` — Kotlin's — went to a Logger's `error`, and
 * `module { … }` in one test to another test class's private `module`.
 * `require(n >= 0) { … }` is Kotlin's precondition, not a member `require`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-member-'));
  const files: Record<string, string> = {
    'src/main/kotlin/app/dsl/Module.kt': `package app.dsl

class Scope {
    fun get(): Any = 1
}

class Koin {
    fun get(): Any = 2
}

class Module {
    fun single(definition: Scope.() -> Any) { }
}

fun module(declaration: Module.() -> Unit): Module = Module().apply(declaration)
`,
    'src/main/kotlin/app/log/Logger.kt': `package app.log

class Logger {
    fun error(message: String) { }
}
`,
    'src/main/kotlin/app/db/Table.kt': `package app.db

abstract class Table {
    fun integer(name: String): Int = 0
}
`,
    'src/main/kotlin/app/io/Source.kt': `package app.io

interface Source {
    fun require(byteCount: Long)
}

class RealSource : Source {
    override fun require(byteCount: Long) { }

    fun read(byteCount: Long) {
        require(byteCount >= 0L) { "byteCount < 0: $byteCount" }
        require(byteCount)
    }
}
`,
    'src/test/kotlin/app/TestUtil.kt': `package app

object TestUtil {
    fun deepCopy(value: Int): Int = value
}
`,
    'src/test/kotlin/app/AppTest.kt': `package app

import app.TestUtil.deepCopy
import app.db.Table
import app.dsl.module

class AppTest {
    fun wires() {
        val m = module {
            single { get() }
        }
        val table = object : Table() {
            val id = integer("id")
        }
        val copy = deepCopy(1)
        if (copy < 0) error("negative")
    }
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('bare Kotlin calls', () => {
  it('reach a DSL lambda’s receiver, an anonymous object’s base and an imported object member — nothing else', () => {
    const calls = callsFrom('src/test/kotlin/app/AppTest.kt');
    expect(calls).toContain('app.dsl::Module::single');
    expect(calls).toContain('app.dsl::Scope::get');
    expect(calls).toContain('app.db::Table::integer');
    expect(calls).toContain('app::TestUtil::deepCopy');
    expect(calls).not.toContain('app.dsl::Koin::get');
    expect(calls).not.toContain('app.log::Logger::error');
  });

  it('leave Kotlin’s precondition `require(cond) { … }` to the standard library', () => {
    const read = cg.getNodesInFile('src/main/kotlin/app/io/Source.kt').find((n) => n.name === 'read')!;
    const requires = cg.getOutgoingEdgesFrom([read.id]).filter((e) => e.kind === 'calls').map((e) => e.line);
    expect(requires).toEqual([12]);
  });
});
