/**
 * The python attribute-type reader, exercised through the BUILT BINARY — the
 * only path that proves it runs at all.
 *
 * The reader needs the python grammar loaded on the thread that RESOLVES. A full
 * index routes parsing to `dist/extraction/parse-worker.js`, so the main thread
 * loads no grammar; from source that worker does not exist, every in-process
 * test takes the fallback branch, and the whole feature can be dead in the
 * shipped build while the suite is green. It was: `codegraph index` produced no
 * attribute edges and `codegraph sync` produced them, so the graph depended on
 * how a file happened to be indexed last.
 *
 * That is the same trap the kernel/wasm split set on this branch two commits
 * earlier. A source-only test cannot catch it, so this one runs the binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(args: string[], cwd: string): void {
  execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Where `Recorder.halt`'s calls edges land. */
function haltTargets(dir: string): string[] {
  const cg = CodeGraph.openSync(dir);
  try {
    const halt = cg.getNodesByKind('method').find((n) => n.name === 'halt');
    if (!halt) return [];
    return cg
      .getOutgoingEdges(halt.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!)
      .map((n) => `${n.name}@${n.filePath.replace(/\\/g, '/')}`)
      .sort();
  } finally {
    cg.close();
  }
}

describe('python attribute types through the built binary', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-cli-'));
    fs.writeFileSync(
      path.join(dir, 'capture.py'),
      'class AudioCapture:\n    def stop(self):\n        return None\n'
    );
    // A distractor: without one, a bare-name fallback could find `stop` anyway.
    fs.writeFileSync(
      path.join(dir, 'other.py'),
      'class Unrelated:\n    def stop(self):\n        return None\n'
    );
    fs.writeFileSync(
      path.join(dir, 'rec.py'),
      'from capture import AudioCapture\n\n\nclass Recorder:\n    def __init__(self):\n'
        + '        self._capture = AudioCapture()\n\n'
        + '    def halt(self):\n        return self._capture.stop()\n'
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a full index resolves the attribute call', () => {
    run(['init'], dir);
    run(['index'], dir);
    expect(haltTargets(dir)).toEqual(['stop@capture.py']);
  });

  // NOT TESTED HERE: the resolver WORKER's own grammar warming
  // (`resolver-worker.ts`). A worker resolves nothing until a single batch
  // reaches `MIN_PARALLEL_BATCH`, and fixtures up to 150 files x 30 calls
  // (4,500 refs) still resolve entirely on the main thread — the pool spawns
  // but never takes a batch — so a test at any size this suite can afford
  // passes with the worker fix removed. Two attempts at one did exactly that.
  // The worker path was verified by measurement instead: on a 1,500-file python
  // project with the pool forced on, removing the worker's warm dropped edges
  // into the fixture's method from 9,000 to 3,332. Left uncovered deliberately
  // rather than covered by a test that cannot fail.

  it('index and sync agree — the graph does not depend on how a file was indexed', () => {
    run(['init'], dir);
    run(['index'], dir);
    const afterIndex = haltTargets(dir);
    fs.appendFileSync(path.join(dir, 'rec.py'), '\n# touch\n');
    run(['sync'], dir);
    expect(haltTargets(dir)).toEqual(afterIndex);
    expect(afterIndex).toEqual(['stop@capture.py']);
  });
});
