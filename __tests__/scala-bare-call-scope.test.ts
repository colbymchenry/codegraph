/**
 * A bare Scala name reached by name alone must be in reach:
 * - a parameter or local binds it: `f(true)` with `f: A => B` is not a case
 *   class's field `f` (cats: 438 times);
 * - a later link of a chain (`fa.iterator.map(f)`) reaches a member of what
 *   the receiver is named after (`basicRequest.send` → Request), never a
 *   package object's function;
 * - otherwise a member of the types around it — an anonymous subclass's base
 *   included (`new OptionParser[C]("x") { head("x") }`) — of their supertypes,
 *   or of an imported object.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scala-scope-'));
  const files: Record<string, string> = {
    'src/main/scala/app/FreeT.scala': `package app

final case class FlatMapped[A](f: A => A)
`,
    'src/main/scala/app/LazyOps.scala': `package app

class LazyOps[A](xs: List[A]) {
  def map[B](g: A => B): List[B] = xs.map(g)
}
`,
    'src/main/scala/app/OptionParser.scala': `package app

abstract class OptionParser[C](name: String) {
  def head(xs: String*): Unit = ()
}
`,
    'src/main/scala/app/Base.scala': `package app

trait Base {
  def helper(): Int = 1
}
`,
    'src/main/scala/app/Request.scala': `package app

class Request {
  def send(backend: String): String = backend
}
`,
    'src/main/scala/app/Use.scala': `package app

object Use extends Base {
  def tabulate[A](f: Boolean => A): (A, A) = (f(true), f(false))
  def twice(fa: List[Int]): List[Int] = fa.iterator.map(_ + 1).toList
  def run(basicRequest: Request): String = basicRequest.send("b")
  def local(): Int = helper()
  val parser = new OptionParser[Int]("scopt") {
    head("scopt", "3.x")
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

describe('bare Scala calls', () => {
  it('stay with locals, the receiver’s type, the class hierarchy and anonymous bases', () => {
    const ids = cg.getNodesInFile('src/main/scala/app/Use.scala').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(targets.some((t) => t.endsWith('FlatMapped::f'))).toBe(false);
    expect(targets.some((t) => t.endsWith('LazyOps::map'))).toBe(false);
    expect(targets.some((t) => t.endsWith('Request::send'))).toBe(true);
    expect(targets.some((t) => t.endsWith('Base::helper'))).toBe(true);
    expect(targets.some((t) => t.endsWith('OptionParser::head'))).toBe(true);
  });
});
