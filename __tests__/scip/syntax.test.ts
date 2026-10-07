import { describe, expect, it } from 'vitest';
import { INDEXERS } from '../../src/scip/indexers';
import { callLine } from '../../src/scip/site';
import { callShape, looksLikeCall } from '../../src/scip/syntax';

/** How the merge reads a source line: which line a call is keyed on, and whether a reference is a call at all. */

/** The line callLine keys the call to `name` on (both 0-based), found by its last occurrence in `src`. */
const lineOf = (src: string, name: string) => {
  const lines = src.split('\n');
  for (let l = lines.length - 1; l >= 0; l--) {
    const c = lines[l]!.lastIndexOf(name);
    if (c >= 0) return callLine(lines, l, c);
  }
  throw new Error(`no ${name}`);
};

describe('callLine: the line codegraph keys a call on', () => {
  it('a chain over lines counts on the line it starts, dots leading or trailing', () => {
    expect(lineOf('return mk()\n  .bar()\n  .baz();', 'baz')).toBe(0); // TS, Rust (rustfmt)
    expect(lineOf('return mk().\n\tBar().\n\tBaz()', 'Baz')).toBe(0); // Go: a leading dot would end the statement
    expect(lineOf('return (self.\n    helper().\n    last())', 'last')).toBe(0); // Python
    expect(lineOf('return this\n  .helper()', 'helper')).toBe(0);
  });

  it('follows receivers that are groups, optional chains and postfix operators', () => {
    expect(lineOf('a?.b()\n  ?.c()', 'c')).toBe(0);
    expect(lineOf('let s = read()?\n    .trim()', 'trim')).toBe(0); // Rust `?`
    expect(lineOf('foo(\n  a,\n).bar()', 'bar')).toBe(0); // the receiver's arguments span lines
    expect(lineOf('items[\n  0\n]\n  .run()', 'run')).toBe(0);
    expect(lineOf('let v = x\n  // a comment.\n  .y()', 'y')).toBe(0);
  });

  it('leaves a call that is no member of what precedes it on its own line', () => {
    expect(lineOf('foo();\nbar();', 'bar')).toBe(1);
    expect(lineOf('// see a.b.\nbar();', 'bar')).toBe(1); // a comment's period is no member access
    expect(lineOf('# done.\nbar()', 'bar')).toBe(1);
    expect(lineOf('foo(\n  bar())', 'bar')).toBe(1); // an argument, not a member
    expect(lineOf('x = a.\n  b.c()', 'c')).toBe(0);
    expect(lineOf('one()\ntwo.three()', 'three')).toBe(1);
  });
});

describe('call shapes', () => {
  const LANG: Record<string, keyof typeof INDEXERS> = { go: 'go', rs: 'rust', ts: 'typescript' };
  const shape = (file: string, line: string, name: string) => {
    const col = line.indexOf(name);
    const o = { range: { startLine: 0, startCol: col, endLine: 0, endCol: col + name.length }, symbol: '', roles: 0 };
    return callShape(o, 0, [line], INDEXERS[LANG[file.split('.').pop()!]!].literalShape);
  };

  it('recognizes call shapes', () => {
    expect(looksLikeCall('(1)')).toBe(true);
    expect(looksLikeCall(' ?.(x)')).toBe(true);
    expect(looksLikeCall('<Map<string, number>>(x)')).toBe(true);
    expect(looksLikeCall(', cb)')).toBe(false);
    expect(looksLikeCall(' < 3')).toBe(false);
  });

  it('Go: composite literals, not container element types or return types', () => {
    expect(shape('a.go', 'return &Invoice{Amount: 1}', 'Invoice')).toBe('literal');
    expect(shape('a.go', 'b := Box[int]{v: 1}', 'Box')).toBe('literal');
    expect(shape('a.go', 'xs := []*Invoice{a, b}', 'Invoice')).toBeNull();
    expect(shape('a.go', 'm := map[string]Invoice{}', 'Invoice')).toBeNull();
    expect(shape('a.go', 'func Make() *Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.go', 'func Make() *shop.Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.go', 'return shop.Invoice{Amount: 1}', 'Invoice')).toBe('literal');
  });

  it('Rust: struct literals, not impl headers, return types or patterns', () => {
    expect(shape('a.rs', '    Invoice { amount }', 'Invoice')).toBe('literal');
    expect(shape('a.rs', 'let v = Wrapper::<u8> { x: 1 };', 'Wrapper')).toBe('literal');
    expect(shape('a.rs', 'impl Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'impl Pricer for Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'pub fn make() -> Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'let Invoice { amount } = inv;', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    Invoice { amount: 0 } => 0,', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'pub fn make() -> models::Invoice {', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    Some(Invoice { amount }) => amount,', 'Invoice')).toBeNull();
    expect(shape('a.rs', 'for Invoice { amount } in all {', 'Invoice')).toBeNull();
    expect(shape('a.rs', '    let v = models::Invoice { amount: 1 };', 'Invoice')).toBe('literal');
    expect(shape('a.ts', 'class A extends Invoice {', 'Invoice')).toBeNull(); // braces mean nothing in TS
  });
});

describe('Rust impl headers', () => {
  // [trait text, implementing type text] as the merge reads them, or null
  const read = (line: string) => {
    const h = INDEXERS.rust.implHeader!(line);
    return h && [line.slice(h.traitFrom, h.selfFrom - 3).trim(), line.slice(h.selfFrom).trim()];
  };

  it('names the trait after the impl generics and the type after `for`; an inherent impl is no header', () => {
    expect(read('impl Pricer for Invoice {')).toEqual(['Pricer', 'Invoice {']);
    expect(read('impl<T: Display> From<T> for Wrapper<T> {')).toEqual(['From<T>', 'Wrapper<T> {']);
    expect(read("    impl<'a> Iterator for Parents<'a> {")).toEqual(['Iterator', "Parents<'a> {"]);
    expect(read('unsafe impl Send for Handle {}')).toEqual(['Send', 'Handle {}']);
    expect(read('impl fmt::Display for Error {')).toEqual(['fmt::Display', 'Error {']);
    expect(read('impl Invoice {')).toBeNull();
    expect(read('let x = impl_for(y);')).toBeNull();
  });
});
