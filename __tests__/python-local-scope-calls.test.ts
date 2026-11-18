/**
 * A bare Python call of a name the code around it binds is a call of that
 * binding, never of a module-level namesake: a parameter or local of the
 * calling function (#3037, which the module's own `def` of the name in the
 * same file used to win), a comprehension variable or lambda parameter on the
 * call's own statement (#3230), or a parameter or local of a function that
 * encloses the caller (#3231). What the module itself binds — a rebinding like
 * `handler = wrap(handler)` — and a class body in between never hide the
 * module's def, and a pytest fixture is still what a test's parameter of its
 * name receives.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pyscope-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** The `calls` edges out of the function or method with this qualified name, as `name@file`. */
function callees(qualified: string): string[] {
  const from = [...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method')].filter((n) => n.qualifiedName === qualified);
  expect(from.length, `${qualified} should be indexed`).toBe(1);
  return cg!
    .getOutgoingEdges(from[0]!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.qualifiedName}@${n.filePath}`)
    .sort();
}

describe("a local binding shadows the same file's module function (#3037)", () => {
  it("the issue's repro, and the assignment, parameter and loop forms", async () => {
    await index({
      't.py': [
        'import re',
        '',
        '',
        'def flat(html):',
        '    return html.strip()',
        '',
        '',
        'def test_one(plain):',
        '    flat = lambda h: re.sub(r"\\s+", " ", h)',
        '    return flat(plain)',
        '',
        '',
        'def test_attr(x, plain):',
        '    flat = x.upper',
        '    return flat(plain)',
        '',
        '',
        'def test_param(flat, plain):',
        '    return flat(plain)',
        '',
        '',
        'def test_loop(fs, plain):',
        '    for flat in fs:',
        '        flat(plain)',
        '',
        '',
        'def control(plain):',
        '    return flat(plain)',
        '',
      ].join('\n'),
    });
    for (const fn of ['test_one', 'test_attr', 'test_param', 'test_loop']) expect(callees(fn), fn).toEqual([]);
    expect(callees('control')).toEqual(['flat@t.py']);
  });

  it("keeps the module's def when only the module rebinds the name, or a call's keyword does", async () => {
    await index({
      'm.py': [
        'def wrap(f):',
        '    return f',
        '',
        '',
        'def callback(x):',
        '    return x',
        '',
        '',
        'def register(name, handler, callback=None):',
        '    return name',
        '',
        '',
        'def setup(handler):',
        '    return register("evt",',
        '                    handler, callback=callback)',
        '',
        '',
        'def fire():',
        '    return callback(1)',
        '',
        '',
        'def handler(evt):',
        '    return evt',
        '',
        '',
        'handler = wrap(handler)',
        '',
        '',
        'def go():',
        '    return handler(1)',
        '',
      ].join('\n'),
    });
    expect(callees('fire')).toEqual(['callback@m.py']);
    expect(callees('go')).toEqual(['handler@m.py']);
  });

  it('keeps a same-file pytest fixture a test takes as a parameter, and a nested def', async () => {
    await index({
      'test_x.py': [
        'import pytest',
        '',
        '',
        '@pytest.fixture',
        'def flat():',
        '    return lambda h: h',
        '',
        '',
        'def test_fixture(flat):',
        '    return flat("x")',
        '',
        '',
        'def outer():',
        '    def helper():',
        '        return 1',
        '    return helper()',
        '',
        '',
        'def helper():',
        '    return 2',
        '',
      ].join('\n'),
    });
    expect(callees('test_fixture')).toEqual(['flat@test_x.py']);
    expect(callees('outer')).toEqual(['outer::helper@test_x.py']);
  });

  it("doesn't hide the module's def behind a class attribute of the name", async () => {
    await index({
      'c.py': 'def helper():\n    return 1\n\n\nclass C:\n    helper = 1\n\n    def m(self):\n        return helper()\n',
    });
    expect(callees('C::m')).toEqual(['helper@c.py']);
  });
});

describe("a comprehension's variable or a lambda's parameter is the call's own (#3230)", () => {
  it.each([
    ['a list comprehension', 'def comp(polys):\n    return [p(0) for p in polys]\n'],
    ['a comprehension over lines', 'def comp(polys):\n    return [\n        p(0)\n        for p in polys\n    ]\n'],
    ['a generator expression', 'def comp(polys):\n    return sum(p(0) for p in polys)\n'],
    ['a dict comprehension', 'def comp(polys):\n    return {i: p(0) for i, p in enumerate(polys)}\n'],
    ['a lambda', 'def comp(polys):\n    f = lambda p: p(0)\n    return f(polys)\n'],
  ])('%s links no other file\'s symbol of that name', async (_label, code) => {
    await index({ 'other/far.py': 'p = object()\n\n\ndef p2():\n    return 1\n', 't.py': code });
    expect(callees('comp').filter((e) => e.includes('other/far.py'))).toEqual([]);
  });
});

describe("an enclosing function's binding is the nested function's too (#3231)", () => {
  it("the issue's repro, an enclosing parameter, and a binding two functions up", async () => {
    await index({
      'other/far.py': 'def evaluate(path):\n    return path\n',
      't.py': [
        'def closure(make):',
        '    evaluate = make()',
        '',
        '    def inner(path):',
        '        return evaluate(path)',
        '    return inner',
        '',
        '',
        'def param_closure(evaluate):',
        '    def inner(path):',
        '        return evaluate(path)',
        '    return inner',
        '',
        '',
        'def two_up(make):',
        '    evaluate = make()',
        '',
        '    def mid():',
        '        def inner(path):',
        '            return evaluate(path)',
        '        return inner',
        '    return mid',
        '',
      ].join('\n'),
    });
    expect(callees('closure::inner')).toEqual([]);
    expect(callees('param_closure::inner')).toEqual([]);
    expect(callees('two_up::mid::inner')).toEqual([]);
  });
});
