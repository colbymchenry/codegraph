/**
 * A Python base the file imports from outside the project is that package's
 * class, plain or parameterized: `class Color(Enum)` after `from enum import
 * Enum` extends no project class that happens to be named `Enum`. Names the
 * file binds to the project, or doesn't bind at all, keep linking.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  'app/__init__.py': '',
  'app/schema.py': `class Enum:
    pass


class Sequence:
    pass


class Generic:
    pass


class Protocol:
    pass


class BaseModel:
    pass


class Thing:
    pass
`,
  'app/outside.py': `from enum import Enum
from typing import Generic, Protocol, Sequence, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Color(Enum):
    pass


class Plain(Sequence):
    pass


class Items(Sequence[int]):
    pass


class Box(Generic[T]):
    pass


class Greeter(Protocol[T]):
    pass


class Item(BaseModel):
    pass


class Row(BaseModel, Enum):
    pass
`,
  'app/inside.py': `from app.schema import Sequence

from .schema import Enum


class Mine(Enum):
    pass


class Seq(Sequence[int]):
    pass
`,
  'app/shadow.py': `from enum import Enum


class Enum(Enum):
    pass


class Own(Enum):
    pass
`,
  'app/fallback.py': `try:
    from pydantic import BaseModel
except ImportError:
    from .schema import BaseModel


class Either(BaseModel):
    pass
`,
  'app/starred.py': `from .schema import *


class Starred(Enum):
    pass
`,
  'app/relative.py': `from .moved import Thing


class Keep(Thing):
    pass
`,
  'lib/support/helpers/base.py': `class Base:
    pass
`,
  'tests/test_base.py': `from helpers.base import Base


class TestBase(Base):
    pass
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-outside-bases-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file:class` of what the class `name` in `file` extends. */
const bases = (file: string, name: string): string[] => {
  const node = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'class')!;
  expect(node, name).toBeDefined();
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'extends').map((e) => {
    const target = cg.getNode(e.target)!;
    return `${target.filePath}:${target.name}`;
  });
};

describe('a Python base imported from outside the project', () => {
  it('links no project class of that name, plain or parameterized', () => {
    expect(bases('app/outside.py', 'Color')).toEqual([]);
    expect(bases('app/outside.py', 'Plain')).toEqual([]);
    expect(bases('app/outside.py', 'Items')).toEqual([]);
    expect(bases('app/outside.py', 'Box')).toEqual([]);
    expect(bases('app/outside.py', 'Greeter')).toEqual([]);
    expect(bases('app/outside.py', 'Item')).toEqual([]);
    expect(bases('app/outside.py', 'Row')).toEqual([]);
  });

  it('keeps a base the file imports from the project', () => {
    expect(bases('app/inside.py', 'Mine')).toEqual(['app/schema.py:Enum']);
    expect(bases('app/inside.py', 'Seq')).toEqual(['app/schema.py:Sequence']);
  });

  it('keeps a class the file declares itself under the imported name', () => {
    expect(bases('app/shadow.py', 'Own')).toEqual(['app/shadow.py:Enum']);
  });

  it('keeps a base one of two imports of the name finds in the project', () => {
    expect(bases('app/fallback.py', 'Either')).toEqual(['app/schema.py:BaseModel']);
  });

  it('keeps a base no named import binds', () => {
    expect(bases('app/starred.py', 'Starred')).toEqual(['app/schema.py:Enum']);
  });

  it('keeps a base a relative import names, though that module is gone', () => {
    expect(bases('app/relative.py', 'Keep')).toEqual(['app/schema.py:Thing']);
  });

  it('keeps a class in a file the import path names, though no search root finds it', () => {
    expect(bases('tests/test_base.py', 'TestBase')).toEqual(['lib/support/helpers/base.py:Base']);
  });
});
