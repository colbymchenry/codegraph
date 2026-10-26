/**
 * A grammar that never finishes a slice must not take the viewer's server
 * down. The COBOL grammar's scanner once looped forever on a slice ending in a
 * line like `    .` (fixed in the grammar since), which froze cobolcraft's Flow
 * strip and every request behind it: a parse inside WebAssembly cannot be
 * interrupted from JavaScript. Slices are classified in a worker the server
 * ends past a deadline; the slice is served plain, and the next one gets a
 * fresh worker. The deadline is forced here rather than found in a grammar.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { highlightLines, clearHighlightCache } from '../src/ui-server/highlight';
import { stopHighlightWorker, tokenizeBounded } from '../src/ui-server/highlight/bounded-tokenize';

afterAll(() => stopHighlightWorker());

describe('highlighting a slice', () => {
  it('gives up on a slice past the deadline, and the next slice gets a fresh worker', async () => {
    const big = 'export const value: number = 1;\n'.repeat(2000);
    const started = Date.now();
    const timedOut = await tokenizeBounded(big, 'typescript', 1);
    expect('timedOut' in timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    const fine = await tokenizeBounded('const y = 2;', 'typescript');
    expect('result' in fine && (fine.result?.spans.length ?? 0) > 0).toBe(true);
  }, 20_000);

  it('still highlights through the worker', async () => {
    clearHighlightCache();
    const fine = await highlightLines(['export const x: number = 1;'], { language: 'typescript' });
    expect(fine.engine).toBe('tree-sitter');
    // The slice that used to hang the COBOL grammar is classified now.
    const cobol = await highlightLines(['    PERFORM AssertOk', '    .'], { language: 'cobol' });
    expect(cobol.reason ?? '').not.toMatch(/took too long/);
  }, 20_000);
});
