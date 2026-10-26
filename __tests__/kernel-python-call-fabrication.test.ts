/**
 * Python non-identifier call receivers must not fabricate edges — ON THE ARM
 * THAT SHIPS.
 *
 * `resolution.test.ts` already covers this end-to-end, but python is in the
 * kernel's DEFAULT_ROUTED set, so in a from-source checkout (no staged .node)
 * that test exercises the *wasm* TreeSitterExtractor while every published
 * bundle extracts python with codegraph-kernel/src/python.rs. A fix applied to
 * only one arm is a green test over code that never runs.
 *
 * This suite forces the kernel arm and asserts the same two properties:
 *   - `ledger.append(row)`, where `ledger` is an imported project module that
 *     exports `append`, RESOLVES (the false-negative half, #66).
 *   - `self.data.append(...)` / `rows[k].append(...)` — attribute-chain and
 *     subscript receivers — do NOT fabricate an edge to that same `append`
 *     (the false-positive half; `python.rs` used to emit a BARE `append`,
 *     which exact-matched the only project-wide symbol of that name).
 *
 * Skips when no kernel binary is staged, like the parity suites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

describe.skipIf(!kernelBuilt)('python call-receiver fabrication (kernel arm)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;
  let savedLangs: string | undefined;

  beforeEach(() => {
    savedLangs = process.env.CODEGRAPH_KERNEL_LANGS;
    process.env.CODEGRAPH_KERNEL_LANGS = 'python';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-fab-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (savedLangs === undefined) delete process.env.CODEGRAPH_KERNEL_LANGS;
    else process.env.CODEGRAPH_KERNEL_LANGS = savedLangs;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a module-qualified call and fabricates none from chained receivers (#66)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'ledger.py'),
      'def append(row):\n    return True\n\n\ndef path():\n    return "ledger.jsonl"\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'record.py'),
      'from . import ledger\n\n\ndef add_outcome(row):\n    if not ledger.append(row):\n        return None\n    return ledger.path()\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'unrelated.py'),
      'class Box:\n    def __init__(self):\n        self.data = []\n\n    def build_map(self):\n        self.data.append({"x": 1})\n        rows = {}\n        rows["k"] = []\n        rows["k"].append(2)\n        return rows\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const ledgerAppend = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'append' && n.filePath.replace(/\\/g, '/').endsWith('ledger.py'));
    expect(ledgerAppend).toBeDefined();

    const addOutcome = cg.getNodesByKind('function').find((n) => n.name === 'add_outcome');
    expect(addOutcome).toBeDefined();
    expect(
      cg
        .getOutgoingEdges(addOutcome!.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => e.target)
    ).toContain(ledgerAppend!.id);

    // Both non-identifier receivers live in build_map; neither may reach
    // ledger.py's append.
    const buildMap = cg.getNodesByKind('method').find((n) => n.name === 'build_map');
    expect(buildMap).toBeDefined();
    expect(
      cg
        .getOutgoingEdges(buildMap!.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => e.target)
    ).not.toContain(ledgerAppend!.id);
  });
});
