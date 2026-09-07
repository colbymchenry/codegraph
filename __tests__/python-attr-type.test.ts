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

  it('unwraps Optional and a `| None` union', async () => {
    writeKinds();
    box('from kinds import Real\n\n\nclass Box:\n    def __init__(self):\n'
      + '        self.h: Optional[Real] = None\n        self.j: Real | None = None\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
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

  it('a same-named class in another file donates nothing', async () => {
    writeKinds();
    fs.writeFileSync(
      path.join(tempDir, 'other.py'),
      'from kinds import Decoy\n\n\nclass Box:\n    def __init__(self):\n        self.h = Decoy()\n'
    );
    box('class Box:\n    def __init__(self, h):\n        self.h = h\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual([]);
  });

  it('an external library object does not bind to a same-named project class', async () => {
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

  it('an annotation beats a constructor call written earlier', async () => {
    writeKinds();
    box('from kinds import Real, Decoy\n\n\nclass Box:\n    def __init__(self):\n        self.h = Decoy()\n\n'
      + '    def wire(self, c):\n        self.h: Real = c\n\n'
      + '    def go(self, x):\n        return self.h.run(x)\n');
    expect(await runCalls()).toEqual(['run@Real::run']);
  });
});
