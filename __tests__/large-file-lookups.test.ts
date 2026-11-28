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
 * The same goes for the nodes of a file by name, which a routes file asked
 * its controller for once per route, for a node's children stepped through
 * with a cursor where they were read by index, and for where each of many
 * names first occurs in a text, which was an `indexOf` from the text's start
 * for each name.
 *
 * And a list as long as a large file has imports or symbols is added to
 * another without being spread into a call's arguments, which overflowed the
 * stack.
 */

import { describe, it, expect } from 'vitest';
import { firstIndexOfEach, lineAt } from '../src/resolution/synth-utils';
import { importsBoundTo, importsFrom, importsReadBy, pythonMemberImports } from '../src/resolution/import-lookup';
import { nodesAroundLine, nodesAroundLineIn, nodesNamed, nodesNamedIn, nodesNamedLower, nodesUnder } from '../src/resolution/nodes-around';
import { childrenOf, namedChildrenOf } from '../src/extraction/tree-sitter-helpers';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
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

describe('the nodes of a file by name', () => {
  const contextOf = (nodes: Node[]): ResolutionContext => ({ getNodesInFile: () => nodes } as unknown as ResolutionContext);

  /** A file's nodes: names shared across kinds and owners, some differing only in case, members under types under namespaces. */
  function fileNodes(count: number, seed: number): Node[] {
    const next = random(seed);
    const names = ['index', 'Index', 'INDEX', 'show', 'x1', 'x10', 'constructor', '__proto__', 'toString', ''];
    const owners = ['App', 'App::Users', 'App::Users::Admin', 'Other', 'app', 'App::User'];
    return Array.from({ length: count }, (_, i) => {
      const name = next() < 0.6 ? names[Math.floor(next() * names.length)]! : `x${i}`;
      const owner = next() < 0.8 ? owners[Math.floor(next() * owners.length)]! : '';
      return { id: `n${i}`, kind: next() < 0.5 ? 'method' : 'class', name, qualifiedName: owner ? `${owner}::${name}` : name, startLine: i + 1, endLine: i + 1 } as unknown as Node;
    });
  }
  const asked = ['index', 'Index', 'show', 'x1', 'x10', 'x3', 'x30', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'nothing'];
  const ids = (nodes: readonly Node[]): string[] => nodes.map((n) => n.id);

  // Ten and sixty-three nodes are read through; sixty-four and more are indexed.
  for (const count of [0, 10, 63, 64, 500, 5000]) {
    it(`are what a pass over all of them finds, in the file's order (${count} nodes)`, () => {
      const nodes = fileNodes(count, count + 2);
      const context = contextOf(nodes);
      for (const name of asked) {
        const same = (n: Node): boolean => n.name === name;
        expect(ids(nodesNamed(context, 'f', name).filter(same)), `named ${JSON.stringify(name)}`).toEqual(ids(nodes.filter(same)));
        expect(ids(nodesNamedIn(nodes, name).filter(same)), `named ${JSON.stringify(name)}, in hand`).toEqual(ids(nodes.filter(same)));
        const lower = name.toLowerCase();
        expect(ids(nodesNamedLower(context, 'f', lower)), `named ${JSON.stringify(lower)} in any case`).toEqual(ids(nodes.filter((n) => n.name.toLowerCase() === lower)));
      }
      for (const owner of ['App', 'App::Users', 'App::Users::Admin', 'App::User', 'Other', 'app', 'App::', '', 'Nothing']) {
        expect(ids(nodesUnder(context, 'f', owner)), `under ${JSON.stringify(owner)}`).toEqual(ids(nodes.filter((n) => n.qualifiedName.startsWith(`${owner}::`))));
      }
    });
  }

  it('are fewer than all of them, in a file large enough to be worth it', () => {
    const nodes = fileNodes(5000, 4);
    expect(nodesNamed(contextOf(nodes), 'f', 'x4999').length).toBeLessThan(3);
    expect(nodesNamed(contextOf(nodes), 'f', 'nothing')).toHaveLength(0);
  });

  it('gives every node when there is no name to go by', () => {
    const nodes = fileNodes(300, 6);
    for (const name of [undefined, null]) expect(nodesNamed(contextOf(nodes), 'f', name)).toBe(nodes);
  });

  it('reads the array the context hands out now, not the one it handed out before', () => {
    const first = fileNodes(300, 8);
    const second = fileNodes(300, 9);
    for (const nodes of [first, second, first]) {
      const context = contextOf(nodes);
      expect(ids(nodesNamed(context, 'f', 'show'))).toEqual(ids(nodes.filter((n) => n.name === 'show')));
      expect(ids(nodesNamedLower(context, 'f', 'index'))).toEqual(ids(nodes.filter((n) => n.name.toLowerCase() === 'index')));
      expect(ids(nodesUnder(context, 'f', 'App'))).toEqual(ids(nodes.filter((n) => n.qualifiedName.startsWith('App::'))));
      const holds = (n: Node): boolean => n.startLine <= 70 && n.endLine >= 70;
      expect(ids(nodesAroundLineIn(nodes, 70).filter(holds))).toEqual(ids(nodes.filter(holds)));
    }
  });
});

