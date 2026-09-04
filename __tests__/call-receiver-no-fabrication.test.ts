/**
 * A member call whose receiver is itself a call never fabricates an edge
 * (#1683, #1681). `d.setdefault(k, []).append(v)` used to lose its receiver at
 * extraction time, degrade to the bare `append`, and exact-match any top-level
 * project function of that name — a call edge from an unrelated function,
 * reproduced in Python and JavaScript alike. The receiver is now kept as
 * `<inner>().<method>`, which nothing name-matches; the inner call resolves
 * on its own as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1683-'));
  fs.mkdirSync(path.join(dir, 'py'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'py', '__init__.py'), '');
  fs.writeFileSync(
    path.join(dir, 'py', 'collect.py'),
    'def append(item):\n    return item\n\ndef get(key):\n    return key\n\ndef make():\n    return {}\n\n' +
      'def bucket(d, k, v):\n    d.setdefault(k, []).append(v)\n    return d.items().get(k)\n\n' +
      'def fresh():\n    return make().get("x")\n'
  );
  fs.writeFileSync(
    path.join(dir, 'js', 'collect.js'),
    'function append(item) { return item; }\nfunction run() { return 1; }\nfunction make() { return {}; }\n' +
      'function bucket(d, k, v) { d.setdefault(k, []).append(v); make().run(); (0, make)().run(); }\n' +
      'module.exports = { append, run, make, bucket };\n'
  );
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const fn = (name: string, file: string) => cg.getNodesByName(name).find((n) => n.kind === 'function' && n.filePath.endsWith(file))!;
const calleesOf = (name: string, file: string) =>
  cg.getCallees(fn(name, file).id).filter(({ edge }) => edge.kind === 'calls').map(({ node }) => node.name).sort();
// Callers through `calls` edges only — a `module.exports = { run }` value reference is not a call.
const callersOf = (name: string, file: string) =>
  cg.getCallers(fn(name, file).id).filter(({ edge }) => edge.kind === 'calls').map(({ node }) => node.name);

describe('call-expression receivers (#1683)', () => {
  it('Python: no edge from a call-result receiver to a same-named top-level function', () => {
    expect(calleesOf('bucket', 'collect.py')).toEqual([]);
    expect(callersOf('append', 'collect.py')).toEqual([]);
    expect(callersOf('get', 'collect.py')).toEqual([]);
    // The inner call still resolves on its own; `.get` on its unknown product does not.
    expect(calleesOf('fresh', 'collect.py')).toEqual(['make']);
  });

  it('JavaScript: the same shape, and the inner call keeps its edge', () => {
    expect(callersOf('append', 'collect.js')).toEqual([]);
    // `make().run()` — what `make` returns is unknown, so `run` is not guessed.
    expect(callersOf('run', 'collect.js')).toEqual([]);
    expect(calleesOf('bucket', 'collect.js')).toEqual(['make']);
  });

  it('encodes the receiver as `<inner>().<method>` and drops a receiver with no static callee', () => {
    const r = extractFromSource('src/x.js', 'function f(d) { d.setdefault("k", []).append(1); make().run(); (0, make)().run(); arr[0]().go(); }');
    const names = r.unresolvedReferences.filter((u) => u.referenceKind === 'calls').map((u) => u.referenceName).sort();
    // `(0, make)` and `arr[0]` are the inner calls' own refs, unchanged; their chains are dropped.
    expect(names).toEqual(['(0, make)', 'arr[0]', 'd.setdefault', 'd.setdefault().append', 'make', 'make().run']);
    const py = extractFromSource('x.py', 'def f(d):\n    d.setdefault("k", []).append(1)\n    d.items().get(2)\n');
    expect(py.unresolvedReferences.filter((u) => u.referenceKind === 'calls').map((u) => u.referenceName).sort())
      .toEqual(['d.items', 'd.items().get', 'd.setdefault', 'd.setdefault().append']);
  });
});
