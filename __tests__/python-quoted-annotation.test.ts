/**
 * A quoted (forward-reference) parameter annotation names a receiver type too
 * (#1684): `def f(o: "Alpha")` resolves `o.render()` exactly like `def f(o:
 * Alpha)`. Quoted annotations are ordinary Python — forward references, and
 * everything under `from __future__ import annotations`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1684-'));
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
  fs.writeFileSync(
    path.join(dir, 'pkg', 'a.py'),
    'def render(x):\n    return x\n\nclass Alpha:\n    def render(self):\n        return "a"\n\nclass Beta:\n    def render(self):\n        return "b"\n'
  );
  fs.writeFileSync(
    path.join(dir, 'pkg', 'b.py'),
    'from __future__ import annotations\nfrom pkg.a import Alpha, Beta\n\n' +
      'def quoted(o: "Alpha"):\n    return o.render()\n\n' +
      "def single_quoted(o: 'Beta'):\n    return o.render()\n\n" +
      'def unquoted(o: Alpha):\n    return o.render()\n'
  );
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const calleeOf = (fn: string): string[] =>
  cg
    .getCallees(cg.getNodesByName(fn).find((n) => n.kind === 'function')!.id)
    .map(({ node }) => node.qualifiedName)
    .sort();

describe('quoted forward-reference annotations (#1684)', () => {
  it('resolves the method on the quoted type, the same as the unquoted annotation', () => {
    expect(calleeOf('unquoted')).toEqual(['Alpha::render']);
    expect(calleeOf('quoted')).toEqual(['Alpha::render']);
    expect(calleeOf('single_quoted')).toEqual(['Beta::render']);
  });
});
