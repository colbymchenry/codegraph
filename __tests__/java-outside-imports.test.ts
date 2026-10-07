/**
 * A Java single-type import names the class it imports: after
 * `import java.lang.reflect.Field;` the file's `Field` is the JDK's — gson's
 * production code bound it to a test's nested `ParameterizedTypesTest.Field`,
 * jsoup's W3C converter (`import org.w3c.dom.Document;`) to jsoup's own
 * `Document`. A static import (`import static org.junit.Assert.assertEquals;`)
 * likewise owns its name. Imports of the project's own classes — nested ones
 * included — resolve as before. Kotlin imports (no `;`, optional `as`) are read
 * the same way; a member the file itself declares still comes first.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-imports-'));
  const files: Record<string, string> = {
    'src/test/java/app/functional/TypesTest.java': `package app.functional;

public class TypesTest {
  static class Field {
    String name;
  }

  static void assertEquals(Object a, Object b) { }
}
`,
    'src/main/java/app/model/Outer.java': `package app.model;

public class Outer {
  public static class Inner {
    public static Inner create() { return new Inner(); }
  }
}
`,
    'src/main/java/app/Reflect.java': `package app;

import java.lang.reflect.Field;
import app.model.Outer;
import app.model.Outer.Inner;

public class Reflect {
  String nameOf(Field field) {
    return field.getName();
  }

  Outer.Inner make() {
    return Inner.create();
  }
}
`,
    'src/main/kotlin/app/Dates.kt': `package app

import java.lang.reflect.Field
import kotlinx.datetime.toLocalDateTime
import app.model.Outer.Inner as Made

class Dates {
    private fun toLocalDateTime(value: Long): Long = value

    fun parse(value: Long, field: Field): Long {
        field.getName()
        Made.create()
        return toLocalDateTime(value)
    }
}
`,
    'src/test/java/app/ReflectTest.java': `package app;

import static org.junit.Assert.assertEquals;

public class ReflectTest {
  void names() {
    assertEquals("a", "a");
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

/** `kind qualified-name` of every non-structural edge out of a file. */
function edgesFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && e.kind !== 'imports')
    .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

describe('Java single-type and static imports from outside the project', () => {
  it('own their names; the project’s own imports still resolve', () => {
    const edges = edgesFrom('src/main/java/app/Reflect.java');
    expect(edges).not.toContain('references app.functional::TypesTest::Field');
    expect(edges).toContain('calls app.model::Outer::Inner::create');
  });

  it('Kotlin: an outside import owns its name, but a member the file declares comes first; `as` aliases bind', () => {
    const edges = edgesFrom('src/main/kotlin/app/Dates.kt');
    expect(edges).not.toContain('references app.functional::TypesTest::Field');
    expect(edges).toContain('calls app::Dates::toLocalDateTime');
    expect(edges).toContain('calls app.model::Outer::Inner::create');
  });

  it('a static import’s method is not a project method of that name', () => {
    expect(edgesFrom('src/test/java/app/ReflectTest.java')).not.toContain('calls app.functional::TypesTest::assertEquals');
  });
});
