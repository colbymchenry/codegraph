/**
 * Python calls of builtin-named methods through a typed local or parameter
 * (#2583).
 *
 * `get`, `update`, `items`, `pop`, `close` and the other dict/list/file method
 * names are dropped as builtins before any strategy can type the receiver.
 * When the function that binds the receiver says what it holds — a
 * constructor or a typed factory as the whole value, or a parameter's
 * annotation — the call is that project class's method. The negative cases
 * are the shapes where such typing produced a wrong edge in the reporter's
 * follow-up: the type's import, a later rebinding, a chained constructor,
 * module-level code, a union. Those stay unlinked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  // The issue's own files.
  'loader.py': `class SystemPackRegistry:
    def get(self, pack_id):
        return pack_id

    def update(self):
        return None

    def items(self):
        return []

    def pop(self, key):
        return key

    def close(self):
        return None


def load_registry() -> SystemPackRegistry:
    return SystemPackRegistry()


def make_registry():
    return SystemPackRegistry()


async def open_registry() -> "SystemPackRegistry":
    return SystemPackRegistry()
`,
  'test_packs.py': `from loader import SystemPackRegistry, load_registry


def test_pack():
    registry = load_registry()
    return registry.get("x")


def test_ctor():
    reg = SystemPackRegistry()
    reg.update()
    return reg.get("y")
`,
  'more.py': `from typing import Optional
import loader
from loader import SystemPackRegistry, make_registry, open_registry


def annotated(reg: SystemPackRegistry):
    reg.get("a")
    reg.items()


def quoted(reg: "SystemPackRegistry"):
    reg.pop("b")


def optional(reg: Optional[SystemPackRegistry] = None):
    reg.close()


def ctor_more():
    reg = SystemPackRegistry()
    reg.items()
    reg.pop("d")
    reg.close()


def through_module():
    reg = loader.SystemPackRegistry()
    reg.items()


def untyped_factory():
    reg = make_registry()
    reg.update()


async def awaited_factory():
    reg = await open_registry()
    reg.close()


def none_first(flag):
    reg = None
    if flag:
        reg = SystemPackRegistry()
    reg.update()


def annotated_local():
    reg: SystemPackRegistry = make_registry()
    reg.pop("e")


def closure():
    reg = SystemPackRegistry()

    def inner():
        return reg.get("f")
    return inner
`,
  // Two project classes named Handler: the import says which one.
  'a.py': `class Handler:
    def get(self):
        return "a"
`,
  'b.py': `class Handler:
    def get(self):
        return "b"
`,
  'handlers.py': `from b import Handler


def handle():
    h = Handler()
    return h.get()
`,
  // A method a declared base in another file has.
  'base.py': `class BaseStore:
    def update(self, data):
        return data
`,
  'derived.py': `from base import BaseStore


class Derived(BaseStore):
    pass


def refresh():
    d = Derived()
    d.update({})
`,
  // The reporter's follow-up: shapes the receiver typing must not link.
  'models.py': `class Queue:
    def get(self):
        return None


class Session:
    def get(self, url):
        return url

    def close(self):
        return None


class Store:
    def get(self, key):
        return key

    def update(self, data):
        return data

    def items(self):
        return []


class Foo:
    def build(self):
        return self

    def data(self):
        return {}


class Counter:
    def update(self, other):
        return other


class StringIO:
    def read(self):
        return ""
`,
  'traps.py': `import json
from queue import Queue
from requests import Session
from collections import Counter
from io import StringIO
from models import Store, Foo


def outside_import():
    q = Queue()
    q.get()
    s = Session()
    s.get("http://x")
    c = Counter()
    c.update("abc")
    buf = StringIO()
    buf.read()


def rebinding(p):
    reg = Store()
    reg = {}
    reg.get("k")
    data = Store()
    data = json.load(p)
    data.update({})


def branches(flag, rows, path):
    a = Store() if flag else {}
    a.get("k")
    if flag:
        b = Store()
    else:
        b = {}
    b.get("k")
    c = Store()
    for c in rows:
        c.items()
    d = Store()
    with open(path) as d:
        d.get("k")
    e = Store()
    return [e.get("k") for e in rows]


def chained():
    x = Foo().data()
    x.get("k")
    y = Foo().build()
    y.get("k")


def unions(reg: "Store | dict"):
    if isinstance(reg, dict):
        reg.get("k")


def unannotated(reg):
    reg.get("k")


def rebound_callee(load):
    Store = load()
    reg = Store()
    reg.get("k")


_store = Store()
_store = {}


def rebound_global():
    _store.get("k")
`,
  'modlevel.py': `from models import Store


def make():
    reg = Store()
    return reg


reg = {}
reg.get("k")
`,
  'outside_base.py': `from somepkg import BaseStore


class Child(BaseStore):
    pass


def use_child():
    ch = Child()
    ch.update({})
`,
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2583-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = await CodeGraph.init(dir, { index: true });
});

afterAll(() => {
  cg?.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The `calls` targets of the named function or method in `file`, as `qualifiedName@file`, sorted. */
