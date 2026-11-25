/**
 * A Python class with PEP 695 type parameters, `class Repo[T](Base[T]):`,
 * names its bases after the parameter list. The resolver's base-list reader
 * (`pythonBaseList`, behind module-global, `self.` and class-name dispatch)
 * expected `(` right after the name, so such a class had no bases there.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-pep695-bases-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app/m.py'), `class Base[T]:
    def run(self):
        pass


class Other:
    def run(self):
        pass


class Mixin:
    pass


class Classic(Mixin, Base):
    pass


class Repo[T](Base[T]):
    pass


class Bounded[T: dict[str, int], *Ts, **P](Mixin, Base[T]):
    pass


class Constrained[T: (int, str)](Mixin, Base[T]):
    pass


class WrappedParams[
    K,
    V: (int, str),
](
    Mixin,
    Base[V],
):
    pass


class NoBases[T]:
    pass


current_a = Classic()
current_b = Repo()
current_c = Bounded()
current_d = Constrained()
current_e = WrappedParams()


def global_classic():
    current_a.run()


def global_repo():
    current_b.run()


def global_bounded():
    current_c.run()


def global_constrained():
    current_d.run()


def global_wrapped_params():
    current_e.run()


def class_classic(x):
    Classic.run(x)


def class_repo(x):
    Repo.run(x)


def class_bounded(x):
    Bounded.run(x)


def class_constrained(x):
    Constrained.run(x)


def class_wrapped_params(x):
    WrappedParams.run(x)


def class_no_bases(x):
    NoBases.run(x)
`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** Qualified names of the methods `fn` calls. */
const calls = (fn: string): string[] => {
  const node = cg.getNodesInFile('app/m.py').find((n) => n.name === fn && n.kind === 'function')!;
  expect(node, fn).toBeDefined();
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).filter((n) => n.kind === 'method').map((n) => n.qualifiedName);
};

// Base and Other both declare `run`, and the globals are not named after their
// classes, so only the class's own bases can pick one.
describe('a Python class with PEP 695 type parameters', () => {
  it('resolves through a classic base list (control)', () => {
    expect(calls('global_classic')).toEqual(['Base::run']);
    expect(calls('class_classic')).toEqual(['Base::run']);
  });

  it('reads the bases after a type parameter list', () => {
    expect(calls('global_repo')).toEqual(['Base::run']);
    expect(calls('class_repo')).toEqual(['Base::run']);
  });

  it('skips bounds with brackets, *Ts and **P in the parameter list', () => {
    expect(calls('global_bounded')).toEqual(['Base::run']);
    expect(calls('class_bounded')).toEqual(['Base::run']);
  });

  it('does not take a constraint tuple for the base list', () => {
    expect(calls('global_constrained')).toEqual(['Base::run']);
    expect(calls('class_constrained')).toEqual(['Base::run']);
  });

  it('reads a parameter list and a base list both wrapped over several lines', () => {
    expect(calls('global_wrapped_params')).toEqual(['Base::run']);
    expect(calls('class_wrapped_params')).toEqual(['Base::run']);
  });

  it('links each such class to its base with an extends edge', () => {
    const base = cg.getNodesInFile('app/m.py').find((n) => n.name === 'Base' && n.kind === 'class')!;
    for (const name of ['Repo', 'Bounded', 'Constrained', 'WrappedParams']) {
      const cls = cg.getNodesInFile('app/m.py').find((n) => n.name === name && n.kind === 'class')!;
      const targets = cg.getOutgoingEdges(cls.id).filter((e) => e.kind === 'extends').map((e) => e.target);
      expect(targets, name).toContain(base.id);
    }
  });

  it('gives a parameterized class without bases none', () => {
    expect(calls('class_no_bases')).not.toContain('Base::run');
    expect(calls('class_no_bases')).not.toContain('Other::run');
  });
});
