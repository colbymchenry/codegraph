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
});
