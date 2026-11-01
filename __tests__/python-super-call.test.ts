/**
 * Both extractors record `super().run()` as the name `super().run`, and no
 * strategy read that name, so every call through `super()` stayed unresolved. A
 * base class's `__init__` showed none of the subclasses that call it, and an
 * override never reached the method it extends.
 *
 * The target is what Python runs: the first class after the caller's in its
 * method resolution order that defines the name. With none in the project, as
 * for a base from a library, the call stays unlinked: a project method of that
 * name is no candidate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const KERNEL = path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const ARMS = [
  { arm: 'wasm', env: { CODEGRAPH_KERNEL: '0' } as Record<string, string> },
  ...(fs.existsSync(KERNEL) ? [{ arm: 'kernel', env: { CODEGRAPH_KERNEL_LANGS: 'python' } as Record<string, string> }] : []),
];

describe.each(ARMS)('a Python call through super() ($arm)', ({ env }) => {
  let root: string;
  let cg: CodeGraph;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const index = async (files: Record<string, string[]>): Promise<void> => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-super-'));
    for (const [file, lines] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), lines.join('\n') + '\n');
    }
    cg = await CodeGraph.init(root, { index: true });
  };

  const method = (qualified: string): Node =>
    [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualified)!;
  // Methods only: `super(B, self)` also mentions the class `B`.
  const callees = (qualified: string): string[] => cg.getCallees(method(qualified).id)
    .filter((c) => c.node.kind === 'method').map((c) => c.node.qualifiedName).sort();

  it('reaches the method of a base in the same file', async () => {
    await index({
      'same.py': [
        'class A:',
        '    def __init__(self):',
        '        self.x = 1',
        '',
        '    def run(self):',
        '        return 1',
        '',
        'class B(A):',
        '    def __init__(self):',
        '        super().__init__()',
        '',
        '    def run(self):',
        '        return super().run()',
      ],
    });
    expect(callees('B::__init__')).toEqual(['A::__init__']);
    expect(callees('B::run')).toEqual(['A::run']);
    expect(cg.getCallers(method('A::__init__').id).map((c) => c.node.qualifiedName)).toEqual(['B::__init__']);
  });

  it('reaches the method of a base in another file', async () => {
    await index({
      'pkg/__init__.py': [''],
      'pkg/base.py': ['class Base:', '    def __init__(self, name):', '        self.name = name'],
      'pkg/child.py': [
        'from pkg.base import Base',
        '',
        'class Child(Base):',
        '    def __init__(self, name):',
        '        super().__init__(',
        '            name,',
        '        )',
      ],
    });
    expect(callees('Child::__init__')).toEqual(['Base::__init__']);
  });

  it('skips a base that does not define the name', async () => {
    await index({
      'three.py': [
        'class A:',
        '    def run(self):',
        '        return 1',
        '',
        'class B(A):',
        '    pass',
        '',
        'class C(B):',
        '    def run(self):',
        '        return super().run()',
      ],
    });
    expect(callees('C::run')).toEqual(['A::run']);
  });

  it('calls a method other than the one it is written in', async () => {
    await index({
      'other.py': [
        'class A:',
        '    def helper(self):',
        '        return 1',
        '',
        'class B(A):',
        '    def helper(self):',
        '        return 2',
        '',
        '    def go(self):',
        '        return super().helper()',
      ],
    });
    expect(callees('B::go')).toEqual(['A::helper']);
  });

  it('reads the two-argument form', async () => {
    await index({
      'old.py': [
        'class A:',
        '    def run(self):',
        '        return 1',
        '',
        'class B(A):',
        '    def run(self):',
        '        return super(B, self).run()',
      ],
    });
    expect(callees('B::run')).toEqual(['A::run']);
  });

  it('stays out of a two-argument form that names another class', async () => {
    await index({
      'skip.py': [
        'class A:',
        '    def run(self):',
        '        return 1',
        '',
        'class B(A):',
        '    def run(self):',
        '        return 2',
        '',
        'class C(B):',
        '    def run(self):',
        '        return super(B, self).run()',
      ],
    });
    expect(callees('C::run')).toEqual([]);
  });

  it('works inside a function nested in a method', async () => {
    await index({
      'nested.py': [
        'class A:',
        '    def run(self):',
        '        return 1',
        '',
        'class B(A):',
        '    def run(self):',
        '        def inner():',
        '            return super(B, self).run()',
        '        return inner()',
      ],
    });
    expect(callees('B::run::inner')).toEqual(['A::run']);
  });

  it('follows the method resolution order across a diamond', async () => {
    await index({
      'diamond.py': [
        'class Root:',
        '    def run(self):',
        '        return 0',
        '',
        'class Left(Root):',
        '    pass',
        '',
        'class Right(Root):',
        '    def run(self):',
        '        return 1',
        '',
        'class Both(Left, Right):',
        '    def run(self):',
        '        return super().run()',
      ],
    });
    // Both, Left, Right, Root: Right comes before Root, depth first would say Root.
    expect(callees('Both::run')).toEqual(['Right::run']);
  });

  it('takes the bases in the order the class names them', async () => {
    await index({
      'order.py': [
        'class First:',
        '    def run(self):',
        '        return 1',
        '',
        'class Second:',
        '    def run(self):',
        '        return 2',
        '',
        'class Both(Second, First):',
        '    def run(self):',
        '        return super().run()',
      ],
    });
    expect(callees('Both::run')).toEqual(['Second::run']);
  });

  it('takes the last def of the name, below any overload stubs', async () => {
    await index({
      'stubs.py': [
        'from typing import overload',
        '',
        'class A:',
        '    @overload',
        '    def get(self, x: int) -> int: ...',     // 5
        '    @overload',
        '    def get(self, x: str) -> str: ...',     // 7
        '    def get(self, x):',                     // 8
        '        return x',
        '',
        'class B(A):',
        '    def get(self, x):',
        '        return super().get(x)',
      ],
    });
    expect(cg.getCallees(method('B::get').id).map((c) => c.node.startLine)).toEqual([8]);
  });

  it('stays unlinked when the base is from outside the project', async () => {
    await index({
      'app/models.py': [
        'from django.db import models',
        '',
        'class Site(models.Model):',
        '    def save(self):',
        '        return super().save()',
        '',
        '    def __init__(self):',
        '        super().__init__()',
        '',
        'class Unrelated:',
        '    def save(self):',
        '        return 1',
        '',
        '    def __init__(self):',
        '        self.x = 1',
      ],
      'app/save.py': ['def save():', '    return 1'],
    });
    expect(callees('Site::save')).toEqual([]);
    expect(callees('Site::__init__')).toEqual([]);
  });

  it('stays unlinked in a mixin, whose next class is not written down', async () => {
    await index({
      'mixin.py': [
        'class Mixin:',
        '    def run(self):',
        '        return super().run()',
        '',
        'class Other:',
        '    def run(self):',
        '        return 1',
      ],
    });
    expect(callees('Mixin::run')).toEqual([]);
  });
});
