/**
 * A type never inherits from itself. cats' `trait BigDecimalInstances extends
 * cats.kernel.instances.BigDecimalInstances` and `trait AllOps … with
 * Functor.AllOps[F, A]` reached the resolver by the bare name they share with
 * the declaring trait, and 111 such `extends` pointed back at it. The
 * supertype is the other type of that name the written qualifier leads to.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-super-self-'));
  const files: Record<string, string> = {
    'kernel/src/main/scala/cats/kernel/instances/BigDecimalInstances.scala': `package cats.kernel
package instances

trait BigDecimalInstances {
  def order: Int = 0
}
`,
    'core/src/main/scala/cats/instances/bigDecimal.scala': `package cats
package instances

trait BigDecimalInstances extends cats.kernel.instances.BigDecimalInstances {
  def show: String = ""
}
`,
    'core/src/main/scala/cats/Functor.scala': `package cats

object Functor {
  trait AllOps[F[_], A]
}

object Apply {
  trait AllOps[F[_], A] extends Functor.AllOps[F, A]
}

object Foldable {
  trait AllOps[F[_], A]
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

const supertypesOf = (file: string, qualifiedName: string) => {
  const ids = cg.getNodesInFile(file).filter((n) => n.qualifiedName === qualifiedName).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'extends').map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('a supertype sharing the declaring type’s name', () => {
  it('is the other type the written qualifier names', () => {
    expect(supertypesOf('core/src/main/scala/cats/instances/bigDecimal.scala', 'BigDecimalInstances'))
      .toEqual(['kernel/src/main/scala/cats/kernel/instances/BigDecimalInstances.scala:BigDecimalInstances']);
    expect(supertypesOf('core/src/main/scala/cats/Functor.scala', 'Apply::AllOps'))
      .toEqual(['core/src/main/scala/cats/Functor.scala:Functor::AllOps']);
  });
});
