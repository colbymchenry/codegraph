/**
 * A Python base list wrapped over several lines — as black and ruff write a
 * long one, one base per line — is read whole by the resolver's own reader of
 * a class's bases (`pythonBases`, behind module-global and `self.` dispatch).
 * It read only the `class` line, so a module global holding such a class,
 * `current = Wrapped()` then `current.run()`, reached no method its bases
 * declare. Extraction already read the whole list.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-multiline-bases-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app/m.py'), `from typing import Generic, TypeVar

T = TypeVar("T")


class Base(Generic[T]):
    def run(self):
        pass


class Other:
    def run(self):
        pass


class Mixin:
    pass


class User:
    def save(self):
        pass


class Account:
    def save(self):
        pass


class OneLine(Mixin, Base):
    pass


class Wrapped(
    Mixin,
    Base,
):
    pass


class Commented(
    Mixin,  # no run here :)
    # the base that declares run:
    Base,
):
    pass


class WrappedGeneric(
    Mixin,
    Base[
        dict[str, int]
    ],
):
    pass


current_a = OneLine()
current_b = Wrapped()
current_c = Commented()
current_d = WrappedGeneric()


def use_one_line():
    current_a.run()


def use_wrapped():
    current_b.run()


def use_commented():
    current_c.run()


def use_wrapped_generic():
    current_d.run()


def keep(cls):
    return cls


@keep
class DecoratedOneLine(Mixin, Base):
    pass


@keep
class DecoratedWrapped(
    Mixin,
    Base,
):
    pass


def class_one_line(x):
    OneLine.run(x)


def class_wrapped(x):
    Wrapped.run(x)


def class_commented(x):
    Commented.run(x)


def class_decorated_one_line(x):
    DecoratedOneLine.run(x)


def class_decorated_wrapped(x):
    DecoratedWrapped.run(x)


class WrappedRepo(
    Mixin,
    Base[User],
):
    pass


def class_wrapped_base_method(x):
    WrappedRepo.run(x)


def class_wrapped_type_argument(x):
    WrappedRepo.save(x)
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

describe('a Python base list wrapped over several lines', () => {
  // Base and Other both declare `run`, and the globals are not named after
  // their classes, so only the class's own bases can pick one.
  it('resolves a module global through a one-line list (control)', () => {
    expect(calls('use_one_line')).toEqual(['Base::run']);
  });

  it('resolves a module global through a wrapped list', () => {
    expect(calls('use_wrapped')).toEqual(['Base::run']);
  });

  it('skips comments inside the list, parentheses and all', () => {
    expect(calls('use_commented')).toEqual(['Base::run']);
  });

  it('reads a parameterized base wrapped inside the list', () => {
    expect(calls('use_wrapped_generic')).toEqual(['Base::run']);
  });
});

// A call through the class name, `Wrapped.run(x)`, finds `run` through the
// supertypes the class head declares (`declaredSupertypes`), a second reader.
describe('a class-name call through a wrapped base list', () => {
  it('resolves through a one-line list (control)', () => {
    expect(calls('class_one_line')).toEqual(['Base::run']);
  });

  it('resolves through a wrapped list', () => {
    expect(calls('class_wrapped')).toEqual(['Base::run']);
  });

  it('skips comments inside the list, parentheses and all', () => {
    expect(calls('class_commented')).toEqual(['Base::run']);
  });

  it('reads the head of a decorated class, one line or wrapped', () => {
    expect(calls('class_decorated_one_line')).toEqual(['Base::run']);
    expect(calls('class_decorated_wrapped')).toEqual(['Base::run']);
  });

  it('keeps the base of a wrapped list and drops its type argument', () => {
    expect(calls('class_wrapped_base_method')).toEqual(['Base::run']);
    expect(calls('class_wrapped_type_argument')).toEqual([]);
  });
});
