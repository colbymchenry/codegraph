/**
 * Parse-worker native stack size (issue #1581).
 *
 * The kernel walkers recurse once per parse-tree level, so a deeply nested
 * source file consumes native stack proportional to its nesting depth. Node's
 * default worker stack is 4MB, and overflowing it inside the addon is a
 * SIGSEGV — not a catchable JS error — which kills the whole `codegraph index`
 * process, since worker threads share it. clang's
 * `test/Parser/parser_overflow.c` (16,384 nested braces) triggered exactly
 * this on a real repo. The pool therefore pins an explicit
 * `resourceLimits.stackSizeMb`.
 *
 * Both arms run the parse in a CHILD PROCESS on purpose: if the fix regresses,
 * the parse segfaults, and a segfault in a worker thread would take this test
 * runner down with it instead of reporting a failure. A dead child is
 * observable; a dead runner is not.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PARSE_WORKER_STACK_MB } from '../src/extraction/parse-pool';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

/** Nesting depth from clang's parser_overflow.c — the input seen in the wild. */
const NESTING_DEPTH = 16_384;

/**
 * Run `body` inside a worker thread with `stackSizeMb`, in a child process.
 * Returns the child's exit status: 0 when the worker completed, non-zero (or a
 * signal) when it died — which is what a native stack overflow looks like.
 */
function runInWorker(stackSizeMb: number, body: string) {
  const script = `
    const { Worker, isMainThread, workerData } = require('worker_threads');
    if (isMainThread) {
      const w = new Worker(__filename, {
        workerData: { kernelPath: ${JSON.stringify(KERNEL_PATH)}, depth: ${NESTING_DEPTH} },
        resourceLimits: { stackSizeMb: ${stackSizeMb} },
      });
      w.on('exit', (code) => process.exit(code));
      w.on('error', (e) => { console.error(e.message); process.exit(1); });
    } else {
      ${body}
    }
  `;
  const file = path.join(__dirname, `.stack-probe-${stackSizeMb}-${process.pid}.cjs`);
  fs.writeFileSync(file, script);
  try {
    return spawnSync(process.execPath, [file], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

describe('parse worker stack size', () => {
  it('is large enough for the deepest nesting seen in real repos', () => {
    // ~450 bytes of native stack per tree level for c/cpp, measured on the
    // ccpp walker; the observed cliff was between 8k and 10k levels at 4MB.
    const bytesPerLevel = 450;
    const headroom = 2;
    expect(PARSE_WORKER_STACK_MB * 1024 * 1024).toBeGreaterThan(
      NESTING_DEPTH * bytesPerLevel * headroom
    );
  });

  it('reaches the worker thread without shrinking its heap', () => {
    const r = runInWorker(
      PARSE_WORKER_STACK_MB,
      `
      const { resourceLimits } = require('worker_threads');
      console.log(JSON.stringify(resourceLimits));
      `
    );
    expect(r.status).toBe(0);
    const limits = JSON.parse(r.stdout.trim());
    expect(limits.stackSizeMb).toBe(PARSE_WORKER_STACK_MB);
    // A partial resourceLimits must not silently cap the V8 heap — parse
    // workers legitimately reach ~1.4GB RSS on a large index.
    expect(limits.maxOldGenerationSizeMb).toBeGreaterThan(512);
  });

  it.skipIf(!kernelBuilt)('parses a deeply nested C file without dying', () => {
    const r = runInWorker(
      PARSE_WORKER_STACK_MB,
      `
      const { workerData } = require('worker_threads');
      const kernel = require(workerData.kernelPath);
      const d = workerData.depth;
      const src = 'void foo(void) {\\n' + '{'.repeat(d) + '}'.repeat(d) + '\\n}\\n';
      const buffers = kernel.extractFile('deep.c', src, 'c');
      console.log('nodes=' + buffers.meta.readUInt32LE(4));
      `
    );
    expect(r.signal, 'worker died on a native stack overflow').toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nodes=');
  });
});
