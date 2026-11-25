/**
 * A store failure during indexAll must reject it, not hang the process (#1773).
 *
 * The in-order commit window waited for the commit cursor to advance, but after
 * a failed store the cursor never moves: flushOrdered returns at once, so the
 * backpressure loop spun on microtasks forever. The process pinned a core and
 * no timer could fire, so a test that closed its graph mid-index (after a
 * timeout) wedged the whole vitest worker. Runs in a child process under a hard
 * timeout: a regression would otherwise hang this worker the same way.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const DIST = path.resolve(__dirname, '../dist');

const script = `
const fs = require('fs'); const os = require('os'); const path = require('path');
const { default: CodeGraph } = require(path.join(process.argv[1], 'index.js'));
const { ExtractionOrchestrator } = require(path.join(process.argv[1], 'extraction/index.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-failure-'));
// More files than the commit window holds, so the failed cursor is waited on.
for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.ts'), 'export function f' + i + '() { return ' + i + '; }\\n');
const store = ExtractionOrchestrator.prototype.storeExtractionResult;
let calls = 0;
ExtractionOrchestrator.prototype.storeExtractionResult = function (...args) {
  if (calls++ === 0) throw new Error('injected store failure');
  return store.apply(this, args);
};
const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
cg.indexAll().then(
  () => process.stdout.write('resolved\\n'),
  (err) => process.stdout.write('rejected: ' + err.message + '\\n'),
).finally(() => {
  try { cg.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});
`;

describe('indexAll after a failed store (#1773)', () => {
  it('rejects with the store error instead of spinning', () => {
    const child = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, '-e', script, DIST], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        // The main-thread store path, with the smallest pooled commit window.
        CODEGRAPH_NO_STORE_WORKER: '1',
        CODEGRAPH_PARSE_WORKERS: '1',
        CODEGRAPH_TELEMETRY: '0',
      },
    });
    expect(child.signal, `indexAll did not settle: ${child.stderr}`).toBeNull();
    expect(child.stdout.trim()).toBe('rejected: injected store failure');
  }, 90_000);
});
