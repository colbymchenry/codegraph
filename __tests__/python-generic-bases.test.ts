/**
 * A Python class with a parameterized base, `class Leaf(Base[str])`, extends
 * `Base`. The grammar parses `Base[str]` in the base list as a `subscript`,
 * and the base-list reader took only bare identifiers and attributes, so such
 * a class had no `extends` edge at all. The reference now names the subscript's
 * value, on the wasm path and in the kernel alike (python is kernel-routed in
 * every published bundle, so each arm runs here; the kernel arm skips when no
 * kernel binary is staged, like the parity suites). The resolver's own reading
 * of a class's base list (`pythonBases`, behind module-global and
 * `self.` dispatch) drops the type arguments the same way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const FILES: Record<string, string> = {
  'app/models.py': `from typing import Generic, TypeVar

T = TypeVar("T")
U = TypeVar("U")


class Base(Generic[T]):
    def run(self):
        pass


class Pair(Generic[T, U]):
    pass


class Mixin:
    pass


class Meta(type):
    pass
`,
  'app/leaves.py': `from app import models
from app.models import Base, Pair, Mixin, Meta


class Plain(Base):
    pass


class Leaf(Base[str]):
    pass


class Nested(Base[list[int]]):
    pass


class Two(Pair[str, dict[str, int]]):
    pass


class Multi(
    Base[
        str
    ]
):
    pass


class Chained(Base[int][str]):
    pass


class Both(Mixin, Base[str]):
    pass


class Dotted(models.Base[int]):
    pass


class DottedPlain(models.Base):
    pass


class Keyword(Base[str], metaclass=Meta):
    pass


def make():
    return Base


class Computed(make()[0]):
    pass
`,
  'app/globals.py': `from typing import Generic, TypeVar

T = TypeVar("T")
U = TypeVar("U")


class Base(Generic[T]):
    def run(self):
        pass


class Pair(Generic[T, U]):
    def run(self):
        pass


class Other:
    def run(self):
        pass


class Plain(Base):
    pass


class Leaf(Base[str]):
    pass


class Two(Pair[str, dict[str, int]]):
    pass


current_a = Plain()
current_b = Leaf()
current_c = Two()


def use_plain():
    current_a.run()


def use_leaf():
    current_b.run()


def use_two():
    current_c.run()
`,
};

const arms = [
  { arm: 'wasm', env: { CODEGRAPH_KERNEL: '0' }, skip: false },
  { arm: 'kernel', env: { CODEGRAPH_KERNEL_LANGS: 'python' }, skip: !kernelAvailable },
];

describe.each(arms)('a parameterized Python base names its class ($arm)', ({ env, skip }) => {
  let root = '';
  let cg: CodeGraph;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    if (skip) return;
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-generic-bases-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    fs.writeFileSync(path.join(root, 'app/__init__.py'), '');
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Names of the classes `name` in app/leaves.py extends. */
  const bases = (name: string): string[] => {
    const node = cg.getNodesInFile('app/leaves.py').find((n) => n.name === name && n.kind === 'class')!;
    expect(node, name).toBeDefined();
    return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'extends')
      .map((e) => cg.getNode(e.target)!.name).sort();
  };

  it.skipIf(skip)('links Base[str], Base[list[int]] and Pair[str, dict[str, int]] like a plain base', () => {
    expect(bases('Plain')).toEqual(['Base']);
    expect(bases('Leaf')).toEqual(['Base']);
    expect(bases('Nested')).toEqual(['Base']);
    expect(bases('Two')).toEqual(['Pair']);
  });

  it.skipIf(skip)('links a parameterized base written over several lines', () => {
    expect(bases('Multi')).toEqual(['Base']);
  });

  it.skipIf(skip)('links nothing for a subscript of a subscript, Base[int][str]', () => {
    expect(bases('Chained')).toEqual([]);
  });

  it.skipIf(skip)('resolves a method a module global inherits through a parameterized base', () => {
    // Base, Pair and Other each declare `run`, so only the class's own bases pick
    // one; the globals are not named after their classes, so no name match does.
    /** Qualified names of the methods `fn` in app/globals.py calls. */
    const calls = (fn: string): string[] => {
      const node = cg.getNodesInFile('app/globals.py').find((n) => n.name === fn && n.kind === 'function')!;
      expect(node, fn).toBeDefined();
      return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.target)!).filter((n) => n.kind === 'method').map((n) => n.qualifiedName);
    };
    expect(calls('use_plain')).toEqual(['Base::run']);
    expect(calls('use_leaf')).toEqual(['Base::run']);
    expect(calls('use_two')).toEqual(['Pair::run']);
  });

  it.skipIf(skip)('keeps every base of a list that mixes plain and parameterized ones', () => {
    expect(bases('Both')).toEqual(['Base', 'Mixin']);
  });

  it.skipIf(skip)('links a module-qualified parameterized base like its plain form', () => {
    expect(bases('DottedPlain')).toEqual(['Base']);
    expect(bases('Dotted')).toEqual(['Base']);
  });

  it.skipIf(skip)('ignores a keyword argument and a base that is not a name', () => {
    expect(bases('Keyword')).toEqual(['Base']);
    expect(bases('Computed')).toEqual([]);
  });

  it.skipIf(skip)('links nothing for Generic[T], a class outside the project', () => {
    const base = cg.getNodesInFile('app/models.py').find((n) => n.name === 'Base' && n.kind === 'class')!;
    expect(cg.getOutgoingEdges(base.id).filter((e) => e.kind === 'extends')).toEqual([]);
  });
});
