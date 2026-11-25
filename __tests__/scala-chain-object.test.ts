/**
 * A Scala chain link `x.map { … }` is a member of what `x` is — never an
 * object that happens to be named `map` (alleycats' `object map`, cats'
 * `instances.map` / `syntax.flatMap` objects took 418 such calls). A type or
 * object is a chain link only when the receiver names what holds it:
 * `sttp.client4.Response(…)`, `fs2.concurrent.Topic(1)`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scala-chain-'));
  const files: Record<string, string> = {
    'src/main/scala/alleycats/std/map.scala': `package alleycats.std

object map {
  val instances: Int = 1
}
`,
    'src/main/scala/app/client/Response.scala': `package app.client

case class Response(code: Int)
`,
    'src/main/scala/app/Use.scala': `package app

class Use {
  def gen[A](a: A): List[A] = List(a)
  def run(): List[Int] = gen[Int](1).map { x => x + 1 }
  def make(): Any = app.client.Response(200)
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => cg.getNode(e.target)!.filePath)
    .sort();
};

describe('Scala chain links', () => {
  it('never land on an object named like the member', () => {
    expect(targetsFrom('src/main/scala/app/Use.scala')).not.toContain('src/main/scala/alleycats/std/map.scala');
  });

  it('reach a type the receiver’s package path names', () => {
    expect(targetsFrom('src/main/scala/app/Use.scala')).toContain('src/main/scala/app/client/Response.scala');
  });
});
