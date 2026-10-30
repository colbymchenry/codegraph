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
    // `(0, make)()` and `arr[0]()` call a value with no name; their chains are dropped too.
    expect(names).toEqual(['d.setdefault', 'd.setdefault().append', 'make', 'make().run']);
    const py = extractFromSource('x.py', 'def f(d):\n    d.setdefault("k", []).append(1)\n    d.items().get(2)\n');
    expect(py.unresolvedReferences.filter((u) => u.referenceKind === 'calls').map((u) => u.referenceName).sort())
      .toEqual(['d.items', 'd.items().get', 'd.setdefault', 'd.setdefault().append']);
  });

  // A callee that names nothing used to give the reference its whole source
  // text: an IIFE's body, `connect(mapState)`, `handlers[type]`. No symbol has
  // such a name, so nothing resolved and each one parked as a failed reference.
  it('records no name for a callee that names nothing, and looks through wrappers that keep one', () => {
    const js = extractFromSource('src/x.js', [
      'class A extends B { constructor() { super(1); } }',
      'function f(handlers, type, fn, ns) {',
      '  (() => { inner(); })();',
      '  (function () { inner2(); })();',
      '  connect(mapState)(View);',
      '  create()(setup);',
      "  breakpoint('tablet')`padding: 0;`;",
      '  handlers[type](1);',
      '  (0, fn)();',
      '  (fn)();',
      '  (ns.fn)();',
      '}',
    ].join('\n'));
    expect(js.unresolvedReferences.filter((u) => u.referenceKind === 'calls').map((u) => u.referenceName).sort())
      .toEqual(['breakpoint', 'connect', 'create', 'fn', 'inner', 'inner2', 'ns.fn', 'super']);
    // A tag with an object type argument error-recovers into a call on `css<{…}>`.
    const ts = extractFromSource('src/x.ts', 'function g(fn: () => void) { fn!(); (fn as F)(); css<{ open: boolean }>`color: red;`; }');
    expect(ts.unresolvedReferences.filter((u) => u.referenceKind === 'calls').map((u) => u.referenceName).sort())
      .toEqual(['css', 'fn', 'fn']);
  });

  // tree-sitter-typescript parses a prefix operator over a generic call as the
  // call's callee, as it does `await f<T>()` (#2586): `!settings.get<boolean>(…)`
  // was a call named `!settings.get`.
  it('looks through a prefix operator over a generic call', () => {
    const ts = extractFromSource('src/x.ts', [
      'function h() {',
      "  if (!settings.get<boolean>('X')) return;",
      '  void apiRequest<Status>(1);',
      '  return typeof load<T>() === "x" || -count<number>() > 0 || !!useFlag<boolean>();',
      '}',
    ].join('\n'));
    const calls = ts.unresolvedReferences.filter((u) => u.referenceKind === 'calls');
    expect(calls.map((u) => u.referenceName).sort()).toEqual(['apiRequest', 'count', 'load', 'settings.get', 'useFlag']);
    // Each sits where its callee's name starts, past the operator.
    expect(calls.find((u) => u.referenceName === 'settings.get')).toMatchObject({ line: 2, column: 7 });
    expect(calls.find((u) => u.referenceName === 'apiRequest')).toMatchObject({ line: 3, column: 7 });
  });

  // The reference sits where the name does, and is a bare call as a plain
  // call's is: SigNoz's `(callback as FrameRequestCallback)(0)` names the
  // arrow's own parameter, and `(callback)(0)` starting at the `(` bound a
  // generated interface's `callback` property.
  it('treats a wrapped callee as the plain call, so a parameter it names shadows a namesake', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cast-callee-'));
    try {
      fs.writeFileSync(path.join(root, 'schemas.ts'), 'export interface DTO {\n  callback?: string[] | null;\n}\n');
      fs.writeFileSync(path.join(root, 'raf.test.ts'), [
        "import type { DTO } from './schemas';",
        "describe('raf', () => {",
        '  beforeEach(() => {',
        "    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {",
        '      callback(0);',
        '      (callback as FrameRequestCallback)(1);',
        '      callback!(2);',
        '      (callback)(3);',
        '      return 0;',
        '    });',
        '  });',
        '});',
        'export const dto: DTO = {};',
      ].join('\n'));
      const graph = CodeGraph.initSync(root);
      await graph.indexAll();
      const property = graph.getNodesByName('callback').find((n) => n.kind === 'property')!;
      expect(graph.getCallers(property.id)).toEqual([]);
      graph.destroy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
