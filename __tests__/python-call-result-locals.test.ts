/**
 * A Python local bound from a call has the type the callee's `-> T` declares,
 * for any method called on it: a function's (`made = make(q)`, #3038) or a
 * method's on another local of a known class (`s = store.stage()`, #3240). A
 * builtin or a class from outside the project (`-> Path`, `-> str`) has no
 * project method, so a project method sharing the name is never the call; a
 * project class (`-> Stager`) gives its own method, even where another class
 * has one of that name.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-3038-'));
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

/** The methods a function calls, as `Class::method`. */
function methodCallees(fn: string): string[] {
  const from = cg!.getNodesByKind('function').find((n) => n.name === fn);
  expect(from, `${fn} should be indexed`).toBeDefined();
  return cg!
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n && n.kind === 'method')
    .map((n) => n.qualifiedName)
    .sort();
}

const ARM = [
  'class Arm:',
  '    def stat(self, field: str) -> float:',
  '        return 1.0',
  '',
  '    def casefold(self):',
  '        return ""',
  '',
  '    def removeprefix(self, p):',
  '        return ""',
  '',
].join('\n');

describe("a local bound from a function's call (#3038)", () => {
  it("the issue's repro: a `-> Path` result calls no project `stat`", async () => {
    await index({
      'arm.py': ARM,
      'use.py': [
        'from pathlib import Path',
        '',
        '',
        'def make(p: Path) -> Path:',
        '    return p',
        '',
        '',
        'def size(p: Path) -> int:',
        '    return p.stat().st_size',
        '',
        '',
        'def size_of_made(q: Path) -> int:',
        '    made = make(q)',
        '    return made.stat().st_size',
        '',
      ].join('\n'),
    });
    expect(methodCallees('size')).toEqual([]);
    expect(methodCallees('size_of_made')).toEqual([]);
  });

  it('nor does a `-> pathlib.Path` or a `-> str` result, or a parameter annotated `str`', async () => {
    await index({
      'arm.py': ARM,
      'use.py': [
        'import pathlib',
        '',
        '',
        'def make2(p) -> pathlib.Path:',
        '    return p',
        '',
        '',
        'def name_of(p) -> str:',
        '    return str(p)',
        '',
        '',
        'def via_qualified(q):',
        '    made = make2(q)',
        '    return made.stat().st_size',
        '',
        '',
        'def via_str(q):',
        '    s = name_of(q)',
        '    return s.casefold() + s.removeprefix("x")',
        '',
        '',
        'def param_str(s: str):',
        '    return s.removeprefix("x")',
        '',
      ].join('\n'),
    });
    for (const fn of ['via_qualified', 'via_str', 'param_str']) expect(methodCallees(fn), fn).toEqual([]);
  });

  it("a project class's annotation gives its own method, though another class has one of the name", async () => {
    await index({
      'm.py': [
        'class Stager:',
        '    def push(self, rows):',
        '        return rows',
        '',
        'class Decoy:',
        '    def push(self, rows):',
        '        return rows',
        '',
        'def make() -> Stager:',
        '    return Stager()',
        '',
        'def via_function():',
        '    s = make()',
        '    s.push([1])',
        '',
      ].join('\n'),
    });
    expect(methodCallees('via_function')).toEqual(['Stager::push']);
  });

  it('reads a value wrapped in parentheses as the expression inside, not a tuple', async () => {
    await index({
      't.py': [
        'class Timeout:',
        '    def as_dict(self):',
        '        return {}',
        '',
        '',
        'def go(t):',
        '    timeout = (',
        '        Timeout(t)',
        '        if t',
        '        else Timeout(1)',
        '    )',
        '    return timeout.as_dict()',
        '',
      ].join('\n'),
    });
    expect(methodCallees('go')).toEqual(['Timeout::as_dict']);
  });

  it('leaves a local whose factory says nothing readable to the strategies that guessed before', async () => {
    await index({
      'w.py': [
        'import lib',
        '',
        '',
        'class Widget:',
        '    def render(self):',
        '        return 1',
        '',
        '',
        'def build():',
        '    return lib.make()',
        '',
        '',
        'def use():',
        '    widget = build()',
        '    return widget.render()',
        '',
      ].join('\n'),
    });
    expect(methodCallees('use')).toEqual(['Widget::render']);
  });
});

describe("a local bound from another local's method call (#3240)", () => {
  const STORE = [
    'class Stager:',
    '    def add(self, rows):',
    '        return rows',
    '',
    '    def push(self, rows):',
    '        return rows',
    '',
    'class Decoy:',
    '    def push(self, rows):',
    '        return rows',
    '',
    'class Store:',
    '    def stage(self) -> Stager:',
    '        return Stager()',
    '',
  ].join('\n');

  it("the issue's repro: the method's return annotation types the local", async () => {
    await index({
      'm.py': [
        STORE,
        'def via_method():',
        '    store = Store()',
        '    s = store.stage()',
        '    s.add([2])',
        '',
        'def via_param_method(store: Store):',
        '    s = store.stage()',
        '    s.add([3])',
        '',
        'def pushes(store: Store):',
        '    s = store.stage()',
        '    s.push([4])',
        '',
      ].join('\n'),
    });
    expect(methodCallees('via_method')).toEqual(['Stager::add', 'Store::stage']);
    expect(methodCallees('via_param_method')).toEqual(['Stager::add', 'Store::stage']);
    expect(methodCallees('pushes')).toEqual(['Stager::push', 'Store::stage']);
  });
});
