/**
 * A Scala `val` written inside a block of a class body — cats' `test("…") {
 * val f = … }` — is that block's, not a member of the class: a lambda
 * parameter `f` in another suite (`forAll { (e: Int, f: Int => Int) => f(e) }`)
 * and a sibling test's `f(2)` are not calls to it. A lowercase package import
 * (`import cats.syntax.all._`) no longer lets every class's members in; an
 * imported package object's supertypes do (`package object api extends Api`),
 * as does the package object of the file's own package.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scala-block-'));
  const files: Record<string, string> = {
    'src/test/scala/app/ASuite.scala': `package app

class ASuite {
  def test(name: String)(body: => Unit): Unit = ()

  test("a") {
    val f = (i: Int) => i
    f(1)
  }

  test("c") {
    f(2)
  }
}
`,
    'src/test/scala/app/BSuite.scala': `package app

import app.syntax.all._

class BSuite {
  def test(name: String)(body: => Unit): Unit = ()
  def forAll(p: (Int, Int => Int) => Boolean): Unit = ()

  test("b") {
    forAll { (e: Int, f: Int => Int) =>
      f(e) == 1
    }
  }
}
`,
    'src/main/scala/app/syntax/all.scala': `package app.syntax

object all
`,
    'src/main/scala/app/Api.scala': `package app

trait Api {
  def multipart(s: String): String = s
}
`,
    'src/main/scala/app/api/package.scala': `package app

package object api extends Api
`,
    'src/main/scala/app/client/Client.scala': `package app.client

import app.api._

class Client {
  def send(): String = multipart("x")
}
`,
    'src/main/scala/app/api/Inner.scala': `package app.api

class Inner {
  def send(): String = multipart("y")
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

/** `qualified name:line` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${cg.getNode(e.target)!.qualifiedName}:${e.line}`)
    .sort();
}

describe('Scala block-local vals', () => {
  it('are called from their own block only', () => {
    expect(callsFrom('src/test/scala/app/ASuite.scala').filter((c) => c.startsWith('ASuite::f'))).toEqual(['ASuite::f:8']);
  });

  it('are not another suite’s lambda parameter, whatever the file imports', () => {
    expect(callsFrom('src/test/scala/app/BSuite.scala').filter((c) => c.includes('::f:'))).toEqual([]);
  });
});

describe('Scala package objects', () => {
  it('bring their supertypes’ members in when imported, and into their own package', () => {
    expect(callsFrom('src/main/scala/app/client/Client.scala')).toEqual(['Api::multipart:6']);
    expect(callsFrom('src/main/scala/app/api/Inner.scala')).toEqual(['Api::multipart:4']);
  });
});
