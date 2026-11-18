/**
 * A Python `self.x()` or `cls.x()` names a member of the instance or the
 * class: a method the class has or inherits, or an attribute holding a
 * callable (#2958). It never means a module-level function or variable of
 * another file, and when the class binds the attribute itself it means what
 * that binding holds: a parameter (`self.create_app = create_app`), an
 * instance (`self.out = Layer()`), a tuple's element, not a same-named symbol
 * somewhere else, another class's method included. What the binding names
 * under its own name, the class's own and inherited methods, a mixin's call
 * into the class it is mixed into, and a function of the caller's own file
 * still link.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2958-'));
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

/** The `calls` edges out of a function or method named `caller`, as `name@file`. */
function callees(caller: string): string[] {
  const from = [...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method')].filter((n) => n.name === caller);
  expect(from.length, `${caller} should be indexed`).toBeGreaterThan(0);
  return from
    .flatMap((n) => cg!.getOutgoingEdges(n.id))
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.qualifiedName}@${n.filePath}`)
    .sort();
}

describe('a Python call on self or cls (#2958)', () => {
  it("the issue's repro: an attribute set from a parameter is not another file's function", async () => {
    await index({
      'pkg/cli.py': [
        'class ScriptInfo:',
        '    def __init__(self, create_app=None):',
        '        self.create_app = create_app',
        '',
        '    def load_app(self):',
        '        if self.create_app is not None:',
        '            return self.create_app()',
        '        return None',
        '',
      ].join('\n'),
      'examples/factory.py': 'def create_app():\n    return object()\n',
    });
    expect(callees('load_app')).toEqual([]);
  });

  it('nor is an attribute holding an instance a function or a variable of that name elsewhere', async () => {
    await index({
      'other/features.py': 'def out(x):\n    return x\n',
      'scripts/export.py': 'games = []\nout = (games.copy())\n',
      'lab/model.py': [
        'class Layer:',
        '    def __call__(self, x):',
        '        return x',
        '',
        'class MLP:',
        '    def __init__(self):',
        '        self.out = Layer()',
        '    def forward(self, x):',
        '        return self.out(x)',
        '',
      ].join('\n'),
    });
    expect(callees('forward')).toEqual([]);
  });

  it('nor is an attribute a tuple binds', async () => {
    await index({
      'harness/runner.py': 'def run(*args):\n    return args\n',
      'tests/test_git.py': [
        'import unittest',
        '',
        '',
        'def _git_repo(path):',
        '    return path, print',
        '',
        '',
        'class GitTest(unittest.TestCase):',
        '    def setUp(self):',
        '        self.repo, self.run = _git_repo("x")',
        '',
        '    def test_add(self):',
        '        self.run("git", "add", "-A")',
        '',
      ].join('\n'),
    });
    expect(callees('test_add')).toEqual([]);
  });

  it("nor another class's method of that name, when the class binds the attribute", async () => {
    await index({
      'a/handlers.py': 'class Other:\n    def callback(self):\n        pass\n',
      'b/svc.py': [
        'class Svc:',
        '    def __init__(self, callback):',
        '        self.callback = callback',
        '',
        '    def fire(self):',
        '        self.callback()',
        '',
      ].join('\n'),
    });
    expect(callees('fire')).toEqual([]);
  });

  it('nor, on cls, a class attribute', async () => {
    await index({
      'other/hooks.py': 'def factory():\n    return 1\n',
      'app.py': [
        'class Builder:',
        '    factory = None',
        '',
        '    @classmethod',
        '    def build(cls):',
        '        return cls.factory()',
        '',
      ].join('\n'),
    });
    expect(callees('build')).toEqual([]);
  });

  it("keeps the class's own and inherited methods", async () => {
    await index({
      'base.py': 'class Base:\n    def helper(self):\n        return 1\n',
      'child.py': [
        'from base import Base',
        '',
        '',
        'class Child(Base):',
        '    def save(self):',
        '        return 1',
        '',
        '    def run(self):',
        '        self.save()',
        '        return self.helper()',
        '',
      ].join('\n'),
      'other.py': 'def helper():\n    return 2\n\n\ndef save():\n    return 3\n',
    });
    expect(callees('run')).toEqual(['Base::helper@base.py', 'Child::save@child.py']);
  });

  it("keeps a subclass's override even when the class binds a fallback for it", async () => {
    await index({
      'mixin.py': [
        'class ListMixin:',
        '    def __init__(self):',
        '        if not hasattr(self, "_set_single"):',
        '            self._set_single = self._set_single_rebuild',
        '',
        '    def _set_single_rebuild(self, i, v):',
        '        return None',
        '',
        '    def __setitem__(self, i, v):',
        '        self._set_single(i, v)',
        '',
      ].join('\n'),
      'line.py': 'from mixin import ListMixin\n\n\nclass LineString(ListMixin):\n    def _set_single(self, i, v):\n        return None\n',
    });
    expect(callees('__setitem__')).toEqual(['LineString::_set_single@line.py']);
  });

  it("keeps a mixin's call into the class it is mixed into", async () => {
    await index({
      'views.py': 'class ListView:\n    def get_queryset(self):\n        return []\n',
      'mixins.py': 'class FilterMixin:\n    def filtered(self):\n        return self.get_queryset()\n',
    });
    expect(callees('filtered')).toEqual(['ListView::get_queryset@views.py']);
  });

  it('keeps what a binding names under its own name', async () => {
    await index({
      'tools.py': 'def helper():\n    return 1\n\n\ndef _cmp(a, b):\n    return a == b\n',
      'svc.py': [
        'from tools import helper, _cmp',
        '',
        '',
        'class Svc:',
        '    _cmp = staticmethod(_cmp)',
        '',
        '    def __init__(self):',
        '        self.helper = helper',
        '',
        '    def go(self):',
        '        self.helper()',
        '        return self._cmp(1, 2)',
        '',
      ].join('\n'),
    });
    expect(callees('go')).toEqual(['_cmp@tools.py', 'helper@tools.py']);
  });

  it("keeps a function of the caller's own file, and a class an attribute holds", async () => {
    await index({
      'graphs.py': 'class Graph:\n    pass\n',
      'cmp.py': [
        'import graphs',
        '',
        '',
        'def _is_comparable_to(a, b):',
        '    return True',
        '',
        '',
        'class Holder:',
        '    def __init__(self):',
        '        self.Graph = graphs.Graph',
        '',
        '    def eq(self, other):',
        '        self.Graph()',
        '        return self._is_comparable_to(other)',
        '',
      ].join('\n'),
    });
    expect(callees('eq')).toEqual(['_is_comparable_to@cmp.py']);
  });
});
