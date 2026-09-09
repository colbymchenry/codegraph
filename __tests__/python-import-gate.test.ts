/**
 * The python built-in-method filter's escape hatch must open only for a module
 * that is IN THIS PROJECT (#66 follow-up).
 *
 * The filter drops `x.append(...)` so a bare `append` cannot bind to an
 * unrelated project function. The escape exists because a project module can
 * export a top-level `append`, and `ledger.append(row)` is a real dependency.
 *
 * Asking only "does some import bind this local name" is not that test: every
 * import produces a mapping, stdlib and PyPI included. It opened the filter for
 * `os` and `requests` too, and with no project file to resolve to, the ref fell
 * through to the bare-name strategy and bound `os.remove(p)` to a project
 * method named `remove` — the exact fabrication the filter prevents, arriving
 * through its own escape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';

describe('python built-in-method escape is gated on the project', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-gate-'));
  });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const callsFrom = (name: string) => {
    const src = cg!.getNodesByKind('function').find((n) => n.name === name);
    expect(src).toBeDefined();
    return cg!
      .getOutgoingEdges(src!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target))
      .filter(Boolean);
  };

  it('does not bind a stdlib or third-party receiver to a same-named project method', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'store.py'),
      'class Store:\n    def remove(self, key):\n        return key\n\n    def get(self, key):\n        return key\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'cleanup.py'),
      'import os\nimport requests\n\n\ndef cleanup(p, url):\n    os.remove(p)\n    return requests.get(url)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    // Neither `os` nor `requests` is a file in this project, so neither call
    // may reach Store's methods. A silent miss is the correct answer.
    expect(callsFrom('cleanup').map((n) => `${n!.name}@${n!.filePath}`)).toEqual([]);
  });

  it('still resolves a call into a project module that exports the name', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'ledger.py'),
      'def append(row):\n    return True\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'record.py'),
      'from . import ledger\n\n\ndef add_outcome(row):\n    return ledger.append(row)\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const ledgerAppend = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'append' && n.filePath.replace(/\\/g, '/').endsWith('ledger.py'));
    expect(ledgerAppend).toBeDefined();
    expect(callsFrom('add_outcome').map((n) => n!.id)).toContain(ledgerAppend!.id);
  });
});
