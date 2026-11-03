/**
 * A name a Python function binds locally — `flat = lambda h: …`, any
 * assignment, a `for`/`with … as`/`except … as` target — is what its calls
 * inside that function mean, even when a module-level function of the same
 * name sits in the same file (#3037): the local binding shadows it, and a
 * lambda binds no node of its own, so the call links nothing. A call outside
 * the shadowing function still means the module function, and a same-file
 * pytest fixture a test takes as a parameter of that name is still the
 * fixture (#2332's reading, now honored for same-file candidates too).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function callTargets(fromFunction: string): string[] {
  const fn = cg!.getNodesByKind('function').find((n) => n.name === fromFunction)!;
  expect(fn, `${fromFunction} should be in the index`).toBeDefined();
  return cg!
    .getOutgoingEdges(fn.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

async function indexed(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-lambda-shadow-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const MODULE_FN = 'def flat(html):\n    return html.strip()\n';

describe('a local binding shadows the same-file module function (#3037)', () => {
  it("the issue's repro: a lambda bound to the function's own `flat` is no call to the module's `flat`", async () => {
    await indexed({
      'mod.py': `import re


${MODULE_FN}

def test_one(plain):
    flat = lambda h: re.sub(r"\\s+", " ", h)
    return flat(plain)
`,
    });
    expect(callTargets('test_one')).not.toContain('function:flat@mod.py');
  });

  it('a call outside the shadowing function still links to the module function', async () => {
    await indexed({
      'mod.py': `import re


${MODULE_FN}

def test_one(plain):
    flat = lambda h: re.sub(r"\\s+", " ", h)
    return flat(plain)


def test_two(plain):
    return flat(plain)
`,
    });
    expect(callTargets('test_two')).toContain('function:flat@mod.py');
  });

  it('the shadow is the binding, not the lambda: a plain local rebinding shadows too', async () => {
    await indexed({
      'mod.py': `${MODULE_FN}

def make_local():
    return lambda h: h


def use(plain):
    flat = make_local()
    return flat(plain)
`,
    });
    expect(callTargets('use')).not.toContain('function:flat@mod.py');
  });

  it('a binding in one function does not shadow the name in another', async () => {
    await indexed({
      'mod.py': `${MODULE_FN}

def binder(plain):
    flat = lambda h: h
    return flat(plain)


def caller(plain):
    return flat(plain)
`,
    });
    expect(callTargets('caller')).toContain('function:flat@mod.py');
  });

  it('a same-file pytest fixture a test takes as a parameter is still the fixture', async () => {
    await indexed({
      'conftest-less.py': `import pytest


@pytest.fixture
def flat():
    return lambda h: h


def test_fixture(flat):
    return flat("x")
`,
    });
    expect(callTargets('test_fixture')).toContain('function:flat@conftest-less.py');
  });
});