describe('a node\'s children, stepped through', () => {
  // A run of comment lines under one parent is what reading by index was slow on.
  const SOURCES: Array<[string, 'javascript' | 'python', string]> = [
    ['a file of comments and declarations', 'javascript', `${Array.from({ length: 300 }, (_, i) => `// comment ${i}`).join('\n')}\nfunction a(x, y) { return [x, y, { z: 1 }]; }\nclass B { m() {} /* c */ n() {} }\n`],
    ['a file with nothing in it', 'javascript', ''],
    ['a file of one expression', 'javascript', 'f(1, 2, 3);'],
    ['a Python class of methods and comments', 'python', `class A:\n${Array.from({ length: 200 }, (_, i) => `    # note ${i}\n    def m${i}(self, a, b=1):\n        return [a, b]\n`).join('')}`],
  ];

  for (const [what, language, source] of SOURCES) {
    it(`are the ones child(i) and namedChild(i) give, in order: ${what}`, async () => {
      await initGrammars();
      await loadGrammarsForLanguages([language]);
      const tree = getParser(language)!.parse(source)!;
      try {
        let seen = 0;
        const visit = (node: Parameters<typeof childrenOf>[0]): void => {
          const all = [...childrenOf(node)];
          const named = [...namedChildrenOf(node)];
          expect(all.map((c) => c.id)).toEqual(Array.from({ length: node.childCount }, (_, i) => node.child(i)!.id));
          expect(named.map((c) => c.id)).toEqual(Array.from({ length: node.namedChildCount }, (_, i) => node.namedChild(i)!.id));
          seen += all.length;
          for (const c of all) visit(c);
        };
        visit(tree.rootNode);
        if (source) expect(seen).toBeGreaterThan(3);
      } finally {
        tree.delete();
      }
    });
  }

  it('can be left before the last of them', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['javascript']);
    const tree = getParser('javascript')!.parse('a; b; c; d;')!;
    try {
      for (let round = 0; round < 2000; round++) {
        let first: string | undefined;
        for (const c of namedChildrenOf(tree.rootNode)) {
          first = c.text;
          break;
        }
        expect(first).toBe('a;');
      }
    } finally {
      tree.delete();
    }
  });
});

describe('where each of many names first occurs in a text', () => {
  it('is where indexOf finds each, for names that are starts, ends and middles of one another', () => {
    const text = '  disabledOnPress?: boolean;\n  onPress?: () => void;\n  on: string;\n  press: Press;\n';
    const names = ['on', 'onPress', 'Press', 'ress', 'nP', 'disabledOnPress', 'o', 'press', 'string', 'missing', 'OnPresses', ';\n', ''];
    const found = firstIndexOfEach(text, names);
    for (const name of names) expect(found.get(name), JSON.stringify(name)).toBe(text.indexOf(name));
    expect(found.get('on')).toBeGreaterThan(text.indexOf('disabled'));
    expect(found.get('missing')).toBe(-1);
    expect(found.size).toBe(names.length);
  });

  it('is so over generated names and texts, few and many', () => {
    const next = random(13);
    const alphabet = 'ab_o1nP';
    const word = (longest: number): string =>
      Array.from({ length: 1 + Math.floor(next() * longest) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    for (const [nameCount, words] of [[0, 50], [1, 50], [40, 400], [600, 6000], [3000, 300]] as const) {
      const names = Array.from({ length: nameCount }, () => word(7));
      let text = '';
      for (let i = 0; i < words; i++) text += word(9) + (next() < 0.5 ? ' ' : ';\n');
      const found = firstIndexOfEach(text, names);
      for (const name of names) expect(found.get(name), `${JSON.stringify(name)} among ${nameCount} names`).toBe(text.indexOf(name));
      expect(found.size).toBe(new Set(names).size);
    }
  });

  it('is so for a name the text ends in, one it starts with, and characters outside ASCII', () => {
    const text = 'größe: 日本語 😀 naïve größer 😀😀 end';
    const names = ['größe', 'größer', 'ö', '日本', '本語', '😀', '😀😀', '\ud83d', 'end', 'nd', 'g', 'ende', ' '];
    const found = firstIndexOfEach(text, names);
    for (const name of names) expect(found.get(name), JSON.stringify(name)).toBe(text.indexOf(name));
  });

  it('is so in a text as long as a large file, for every name it declares', () => {
    const lines = Array.from({ length: 40_000 }, (_, i) => `  prop${i}?: string;\n  onEvent${i}?: Handler<prop${(i * 7) % 40_000}>;\n`);
    const text = lines.join('');
    const names = lines.flatMap((_, i) => [`prop${i}`, `onEvent${i}`]);
    const started = Date.now();
    const found = firstIndexOfEach(text, names);
    expect(Date.now() - started).toBeLessThan(20_000);
    const next = random(17);
    for (const i of [0, 1, 7, 10, 39_999, ...Array.from({ length: 300 }, () => Math.floor(next() * 40_000))]) {
      expect(found.get(`prop${i}`), `prop${i}`).toBe(text.indexOf(`prop${i}`));
      expect(found.get(`onEvent${i}`), `onEvent${i}`).toBe(text.indexOf(`onEvent${i}`));
    }
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
