/**
 * The test workers run with the WASM runtime flags.
 *
 * Without them a pool worker compiles the tree-sitter grammars on V8's
 * optimizing tier, and once enough parses have warmed a grammar up the worker
 * dies with `Fatal process out of memory: Zone`, which vitest reports only as
 * "Worker exited unexpectedly", with the rest of the file unrun (#1779).
 *
 * The flags reach the workers through a vitest option, and vitest ignores an
 * option it no longer reads without a word: `poolOptions.forks.execArgv` went
 * that way in the move to Vitest 4. So this reads the worker's own command
 * line instead of trusting the config.
 */
import { describe, it, expect } from 'vitest';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

describe('test pool workers', () => {
  it('run with the WASM runtime flags', () => {
    for (const flag of WASM_RUNTIME_FLAGS) expect(process.execArgv).toContain(flag);
  });
});
