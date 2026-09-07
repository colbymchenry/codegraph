/**
 * A python attribute's declared type, read from the AST, so
 * `self._capture.stop()` reaches the class the constructor assigns (#66
 * follow-up to the exclusive gate).
 *
 * Every negative test carries a DISTRACTOR — a second project symbol with the
 * same method name. Without one the old bare-name fallback found the right
 * target by single-candidate luck and the test passed on both arms, proving
 * nothing. That trap has already produced one vacuous suite in this area.
 *
 * The negatives are not hypothetical: each is a defect a review found in a
 * regex version of this reader, which scanned the class's source lines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';

describe('python self-attribute type inference', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-type-'));
  });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Two project classes with a `run` method — so a name match alone is a coin flip. */
  const writeKinds = () =>
    fs.writeFileSync(
      path.join(tempDir, 'kinds.py'),
      'class Real:\n    def run(self, x):\n        return x\n\n\n'
        + 'class Decoy:\n    def run(self, x):\n        return x\n'
    );

  const runCalls = async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go');
    expect(go).toBeDefined();
    return cg
      .getOutgoingEdges(go!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .map((n) => `${n.name}@${n.qualifiedName}`);
  };

  const box = (body: string) => fs.writeFileSync(path.join(tempDir, 'box.py'), body);

  // --- the four shapes python uses to name a type --------------------------

  it('reads a constructor assignment', async () => {
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('reads a typed __init__ parameter through the attribute assigned FROM it', async () => {
    // The DI idiom, and the one a name-based match gets wrong: the parameter is
    // `dep`, the attribute is `_dep`.
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    def __init__(self, dep: Real):\n        self._dep = dep\n\n'
      + '    def go(self, x):\n        return self._dep.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('reads a class-level annotation (dataclass / pydantic style)', async () => {
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    h: Real\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('unwraps Optional', async () => {
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.h: Optional[Real] = None\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('unwraps a `| None` union', async () => {
    // Split from Optional deliberately: one test declaring both attributes and
    // calling only one proved nothing about the other, which is how the first
    // version of this file left the `| None` branch unexercised.
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.j: Real | None = None\n\n'
      + '    def go(self, x):\n        return self.j.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  // --- what the tree refuses to be fooled by -------------------------------

  it('a type named in a DOCSTRING never wins over the real assignment', async () => {
    writeKinds();
    box('from kinds import Real, Decoy\n\n\nclass Box:\n    """Docs.\n\n    Example:\n'
      + '        self.h = Decoy()\n    """\n\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('a type named in a string literal donates nothing', async () => {
    writeKinds();
    box('from kinds import Decoy\n\n\nclass Box:\n    def __init__(self, h):\n'
      + '        self.tip = "set self.h = Decoy() to override"\n        self.h = h\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('a nested class’s __init__ does not donate to the outer class', async () => {
    writeKinds();
    box('from kinds import Real, Decoy\n\n\nclass Box:\n    class Nested:\n        def __init__(self):\n'
      + '            self.h = Decoy()\n\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('a type this file never imported is not taken from another file', async () => {
    // The attribute IS typed — `Client()` — so the cross-file question is
    // actually reached. (An earlier version left the attribute untyped, so the
    // reader produced nothing and the test passed without testing anything.)
    // `box.py` declares no `Client` and imports none, so there is no evidence
    // that `other.py`'s is the one meant.
    fs.writeFileSync(
      path.join(tempDir, 'other.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    box('class Box:\n    def __init__(self):\n        self.h = Client()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('an external library object written dotted does not bind to a project class', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'models.py'),
      'class Session:\n    def run(self, x):\n        return x\n'
    );
    box('import requests\n\n\nclass Box:\n    def __init__(self):\n        self.h = requests.Session()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('a bare-imported external class does not bind to a project class of that name', async () => {
    // The common spelling. Refusing only `requests.Session()` guarded the rare
    // form and let this one through, onto `models.Session`.
    fs.writeFileSync(
      path.join(tempDir, 'models.py'),
      'class Session:\n    def run(self, x):\n        return x\n'
    );
    box('from requests import Session\n\n\nclass Box:\n    def __init__(self):\n        self.h = Session()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('picks the imported class, not whichever same-named one is indexed first', async () => {
    fs.mkdirSync(path.join(tempDir, 'app'));
    fs.mkdirSync(path.join(tempDir, 'aaa_tests'));
    fs.writeFileSync(
      path.join(tempDir, 'aaa_tests', 'fakes.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'app', 'real.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'app', 'box.py'),
      'from app.real import Client\n\n\nclass Box:\n    def __init__(self):\n        self.h = Client()\n\n'
        + '    def go(self, x):\n        return self.h.run(x)\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go')!;
    const hit = cg
      .getOutgoingEdges(go.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'));
    expect(hit).toEqual(['app/real.py']);
  });

  it('an import written in a DOCSTRING does not decide the module', async () => {
    // `getImportMappings` is a regex over raw text, so a docstring's import is
    // indistinguishable from a real one and taking the first match bound this
    // to `decoy`. The AST refuses a docstring TYPE; the module question had to
    // be closed too. Disagreeing bindings mean no answer.
    writeKinds();
    box('"""Example usage.\n\n    from decoy import Real\n"""\nfrom kinds import Real\n\n\n'
      + 'class Box:\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    fs.writeFileSync(
      path.join(tempDir, 'decoy.py'),
      'class Real:\n    def run(self, x):\n        return x\n'
    );
    expect(await runCalls()).toEqual([]);
  });

  it('two candidate files under one module name resolve to neither', async () => {
    // `endsWith` matched `examples/services/client.py` for
    // `from services.client import Client`, and the first survivor won by
    // alphabetical path. Ambiguity is not a tiebreak.
    fs.mkdirSync(path.join(tempDir, 'services'));
    fs.mkdirSync(path.join(tempDir, 'examples'));
    fs.mkdirSync(path.join(tempDir, 'examples', 'services'));
    const cls = 'class Client:\n    def run(self, x):\n        return x\n';
    fs.writeFileSync(path.join(tempDir, 'services', 'client.py'), cls);
    fs.writeFileSync(path.join(tempDir, 'examples', 'services', 'client.py'), cls);
    box('from services.client import Client\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.h = Client()\n\n    def go(self, x):\n        return self.h.run(x)\n');
    const hit = await runCalls();
    expect(hit).toEqual(['run@Client::run']);
    // and it is the real one, not the alphabetically-first copy
    const go = cg!.getNodesByKind('method').find((n) => n.name === 'go')!;
    expect(
      cg!.getOutgoingEdges(go.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'))
    ).toEqual(['services/client.py']);
  });

  it('a parent-relative import resolves against the right package', async () => {
    // `from ..core import Client` climbs one package. Dropping the dot count
    // anchored it at the importing file's own directory, so it never resolved.
    fs.mkdirSync(path.join(tempDir, 'proj'));
    fs.mkdirSync(path.join(tempDir, 'proj', 'api'));
    fs.writeFileSync(
      path.join(tempDir, 'proj', 'core.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'proj', 'api', 'box.py'),
      'from ..core import Client\n\n\nclass Box:\n    def __init__(self):\n        self.h = Client()\n\n'
        + '    def go(self, x):\n        return self.h.run(x)\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go')!;
    expect(
      cg.getOutgoingEdges(go.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'))
    ).toEqual(['proj/core.py']);
  });

  it('an aliased import resolves under the exported name', async () => {
    writeKinds();
    box('from kinds import Real as R\n\n\nclass Box:\n    def __init__(self):\n        self.h = R()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('the constructor wins over a method written above it', async () => {
    // `put` is first-wins and the methods were walked in source order, so a
    // `reset()` above `__init__` decided the type.
    writeKinds();
    box('from kinds import Real, Decoy\n\n\nclass Box:\n    def reset(self):\n        self.h = Decoy()\n\n'
      + '    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('an inherited method resolves through the conformance pass', async () => {
    // `extends` edges do not exist in the first pass, so this shape is parked
    // and retried. Without the deferral a service subclass — the most ordinary
    // shape there is — got nothing.
    fs.writeFileSync(
      path.join(tempDir, 'base.py'),
      'class Base:\n    def zorp(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'other.py'),
      'class Unrelated:\n    def zorp(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'real.py'),
      'from base import Base\n\n\nclass Real(Base):\n    pass\n'
    );
    box('from real import Real\n\n\nclass Box:\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.zorp(x)\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go')!;
    expect(
      cg.getOutgoingEdges(go.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'))
    ).toEqual(['base.py']);
  });

  it('a class that inherits nothing does not inherit its namesake\'s base', async () => {
    // `getSupertypes` matches by NAME, so it unions the `extends` targets of
    // every class called `Real`. `b/real.py`'s Real inherits nothing; without a
    // unique receiver it was given `a/real.py`'s Base.
    fs.mkdirSync(path.join(tempDir, 'a'));
    fs.mkdirSync(path.join(tempDir, 'b'));
    fs.writeFileSync(
      path.join(tempDir, 'a', 'base.py'),
      'class Base:\n    def zorp(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'a', 'real.py'),
      'from a.base import Base\n\n\nclass Real(Base):\n    pass\n'
    );
    fs.writeFileSync(path.join(tempDir, 'b', 'real.py'), 'class Real:\n    pass\n');
    box('from b.real import Real\n\n\nclass Box:\n    def __init__(self):\n        self.h = Real()\n\n'
      + '    def go(self, x):\n        return self.h.zorp(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('resolves a package root that is not the repo root (src layout)', async () => {
    // `src/pkg/core.py` imported as `pkg.core` — the packaged-project default.
    // Anchoring only at the repo root made every such edge disappear.
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.mkdirSync(path.join(tempDir, 'src', 'pkg'));
    fs.mkdirSync(path.join(tempDir, 'src', 'pkg', 'api'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'pkg', 'core.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'pkg', 'api', 'box.py'),
      'from pkg.core import Client\n\n\nclass Box:\n    def __init__(self):\n        self.h = Client()\n\n'
        + '    def go(self, x):\n        return self.h.run(x)\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go')!;
    expect(
      cg.getOutgoingEdges(go.id).filter((e) => e.kind === 'calls')
        .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'))
    ).toEqual(['src/pkg/core.py']);
  });

  it('follows a re-export through a package __init__.py', async () => {
    fs.mkdirSync(path.join(tempDir, 'pkg'));
    fs.writeFileSync(
      path.join(tempDir, 'pkg', 'core.py'),
      'class Client:\n    def run(self, x):\n        return x\n'
    );
    fs.writeFileSync(path.join(tempDir, 'pkg', '__init__.py'), 'from pkg.core import Client\n');
    box('from pkg import Client\n\n\nclass Box:\n    def __init__(self):\n        self.h = Client()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const go = cg.getNodesByKind('method').find((n) => n.name === 'go')!;
    expect(
      cg.getOutgoingEdges(go.id).filter((e) => e.kind === 'calls')
        .map((e) => cg!.getNode(e.target)!.filePath.replace(/\\/g, '/'))
    ).toEqual(['pkg/core.py']);
  });

  it('a commented-out import does not cancel the real one', async () => {
    // The mappings come from a regex with no comment stripping, so the
    // agreement rule saw a disagreement that is not in the code.
    writeKinds();
    box('# from legacy import Real\nfrom kinds import Real\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.h = Real()\n\n    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });

  it('a factory call is not mistaken for a type', async () => {
    writeKinds();
    box('from kinds import Real\n\n\ndef make_client():\n    return Real()\n\n\n'
      + 'class Box:\n    def __init__(self):\n        self.h = make_client()\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('a plain container stays a silent miss', async () => {
    writeKinds();
    box('class Box:\n    def __init__(self):\n        self.h = []\n        self.k: list[int] = []\n\n'
      + '    def go(self, x):\n        self.k.run(x)\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('a builtin name is refused even where the project shadows it', async () => {
    // `self.h: dict` names the builtin, whatever a project class of that name
    // says. Without the builtin list the class lookup would find this `dict`
    // and bind to it — the generics check does not fire on a bare name.
    fs.writeFileSync(
      path.join(tempDir, 'shadow.py'),
      'class dict:\n    def run(self, x):\n        return x\n'
    );
    box('from shadow import dict\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.h: dict = {}\n\n    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('an annotation beats a constructor call written earlier', async () => {
    writeKinds();
    box('from kinds import Real, Decoy\n\n\nclass Box:\n    def __init__(self):\n        self.h = Decoy()\n\n'
      + '    def wire(self, c):\n        self.h: Real = c\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });
});
