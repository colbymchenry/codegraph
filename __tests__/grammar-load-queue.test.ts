import { describe, expect, it, vi } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';
import { getParser, isGrammarLoaded, isGrammarsInitialized, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('grammar loading under concurrent callers', () => {
  it('initializes the runtime once and loads each grammar once, one at a time', async () => {
    expect(isGrammarsInitialized()).toBe(false);
    expect(isGrammarLoaded('lua') || isGrammarLoaded('rust')).toBe(false);
    const init = vi.spyOn(Parser, 'init');
    const original = Language.load.bind(Language);
    let active = 0;
    let peak = 0;
    const load = vi.spyOn(Language, 'load').mockImplementation(async (input) => {
      peak = Math.max(peak, ++active);
      try {
        return await original(input);
      } finally {
        active--;
      }
    });
    try {
      await Promise.all([
        loadGrammarsForLanguages(['lua']),
        loadGrammarsForLanguages(['lua', 'rust']),
        loadGrammarsForLanguages(['rust', 'lua']),
      ]);
      expect(init).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(2);
      expect(peak).toBe(1);
      expect(getParser('lua')).not.toBeNull();
      expect(getParser('rust')).not.toBeNull();
    } finally {
      init.mockRestore();
      load.mockRestore();
    }
  });
});
