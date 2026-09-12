/**
 * readGrammarWasmBytes + bytes-based grammar loading (#1231, Phase 2.1).
 *
 * The orchestrator pre-reads each needed grammar's WASM once on the main
 * thread and hands the bytes to every parse worker, so a worker respawn loads
 * grammars from memory instead of re-reading them from a (possibly slow) disk.
 * These tests pin that the byte reader resolves the same artifacts the loader
 * would, and that web-tree-sitter genuinely accepts the bytes.
 */
import { describe, it, expect } from 'vitest';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { readGrammarWasmBytes } from '../src/extraction/grammars';

describe('readGrammarWasmBytes', () => {
  it('reads bytes for a tree-sitter-wasms grammar and vendored grammars', async () => {
    const bytes = await readGrammarWasmBytes(['typescript', 'lua', 'haskell']);
    expect(bytes.typescript).toBeInstanceOf(Uint8Array); // from tree-sitter-wasms
    expect(bytes.typescript.byteLength).toBeGreaterThan(10_000);
    expect(bytes.lua).toBeInstanceOf(Uint8Array); // vendored under src/extraction/wasm/
    expect(bytes.lua.byteLength).toBeGreaterThan(10_000);
    expect(bytes.haskell).toBeInstanceOf(Uint8Array); // vendored with its upstream MIT notice
    expect(bytes.haskell.byteLength).toBeGreaterThan(10_000);
  });

  it('expands delegating languages to the grammars they need (svelte → ts/js)', async () => {
    const bytes = await readGrammarWasmBytes(['svelte']);
    expect(Object.keys(bytes).sort()).toEqual(['javascript', 'typescript']);
  });

  it('omits languages without a WASM grammar instead of failing', async () => {
    const bytes = await readGrammarWasmBytes(['yaml', 'unknown']);
    expect(Object.keys(bytes)).toEqual([]);
  });

  it('produces bytes web-tree-sitter can load into a working parser', async () => {
    await Parser.init();
    const bytes = await readGrammarWasmBytes(['javascript']);
    const language = await WasmLanguage.load(bytes.javascript);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('function hello() { return 1; }');
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.toString()).toContain('function_declaration');
  });

  it('parses Haskell Other_Letter identifiers through parser and scanner paths', async () => {
    await Parser.init();
    const bytes = await readGrammarWasmBytes(['haskell']);
    const language = await WasmLanguage.load(bytes.haskell);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse([
      '{-# LANGUAGE ImplicitParams, QuasiQuotes, TemplateHaskell #-}',
      'module Origin (函数) where',
      '函数 value = value',
      'aʰ value = value',
      'qualified = O.函数 1',
      'splice = $函数',
      'implicit :: (?函数 :: Int) => Int',
      'implicit = ?函数',
      'quoted = [函数|abc|]',
    ].join('\n'));
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.toString()).toContain('(function name: (variable)');
    expect(tree!.rootNode.toString())
      .toContain('(qualified module: (module (module_id)) id: (variable))');
    expect(tree!.rootNode.toString()).toContain('(quasiquote');
  });

  it('accepts identifiers at both bounds of every compressed Other_Letter range', async () => {
    await Parser.init();
    const bytes = await readGrammarWasmBytes(['haskell']);
    const language = await WasmLanguage.load(bytes.haskell);
    const parser = new Parser();
    parser.setLanguage(language);
    const rangeBounds = [
      [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3],
      [0x17000, 0x187f7], [0x18d00, 0x18d08], [0x20000, 0x2a6df],
      [0x2a700, 0x2b739], [0x2b740, 0x2b81d], [0x2b820, 0x2cea1],
      [0x2ceb0, 0x2ebe0], [0x2ebf0, 0x2ee5d], [0x30000, 0x3134a],
      [0x31350, 0x323af],
    ];
    const codePoints = rangeBounds.flat();
    const declarations = codePoints.map((codePoint, index) =>
      `${String.fromCodePoint(codePoint)}${index} value = value`);
    const tree = parser.parse(['module Ranges where', ...declarations].join('\n'));

    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.descendantsOfType('function')).toHaveLength(codePoints.length);
  });
});
