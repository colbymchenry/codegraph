/**
 * F#'s scanner asks for the column of nearly every token, which over one
 * whole-file string is quadratic, so every parse of F# — indexing, the viewer's
 * highlighting, the branch guards — hands the parser the source in chunks.
 */
import { describe, it, expect } from 'vitest';
import { parserInput, parseWithinBudget } from '../src/extraction/parse-budget';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('parserInput', () => {
  it('serves F# in chunks that put the whole source back together, never splitting a surrogate pair', () => {
    const source = `${'x'.repeat(127)}😀${'let a = 1\n'.repeat(40)}`;
    const input = parserInput(source, 'fsharp');
    expect(typeof input).toBe('function');
    const read = input as (index: number) => string;
    let text = '';
    for (let at = 0; at < source.length; at += read(at).length) {
      const chunk = read(at);
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(129);
      text += chunk;
    }
    expect(text).toBe(source);
    expect(read(0).endsWith('😀')).toBe(true);
  });

  it('hands every other grammar the string itself', () => {
    expect(parserInput('const a = 1;', 'typescript')).toBe('const a = 1;');
  });

  it('parses F# within a request\'s budget to the same tree as the whole string', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['fsharp']);
    const parser = getParser('fsharp')!;
    const source = 'module M\n\nlet f x =\n    x + 1\n\ntype T() =\n    member this.G() = f 1\n';
    const chunked = parseWithinBudget(parser, source, 'fsharp')!;
    const whole = parser.parse(source)!;
    expect(chunked.rootNode.toString()).toBe(whole.rootNode.toString());
    expect(chunked.rootNode.hasError).toBe(false);
  });
});