function callsFrom(file: string, qualifiedName: string): string[] {
  const src = cg.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName &&
    (n.kind === 'function' || n.kind === 'method'));
  expect(src, `${file}:${qualifiedName}`).toBeDefined();
  return cg.getOutgoingEdges(src!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .filter((n) => n.kind === 'method')
    .map((n) => `${n.qualifiedName}@${n.filePath}`)
    .sort();
}

/** The `calls` edges into the file-level code of `file`, to methods. */
function moduleLevelCalls(file: string): string[] {
  const fileNode = cg.getNodesInFile(file).find((n) => n.kind === 'file');
  expect(fileNode).toBeDefined();
  return cg.getOutgoingEdges(fileNode!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .filter((n) => n.kind === 'method')
    .map((n) => `${n.qualifiedName}@${n.filePath}`);
}

describe('Python builtin-named methods through typed locals and parameters (#2583)', () => {
  it('links the issue\'s constructor-typed local', () => {
    expect(callsFrom('test_packs.py', 'test_ctor')).toEqual([
      'SystemPackRegistry::get@loader.py',
      'SystemPackRegistry::update@loader.py',
    ]);
  });

  it('links a local typed by its factory\'s return annotation', () => {
    expect(callsFrom('test_packs.py', 'test_pack')).toEqual(['SystemPackRegistry::get@loader.py']);
  });

  it('links calls through an annotated parameter, quoted or Optional too', () => {
    expect(callsFrom('more.py', 'annotated')).toEqual([
      'SystemPackRegistry::get@loader.py',
      'SystemPackRegistry::items@loader.py',
    ]);
    expect(callsFrom('more.py', 'quoted')).toEqual(['SystemPackRegistry::pop@loader.py']);
    expect(callsFrom('more.py', 'optional')).toEqual(['SystemPackRegistry::close@loader.py']);
  });

  it('links items, pop and close on a constructed local, and one made through the module', () => {
    expect(callsFrom('more.py', 'ctor_more')).toEqual([
      'SystemPackRegistry::close@loader.py',
      'SystemPackRegistry::items@loader.py',
      'SystemPackRegistry::pop@loader.py',
    ]);
    expect(callsFrom('more.py', 'through_module')).toEqual(['SystemPackRegistry::items@loader.py']);
  });

  it('links a local typed by what a factory returns, awaited or not', () => {
    expect(callsFrom('more.py', 'untyped_factory')).toEqual(['SystemPackRegistry::update@loader.py']);
    expect(callsFrom('more.py', 'awaited_factory')).toEqual(['SystemPackRegistry::close@loader.py']);
  });

  it('reads past a None placeholder and trusts a local annotation', () => {
    expect(callsFrom('more.py', 'none_first')).toEqual(['SystemPackRegistry::update@loader.py']);
    expect(callsFrom('more.py', 'annotated_local')).toEqual(['SystemPackRegistry::pop@loader.py']);
  });

  it('links a call in a nested function through the enclosing function\'s local', () => {
    expect(callsFrom('more.py', 'closure::inner')).toEqual(['SystemPackRegistry::get@loader.py']);
  });

  it('records the factory\'s file for a sync to re-open the call', () => {
    const src = cg.getNodesInFile('test_packs.py').find((n) => n.qualifiedName === 'test_pack')!;
    const edge = cg.getOutgoingEdges(src.id).find((e) => e.kind === 'calls' && cg.getNode(e.target)?.name === 'get');
    expect(edge?.metadata?.typeFrom).toEqual(['loader.py']);
  });

  it('takes the class the import names when two project classes share its name', () => {
    expect(callsFrom('handlers.py', 'handle')).toEqual(['Handler::get@b.py']);
  });

  it('links a method a declared base in another file has', () => {
    expect(callsFrom('derived.py', 'refresh')).toEqual(['BaseStore::update@base.py']);
  });

  it('links nothing for a class imported from outside the project that a project class is named like', () => {
    expect(callsFrom('traps.py', 'outside_import')).toEqual([]);
  });

  it('links nothing for a local rebound to a dict or to what json.load returns', () => {
    expect(callsFrom('traps.py', 'rebinding')).toEqual([]);
  });

  it('links nothing for a local bound in a branch, a loop, a with or a comprehension', () => {
    expect(callsFrom('traps.py', 'branches')).toEqual([]);
  });

  it('links nothing more for a local holding what a method of a constructed object returns', () => {
    expect(callsFrom('traps.py', 'chained')).toEqual(['Foo::build@models.py', 'Foo::data@models.py']);
  });

  it('links nothing for a union, an unannotated parameter, a rebound class name or a rebound global', () => {
    expect(callsFrom('traps.py', 'unions')).toEqual([]);
    expect(callsFrom('traps.py', 'unannotated')).toEqual([]);
    expect(callsFrom('traps.py', 'rebound_callee')).toEqual([]);
    expect(callsFrom('traps.py', 'rebound_global')).toEqual([]);
  });

  it('links nothing for module-level code, whatever a function above binds', () => {
    expect(moduleLevelCalls('modlevel.py')).toEqual([]);
  });

  it('links nothing for a method a base from outside the project could hold', () => {
    expect(callsFrom('outside_base.py', 'use_child')).toEqual([]);
  });
});

describe('sync after an edit to the file a typed local reads (#2583)', () => {
  let tmp: string;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (map: Record<string, string>) => {
    for (const [rel, text] of Object.entries(map)) fs.writeFileSync(path.join(tmp, rel), text);
  };

  const getCalls = (g: CodeGraph, qualifiedName: string): string[] => {
    const src = g.getNodesInFile('use.py').find((n) => n.qualifiedName === qualifiedName)!;
    return g.getOutgoingEdges(src.id).filter((e) => e.kind === 'calls')
      .map((e) => g.getNode(e.target)!).filter((n) => n.kind === 'method')
      .map((n) => `${n.qualifiedName}@${n.filePath}`).sort();
  };

  /** Syncs, then checks the synced graph against a fresh index of the same files. */
  const syncedMatchesFresh = async (qualifiedName: string): Promise<string[]> => {
    await graph!.sync();
    const synced = getCalls(graph!, qualifiedName);
    graph!.close();
    fs.rmSync(path.join(tmp, '.codegraph'), { recursive: true, force: true });
    graph = await CodeGraph.init(tmp, { index: true });
    expect(synced).toEqual(getCalls(graph, qualifiedName));
    return synced;
  };

  const USE = 'from loader import Registry, make\n\n\ndef ctor():\n    reg = Registry()\n    return reg.get("k")\n\n\ndef factory():\n    reg = make()\n    return reg.get("k")\n';

  it('re-types the local when the factory changes what it returns', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2583-sync-'));
    const classes = 'class Registry:\n    def get(self, k):\n        return k\n\n\nclass Other:\n    def get(self, k):\n        return k\n\n\n';
    write({ 'loader.py': `${classes}def make() -> Registry:\n    return Registry()\n`, 'use.py': USE });
    graph = await CodeGraph.init(tmp, { index: true });
    expect(getCalls(graph, 'factory')).toEqual(['Registry::get@loader.py']);
    write({ 'loader.py': `${classes}def make() -> Other:\n    return Other()\n` });
    expect(await syncedMatchesFresh('factory')).toEqual(['Other::get@loader.py']);
  });

  it('types the local once the factory gains a return annotation', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2583-sync-'));
    const cls = 'class Registry:\n    def get(self, k):\n        return k\n\n\n';
    write({ 'loader.py': `${cls}def make(kind):\n    return kind()\n`, 'use.py': USE });
    graph = await CodeGraph.init(tmp, { index: true });
    expect(getCalls(graph, 'factory')).toEqual([]);
    write({ 'loader.py': `${cls}def make(kind) -> Registry:\n    return kind()\n` });
    expect(await syncedMatchesFresh('factory')).toEqual(['Registry::get@loader.py']);
  });

  it('links the call once the class gains the method, and drops it when the class loses it', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2583-sync-'));
    const without = 'class Registry:\n    def other(self):\n        pass\n\n\ndef make():\n    return Registry()\n';
    const withGet = 'class Registry:\n    def other(self):\n        pass\n\n    def get(self, k):\n        return k\n\n\ndef make():\n    return Registry()\n';
    write({ 'loader.py': without, 'use.py': USE });
    graph = await CodeGraph.init(tmp, { index: true });
    expect(getCalls(graph, 'ctor')).toEqual([]);
    write({ 'loader.py': withGet });
    expect(await syncedMatchesFresh('ctor')).toEqual(['Registry::get@loader.py']);
    write({ 'loader.py': without });
    expect(await syncedMatchesFresh('ctor')).toEqual([]);
  });
});
