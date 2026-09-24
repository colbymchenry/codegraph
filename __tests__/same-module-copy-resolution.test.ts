/**
 * A module duplicated under another source root (`rc2/…` vs `rcpro2/…`) gives
 * every bare name two same-named candidates, one per copy. Directory proximity
 * is capped, so on a deep tree both copies score the same and the first-indexed
 * one used to win — a call in module B could land on module A's copy. The
 * caller's own copy, when it is uniquely closest, must win; when no copy is
 * closer (the caller sits above both), behavior is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

// Six shared segments already reach the proximity cap.
const ROOT = 'a/b/c/d/e/f';

function write(dir: string, rel: string, lines: string[]): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join('\n') + '\n');
}

describe('exact-name resolution prefers the caller\'s own copy of a duplicated module', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-same-module-'));
    for (const mod of ['rc2', 'rcpro2']) {
      write(tempDir, `${ROOT}/${mod}/util.py`, ['def compute():', '    return 1']);
      write(tempDir, `${ROOT}/${mod}/main.py`, ['def run():', '    return compute()']);
    }
    write(tempDir, `${ROOT}/rc2/only.py`, ['def solo():', '    return 2']);
    write(tempDir, `${ROOT}/rc2/solo_caller.py`, ['def use_solo():', '    return solo()']);
    // Equidistant from both copies.
    write(tempDir, `${ROOT}/top.py`, ['def top():', '    return compute()']);
  });

  afterEach(() => {
    cg?.destroy();
    cg = null;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
    }
  });

  async function callsFrom(fnName: string, filePath: string) {
    const caller = cg!.getNodesByKind('function').find((n) => n.name === fnName && n.filePath === filePath);
    expect(caller).toBeDefined();
    return cg!.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
  }

  function fn(name: string, filePath: string) {
    const node = cg!.getNodesByKind('function').find((n) => n.name === name && n.filePath === filePath);
    expect(node).toBeDefined();
    return node!;
  }

  it('resolves each module\'s call to its own copy', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const calls = await Promise.all(
      ['rc2', 'rcpro2'].map((mod) => callsFrom('run', `${ROOT}/${mod}/main.py`)),
    );
    expect(calls.map((c) => c.map((e) => e.target))).toEqual(
      ['rc2', 'rcpro2'].map((mod) => [fn('compute', `${ROOT}/${mod}/util.py`).id]),
    );
    expect(calls.map((c) => c[0]!.metadata?.confidence)).toEqual([0.8, 0.8]);
  });

  it('keeps the prior choice and confidence when the caller is equidistant', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const calls = await callsFrom('top', `${ROOT}/top.py`);
    expect(calls).toHaveLength(1);
    const copies = ['rc2', 'rcpro2'].map((m) => fn('compute', `${ROOT}/${m}/util.py`).id);
    expect(copies).toContain(calls[0]!.target);
    expect(calls[0]!.metadata?.confidence).toBe(0.7);
  });

  it('leaves a single-candidate name unaffected', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const calls = await callsFrom('use_solo', `${ROOT}/rc2/solo_caller.py`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(fn('solo', `${ROOT}/rc2/only.py`).id);
    expect(calls[0]!.metadata?.confidence).toBe(0.9);
  });
});
