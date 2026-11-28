/**
 * The lookups that replaced a pass over a whole file for each match or each
 * reference answer exactly as the pass did.
 *
 * Three of them are small enough to pin against what they replaced, input by
 * input: the line of an offset in a text, which every route and handler scan
 * wrote as `text.slice(0, i).split('\n').length`; the imports of a file that
 * a reference's name reads, which every step of import resolution found by
 * going through all of them; and the nodes of a file that hold a line, which
 * every question about what is around a reference found by going through all
 * of the file's nodes. Each is checked here against that original expression
 * over generated inputs, on both sides of the size at which the lookup
 * starts to keep an index.
 *
 * And a list as long as a large file has imports or symbols is added to
 * another without being spread into a call's arguments, which overflowed the
 * stack.
 */

import { describe, it, expect } from 'vitest';
import { lineAt } from '../src/resolution/synth-utils';
import { importsBoundTo, importsFrom, importsReadBy, pythonMemberImports } from '../src/resolution/import-lookup';
import { nodesAroundLine } from '../src/resolution/nodes-around';
import { maxOf, minOf, pushAll } from '../src/utils';
import type { ImportMapping, ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

/** A small repeatable generator, so a failure names inputs that can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('the line of an offset', () => {
  const written = (text: string, idx: number): number => text.slice(0, idx).split('\n').length;

  it('is what counting the lines before it gives, in a short text and a long one', () => {
    const next = random(7);
    for (const lines of [0, 1, 3, 40, 400, 4000]) {
      const text = Array.from({ length: lines }, (_, i) => 'x'.repeat(Math.floor(next() * 12)) + (i % 7 === 0 ? '\r' : '')).join('\n');
      const offsets = [0, 1, text.length - 1, text.length, text.length + 5, ...Array.from({ length: 60 }, () => Math.floor(next() * (text.length + 1)))];
      for (const idx of offsets) expect(lineAt(text, idx), `${lines} lines, offset ${idx}`).toBe(written(text, idx));
    }
  });

  it('is so at a newline, just before one and just after', () => {
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(10)}\n\n${'c'.repeat(3000)}\n`;
    for (let idx = 2995; idx < 3020; idx++) expect(lineAt(text, idx), `offset ${idx}`).toBe(written(text, idx));
    for (let idx = text.length - 4; idx <= text.length + 1; idx++) expect(lineAt(text, idx), `offset ${idx}`).toBe(written(text, idx));
  });

  it('reads an offset below zero, or none, as the expression it replaced did', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    for (const idx of [-1, -40, -text.length - 3, NaN, undefined as unknown as number]) {
      expect(lineAt(text, idx), `offset ${idx}`).toBe(written(text, idx));
    }
  });

  it('keeps apart the texts it is asked about in turn', () => {
    const texts = Array.from({ length: 7 }, (_, t) => Array.from({ length: 300 + t * 50 }, (_, i) => `text ${t} line ${i}`).join('\n'));
    const next = random(11);
    for (let round = 0; round < 400; round++) {
      const text = texts[Math.floor(next() * texts.length)]!;
      const idx = Math.floor(next() * text.length);
      expect(lineAt(text, idx)).toBe(written(text, idx));
    }
  });
});

describe('the imports of a file a name reads', () => {
  /** A file's imports: some sharing a local name, some a source, some bound to a dotted or an empty name. */
  function imports(count: number, seed: number): ImportMapping[] {
    const next = random(seed);
    const names = ['a', 'b', 'a.b', 'pkg', 'pkg.mod', 'mod', '', 'x1', 'x10', 'React', '$'];
    const sources = ['pkg', 'pkg.mod', './a', './b', 'react', 'pkg.mod.deep', 'a'];
    return Array.from({ length: count }, (_, i) => {
      const local = next() < 0.5 ? names[Math.floor(next() * names.length)]! : `name${i}`;
      const source = next() < 0.5 ? sources[Math.floor(next() * sources.length)]! : `./mod${i}`;
      return { localName: local, exportedName: next() < 0.3 ? 'default' : local, source, isDefault: next() < 0.2, isNamespace: next() < 0.3 } as ImportMapping;
    });
  }
  const asked = ['a', 'b', 'a.b', 'a.b.c', 'pkg.mod.func', 'pkg.mod.deep.x', 'mod', '.hidden', '', 'x1', 'x10.y', 'name3', 'name3.field', 'name30', 'React.useState', '$.get', 'nothing', 'pkg'];

  // Five imports are read through; forty and four hundred are indexed.
  for (const count of [0, 5, 15, 16, 40, 400]) {
    it(`answers as a pass over all of them does, in their order (${count} imports)`, () => {
      const all = imports(count, count + 1);
      for (const name of asked) {
        expect(importsReadBy(all, name), `read by ${JSON.stringify(name)}`)
          .toEqual(all.filter((imp) => imp.localName === name || name.startsWith(imp.localName + '.')));
        expect(importsBoundTo(all, name), `bound to ${JSON.stringify(name)}`).toEqual(all.filter((imp) => imp.localName === name));
        expect(importsFrom(all, name), `from ${JSON.stringify(name)}`).toEqual(all.filter((imp) => imp.source === name));
      }
      for (const source of ['pkg', 'pkg.mod', './a', 'react', './mod3', 'none']) {
        expect(importsFrom(all, source), `from ${source}`).toEqual(all.filter((imp) => imp.source === source));
      }
    });

    it(`gives a Python member reference every import its resolver acts on (${count} imports)`, () => {
      const all = imports(count, count + 2);
      for (const name of asked) {
        const receiver = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
        // What resolvePythonModuleMember does not pass over.
        const acted = all.filter((imp) => {
          const spelledOut = imp.isNamespace && imp.localName === imp.source.split('.').pop()
            && imp.source.includes('.') && name.startsWith(`${imp.source}.`);
          return imp.localName === receiver || spelledOut;
        });
        const given = pythonMemberImports(all, receiver, name);
        // In the file's order, and none the resolver acts on left out.
        expect(given.map((imp) => all.indexOf(imp))).toEqual(given.map((imp) => all.indexOf(imp)).slice().sort((x, y) => x - y));
        for (const imp of acted) expect(given, `${JSON.stringify(name)} on ${JSON.stringify(receiver)}`).toContain(imp);
      }
    });
  }

  it('reads the array it is handed, not one it was handed before', () => {
    const first = imports(40, 1);
    const second = first.map((imp) => ({ ...imp, localName: `${imp.localName}2` }));
    expect(importsBoundTo(first, 'a')).toEqual(first.filter((imp) => imp.localName === 'a'));
    expect(importsBoundTo(second, 'a')).toEqual([]);
    expect(importsBoundTo(second, 'a2')).toEqual(second.filter((imp) => imp.localName === 'a2'));
  });
});

