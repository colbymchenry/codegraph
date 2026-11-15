/**
 * Grammar loads started together wait for one another.
 *
 * `loadGrammarsForLanguages` loads grammars one at a time because web-tree-sitter
 * corrupts a grammar loaded while another one is loading (tree-sitter#2338). That
 * only held within one call: two calls started together, like a daemon's sync
 * beside a request that loads a grammar for branch guards or syntax tokens, each
 * ran `Parser.init` and their loads ran side by side. A grammar loaded that way
 * stayed cached for the life of the process, and every later parse of its
 * language threw "Incompatible language version". Now every call joins one queue,
 * the runtime initializes once, and a grammar an earlier call loaded is not loaded
 * again.
 */
import { describe, it, expect, vi } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';
import { getParser, isGrammarLoaded, isGrammarsInitialized, loadGrammarsForLanguages } from '../src/extraction/grammars';

const SNIPPETS = {
  lua: 'local x = 1',
  rust: 'fn f() {}',
  python: 'def f():\n    pass\n',
  go: 'package main\n',
  typescript: 'let x: number = 1;',
} as const;

describe('grammar loads started together', () => {
  it('initialize the runtime once, load each grammar once and one at a time, and every grammar parses', async () => {
    const languages = Object.keys(SNIPPETS) as Array<keyof typeof SNIPPETS>;
    expect(isGrammarsInitialized()).toBe(false);
    expect(languages.some((language) => isGrammarLoaded(language))).toBe(false);

    const init = vi.spyOn(Parser, 'init');
    const load = Language.load.bind(Language);
    let active = 0;
    let peak = 0;
    const loads = vi.spyOn(Language, 'load').mockImplementation(async (input) => {
      peak = Math.max(peak, ++active);
      try {
        return await load(input);
      } finally {
        active--;
      }
    });
    try {
      await Promise.all([
        loadGrammarsForLanguages(['lua']),
        loadGrammarsForLanguages(['rust']),
        loadGrammarsForLanguages(['python']),
        loadGrammarsForLanguages(['lua', 'rust']),
        loadGrammarsForLanguages(['go']),
        loadGrammarsForLanguages(['typescript', 'python']),
      ]);

      expect(init).toHaveBeenCalledTimes(1);
      expect(loads).toHaveBeenCalledTimes(languages.length);
      expect(peak).toBe(1);
      for (const language of languages) {
        const tree = getParser(language)!.parse(SNIPPETS[language])!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
        } finally {
          tree.delete();
        }
      }
    } finally {
      init.mockRestore();
      loads.mockRestore();
    }
  });
});
