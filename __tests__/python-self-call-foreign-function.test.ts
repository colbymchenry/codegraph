/**
 * `self.x()` names a member of the instance. When the class has no such method,
 * `x` is an attribute holding a callable, and nothing in the file says which.
 * The bare name then matched a module-level `x` in any other file: flask's
 * `ScriptInfo.load_app` called `self.create_app()`, the callable it was handed,
 * and that linked to an example app's `create_app`.
 *
 * A function of the caller's own file stays. attrs defines `_is_comparable_to`
 * at module level in `_cmp.py` and puts it in the class it builds there, so
 * `self._is_comparable_to(other)` really runs it: a test run records that call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

describe('a Python call on self or cls', () => {
  let root: string;
  let cg: CodeGraph;

  const index = async (files: Record<string, string[]>): Promise<void> => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-self-'));
    for (const [file, lines] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), lines.join('\n') + '\n');
    }
    cg = await CodeGraph.init(root, { index: true });
  };

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const named = (name: string): Node[] => [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
    .filter((n) => n.name === name);
  const callees = (caller: string): string[] => cg.getCallees(named(caller)[0]!.id)
    .map((c) => `${c.node.filePath}:${c.node.name}`).sort();

  it('does not reach a function of another file through an attribute holding a callable', async () => {
    await index({
      'pkg/cli.py': [
        'class ScriptInfo:',
        '    def __init__(self, create_app=None):',
        '        self.create_app = create_app',
        '',
        '    def load_app(self):',
        '        return self.create_app()',
      ],
      'examples/factory.py': ['def create_app():', '    return object()'],
    });
    expect(callees('load_app')).toEqual([]);
  });

  it('does not reach one through an attribute a tuple binds', async () => {
    await index({
      'tests/test_repo.py': [
        'class TestRepo:',
        '    def setUp(self):',
        '        self.repo, self.run = make_repo()',
        '',
        '    def test_add(self):',
        '        self.run("git", "add")',
      ],
      'harness/shell.py': ['def run(*args):', '    return args'],
    });
    expect(callees('test_add')).toEqual([]);
  });

  it('does not reach one on cls', async () => {
    await index({
      'pkg/model.py': [
        'class Model:',
        '    @classmethod',
        '    def build(cls):',
        '        return cls.factory()',
      ],
      'other/factories.py': ['def factory():', '    return object()'],
    });
    expect(callees('build')).toEqual([]);
  });

  it('does not reach one that the file imports', async () => {
    await index({
      'pkg/worker.py': [
        'from other.tasks import run',
        '',
        'class Worker:',
        '    def __init__(self, run):',
        '        self.run = run',
        '',
        '    def go(self):',
        '        return self.run()',
        '',
        '    def plain(self):',
        '        return run()',
      ],
      'other/tasks.py': ['def run():', '    return 1'],
    });
    expect(callees('go')).toEqual([]);
    expect(callees('plain')).toEqual(['other/tasks.py:run']);
  });

  it('keeps a function of its own file, which the file can put on the class', async () => {
    await index({
      'pkg/cmp.py': [
        'def _is_comparable_to(self, other):',
        '    return True',
        '',
        'def make_class():',
        '    return type("Made", (), {"_is_comparable_to": _is_comparable_to, "__eq__": eq})',
        '',
        'def eq(self, other):',
        '    return self._is_comparable_to(other)',
      ],
    });
    expect(callees('eq')).toEqual(['pkg/cmp.py:_is_comparable_to']);
  });

  it('keeps a class of another file, which an attribute holds under its own name', async () => {
    await index({
      'pkg/graph.py': ['class Graph:', '    pass'],
      'tests/test_graph.py': [
        'import pkg.graph as nx',
        '',
        'class TestGraph:',
        '    def setup_method(self):',
        '        self.Graph = nx.Graph',
        '',
        '    def test_empty(self):',
        '        return self.Graph()',
      ],
    });
    expect(cg.getCallees(named('test_empty')[0]!.id).map((c) => c.node.name)).toEqual(['Graph']);
  });

  it('does not reach a module-level variable of another file', async () => {
    await index({
      'lab/model.py': [
        'class Layer:',
        '    def __call__(self, x):',
        '        return x',
        '',
        'class MLP:',
        '    def __init__(self):',
        '        self.out = Layer()',
        '',
        '    def forward(self, x):',
        '        return self.out(x)',
      ],
      'scripts/export.py': ['out = (1, 2)'],
    });
    expect(cg.getCallees(named('forward')[0]!.id).filter((c) => c.node.name === 'out')).toEqual([]);
  });

  it('keeps a method it inherits from a class in another file', async () => {
    await index({
      'pkg/base.py': ['class Base:', '    def setup(self):', '        return 1'],
      'pkg/child.py': [
        'from pkg.base import Base',
        '',
        'class Child(Base):',
        '    def go(self):',
        '        return self.setup()',
      ],
      'other/setup.py': ['def setup():', '    return 2'],
    });
    expect(callees('go')).toEqual(['pkg/base.py:setup']);
  });

  it('leaves a bare call of the same name alone', async () => {
    await index({
      'pkg/use.py': ['def go():', '    return helper()'],
      'other/helpers.py': ['def helper():', '    return 1'],
    });
    expect(callees('go')).toEqual(['other/helpers.py:helper']);
  });
});
