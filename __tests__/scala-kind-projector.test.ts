/**
 * A Scala kind-projector placeholder in a type — `Align[Either[A, *]]`,
 * `Functor[Map[K, ?]]` — names no method: cats' 567 `*` type arguments went
 * to an algebra `Sign`'s `*` operator.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scala-kp-'));
  const files: Record<string, string> = {
    'src/main/scala/algebra/Signed.scala': `package algebra

object Signed {
  sealed abstract class Sign(val toInt: Int) {
    def *(that: Sign): Sign = this
  }
}
`,
    'src/main/scala/cats/Align.scala': `package cats

trait Align[F[_]]

object Align {
  implicit def catsAlignForEither[A]: Align[Either[A, *]] = null
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

describe('Scala kind-projector placeholders', () => {
  it('are not references to a `*` method', () => {
    const ids = cg.getNodesInFile('src/main/scala/cats/Align.scala').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.name);
    expect(targets).not.toContain('*');
  });
});
