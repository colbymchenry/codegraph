/**
 * A type parameter is not a project symbol that shares its name.
 *
 * cats' `def zipWith[A, B, C](fa: ISeq[A], …)` sent `A` to an `implicit def A`
 * (4,916 dependents) and `B` to a `case class B()` declared inside a test;
 * getx's `T` landed on a constant named `T`. A type declared inside a function
 * is only in scope in there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-type-params-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function typeTargets(cg: CodeGraph, name: string): string[] {
  const from = cg.getNodesByName(name).filter((n) => n.kind === 'function' || n.kind === 'method');
  return cg
    .getOutgoingEdgesFrom(from.map((n) => n.id), ['references', 'type_of', 'returns', 'instantiates'])
    .map((e) => cg.getNode(e.target))
    .map((n) => `${n!.kind}:${n!.name}`)
    .sort();
}

describe('type parameters', () => {
  it('Scala: a def’s type parameters, and a case class local to another test', async () => {
    const cg = await project({
      'src/Inst.scala': `package app
object Inst {
  implicit def A: Int = 1
}
`,
      'src/Seqs.scala': `package app
object Seqs {
  def zipWith[A, B, C](fa: List[A], fb: List[B])(f: (A, B) => C): List[C] = ???
}
`,
      // Operator names are declared names too — and must not break the reading.
      'src/Ops.scala': `package app
object Ops {
  def |+|[A](x: A, y: A): A = x
  def *[B](b: B): B = b
}
trait Heyting[@sp(Int, Long) A] {
  def and(a: A, b: A): A
}
final case class FlatMapped(f: Int => Int) {
  type A = Int
}
trait Laws {
  type L = Int
}
class MyLaws extends Laws {
  def check(x: L): Boolean = true
}
object UsesImport {
  import FlatMapped._
  def viaImport(x: A): Int = 1
}
object Folds {
  def foldMap[A](fa: List[A])(f: A => Int)(implicit G: Ordering[Int]): Int = { f(fa.head); G.max(1, 2) }
}
object TraverseLaws {
  def updatedRef[A, B >: A](fa: List[A], b: B): Option[B] = None
}
trait UnorderedTraverseTests {
  def unorderedTraverse[
    A,
    B,
    C,
    X,
    Y
  ](implicit
    ArbXB: Option[X],
    ArbYB: List[B]
  ): Unit = ()
}
`,
      'src/Elsewhere.scala': `package app
object Elsewhere {
  def combineAll(xs: List[A]): Int = 1
  def lift(implicit F: FlatMap): Int = 1
}
`,
      'src/FlatMap.scala': `package app
trait FlatMap
`,
      'src/Eval.scala': `package app
object Eval {
  final case class FlatMap(x: Int)
}
`,
      'src/SyntaxSuite.scala': `package app
class SyntaxSuite {
  def testOptionEmpty(): Unit = {
    case class B()
    val b: B = B()
  }
}
`,
    });
    try {
      expect(typeTargets(cg, 'zipWith')).toEqual([]);
      expect(typeTargets(cg, '|+|')).toEqual([]);
      expect(typeTargets(cg, '*')).toEqual([]);
      // A specialized parameter of the enclosing trait.
      expect(typeTargets(cg, 'and')).toEqual([]);
      // A def's own value parameters: `f(…)` calls the argument, `G` is the implicit.
      const folds = cg.getNodesByName('foldMap')[0]!;
      const fromFolds = cg.getOutgoingEdgesFrom([folds.id], ['calls', 'references']).map((e) => cg.getNode(e.target)!.name);
      expect(fromFolds).not.toContain('f');
      expect(fromFolds).not.toContain('G');
      // Another type's member is only in scope inside it, a subtype, or after an import.
      expect(typeTargets(cg, 'combineAll')).toEqual([]);
      // …and the one in scope is found instead.
      const lift = cg.getNodesByName('lift')[0]!;
      const liftTargets = cg.getOutgoingEdgesFrom([lift.id], ['references']).map((e) => cg.getNode(e.target)!);
      expect(liftTargets.map((n) => `${n.kind}:${n.qualifiedName}`)).toContain('trait:FlatMap');
      expect(liftTargets.map((n) => n.qualifiedName)).not.toContain('Eval::FlatMap');
      expect(typeTargets(cg, 'check')).toContain('type_alias:L');
      expect(typeTargets(cg, 'viaImport')).toContain('type_alias:A');
      // A lower bound's `>:` is not a closing bracket.
      expect(typeTargets(cg, 'updatedRef')).toEqual([]);
      // A parameter list written one per line.
      expect(typeTargets(cg, 'unorderedTraverse')).toEqual([]);
      // Inside its own method, the local class is still the one meant.
      expect(typeTargets(cg, 'testOptionEmpty')).toContain('class:B');
    } finally {
      cg.close();
    }
  });

  it('Java, TypeScript and Dart: declared before or after the name', async () => {
    const cg = await project({
      'src/T.java': `package app;
public class T {}
`,
      'src/Foo.java': `package app;
public class Foo {}
`,
      'src/Util.java': `package app;
import java.util.List;
import java.util.Map;
public class Util {
  public static <T extends Comparable<T>> T max(List<T> xs) { return null; }
  public static Map<String, Foo> index(List<Foo> xs) { return null; }
}
`,
      'src/wrap.ts': `export class T {}
export function wrap<T>(x: T): T { return x; }
`,
      'lib/first.dart': `const T = 1;
T first<T>(List<T> xs) => xs.first;
`,
    });
    try {
      expect(typeTargets(cg, 'max')).toEqual([]);
      // A generic type's ARGUMENTS are not parameters: `Map<String, Foo>` still names Foo.
      expect(typeTargets(cg, 'index')).toContain('class:Foo');
      expect(typeTargets(cg, 'wrap')).toEqual([]);
      expect(typeTargets(cg, 'first')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
