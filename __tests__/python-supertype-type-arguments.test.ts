/**
 * A Python class's supertypes, as its head declares them, are the classes its
 * bases name — not their type arguments. `class Repo(Base[User])` extends
 * `Base`; reading every word of the base list also counted `User`, so a call on
 * the class or on a receiver named after it, `Repo.save()` / `repo.save()`,
 * reached `User.save` when `Base` declares no `save`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-supertype-type-args-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app/m.py'), `from typing import Generic, Optional, TypeVar

T = TypeVar("T")
U = TypeVar("U")


class Base(Generic[T]):
    def load(self):
        pass


class Pair(Generic[T, U]):
    def load(self):
        pass


class User:
    def save(self):
        pass


class Other:
    def save(self):
        pass


class Repo(Base[User]):
    pass


class Store(Pair[str, dict[str, User]]):
    pass


class Keyed(Base[User], metaclass=type):
    pass


class Forward(Base["Pair[str, User]"]):
    pass


class Mixin:
    def save(self):
        pass


class Mixed(Base[Optional[User]], Mixin):
    pass


def save_by_class():
    Repo.save()


def save_by_receiver(repo):
    repo.save()


def save_nested():
    Store.save()


def save_keyed():
    Keyed.save()


def save_forward():
    Forward.save()


def save_mixed():
    Mixed.save()


def load_by_class():
    Repo.load()


def load_nested():
    Store.load()
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

describe('a Python type argument is no supertype', () => {
  it('does not reach a method of the type argument', () => {
    expect(calls('save_by_class')).not.toContain('User::save');
    expect(calls('save_by_receiver')).not.toContain('User::save');
    expect(calls('save_nested')).not.toContain('User::save');
    expect(calls('save_keyed')).not.toContain('User::save');
    expect(calls('save_forward')).not.toContain('User::save');
  });

  it('still reaches the method the base declares', () => {
    expect(calls('load_by_class')).toEqual(['Base::load']);
    expect(calls('load_nested')).toEqual(['Pair::load']);
  });

  it('reaches a later base past the type argument that came first', () => {
    expect(calls('save_mixed')).toEqual(['Mixin::save']);
  });
});
