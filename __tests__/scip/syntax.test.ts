import { describe, expect, it } from 'vitest';
import { callLine } from '../../src/scip/site';
import { looksLikeCall } from '../../src/scip/syntax';

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
    expect(lineOf('const s = read()!\n    .trim()', 'trim')).toBe(0); // non-null assertion
    expect(lineOf('foo(\n  a,\n).bar()', 'bar')).toBe(0); // the receiver's arguments span lines
    expect(lineOf('items[\n  0\n]\n  .run()', 'run')).toBe(0);
    expect(lineOf('let v = x\n  // a comment.\n  .y()', 'y')).toBe(0);
    expect(lineOf('class C {\n  #items = this.make()\n    .configure();\n}', 'configure')).toBe(1); // a private field, no comment
  });

  it('leaves a call that is no member of what precedes it on its own line', () => {
    expect(lineOf('foo();\nbar();', 'bar')).toBe(1);
    expect(lineOf('// see a.b.\nbar();', 'bar')).toBe(1); // a comment's period is no member access
    expect(lineOf('foo(\n  bar())', 'bar')).toBe(1); // an argument, not a member
    expect(lineOf('x = a.\n  b.c()', 'c')).toBe(0);
    expect(lineOf('one()\ntwo.three()', 'three')).toBe(1);
  });
});

describe('call shapes', () => {
  it('recognizes call shapes', () => {
    expect(looksLikeCall('(1)')).toBe(true);
    expect(looksLikeCall(' ?.(x)')).toBe(true);
    expect(looksLikeCall('<Map<string, number>>(x)')).toBe(true);
    expect(looksLikeCall(', cb)')).toBe(false);
    expect(looksLikeCall(' < 3')).toBe(false);
  });


});