describe('the nodes of a file that hold a line', () => {
  const node = (id: number, startLine: number, endLine: number, kind = 'function'): Node =>
    ({ id: `n${id}`, kind, name: `n${id}`, startLine, endLine } as unknown as Node);
  const contextOf = (nodes: Node[]): ResolutionContext => ({ getNodesInFile: () => nodes } as unknown as ResolutionContext);

  /** A file's nodes as a parser leaves them: one around all, types around methods, some on one line, some ending where the next starts. */
  function fileNodes(count: number, seed: number): Node[] {
    const next = random(seed);
    const nodes: Node[] = [node(0, 1, count * 4 + 10, 'file')];
    let line = 2;
    for (let i = 1; nodes.length < count; i++) {
      const span = Math.floor(next() * 400);
      nodes.push(node(nodes.length, line, line + span, 'class'));
      let inner = line + 1;
      while (inner < line + span && nodes.length < count) {
        const length = Math.floor(next() * 6);
        nodes.push(node(nodes.length, inner, Math.min(line + span, inner + length)));
        if (next() < 0.2) nodes.push(node(nodes.length, inner, inner, 'variable'));
        inner += next() < 0.3 ? length : length + 1 + Math.floor(next() * 3);
      }
      line += span + (next() < 0.5 ? 0 : 1 + Math.floor(next() * 80));
    }
    return nodes;
  }

  for (const count of [10, 63, 64, 500, 5000]) {
    it(`are among those it gives, in the file's order (${count} nodes)`, () => {
      const nodes = fileNodes(count, count);
      const context = contextOf(nodes);
      const lastLine = nodes[0]!.endLine;
      const next = random(count + 1);
      const lines = [0, 1, 2, 63, 64, 65, 127, 128, lastLine - 1, lastLine, lastLine + 1, lastLine + 500,
        ...Array.from({ length: 300 }, () => Math.floor(next() * (lastLine + 20)))];
      for (const line of lines) {
        const holds = (n: Node): boolean => n.startLine <= line && n.endLine >= line;
        expect(nodesAroundLine(context, 'f', line).filter(holds).map((n) => n.id), `line ${line}`).toEqual(nodes.filter(holds).map((n) => n.id));
      }
    });
  }

  it('are fewer than all of them, in a file large enough to be worth it', () => {
    const nodes = fileNodes(5000, 3);
    const around = nodesAroundLine(contextOf(nodes), 'f', Math.floor(nodes[0]!.endLine / 2));
    expect(around.length).toBeLessThan(nodes.length / 10);
  });

  it('gives every node when one has no lines to go by, or the line is none', () => {
    const nodes = fileNodes(200, 5);
    for (const odd of [node(900, 40, 12), node(901, NaN, 50), node(902, 30, undefined as unknown as number)]) {
      const withOdd = [...nodes.slice(0, 100), odd, ...nodes.slice(100)];
      expect(nodesAroundLine(contextOf(withOdd), 'f', 45)).toBe(withOdd);
    }
    for (const line of [-1, NaN, undefined as unknown as number]) expect(nodesAroundLine(contextOf(nodes), 'f', line)).toBe(nodes);
  });

  it('reads the array the context hands out now, not the one it handed out before', () => {
    const first = fileNodes(300, 8);
    const second = first.map((n, i) => node(i + 10_000, n.startLine + 5, n.endLine + 5, n.kind));
    const holds = (n: Node): boolean => n.startLine <= 70 && n.endLine >= 70;
    expect(nodesAroundLine(contextOf(first), 'f', 70).filter(holds).map((n) => n.id)).toEqual(first.filter(holds).map((n) => n.id));
    expect(nodesAroundLine(contextOf(second), 'f', 70).filter(holds).map((n) => n.id)).toEqual(second.filter(holds).map((n) => n.id));
  });
});

describe('a list too long to spread into a call', () => {
  // More arguments than a call takes: `target.push(...items)` throws a RangeError at about this many.
  const many = Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 100_003);

  it('is added to another, item by item', () => {
    const target = [1, 2];
    pushAll(target, many);
    expect(target).toHaveLength(many.length + 2);
    expect(target.slice(0, 4)).toEqual([1, 2, many[0], many[1]]);
    expect(target[target.length - 1]).toBe(many[many.length - 1]);
    pushAll(target, []);
    expect(target).toHaveLength(many.length + 2);
  });

  it('has its largest and its smallest found as Math.max and Math.min find them', () => {
    expect(maxOf(many)).toBe(100_002);
    expect(minOf(many)).toBe(0);
    for (const values of [[3, -1, 7], [-5], [2, NaN, 9], [Infinity, 1], []]) {
      expect(maxOf(values)).toBe(Math.max(...values));
      expect(minOf(values)).toBe(Math.min(...values));
    }
  });
});
