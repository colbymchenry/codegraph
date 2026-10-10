import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import path from 'node:path';
import { getVerilogPortOrder } from '../src/extraction/languages/verilog-signals';

let parser: Parser;
beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(path.join(__dirname, '../src/extraction/wasm/tree-sitter-systemverilog.wasm')));
});
afterAll(() => parser?.delete());
function order(source: string): string[] | null {
  const tree = parser.parse(source)!;
  try { return getVerilogPortOrder(tree.rootNode.namedChildren[0]!, source); }
  finally { tree.delete(); }
}

describe('authoritative HDL positional port order', () => {
  it('takes ANSI comma continuation ports in header source order, ignoring comments', () => {
    expect(order('module m(input a, /* comment `ifdef FALSE */ b, output [3:0] c); endmodule')).toEqual(['a', 'b', 'c']);
  });
  it('uses non-ANSI header order even when body declarations are reversed', () => {
    expect(order('module m(a,b,c); input c; output b; input a; endmodule')).toEqual(['a', 'b', 'c']);
  });
  it('preserves escaped identifiers and supports empty headers', () => {
    expect(order('module m(input \\x.y , output z); endmodule')).toEqual(['\\x.y', 'z']);
    expect(order('module m(\\x.y ,z); input z; output \\x.y ; endmodule')).toEqual(['\\x.y', 'z']);
    expect(order('module m(); endmodule')).toEqual([]);
    expect(order('module m; endmodule')).toEqual([]);
  });
  it.each([
    'module m(a,,b); input a,b; endmodule',
    'module m({a,b},c); input a,b,c; endmodule',
    'module m(.a(x),b); input x,b; endmodule',
    'module m(input a, a); endmodule',
    'module m(input a, \\a ); endmodule',
    'module m(input a, `ifdef TEST input b, `endif output c); endmodule',
    'module m(`PORTS); endmodule',
    'module m(input a); assign = ; endmodule',
  ])('does not infer order from ambiguous or incomplete syntax: %s', source => {
    expect(order(source)).toBeNull();
  });
  it('accepts interfaces and ignores parameter declarations in port numbering', () => {
    expect(order('interface bus #(parameter W=8)(input clk, input [W-1:0] data); endinterface')).toEqual(['clk', 'data']);
  });
});
