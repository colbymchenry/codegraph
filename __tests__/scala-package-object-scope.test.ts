/**
 * A Scala package object's member is in scope in its package and the
 * packages under it, or through an import of that package. cats.laws' `Eq`
 * is the `cats` package object's alias — 752 references went to the
 * `algebra` package object's `Eq` instead.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scala-pkgobj-'));
  const files: Record<string, string> = {
    'algebra-core/src/main/scala/algebra/package.scala': `package object algebra {
  type Eq[A] = cats.kernel.Eq[A]
}
`,
    'core/src/main/scala/cats/package.scala': `package object cats {
  type Eq[A] = cats.kernel.Eq[A]
}
`,
    'laws/src/main/scala/cats/laws/FunctorLaws.scala': `package cats
package laws

trait FunctorLaws {
  def identity[A](eq: Eq[A]): Boolean = true
}
`,
    'algebra-laws/src/main/scala/algebra/laws/RingLaws.scala': `package algebra.laws

import algebra._

trait RingLaws {
  def eqv[A](eq: Eq[A]): Boolean = true
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

const eqTargets = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return [...new Set(cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references')
    .map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'Eq').map((t) => t.filePath))];
};

describe('Scala package object members', () => {
  it('are in scope in their package and those under it', () => {
    expect(eqTargets('laws/src/main/scala/cats/laws/FunctorLaws.scala')).toEqual(['core/src/main/scala/cats/package.scala']);
  });

  it('and through an import of their package', () => {
    expect(eqTargets('algebra-laws/src/main/scala/algebra/laws/RingLaws.scala')).toEqual(['algebra-core/src/main/scala/algebra/package.scala']);
  });
});
