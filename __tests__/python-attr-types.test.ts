/**
 * Python attribute types a class body does not spell out itself (#1704, #750).
 *
 * `self.client.send()` resolves when the class body says what `self.client`
 * holds (python-attr-chain.test.ts). These are the two common ways it says so
 * only INDIRECTLY:
 *
 * - through a factory: `self.client = Client.from_env()` / `make_client()`,
 *   typed by the factory's `-> T` annotation or by what every `return` in its
 *   body constructs (the Python instance of the #750 chained-factory family);
 * - through a base class: `self.repo` assigned in a base's `__init__`, in
 *   another file, and used in a subclass.
 *
 * Each positive test plants a DISTRACTOR — a second project class with the same
 * method name — so a bare-name guess cannot pass it. Each negative test is a
 * shape where the type is unknowable or contested: silence, never a guess.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';

describe('python attribute types from factories and base classes', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-attr-types-'));
  });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const write = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  };

  const callsFrom = (name: string) => {
    const src = cg!.getNodesByKind('method').find((n) => n.name === name);
    expect(src).toBeDefined();
    return cg!
      .getOutgoingEdges(src!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .map((n) => `${n.qualifiedName}@${n.filePath.replace(/\\/g, '/')}`);
  };

  const DISTRACTOR = 'class Other:\n    def send(self):\n        pass\n\n    def save(self):\n        pass\n\n    def go(self):\n        pass\n';

  describe('factories', () => {
    it('types an attribute by a classmethod return annotation', async () => {
      write({
        'client.py': 'class Client:\n    @classmethod\n    def from_env(cls) -> "Client":\n        return cls()\n\n    def send(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import Client\n\nclass Svc:\n    def __init__(self):\n        self.client = Client.from_env()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('types an attribute by a classmethod that returns cls(...)', async () => {
      write({
        'client.py': 'class Client:\n    @classmethod\n    def from_env(cls):\n        return cls()\n\n    def send(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import Client\n\nclass Svc:\n    def __init__(self):\n        self.client = Client.from_env()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('types cls(...) as the class the factory is called on, not where it is defined', async () => {
      write({
        'base.py': 'class Base:\n    @classmethod\n    def create(cls):\n        return cls()\n\n    def send(self):\n        pass\n',
        'client.py': 'from base import Base\n\nclass Client(Base):\n    def send(self):\n        pass\n',
        'svc.py': 'from client import Client\n\nclass Svc:\n    def __init__(self):\n        self.client = Client.create()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('types an attribute by an imported factory function annotation', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef make_client() -> Client:\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import make_client\n\nclass Svc:\n    def __init__(self):\n        self.client = make_client()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('types an attribute by what an unannotated factory returns', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef make_client(url=None):\n    if url is None:\n        return None\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import make_client\n\nclass Svc:\n    def __init__(self):\n        self.client = make_client("x")\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('types a factory called through its module', async () => {
      write({
        'app/__init__.py': '',
        'app/clients.py': 'class Client:\n    def send(self):\n        pass\n\ndef build() -> "Client":\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from app import clients\n\nclass Svc:\n    def __init__(self):\n        self.client = clients.build()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@app/clients.py']);
    });

    it('stays silent when the factory returns something it cannot name', async () => {
      write({
        'client.py': 'REGISTRY = {}\n\nclass Client:\n    def send(self):\n        pass\n\ndef make_client(kind):\n    return REGISTRY[kind]()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import make_client\n\nclass Svc:\n    def __init__(self):\n        self.client = make_client("x")\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('types a factory only by returns that are whole calls, and by agreeing arms', async () => {
      const lib = 'class Client:\n    def send(self):\n        pass\n\n    def close(self):\n        pass\n\n'
        + 'class Fake:\n    def send(self):\n        pass\n\n'
        + 'class Pool:\n    def acquire(self):\n        return Client()\n\n    def close(self):\n        pass\n';
      write({
        'lib.py': lib,
        'f.py': 'from lib import Client, Fake, Pool\n\n'
          + 'def either(t):\n    return Client() if t else Fake()\n\n'
          + 'def wrapped(t):\n    return Client() \\\n        if t else Fake()\n\n'
          + 'def chained():\n    return Pool().acquire()\n\n'
          + 'def closed():\n    return Client().close()\n\n'
          + 'def same(t):\n    return Client(1) if t else Client(\n        2,\n    )\n\n'
          + 'def make_pool():\n    return Pool()\n',
        'svc.py': 'from f import either, wrapped, chained, closed, same, make_pool\n\n'
          + 'class Svc:\n    def __init__(self, t):\n'
          + '        self.a = either(t)\n        self.b = wrapped(t)\n        self.c = chained()\n'
          + '        self.d = closed()\n        self.e = same(t)\n        self.g = make_pool().acquire()\n\n'
          + '    def a_(self):\n        self.a.send()\n\n    def b_(self):\n        self.b.send()\n\n'
          + '    def c_(self):\n        self.c.close()\n\n    def d_(self):\n        self.d.send()\n\n'
          + '    def e_(self):\n        self.e.send()\n\n    def g_(self):\n        self.g.close()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('a_')).toEqual([]);
      expect(callsFrom('b_')).toEqual([]);
      expect(callsFrom('c_')).toEqual([]);
      expect(callsFrom('d_')).toEqual([]);
      expect(callsFrom('e_')).toEqual(['Client::send@lib.py']);
      expect(callsFrom('g_')).toEqual([]);
    });

    it('stays silent when the factory returns two different classes', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\nclass Fake:\n    def send(self):\n        pass\n\ndef make_client(test):\n    if test:\n        return Fake()\n    return Client()\n',
        'svc.py': 'from client import make_client\n\nclass Svc:\n    def __init__(self):\n        self.client = make_client(False)\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('stays silent for a generator or an un-awaited coroutine factory', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef clients():\n    yield Client()\n\nasync def connect():\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import clients, connect\n\nclass Svc:\n    def __init__(self):\n        self.a = clients()\n        self.b = connect()\n\n    def run(self):\n        self.a.send()\n        self.b.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('types an awaited coroutine factory', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\nasync def connect() -> Client:\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import connect\n\nclass Svc:\n    async def start(self):\n        self.client = await connect()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Client::send@client.py']);
    });

    it('stays silent when the returned class name is rebound locally', async () => {
      write({
        'signing.py': 'from loader import import_string\n\nclass Signer:\n    def unsign(self, v):\n        return v\n\ndef get_signer(backend):\n    Signer = import_string(backend)\n    return Signer()\n',
        'loader.py': 'def import_string(p):\n    return None\n',
        'other.py': 'class Other:\n    def unsign(self, v):\n        return v\n',
        'svc.py': 'from signing import Signer, get_signer\nfrom loader import import_string\n\nclass Svc:\n    def __init__(self, path):\n        self.a = get_signer(path)\n        Backend = import_string(path)\n        self.b = Backend()\n\n    def run(self):\n        self.a.unsign(1)\n        self.b.unsign(2)\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('keeps a parameter-typed attribute whose parameter shadows an imported module', async () => {
      write({
        'shapes/__init__.py': '',
        'shapes/box.py': 'class Box:\n    def substitute(self):\n        pass\n',
        'other.py': 'class Other:\n    def substitute(self):\n        pass\n',
        'shapes/table.py': 'from typing import Optional\nfrom . import box\n\nclass Table:\n    def __init__(self, box: Optional[box.Box] = None):\n        self.box = box\n\n    def run(self):\n        self.box.substitute()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Box::substitute@shapes/box.py']);
    });

    it('does not follow a factory imported from outside the project', async () => {
      write({
        'client.py': 'class Session:\n    def send(self):\n        pass\n\ndef session() -> Session:\n    return Session()\n',
        'svc.py': 'from requests import session\n\nclass Svc:\n    def __init__(self):\n        self.http = session()\n\n    def run(self):\n        self.http.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('does not let a same-named factory in another module answer', async () => {
      write({
        'p/__init__.py': '',
        'p/a.py': 'class Client:\n    def send(self):\n        pass\n\ndef make() -> Client:\n    return Client()\n',
        'q/__init__.py': '',
        'q/a.py': 'class Fake:\n    def send(self):\n        pass\n\ndef make() -> Fake:\n    return Fake()\n',
        'svc.py': 'from q.a import make\n\nclass Svc:\n    def __init__(self):\n        self.client = make()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Fake::send@q/a.py']);
    });
  });

  describe('chained factory calls (#750)', () => {
    it('resolves a method called straight on a factory result', async () => {
      write({
        'client.py': 'class Client:\n    @classmethod\n    def from_env(cls):\n        return cls()\n\n    def send(self):\n        pass\n\ndef make_client() -> Client:\n    return Client()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import Client, make_client\n\nclass Svc:\n    def run(self):\n        Client.from_env().send()\n        make_client().send()\n        Client().send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run').filter((c) => c.includes('send'))).toEqual([
        'Client::send@client.py', 'Client::send@client.py', 'Client::send@client.py',
      ]);
    });

    it('stays silent on a chained call through a factory it cannot type', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef make_client(kind):\n    return kind()\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from client import make_client\n\nclass Svc:\n    def run(self):\n        make_client(1).send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run').filter((c) => c.includes('send'))).toEqual([]);
    });
  });

  describe('base classes', () => {
    it('types an attribute assigned in a base class __init__ in another file', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'other.py': DISTRACTOR,
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Repo::save@repo.py']);
    });

    it('follows a chain of bases', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self, repo: Repo):\n        self.repo = repo\n',
        'mid.py': 'from base import Base\n\nclass Mid(Base):\n    pass\n',
        'other.py': DISTRACTOR,
        'child.py': 'from mid import Mid\n\nclass Child(Mid):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Repo::save@repo.py']);
    });

    it('lets the subclass own assignment shadow the base', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n\nclass Cache:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'child.py': 'from base import Base\nfrom repo import Cache\n\nclass Child(Base):\n    def __init__(self):\n        super().__init__()\n        self.repo = Cache()\n\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['Cache::save@repo.py']);
    });

    it('stays silent when an untyped subclass assignment shadows a typed base', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'other.py': DISTRACTOR,
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def __init__(self, repo):\n        super().__init__()\n        self.repo = repo\n\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('stays silent when two bases disagree', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n\nclass Cache:\n    def save(self):\n        pass\n',
        'bases.py': 'from repo import Repo, Cache\n\nclass A:\n    def __init__(self):\n        self.store = Repo()\n\nclass B:\n    def __init__(self):\n        self.store = Cache()\n',
        'child.py': 'from bases import A, B\n\nclass Child(A, B):\n    def run(self):\n        self.store.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });

    it('stays silent for a base class from outside the project', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'child.py': 'from django.views import View\n\nclass Child(View):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual([]);
    });
  });

  describe('already typed by PR-A (pinned)', () => {
    it('types a dotted constructor and a dotted annotation', async () => {
      write({
        'app/__init__.py': '',
        'app/models.py': 'class User:\n    def save(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'svc.py': 'import app.models\nfrom app import models\n\nclass Svc:\n    def __init__(self, u):\n        self.user = models.User()\n        self.other: app.models.User = u\n\n    def run(self):\n        self.user.save()\n        self.other.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['User::save@app/models.py', 'User::save@app/models.py']);
    });

    it('needs every branch of a conditional assignment to agree', async () => {
      write({
        'a.py': 'class A:\n    def go(self):\n        pass\n\nclass B:\n    def go(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'svc.py': 'from a import A, B\n\nclass Svc:\n    def __init__(self, f):\n        if f:\n            self.x = A(1)\n        else:\n            self.x = A(2)\n        try:\n            self.y = A()\n        except Exception:\n            self.y = B()\n\n    def run(self):\n        self.x.go()\n        self.y.go()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callsFrom('run')).toEqual(['A::go@a.py']);
    });
  });

  describe('sync converges to a fresh index', () => {
    const edgesOf = (graph: CodeGraph) =>
      graph
        .getNodesByKind('method')
        .filter((n) => n.name === 'run')
        .flatMap((n) => graph.getOutgoingEdges(n.id).filter((e) => e.kind === 'calls'))
        .map((e) => `${graph.getNode(e.target)!.qualifiedName}@${graph.getNode(e.target)!.filePath}`)
        .sort();

    const convergeAfter = async (edit: Record<string, string>) => {
      await cg!.sync();
      const synced = edgesOf(cg!);
      cg!.close();
      fs.rmSync(path.join(tempDir, '.codegraph'), { recursive: true, force: true });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(synced).toEqual(edgesOf(cg));
      void edit;
      return synced;
    };

    it('re-types an attribute when a factory in another file changes its return', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\nclass Fake:\n    def send(self):\n        pass\n',
        'factory.py': 'from client import Client, Fake\n\ndef make():\n    return Client()\n',
        'svc.py': 'from factory import make\n\nclass Svc:\n    def __init__(self):\n        self.client = make()\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual(['Client::send@client.py']);
      const edit = { 'factory.py': 'from client import Client, Fake\n\ndef make():\n    return Fake()\n' };
      write(edit);
      expect(await convergeAfter(edit)).toEqual(['Fake::send@client.py']);
    });

    it('types an attribute once an untyped factory gains an annotation', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'factory.py': 'from client import Client\n\ndef make(kind):\n    return kind()\n',
        'svc.py': 'from factory import make\n\nclass Svc:\n    def __init__(self):\n        self.client = make(1)\n\n    def run(self):\n        self.client.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual([]);
      const edit = { 'factory.py': 'from client import Client\n\ndef make(kind) -> Client:\n    return kind()\n' };
      write(edit);
      expect(await convergeAfter(edit)).toEqual(['Client::send@client.py']);
    });

    it('re-types an inherited attribute when the base __init__ changes', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n\nclass Cache:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo, Cache\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual(['Repo::save@repo.py']);
      const edit = { 'base.py': 'from repo import Repo, Cache\n\nclass Base:\n    def __init__(self):\n        self.repo = Cache()\n' };
      write(edit);
      expect(await convergeAfter(edit)).toEqual(['Cache::save@repo.py']);
    });

    it('drops an inherited edge when the base class file is deleted', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual(['Repo::save@repo.py']);
      fs.rmSync(path.join(tempDir, 'base.py'));
      expect(await convergeAfter({})).toEqual([]);
    });

    it('re-opens nothing when an edit touches no file an answer was read from', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.repo.save()\n',
        'unrelated.py': 'def f():\n    return 1\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      const spy = vi.spyOn((cg as unknown as { orchestrator: { resurrectTypeDependentEdges: (...a: unknown[]) => string[] } }).orchestrator, 'resurrectTypeDependentEdges');
      write({ 'unrelated.py': 'def f():\n    return 2\n' });
      await cg.sync();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.results[0]!.value).toEqual([]);
      expect(edgesOf(cg)).toEqual(['Repo::save@repo.py']);
    });

    it('retries a failed call in a file whose other attribute edge was re-opened', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\nclass Fake:\n    def send(self):\n        pass\n',
        'f.py': 'from client import Client, Fake\n\ndef make():\n    return Client()\n\ndef make2(k):\n    return k()\n',
        // Two classes in one file, both `run`: A's edge is re-opened by the
        // edit, B's call only now resolves.
        'svc.py': 'from f import make, make2\n\nclass A:\n    def __init__(self):\n        self.a = make()\n\n    def run(self):\n        self.a.send()\n\n'
          + 'class B:\n    def __init__(self):\n        self.b = make2(1)\n\n    def run(self):\n        self.b.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual(['Client::send@client.py']);
      write({ 'f.py': 'from client import Client, Fake\n\ndef make():\n    return Fake()\n\ndef make2(k) -> Client:\n    return k()\n' });
      expect(await convergeAfter({})).toEqual(['Client::send@client.py', 'Fake::send@client.py']);
    });

    it('types an attribute once the factory it imports comes into existence', async () => {
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'f.py': 'from client import Client\n\ndef make_v2():\n    return Client()\n',
        'svc.py': 'from f import make\n\nclass Svc:\n    def __init__(self):\n        self.c = make()\n\n    def run(self):\n        self.c.send()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual([]);
      write({ 'f.py': 'from client import Client\n\ndef make():\n    return Client()\n' });
      expect(await convergeAfter({})).toEqual(['Client::send@client.py']);
    });

    it('narrows the retry to what the edited file can reach when there are too many candidates', async () => {
      const svc = 'from client import make, helper\n\nclass Svc:\n    def __init__(self, x, y):\n'
        + '        self.c = make(1)\n        self.d = x\n        self.e = y\n        helper()\n\n'
        + '    def run(self):\n        self.c.send()\n        self.d.send()\n        self.e.send()\n';
      write({
        'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef make(k):\n    return k()\n\ndef helper():\n    pass\n',
        'other.py': DISTRACTOR,
        'svc.py': svc,
      });
      process.env.CODEGRAPH_PY_ATTR_RETRY_CEILING = '1';
      try {
        cg = await CodeGraph.init(tempDir, { index: true });
        expect(edgesOf(cg)).toEqual([]);
        // Three failed candidates, over the ceiling of 1: only `self.c` —
        // assigned from `make`, which the edited file defines — is kept.
        write({ 'client.py': 'class Client:\n    def send(self):\n        pass\n\ndef make(k) -> Client:\n    return k()\n\ndef helper():\n    pass\n' });
        expect(await convergeAfter({})).toEqual(['Client::send@client.py']);
      } finally {
        delete process.env.CODEGRAPH_PY_ATTR_RETRY_CEILING;
      }
    });

    it('drops an inherited edge when the base stops typing the attribute', async () => {
      write({
        'repo.py': 'class Repo:\n    def save(self):\n        pass\n',
        'other.py': DISTRACTOR,
        'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self):\n        self.repo = Repo()\n',
        'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.repo.save()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(edgesOf(cg)).toEqual(['Repo::save@repo.py']);
      const edit = { 'base.py': 'from repo import Repo\n\nclass Base:\n    def __init__(self, repo):\n        self.repo = repo\n' };
      write(edit);
      expect(await convergeAfter(edit)).toEqual([]);
    });
  });
});
