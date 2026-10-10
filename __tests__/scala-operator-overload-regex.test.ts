/**
 * A call to an overloaded operator method (Scala's `++`) reaches the overload
 * matcher, which looks for `<name>(` in the call-site text with a regex built
 * from the method name. The name was escaped for `~` only, so `++` produced
 * `/\b++\s*(...)/` — "Nothing to repeat" — and the exception aborted the whole
 * resolution pass, leaving a project like Canton/Splice with its references
 * unresolved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

let cg: CodeGraph | undefined;
let dir: string | undefined;

afterEach(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('overloaded operator methods', () => {
  it('resolves a call to an overloaded `++` without failing the index', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scala-op-'));
    fs.writeFileSync(path.join(dir, 'Bag.scala'), `class Bag {
  def ++(other: Bag): Bag = this
  def ++(items: Seq[Int]): Bag = this
  def merge(other: Bag): Bag = this.++(other)
}
`);
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.scala'], exclude: [] } });
    await expect(cg.indexAll()).resolves.toBeDefined();
    const merge = cg.getNodesByQualifiedName('Bag::merge')[0];
    expect(merge).toBeDefined();
    expect(cg.getPendingReferenceCount()).toBe(0);
  });
});
