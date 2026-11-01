/**
 * A Python reference keeps its whole chain, and what it reads is the chain's
 * last link. `HttpResponse.content.fset(self, value)` is no call of the
 * `content` getter, `Engine.get_default.cache_clear()` no call of `get_default`,
 * and `Container.SomeModel.objects.create(…)` no `SomeModel()`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const RESPONSE = `class HttpResponse:
    @property
    def content(self):
        return b""

    @staticmethod
    def get_default():
        return None

    class Inner:
        objects = None

        def run(self):
            return 1

    def plain(self):
        return 2
`;

async function targetsOf(body: string): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-chain-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'response.py'), RESPONSE);
  fs.writeFileSync(path.join(root, 'use.py'), `from response import HttpResponse\n\n\ndef caller(self):\n    ${body}\n`);
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  const fn = cg.getNodesByName('caller')[0]!;
  return cg.getOutgoingEdges(fn.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`);
}

describe('a Python chain through an imported class', () => {
  it.each([
    ['a property\'s setter', 'HttpResponse.content.fset(self, 1)'],
    ['an attribute of a method', 'HttpResponse.get_default.cache_clear()'],
    ['a call through a nested class\'s attribute', 'HttpResponse.Inner.objects.create(x=1)'],
    ['an indexed read through one', 'HttpResponse.Inner.objects.defer("x")[0]'],
  ])('links nothing on %s', async (_shape, body) => {
    expect(await targetsOf(body)).toEqual([]);
  });

  it.each([
    ['a method of the class', 'HttpResponse.plain(self)', 'calls HttpResponse::plain'],
    ['a static method', 'HttpResponse.get_default()', 'calls HttpResponse::get_default'],
    ['a nested class', 'HttpResponse.Inner()', 'instantiates HttpResponse::Inner'],
    ['a method of a nested class', 'HttpResponse.Inner.run(self)', 'calls HttpResponse::Inner::run'],
  ])('links %s', async (_shape, body, target) => {
    expect(await targetsOf(body)).toEqual([target]);
  });
});
