/**
 * Python module-specifier resolution: one resolver for every Python import.
 *
 * An absolute dotted specifier (`pkg.sub.mod`) used to reach a file only
 * through a suffix match against ANY `…/pkg/sub/mod.py` in the repo. That
 * bound `import json` to a project's `app/utils/json.py`, and picked an
 * arbitrary twin when two services both carry `core/models.py`. Named imports
 * that an `__init__.py` re-exports got no edge at all. Each case below plants
 * a same-named decoy, so only the import can pick the right target.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractImportMappings } from '../src/resolution/import-resolver';

describe('Python module resolution', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pymod-'));
    cg = undefined;
  });

  afterEach(() => {
    if (cg) cg.destroy();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  /** `kind` edges leaving `fnName` in `file`, as `name@file` of each target. */
  function targets(fnName: string, file: string, kind: 'calls' | 'imports'): string[] {
    const src = cg!
      .getNodesInFile(file)
      .find((n) => n.name === fnName && (n.kind === 'function' || n.kind === 'file'));
    expect(src, `${fnName} in ${file}`).toBeDefined();
    return cg!
      .getOutgoingEdges(src!.id)
      .filter((e) => e.kind === kind)
      .map((e) => cg!.getNode(e.target))
      .map((n) => `${n!.name}@${n!.filePath.replace(/\\/g, '/')}`);
  }

  it('resolves an absolute dotted specifier to the module at a package root, not a same-named nested module', async () => {
    write({
      'pkg/__init__.py': '',
      'pkg/sub/__init__.py': '',
      'pkg/sub/mod.py': 'def run():\n    return 1\n',
      // `aaa.pkg.sub.mod` — ends in `pkg/sub/mod.py` but is not `pkg.sub.mod`.
      'aaa/__init__.py': '',
      'aaa/pkg/__init__.py': '',
      'aaa/pkg/sub/__init__.py': '',
      'aaa/pkg/sub/mod.py': 'def run():\n    return 2\n',
      'app/__init__.py': '',
      'app/main.py': `import pkg.sub.mod
from pkg.sub.mod import run


def qualified():
    pkg.sub.mod.run()


def named():
    run()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('qualified', 'app/main.py', 'calls')).toEqual(['run@pkg/sub/mod.py']);
    expect(targets('named', 'app/main.py', 'calls')).toEqual(['run@pkg/sub/mod.py']);
    expect(targets('main.py', 'app/main.py', 'imports')).toContain('mod.py@pkg/sub/mod.py');
    expect(targets('main.py', 'app/main.py', 'imports')).not.toContain('mod.py@aaa/pkg/sub/mod.py');
  });

  it('finds packages under a src/ layout from the __init__.py chain', async () => {
    write({
      'src/shop/__init__.py': '',
      'src/shop/cart.py': 'def total():\n    return 1\n',
      'legacy/__init__.py': '',
      'legacy/shop/__init__.py': '',
      'legacy/shop/cart.py': 'def total():\n    return 2\n',
      'tests/test_cart.py': `from shop.cart import total


def test_total():
    total()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('test_total', 'tests/test_cart.py', 'calls')).toEqual(['total@src/shop/cart.py']);
  });

  it('prefers the monorepo service that contains the importer', async () => {
    write({
      'svc_a/core/__init__.py': '',
      'svc_a/core/models.py': 'def save():\n    return 1\n',
      'svc_b/core/__init__.py': '',
      'svc_b/core/models.py': 'def save():\n    return 2\n',
      'svc_b/core/views.py': `import core.models


def view():
    core.models.save()
`,
      'svc_a/core/views.py': `import core.models


def view():
    core.models.save()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('views.py', 'svc_b/core/views.py', 'imports')).toContain('models.py@svc_b/core/models.py');
    expect(targets('views.py', 'svc_b/core/views.py', 'imports')).not.toContain('models.py@svc_a/core/models.py');
    expect(targets('views.py', 'svc_a/core/views.py', 'imports')).toContain('models.py@svc_a/core/models.py');
    expect(targets('views.py', 'svc_a/core/views.py', 'imports')).not.toContain('models.py@svc_b/core/models.py');
    expect(targets('view', 'svc_b/core/views.py', 'calls')).toEqual(['save@svc_b/core/models.py']);
    expect(targets('view', 'svc_a/core/views.py', 'calls')).toEqual(['save@svc_a/core/models.py']);
  });

  it('draws no edge when two package roots both provide the module and neither contains the importer', async () => {
    write({
      'svc_a/core/__init__.py': '',
      'svc_a/core/models.py': 'def save():\n    return 1\n',
      'svc_b/core/__init__.py': '',
      'svc_b/core/models.py': 'def save():\n    return 2\n',
      'tools/check.py': `import core.models


def check():
    core.models.save()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    // The import names no module this file can prove. (The `save()` call is
    // emitted as a bare name, which the name matcher still answers on its own.)
    const intoServices = (t: string) => t.includes('@svc_');
    expect(targets('check.py', 'tools/check.py', 'imports').filter(intoServices)).toEqual([]);
  });

  it('reads package roots declared in pyproject.toml, for namespace packages without __init__.py', async () => {
    write({
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
      'lib/nsp/tools.py': 'def go():\n    return 1\n',
      'vendor/__init__.py': '',
      'vendor/nsp/tools.py': 'def go():\n    return 2\n',
      'tests/test_tools.py': `import nsp.tools


def test_go():
    nsp.tools.go()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('test_go', 'tests/test_tools.py', 'calls')).toEqual(['go@lib/nsp/tools.py']);
  });

  it('resolves a namespace package from inside itself', async () => {
    write({
      'backend/myapp/models.py': 'def fetch():\n    return 1\n',
      'backend/myapp/views.py': `from myapp.models import fetch


def index():
    fetch()
`,
      'other/__init__.py': '',
      'other/myapp/__init__.py': '',
      'other/myapp/models.py': 'def fetch():\n    return 2\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('index', 'backend/myapp/views.py', 'calls')).toEqual(['fetch@backend/myapp/models.py']);
  });

  it('resolves a package import to its __init__.py', async () => {
    write({
      'shop/__init__.py': 'def checkout():\n    return 1\n',
      'misc/__init__.py': '',
      'misc/tools.py': 'def checkout():\n    return 2\n',
      'main.py': `import shop


def buy():
    shop.checkout()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('buy', 'main.py', 'calls')).toEqual(['checkout@shop/__init__.py']);
    expect(targets('main.py', 'main.py', 'imports')).toContain('__init__.py@shop/__init__.py');
  });

  it('follows __init__.py re-exports: relative, absolute, aliased, parenthesised and star', async () => {
    write({
      'shop/__init__.py': `from .billing.invoice import make_invoice
from shop.billing.tax import compute_tax as tax
from .cart import (
    add_item,  # the common multi-line form
    remove_item,
)
from .money import *
`,
      'shop/billing/__init__.py': '',
      'shop/billing/invoice.py': 'def make_invoice():\n    return 1\n',
      'shop/billing/tax.py': 'def compute_tax():\n    return 1\n',
      'shop/cart.py': 'def add_item():\n    return 1\n\n\ndef remove_item():\n    return 1\n',
      'shop/money.py': 'def to_cents():\n    return 1\n',
      // A same-named decoy for every re-exported name.
      'decoys/__init__.py': '',
      'decoys/all.py': `def make_invoice():
    return 2


def compute_tax():
    return 2


def tax():
    return 2


def add_item():
    return 2


def remove_item():
    return 2


def to_cents():
    return 2
`,
      'main.py': `from shop import make_invoice, tax, add_item, remove_item, to_cents


def order():
    make_invoice()
    tax()
    add_item()
    remove_item()
    to_cents()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('order', 'main.py', 'calls').sort()).toEqual([
      'add_item@shop/cart.py',
      'compute_tax@shop/billing/tax.py',
      'make_invoice@shop/billing/invoice.py',
      'remove_item@shop/cart.py',
      'to_cents@shop/money.py',
    ]);
  });

  it('terminates on a re-export cycle and draws no edge', async () => {
    write({
      'a/__init__.py': 'from b import thing\n',
      'b/__init__.py': 'from a import thing\n',
      'main.py': `from a import thing


def use():
    thing()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('use', 'main.py', 'calls')).toEqual([]);
  });

  it('never binds a stdlib or third-party import to a same-named module nested in the project', async () => {
    write({
      'app/__init__.py': '',
      'app/utils/__init__.py': '',
      'app/utils/json.py': 'def loads(s):\n    return s\n',
      'app/utils/yaml.py': 'def safe_load(s):\n    return s\n',
      'app/views.py': `import json
import yaml


def view():
    json.loads("1")
    yaml.safe_load("x")
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('view', 'app/views.py', 'calls')).toEqual([]);
    expect(targets('views.py', 'app/views.py', 'imports')).toEqual([]);
  });

  it('binds a top-level module the project really provides at a package root', async () => {
    write({
      'yaml.py': 'def safe_load(s):\n    return s\n',
      'app/__init__.py': '',
      'app/views.py': `import yaml


def view():
    yaml.safe_load("x")
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('view', 'app/views.py', 'calls')).toEqual(['safe_load@yaml.py']);
  });

  it('keeps script-directory imports: a sibling module of a file outside any package', async () => {
    write({
      'scripts/helpers.py': 'def helper():\n    return 1\n',
      'lib/__init__.py': '',
      'lib/helpers.py': 'def helper():\n    return 2\n',
      'scripts/run.py': `import helpers


def main():
    helpers.helper()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('main', 'scripts/run.py', 'calls')).toEqual(['helper@scripts/helpers.py']);
  });

  it('does not resolve a relative import that climbs above the top-level package', async () => {
    write({
      'helpers.py': 'def helper():\n    return 1\n',
      'pkg/__init__.py': '',
      'pkg/mod.py': `from .. import helpers


def use():
    helpers.helper()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('mod.py', 'pkg/mod.py', 'imports')).not.toContain('helpers.py@helpers.py');
    expect(targets('use', 'pkg/mod.py', 'calls')).toEqual([]);
  });
  // Before this change a Python named import never reached the import
  // resolver's member branch, so `send_welcome.delay()` stayed unresolved.
  // Now that it does, it must keep that answer rather than land on the task.
  it('keeps an attribute of an imported function unresolved, as before', async () => {
    write({
      'api/tasks.py': 'def send_welcome(item_id):\n    return item_id\n',
      'api/items.py': `from .tasks import send_welcome


def create():
    send_welcome.delay(1)
    send_welcome(2)
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    // `send_welcome.delay()` enqueues a Celery job; only the direct call is a call.
    const edges = cg
      .getOutgoingEdges(cg.getNodesInFile('api/items.py').find((n) => n.name === 'create')!.id)
      .filter((e) => e.kind === 'calls');
    expect(edges.map((e) => e.line)).toEqual([6]);
  });

  it('never lets a package nested in a test fixture capture an import from outside it', async () => {
    write({
      'app/__init__.py': '',
      'app/client.py': `import requests


def fetch():
    requests.get("x")
`,
      // A fixture project's own copy of a PyPI name — importable only by the
      // fixture's own code, never by the application.
      'tests/fixtures/proj/requests/__init__.py': 'def get(u):\n    return u\n',
      'tests/fixtures/proj/pyproject.toml': '[project]\nname = "proj"\n',
      'tests/fixtures/proj/use.py': `import requests


def use():
    requests.get("y")
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    const intoFixture = (t: string) => t.includes('@tests/fixtures/');
    expect(targets('client.py', 'app/client.py', 'imports').filter(intoFixture)).toEqual([]);
    expect(targets('fetch', 'app/client.py', 'calls').filter(intoFixture)).toEqual([]);
    // Inside its own subtree the fixture still resolves its own package.
    expect(targets('use', 'tests/fixtures/proj/use.py', 'calls')).toEqual(['get@tests/fixtures/proj/requests/__init__.py']);
  });

  it('never lets a package nested inside another package capture an import from outside it', async () => {
    write({
      'mylib/__init__.py': '',
      'mylib/_vendor/__init__.py': '',
      'mylib/_vendor/six.py': 'def ensure_str(s):\n    return s\n',
      'app/__init__.py': '',
      'app/main.py': `import six


def run():
    six.ensure_str("x")
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('run', 'app/main.py', 'calls')).toEqual([]);
  });

  it('treats src/ as a package root for a namespace package with no __init__.py and no build config', async () => {
    write({
      'src/shop/cart.py': 'def total():\n    return 0\n',
      'legacy/cart.py': 'def total():\n    return 9\n',
      'tests/test_cart.py': `from shop.cart import total


def test_it():
    total()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('test_cart.py', 'tests/test_cart.py', 'imports')).toContain('cart.py@src/shop/cart.py');
    expect(targets('test_it', 'tests/test_cart.py', 'calls')).toEqual(['total@src/shop/cart.py']);
  });

  it("reads a service's own src/ layout and nested build configs, scoped to their tables", async () => {
    write({
      // A monorepo service with a src/ layout and nothing at the repo root.
      'services/billing/pyproject.toml': '[project]\nname = "billing"\n',
      'services/billing/src/billing/__init__.py': '',
      'services/billing/src/billing/invoice.py': 'def make():\n    return 1\n',
      // A nested setup.cfg declaring its package directory.
      'services/auth/setup.cfg': '[metadata]\nname = auth\n\n[options]\npackage_dir =\n    =lib\n',
      'services/auth/lib/authn/tokens.py': 'def issue():\n    return 1\n',
      // `where` under an unrelated table must not declare a root.
      'pyproject.toml': '[tool.other]\nwhere = ["decoy"]\n',
      'decoy/authn/tokens.py': 'def issue():\n    return 2\n',
      'tools/run.py': `from billing.invoice import make
from authn.tokens import issue


def go():
    make()
    issue()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('go', 'tools/run.py', 'calls').sort()).toEqual([
      'issue@services/auth/lib/authn/tokens.py',
      'make@services/billing/src/billing/invoice.py',
    ]);
  });

  it('prefers a regular package over a same-named module, and a module over a namespace directory', async () => {
    write({
      'pkg.py': 'def f():\n    return "module"\n',
      'pkg/__init__.py': 'def f():\n    return "package"\n',
      'mod.py': 'def g():\n    return "module"\n',
      'mod/g.py': 'def g():\n    return "namespace"\n',
      'main.py': `from pkg import f
from mod import g


def go():
    f()
    g()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('go', 'main.py', 'calls').sort()).toEqual(['f@pkg/__init__.py', 'g@mod.py']);
  });

  it('honours __all__ on a star re-export, and skips _private names without one', async () => {
    write({
      'pkg/__init__.py': `from .impl import *
from .noall import *
from .priv import _priv
`,
      'pkg/impl.py': `__all__ = ["pub"]


def pub():
    return 1


def hidden():
    return 2


def _priv():
    return 3
`,
      'pkg/noall.py': `def hidden():
    return 4


def _priv():
    return 5


def util():
    return 6
`,
      'pkg/priv.py': 'def _priv():\n    return 7\n',
      'main.py': `from pkg import pub, hidden, _priv, util


def go():
    pub()
    hidden()
    _priv()
    util()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('go', 'main.py', 'calls').sort()).toEqual([
      '_priv@pkg/priv.py',
      'hidden@pkg/noall.py',
      'pub@pkg/impl.py',
      'util@pkg/noall.py',
    ]);
  });

  it('does not trust an __all__ assembled from other names, as django.db.models builds its own', async () => {
    write({
      'shop/__init__.py': 'from shop.models import *\n',
      'shop/models/__init__.py': `from shop.models.fields import *
from shop.models.fields import __all__ as fields_all

__all__ = fields_all + ["Model"]
__all__ += ["Manager"]
`,
      'shop/models/fields.py': '__all__ = ["CharField"]\n\n\nclass CharField:\n    pass\n',
      'decoy.py': 'class CharField:\n    pass\n',
      'main.py': `from shop import CharField


def build():
    CharField()
`,
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(cg.getOutgoingEdges(cg.getNodesInFile('main.py').find((n) => n.name === 'build')!.id)
      .map((e) => cg!.getNode(e.target)!.filePath)).toEqual(['shop/models/fields.py']);
  });

  it("lets the importer's own tree answer before a same-named module next to it", async () => {
    // A script run from `demo/` imports `utils.helpers`; `demo/utils/` also
    // holds a `utils.py`, which must not shadow the package it sits in.
    write({
      'demo/run.py': 'from utils.helpers import go\n',
      'demo/utils/helpers.py': 'def go():\n    return 1\n',
      'demo/utils/utils.py': 'def x():\n    return 1\n',
      'demo/utils/runner.py': `from utils.helpers import go


def main():
    go()
`,
      'pkg/__init__.py': '',
      'pkg/utils.py': 'def go():\n    return 2\n',
    });
    cg = await CodeGraph.init(tempDir, { index: true });

    expect(targets('runner.py', 'demo/utils/runner.py', 'imports')).toContain('helpers.py@demo/utils/helpers.py');
    expect(targets('main', 'demo/utils/runner.py', 'calls')).toEqual(['go@demo/utils/helpers.py']);
  });

  describe('from P import N: the package attribute before the submodule', () => {
    // CPython's `_handle_fromlist` looks N up on the package first and imports
    // the submodule P.N only when the package has no such attribute.
    it('binds a name the package __init__.py defines, not a same-named submodule', async () => {
      write({
        'pkg/__init__.py': 'def f():\n    return 0\n',
        'pkg/f.py': 'X = 1\n',
        'main.py': 'from pkg import f\n\n\ndef main():\n    f()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(targets('main.py', 'main.py', 'imports')).toEqual(['f@pkg/__init__.py']);
    });

    it('binds it through a relative import too', async () => {
      write({
        'pkg/__init__.py': '',
        'pkg/sub/__init__.py': 'def f():\n    return 0\n',
        'pkg/sub/f.py': 'X = 1\n',
        'pkg/a/__init__.py': '',
        'pkg/a/m.py': 'from ..sub import f\n\n\ndef main():\n    f()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(targets('m.py', 'pkg/a/m.py', 'imports')).toContain('f@pkg/sub/__init__.py');
      expect(targets('m.py', 'pkg/a/m.py', 'imports')).not.toContain('f.py@pkg/sub/f.py');
    });

    it('binds a name the package re-exports, not a same-named subpackage', async () => {
      write({
        'pkg/__init__.py': 'from .impl import thing\n',
        'pkg/impl.py': 'def thing():\n    return 1\n',
        'pkg/thing/__init__.py': '',
        'main.py': 'from pkg import thing\n\n\ndef main():\n    thing()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(targets('main.py', 'main.py', 'imports')).toEqual(['thing@pkg/impl.py']);
    });

    it('still binds the submodule when the package does not bind the name', async () => {
      write({
        'pkg/__init__.py': 'X = 1\n',
        'pkg/f.py': 'def g():\n    return 1\n',
        'main.py': 'from pkg import f\n\n\ndef main():\n    f.g()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(targets('main.py', 'main.py', 'imports')).toEqual(['f.py@pkg/f.py']);
      expect(targets('main', 'main.py', 'calls')).toEqual(['g@pkg/f.py']);
    });
  });

  describe('service roots under a shared test config', () => {
    const services = (extra: Record<string, string>) => ({
      'services/billing/pyproject.toml': '[project]\nname = "billing"\n',
      'services/billing/src/billing/__init__.py': '',
      'services/billing/src/billing/models.py': 'def charge():\n    return 1\n',
      'services/api/pyproject.toml': '[project]\nname = "api"\n',
      'services/api/src/api/__init__.py': '',
      'services/api/src/api/views.py': 'from billing.models import charge\n\n\ndef view():\n    charge()\n',
      ...extra,
    });
    const linked = () =>
      expect(targets('views.py', 'services/api/src/api/views.py', 'imports')).toContain(
        'models.py@services/billing/src/billing/models.py'
      );

    it('keeps a service a project root when a shared conftest.py sits above it', async () => {
      write(services({ 'services/conftest.py': 'import pytest\n' }));
      cg = await CodeGraph.init(tempDir, { index: true });
      linked();
    });

    it('keeps a service a project root when a smoke_test.py script sits above it', async () => {
      write(services({ 'services/smoke_test.py': 'print(1)\n' }));
      cg = await CodeGraph.init(tempDir, { index: true });
      linked();
    });

    it('lets sibling projects under examples/ import each other, but not the code outside', async () => {
      const moved = Object.fromEntries(
        Object.entries(services({})).map(([k, v]) => [k.replace('services/', 'examples/'), v])
      );
      write({
        ...moved,
        'app/__init__.py': '',
        'app/main.py': 'from billing.models import charge\n\n\ndef run():\n    charge()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(targets('views.py', 'examples/api/src/api/views.py', 'imports')).toContain(
        'models.py@examples/billing/src/billing/models.py'
      );
      expect(targets('main.py', 'app/main.py', 'imports')).not.toContain('models.py@examples/billing/src/billing/models.py');
    });
  });

  describe('sync', () => {
    /** Every Python calls/imports edge, as a sorted list of readable triples. */
    function pythonEdges(graph: CodeGraph): string[] {
      const out: string[] = [];
      for (const n of graph.getNodesByKind('function').concat(graph.getNodesByKind('file'))) {
        if (!n.filePath.endsWith('.py')) continue;
        for (const e of graph.getOutgoingEdges(n.id)) {
          if (e.kind !== 'calls' && e.kind !== 'imports') continue;
          const t = graph.getNode(e.target)!;
          out.push(`${e.kind} ${n.name}@${n.filePath} -> ${t.kind}:${t.name}@${t.filePath}`);
        }
      }
      return out.sort();
    }

    async function freshEdges(): Promise<string[]> {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pymod-fresh-'));
      try {
        fs.cpSync(tempDir, copy, { recursive: true, filter: (src) => !src.includes('.codegraph') });
        const fresh = await CodeGraph.init(copy, { index: true });
        const edges = pythonEdges(fresh);
        fresh.destroy();
        return edges;
      } finally {
        fs.rmSync(copy, { recursive: true, force: true });
      }
    }

    it('re-resolves unchanged importers when an __init__.py changes where a package starts', async () => {
      write({
        'a/b/__init__.py': '',
        'a/helpers.py': 'def h():\n    return 1\n',
        'a/b/mod.py': `from ..helpers import h


def use():
    h()
`,
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      // `a/b` is the top-level package, so `..helpers` climbs out of it.
      const before = pythonEdges(cg);
      expect(before).not.toContain('imports mod.py@a/b/mod.py -> file:helpers.py@a/helpers.py');

      write({ 'a/__init__.py': '' });
      await cg.sync();

      const fresh = await freshEdges();
      expect(fresh).toContain('imports mod.py@a/b/mod.py -> file:helpers.py@a/helpers.py');
      expect(pythonEdges(cg)).toEqual(fresh);
    });

    it('re-resolves when pyproject.toml declares a new package root', async () => {
      write({
        'lib/nsp/tools.py': 'def go():\n    return 1\n',
        'tests/test_tools.py': `import nsp.tools


def test_go():
    nsp.tools.go()
`,
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(pythonEdges(cg)).not.toContain('imports test_tools.py@tests/test_tools.py -> file:tools.py@lib/nsp/tools.py');

      write({ 'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n' });
      await cg.sync();

      const fresh = await freshEdges();
      expect(fresh).toContain('imports test_tools.py@tests/test_tools.py -> file:tools.py@lib/nsp/tools.py');
      expect(pythonEdges(cg)).toEqual(fresh);
    });

    /** Spies on both re-open paths of the orchestrator. */
    function spyReopen(graph: CodeGraph) {
      const orchestrator = (graph as unknown as { orchestrator: object }).orchestrator;
      return {
        all: vi.spyOn(orchestrator as { resurrectResolutionEdgesForLanguage: () => number }, 'resurrectResolutionEdgesForLanguage'),
        narrow: vi.spyOn(orchestrator as { resurrectResolutionEdgesTouching: () => number }, 'resurrectResolutionEdgesTouching'),
      };
    }

    const subpackageRepo = {
      'pkg/__init__.py': '',
      'pkg/core.py': 'def run():\n    return 1\n',
      'app/__init__.py': '',
      'app/main.py': `import pkg.core
from pkg.fresh.mod import go


def main():
    pkg.core.run()
    go()
`,
    };

    it('re-resolves only what a new subpackage touches, and matches a fresh index', async () => {
      write(subpackageRepo);
      cg = await CodeGraph.init(tempDir, { index: true });
      const spy = spyReopen(cg);

      write({ 'pkg/fresh/__init__.py': '', 'pkg/fresh/mod.py': 'def go():\n    return 1\n' });
      await cg.sync();

      const fresh = await freshEdges();
      expect(fresh).toContain('imports main.py@app/main.py -> file:mod.py@pkg/fresh/mod.py');
      expect(pythonEdges(cg)).toEqual(fresh);
      expect(spy.all).not.toHaveBeenCalled();
      expect(spy.narrow).toHaveBeenCalledTimes(1);
    });

    it('converges when a subpackage loses its __init__.py and a same-named module takes over', async () => {
      write({
        'pkg/__init__.py': '',
        'pkg/sub.py': 'def f():\n    return 1\n',
        'pkg/sub/__init__.py': '',
        'pkg/sub/x.py': 'def g():\n    return 2\n',
        'main.py': 'import pkg.sub.x\n\n\ndef main():\n    pkg.sub.x.g()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(pythonEdges(cg)).toContain('imports main.py@main.py -> file:x.py@pkg/sub/x.py');

      fs.rmSync(path.join(tempDir, 'pkg/sub/__init__.py'));
      await cg.sync();

      // `pkg.sub` is now the module `pkg/sub.py`, which has no `x`.
      const fresh = await freshEdges();
      expect(fresh).not.toContain('imports main.py@main.py -> file:x.py@pkg/sub/x.py');
      expect(pythonEdges(cg)).toEqual(fresh);
    });

    it('converges when an __init__.py makes a package shadow the same-named module', async () => {
      write({
        'pkg/__init__.py': '',
        'pkg/sub.py': 'def f():\n    return 1\n',
        'pkg/sub/g.py': 'def g():\n    return 2\n',
        'main.py': 'import pkg.sub\n\n\ndef main():\n    pkg.sub.f()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(pythonEdges(cg)).toContain('imports main.py@main.py -> file:sub.py@pkg/sub.py');

      write({ 'pkg/sub/__init__.py': '' });
      await cg.sync();

      const fresh = await freshEdges();
      expect(fresh).toContain('imports main.py@main.py -> file:__init__.py@pkg/sub/__init__.py');
      expect(pythonEdges(cg)).toEqual(fresh);
    });

    it('keeps the package binding when a same-named submodule is added, and matches a fresh index', async () => {
      write({
        'pkg/__init__.py': 'def f():\n    return 0\n',
        'main.py': 'from pkg import f\n\n\ndef main():\n    f()\n',
      });
      cg = await CodeGraph.init(tempDir, { index: true });
      const before = pythonEdges(cg);

      write({ 'pkg/f.py': 'X = 1\n' });
      await cg.sync();

      const fresh = await freshEdges();
      expect(fresh).toEqual(before);
      expect(pythonEdges(cg)).toEqual(fresh);
    });

    describe('an edited __init__.py moves what its importers bind', () => {
      const SUB = 'def run():\n    return "sub"\n';
      const MAIN = 'from pkg import N\n\n\ndef main():\n    N()\n    N.run()\n';
      const IMPL = 'class N:\n    def run(self):\n        return 1\n';

      async function editAndCompare(initial: Record<string, string>, edit: Record<string, string>, expected: string) {
        write(initial);
        cg = await CodeGraph.init(tempDir, { index: true });
        write(edit);
        await cg.sync();
        const fresh = await freshEdges();
        expect(fresh).toContain(expected);
        expect(pythonEdges(cg)).toEqual(fresh);
      }

      it('adding a def of N moves the import off the submodule (E1)', () =>
        editAndCompare(
          { 'pkg/__init__.py': 'X = 1\n', 'pkg/N.py': SUB, 'main.py': MAIN },
          { 'pkg/__init__.py': 'X = 1\n\n\ndef N():\n    return 0\n' },
          'imports main.py@main.py -> function:N@pkg/__init__.py'
        ));

      it('removing a def of N hands the import back to the submodule (E2)', () =>
        editAndCompare(
          { 'pkg/__init__.py': 'X = 1\n\n\ndef N():\n    return 0\n', 'pkg/N.py': SUB, 'main.py': MAIN },
          { 'pkg/__init__.py': 'X = 1\n' },
          'calls main@main.py -> function:run@pkg/N.py'
        ));

      it('removing a re-export of N hands the import back to the submodule (E4)', () =>
        editAndCompare(
          { 'pkg/__init__.py': 'X = 1\nfrom .impl import N\n', 'pkg/N.py': SUB, 'pkg/impl.py': IMPL, 'main.py': MAIN },
          { 'pkg/__init__.py': 'X = 1\n' },
          'imports main.py@main.py -> file:N.py@pkg/N.py'
        ));

      it('repointing a re-export moves the importer with it (B1)', () =>
        editAndCompare(
          {
            'pkg/__init__.py': 'from .impl import thing\n',
            'pkg/impl.py': 'def thing():\n    return 1\n',
            'pkg/impl2.py': 'def thing():\n    return 2\n',
            'main.py': 'from pkg import thing\n\n\ndef main():\n    thing()\n',
          },
          { 'pkg/__init__.py': 'from .impl2 import thing\n' },
          'calls main@main.py -> function:thing@pkg/impl2.py'
        ));
    });

    it('re-opens nothing on a sync that changes nothing', async () => {
      write(subpackageRepo);
      cg = await CodeGraph.init(tempDir, { index: true });
      const spy = spyReopen(cg);

      await cg.sync();

      expect(spy.all).not.toHaveBeenCalled();
      expect(spy.narrow).not.toHaveBeenCalled();
    });

    it('records a fingerprint for an index built before one existed, without re-resolving', async () => {
      write(subpackageRepo);
      cg = await CodeGraph.init(tempDir, { index: true });
      const queries = (cg as unknown as {
        queries: { getMetadata(k: string): string | null; db: { prepare(sql: string): { run(...a: unknown[]): unknown } } };
      }).queries;
      queries.db.prepare('DELETE FROM project_metadata WHERE key = ?').run('python_root_fingerprint');
      const spy = spyReopen(cg);

      write({ 'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n' });
      await cg.sync();

      expect(spy.all).not.toHaveBeenCalled();
      expect(queries.getMetadata('python_root_fingerprint')).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('import parsing', () => {
    const names = (code: string) =>
      extractImportMappings('m.py', code, 'python').map((m) => `${m.localName}<-${m.source}:${m.exportedName}`);

    it('reads a parenthesised multi-line list, with comments and a trailing comma', () => {
      expect(names('from .cart import (\n    add_item,  # note\n    remove_item as rm,\n)\n')).toEqual([
        'add_item<-.cart:add_item',
        'rm<-.cart:remove_item',
      ]);
    });

    it('reads backslash continuations and comma-separated plain imports, at any indentation', () => {
      expect(names('from a import b, \\\n    c\nimport os, pkg.sub as s\ndef f():\n    import lazy\n')).toEqual([
        'b<-a:b',
        'c<-a:c',
        'os<-os:*',
        's<-pkg.sub:*',
        'lazy<-lazy:*',
      ]);
    });

    it('ignores imports written inside a docstring or a comment', () => {
      expect(names('"""\nfrom fake import thing\nimport other\n"""\n# from nope import x\nimport real\n')).toEqual([
        'real<-real:*',
      ]);
    });
  });
});
