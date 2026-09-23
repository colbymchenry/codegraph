/**
 * A python call through an ATTRIBUTE CHAIN is a silent miss, never a guess
 * (#66 follow-up).
 *
 * Since #66 the extractor keeps the receiver's text, so `self.data.append(1)`
 * arrives as `self.data.append` rather than a bare `append`. The comment on that
 * change claimed the qualifier confined it to import/module-member resolution.
 * It did not: `matchMethodCall`'s dotMatch splits it into receiver `self.data` +
 * method `append`, and the bare-name strategies below then bound it to any
 * project method of that name.
 *
 * Go (#1276) and Rust (#1585) already treat a chained receiver as
 * validated-inference-or-nothing, and PHP's `this->prop.method` likewise.
 *
 * Every negative test here uses a DISTRACTOR — a second project symbol with the
 * same method name — because without one the old fallback found the right target
 * by single-candidate luck and the test would pass on both arms, proving
 * nothing. (That is exactly how an earlier version of this suite was vacuous.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';

describe('python attribute-chain receivers', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-chain-'));
  });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const callsFrom = (kind: 'function' | 'method', name: string) => {
    const src = cg!.getNodesByKind(kind).find((n) => n.name === name);
    expect(src).toBeDefined();
    return cg!
      .getOutgoingEdges(src!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .map((n) => `${n.kind}:${n.name}@${n.filePath.replace(/\\/g, '/')}`);
  };

  it('does not bind a self-attribute chain to an unrelated same-named method', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'sink.py'),
      'class Sink:\n    def append(self, x):\n        return x\n\n    def get(self, k):\n        return k\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'box.py'),
      'class Box:\n    def __init__(self):\n        self.data = []\n        self.inner = {}\n\n'
        + '    def build(self, k):\n        self.data.append(1)\n        rows = {}\n        rows[k] = []\n'
        + '        rows[k].append(2)\n        return self.inner.get(k)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    // `self.data` is a list and `self.inner` a dict; nothing in the graph says
    // so, which is exactly why guessing is wrong. Silence, not Sink.
    expect(callsFrom('method', 'build')).toEqual([]);
  });

  it('does not bind a deep chain either', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'leaf.py'),
      'class Leaf:\n    def go(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'deep.py'),
      'class Deep:\n    def __init__(self, a):\n        self.a = a\n\n'
        + '    def run(self, x):\n        return self.a.b.go(x)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('method', 'run')).toEqual([]);
  });

  it('does not bind a non-self chain to a same-named method', async () => {
    // The distractor matters: `Other.send` exists too, so a resolution here
    // could only ever be a guess between them.
    fs.writeFileSync(
      path.join(tempDir, 'kinds.py'),
      'class Client:\n    def send(self, x):\n        return x\n\n\nclass Other:\n    def send(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'use.py'),
      'def run(cfg, x):\n    return cfg.client.send(x)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('function', 'run')).toEqual([]);
  });

  // --- boundaries the gate must NOT cross -----------------------------------

  it('still resolves a single-segment receiver whose type is inferable', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'client.py'),
      'class Client:\n    def send(self, payload):\n        return payload\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'other.py'),
      'class Other:\n    def send(self, payload):\n        return payload\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'svc.py'),
      'from client import Client\n\n\ndef run(payload):\n    c = Client()\n    return c.send(payload)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    // With `Other.send` present, only the local-variable type inference can
    // pick the right one — and it still runs, because `c` has no dot in it.
    expect(callsFrom('function', 'run')).toEqual(['method:send@client.py']);
  });

  it('still resolves a module-qualified call, which is a different strategy', async () => {
    // A guard, not a gate test: `ledger.record` has a single-segment receiver,
    // so the gate never sees it. It is here because the gate sits in the same
    // function as the module path and a careless widening would take it out.
    fs.writeFileSync(path.join(tempDir, 'ledger.py'), 'def record(row):\n    return row\n');
    fs.writeFileSync(
      path.join(tempDir, 'use.py'),
      'from . import ledger\n\n\ndef save(row):\n    return ledger.record(row)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('function', 'save')).toContain('function:record@ledger.py');
  });

  // --- recall the qualifier must not cost ------------------------------------
  //
  // Before the receiver was kept, each of these arrived as a bare method name
  // and resolved by name. The qualifier routes them to evidence instead: the
  // module the import names, or the type the class body declares. Every case
  // carries a same-named distractor so a name-only guess cannot pass.

  const writeTree = (files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  };

  it('resolves a call through a dotted module path', async () => {
    writeTree({
      'app/__init__.py': '',
      'app/utils/__init__.py': '',
      'app/utils/helpers.py': 'def do_x():\n    return 1\n',
      'app/other.py': 'def do_x():\n    return 2\n',
      'app/main.py':
        'import app.utils.helpers\nfrom app import utils\n\n\n'
        + 'def full():\n    return app.utils.helpers.do_x()\n\n\n'
        + 'def via_package():\n    return utils.helpers.do_x()\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('function', 'full')).toEqual(['function:do_x@app/utils/helpers.py']);
    expect(callsFrom('function', 'via_package')).toEqual(['function:do_x@app/utils/helpers.py']);
  });

  it('resolves a class-attribute receiver through the class or cls', async () => {
    writeTree({
      'sink.py': 'class Sink:\n    def lookup(self, k):\n        return k\n',
      'main.py':
        'class Registry:\n    def lookup(self, k):\n        return k\n\n\n'
        + 'class Svc:\n    registry = Registry()\n\n'
        + '    def run(self):\n        return Svc.registry.lookup("k")\n\n'
        + '    @classmethod\n    def c(cls):\n        return cls.registry.lookup("k")\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('method', 'run')).toEqual(['method:lookup@main.py']);
    expect(callsFrom('method', 'c')).toEqual(['method:lookup@main.py']);
  });

  it('resolves a self attribute to the class the class body gives it', async () => {
    writeTree({
      'pkg/__init__.py': '',
      'pkg/a.py': 'class Capture:\n    def stop(self):\n        pass\n',
      'pkg/b.py': 'class Sink:\n    def stop(self):\n        pass\n',
      'pkg/models.py': 'class User:\n    def save(self):\n        pass\n\n\nclass Other:\n    def save(self):\n        pass\n',
      'pkg/main.py':
        'from pkg.a import Capture\nfrom pkg.b import Sink\nfrom pkg import models\n\n\n'
        + 'class Svc:\n    def __init__(self, cap: Capture):\n        self.cap = cap\n'
        + '        self.sink = Sink()\n        self.user = models.User()\n\n'
        + '    def by_param(self):\n        self.cap.stop()\n\n'
        + '    def by_ctor(self):\n        self.sink.stop()\n\n'
        + '    def by_module_type(self):\n        self.user.save()\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('method', 'by_param')).toEqual(['method:stop@pkg/a.py']);
    expect(callsFrom('method', 'by_ctor')).toEqual(['method:stop@pkg/b.py']);
    expect(callsFrom('method', 'by_module_type')).toEqual(['method:save@pkg/models.py']);
  });

  it('follows the attribute type to a method its base class declares', async () => {
    writeTree({
      'app/__init__.py': '',
      'app/capture.py': 'class Base:\n    def stop(self):\n        pass\n\n\nclass Capture(Base):\n    def start(self):\n        pass\n',
      'app/sink.py': 'class Sink:\n    def stop(self):\n        pass\n\n    def start(self):\n        pass\n',
      'app/main.py':
        'from app.capture import Capture\n\n\n'
        + 'class Svc:\n    def __init__(self):\n        self.cap = Capture()\n\n'
        + '    def run(self):\n        self.cap.start()\n        self.cap.stop()\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('method', 'run').sort()).toEqual(['method:start@app/capture.py', 'method:stop@app/capture.py']);
  });

  it('resolves an attribute of a typed local or parameter', async () => {
    writeTree({
      'models.py':
        'class Llm:\n    def rebuild(self):\n        pass\n\n\nclass Other:\n    def rebuild(self):\n        pass\n\n\n'
        + 'class Config:\n    llm: Llm\n\n\nclass App:\n    def __init__(self):\n        self.config = Config()\n',
      'use.py':
        'from models import App, Config\n\n\n'
        + 'def by_param(config: Config):\n    config.llm.rebuild()\n\n\n'
        + 'def by_local():\n    app = App()\n    app.config.llm.rebuild()\n    cfg = app.config\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('function', 'by_param')).toEqual(['method:rebuild@models.py']);
    // Two attribute hops is a deeper chain than the class body answers.
    expect(callsFrom('function', 'by_local')).toEqual([]);
  });

  it('leaves an attribute typed as an external class unresolved', async () => {
    writeTree({
      'session.py': 'class Session:\n    def get(self, url):\n        return url\n',
      'svc.py':
        'import requests\n\n\nclass Svc:\n    def __init__(self):\n        self.http = requests.Session()\n\n'
        + '    def fetch(self, url):\n        return self.http.get(url)\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(callsFrom('method', 'fetch')).toEqual([]);
  });

  it('types an attribute only by a call that is the whole assigned value', async () => {
    const lib =
      'class Client:\n    def send(self):\n        pass\n\n    def close(self):\n        pass\n\n\n'
      + 'class Fake:\n    def send(self):\n        pass\n\n\n'
      + 'class Pool:\n    def acquire(self):\n        return Client()\n\n    def close(self):\n        pass\n';
    writeTree({
      'lib.py': lib,
      'svc.py':
        'from lib import Client, Fake, Pool\n\n\nclass Svc:\n    def __init__(self, t):\n'
        + '        self.pooled = Pool().acquire()\n'
        + '        self.either = Client() if t else Fake()\n'
        + '        self.wrapped = Client() \\\n            if t else Fake()\n'
        + '        self.closed = Client().close()\n'
        + '        self.same = Client(1) if t else Client(2)\n'
        + '        self.multi = Client(\n            t,\n        )\n\n'
        + '    def pooled_(self):\n        self.pooled.close()\n\n'
        + '    def either_(self):\n        self.either.send()\n\n'
        + '    def wrapped_(self):\n        self.wrapped.send()\n\n'
        + '    def closed_(self):\n        self.closed.send()\n\n'
        + '    def multi_(self):\n        self.multi.send()\n\n'
        + '    def same_(self):\n        self.same.send()\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    // `Pool().acquire()` holds what `acquire` returns, not a Pool; a
    // conditional whose arms differ holds either; `Client().close()` holds what `close`
    // returns. A call spread over lines is still one whole call.
    expect(callsFrom('method', 'pooled_')).toEqual([]);
    expect(callsFrom('method', 'either_')).toEqual([]);
    expect(callsFrom('method', 'wrapped_')).toEqual([]);
    expect(callsFrom('method', 'closed_')).toEqual([]);
    expect(callsFrom('method', 'multi_')).toEqual(['method:send@lib.py']);
    // Both arms constructing the same class is that class.
    expect(callsFrom('method', 'same_')).toEqual(['method:send@lib.py']);
  });

  it('never skips a statement after a value that does not close', async () => {
    const lib = 'class Client:\n    def send(self):\n        pass\n\n\nclass Fake:\n    def send(self):\n        pass\n';
    const run = '    def run(self):\n        self.c.send()\n';
    writeTree({
      'lib.py': lib,
      // A string that merely mentions `self.c =` and has an unmatched `(`.
      'a.py': 'from lib import Client, Fake\n\n\nclass A:\n    def __init__(self):\n        self.c = Client()\n\n'
        + '    def check(self):\n        raise ValueError("self.c = must be set (")\n\n'
        + '    def reset(self):\n        self.c = Fake()\n\n' + run,
      // A continuation line `c=1)` at class-body indent reads like `c = 1)`.
      'b.py': 'from lib import Client, Fake\n\n\nclass B:\n    def __init__(self):\n        self.c = Client()\n\n'
        + '    opts = dict(\n    c=1)\n\n    def reset(self):\n        self.c = Fake()\n\n' + run,
      // A Python 3.12 f-string reusing its own quote inside the braces.
      'c.py': 'from lib import Client, Fake\n\n\nclass C:\n    def __init__(self):\n        self.c = Client()\n\n'
        + '    def check(self):\n        self.c = f"{\'"\'}"\n        self.c = Fake()\n\n' + run,
    });
    cg = await CodeGraph.init(tempDir, { index: true });
    // Each class also assigns `Fake()`, so the answer is contested: no edge.
    const runs = cg.getNodesByKind('method').filter((n) => n.name === 'run');
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(cg.getOutgoingEdges(r.id).filter((e) => e.kind === 'calls')).toEqual([]);
    }
  });
});
