/**
 * A grammar that never finishes a slice must not take the viewer's server
 * down. The COBOL grammar's scanner loops forever on a line like `    .` — a
 * period in the fixed-format sequence area — which cobolcraft's free-format
 * paragraphs end with, so a Flow card's window froze the server and every
 * request behind it. Slices are classified in a worker the server ends past
 * a deadline; the slice is served plain, and the next one gets a new worker.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { highlightLines, clearHighlightCache } from '../src/ui-server/highlight';
import { stopHighlightWorker } from '../src/ui-server/highlight/bounded-tokenize';

afterAll(() => stopHighlightWorker());

describe('highlighting a slice', () => {
  it('serves a slice the grammar never finishes plain, and keeps answering', async () => {
    clearHighlightCache();
    const started = Date.now();
    const hung = await highlightLines(['    PERFORM AssertOk', '    .'], { language: 'cobol' });
    expect(hung.engine).toBe('plain');
    expect(hung.reason).toMatch(/took too long/);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The next slice gets a fresh worker and is classified as usual.
    const fine = await highlightLines(['export const x: number = 1;'], { language: 'typescript' });
    expect(fine.engine).toBe('tree-sitter');
  }, 20_000);
});
