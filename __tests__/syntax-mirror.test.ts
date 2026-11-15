import { beforeAll, describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { mirrorTree, type SyntaxMirror } from '../src/resolution/syntax-mirror';

beforeAll(async () => { await loadGrammarsForLanguages(['lua', 'rust']); });

/** Every accessor the bridge analyzers read must agree with web-tree-sitter. */
function compare(node: Node, copy: SyntaxMirror): void {
  expect(copy.type).toBe(node.type);
  expect([copy.startIndex, copy.endIndex, copy.text]).toEqual([node.startIndex, node.endIndex, node.text]);
  expect(copy.startPosition).toEqual(node.startPosition);
  expect(copy.endPosition).toEqual(node.endPosition);
  expect(copy.hasError).toBe(node.hasError);
  expect(copy.previousNamedSibling?.id === undefined).toBe(node.previousNamedSibling === null);
  expect(copy.children.map(child => [child.type, child.text])).toEqual(node.children.map(child => [child!.type, child!.text]));
  for (let i = 0; i < node.childCount; i++) {
    const field = node.fieldNameForChild(i);
    const expected = field ? node.childForFieldName(field) : null;
    if (field && expected) {
      const actual = copy.childForFieldName(field);
      expect([actual?.type, actual?.startIndex, actual?.isNamed]).toEqual([expected.type, expected.startIndex, expected.isNamed]);
    }
  }
  expect(copy.namedChildren).toHaveLength(node.namedChildren.length);
  node.namedChildren.forEach((child, i) => compare(child!, copy.namedChildren[i]!));
}

describe('syntax mirror', () => {
  it.each([
    ['lua', 'local ffi = require("ffi") -- é\r\nlocal t = { ["k"] = 1, [x] = 2 }\r\nlocal function f(a, ...) return a end\r\n'],
    ['lua', 'local s = "naïve ✓"\nif a then b() elseif c then d() else e() end\nlocal broken = { = }\n'],
    ['rust', '/// docs\n#[no_mangle]\npub extern "C" fn ping(op: &str) -> i32 { match op { "é" => 1, _ => 0 } }\nmacro_rules! m { ($a:expr) => { $a }; }\n'],
    ['rust', 'fn broken( { let x = ; }\n'],
  ])('copies a %s tree exactly', (language, source) => {
    const tree = getParser(language as 'lua' | 'rust')!.parse(source)!;
    try { compare(tree.rootNode, mirrorTree(tree, source)); } finally { tree.delete(); }
  });

  it('reports fields inherited through hidden rules, which Node omits', () => {
    const source = 'local x = 1\n';
    const tree = getParser('lua')!.parse(source)!;
    try {
      expect(tree.rootNode.childForFieldName('local_declaration')).toBeNull();
      expect(mirrorTree(tree, source).childForFieldName('local_declaration')?.type).toBe('variable_declaration');
    } finally { tree.delete(); }
  });

  it('keeps significant children free of comments and descendants in source order', () => {
    const source = 'local a = 1 -- note\nlocal b = { c = d }\n';
    const tree = getParser('lua')!.parse(source)!;
    try {
      const copy = mirrorTree(tree, source);
      expect(copy.namedChildren.map(child => child.type)).toContain('comment');
      expect(copy.significantChildren.map(child => child.type)).not.toContain('comment');
      expect(copy.descendantsOfType('identifier').map(node => node.text)).toEqual(['a', 'b', 'c', 'd']);
    } finally { tree.delete(); }
  });
});
