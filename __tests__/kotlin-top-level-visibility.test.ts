/**
 * A top-level Kotlin function — an extension function included — is visible
 * from its own package, and from a file that imports it by name or imports
 * its package with `*`. Nowhere else.
 *
 * Exposed keeps a JDBC and an R2DBC test suite, each with a
 * `fun <T> …Transaction.assertEquals(…)` helper. Tests that imported
 * kotlin.test's or JUnit's `assertEquals`, or the JDBC helper, all landed on
 * the R2DBC one: 3,075 calls. okhttp's tests constructed the deprecated
 * `okhttp3.mockwebserver.MockResponse` although every one imports
 * `mockwebserver3.MockResponse`.
 *
 * Also: a function type with a qualified receiver
 * (`(DatabaseConfig.Builder.() -> Unit)?`) no longer breaks the parse of the
 * class around it. Exposed's `DatabaseTestsBase` came out as loose functions.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { blankKotlinQualifiedReceivers } from '../src/extraction/languages/kotlin';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-visibility-'));
  const files: Record<string, string> = {
    'jdbc/src/main/kotlin/app/jdbc/tests/Assert.kt': `package app.jdbc.tests

class JdbcTransaction

fun <T> JdbcTransaction.assertEquals(exp: T, act: T) {}
`,
    'r2dbc/src/main/kotlin/app/r2dbc/tests/Assert.kt': `package app.r2dbc.tests

class R2dbcTransaction

fun <T> R2dbcTransaction.assertEquals(exp: T, act: T) {}
`,
    'jdbc/src/test/kotlin/app/jdbc/JdbcTest.kt': `package app.jdbc

import app.jdbc.tests.assertEquals

class JdbcTest {
  fun works() {
    assertEquals(1, 1)
  }
}
`,
    'r2dbc/src/test/kotlin/app/r2dbc/R2dbcTest.kt': `package app.r2dbc

import app.r2dbc.tests.*

class R2dbcTest {
  fun works() {
    assertEquals(1, 1)
  }
}
`,
    'core/src/test/kotlin/app/core/PlainTest.kt': `package app.core

import kotlin.test.assertEquals

class PlainTest {
  fun works() {
    assertEquals(1, 1)
  }
}
`,
    'jdbc/src/main/kotlin/app/jdbc/tests/Local.kt': `package app.jdbc.tests

fun check() {
  assertEquals(1, 1)
}
`,
    'jdbc/src/main/kotlin/app/jdbc/tests/DatabaseTestsBase.kt': `package app.jdbc.tests

class DatabaseConfig {
  class Builder
}

@MethodSource("data")
abstract class DatabaseTestsBase {
  fun withTables(configure: (DatabaseConfig.Builder.() -> Unit)? = null, statement: () -> Unit) {
    statement()
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

/** The file each `assertEquals` call in `file` resolved to. */
function assertTargets(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .filter((n) => n.name === 'assertEquals')
    .map((n) => n.filePath);
}

describe('Kotlin top-level functions are visible where imported', () => {
  it('an explicit import picks that package’s extension', () => {
    expect(assertTargets('jdbc/src/test/kotlin/app/jdbc/JdbcTest.kt')).toEqual(['jdbc/src/main/kotlin/app/jdbc/tests/Assert.kt']);
  });

  it('a star import of the package does too', () => {
    expect(assertTargets('r2dbc/src/test/kotlin/app/r2dbc/R2dbcTest.kt')).toEqual(['r2dbc/src/main/kotlin/app/r2dbc/tests/Assert.kt']);
  });

  it('a file importing kotlin.test’s assertEquals reaches neither project helper', () => {
    expect(assertTargets('core/src/test/kotlin/app/core/PlainTest.kt')).toEqual([]);
  });

  it('the same package needs no import', () => {
    expect(assertTargets('jdbc/src/main/kotlin/app/jdbc/tests/Local.kt')).toEqual(['jdbc/src/main/kotlin/app/jdbc/tests/Assert.kt']);
  });
});

describe('a function type with a qualified receiver', () => {
  it('keeps the class around it', () => {
    const nodes = cg.getNodesInFile('jdbc/src/main/kotlin/app/jdbc/tests/DatabaseTestsBase.kt');
    const withTables = nodes.find((n) => n.name === 'withTables')!;
    expect(withTables.kind).toBe('method');
    expect(withTables.qualifiedName).toBe('app.jdbc.tests::DatabaseTestsBase::withTables');
  });

  it('is blanked to its simple name, offsets intact', () => {
    const src = 'fun f(c: (DatabaseConfig.Builder.() -> Unit)?, d: a.b.Response.Builder<T>.(Int) -> Unit, e: Builder.() -> Unit) {}';
    const out = blankKotlinQualifiedReceivers(src);
    expect(out.length).toBe(src.length);
    const blank = (s: string) => ' '.repeat(s.length);
    expect(out).toBe(src.replace('DatabaseConfig.', blank('DatabaseConfig.')).replace('a.b.Response.', blank('a.b.Response.')));
  });
});
