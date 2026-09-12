import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import path from 'node:path';

let parser: Parser;
let grammar: Language;
beforeAll(async () => {
  await Parser.init();
  grammar = await Language.load(path.join(__dirname, '../src/extraction/wasm/tree-sitter-systemverilog.wasm'));
  parser = new Parser();
  parser.setLanguage(grammar);
});
afterAll(() => parser?.delete());

describe('SystemVerilog grammar capabilities', () => {
  it('loads the shipped grammar with the supported ABI', () => {
    expect(grammar.abiVersion).toBe(15);
  });
  it.each([
    ['class timeunits', 'class C; timeunit 1ns; timeprecision 1ps; endclass', 'timeunits_declaration'],
    ['generate inside expression', 'module m; parameter N=1; if (N inside {1,2}) begin: g wire x; end endmodule', 'inside_expression'],
    ['keywords in macro arguments', 'module m; `M(input, output, always_ff) endmodule', 'text_macro_usage'],
  ])('parses %s without recovery', (_name, source, expectedType) => {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType(expectedType).length).toBeGreaterThan(0);
    } finally { tree.delete(); }
  });
  it('rejects whitespace between the backtick and a macro name', () => {
    const tree = parser.parse('module m; ` M(x) endmodule')!;
    try { expect(tree.rootNode.hasError).toBe(true); }
    finally { tree.delete(); }
  });
  it('represents replication multipliers as constant expressions', () => {
    const tree = parser.parse('module m(input a, output [3:0] q); parameter N=4; assign q={N{a}}; endmodule')!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const replication = tree.rootNode.descendantsOfType('multiple_concatenation')[0]!;
      expect(replication.namedChildren[0]?.type).toBe('constant_expression');
    } finally { tree.delete(); }
  });
});
