/**
 * TS 4.7 variance annotations (`interface Stream<out A, in E>`, `<in out T>`)
 * were parse errors in tree-sitter-typescript v0.23.2 (upstream #370). In a
 * big file the errors pile up until the parser gives up and the whole file
 * becomes one ERROR: Effect's Schema.ts, Stream.ts and Channel.ts indexed as
 * almost nothing. The vendored grammar (wasm and kernel) is patched; see
 * docs/grammars/tree-sitter-typescript.md.
 *
 * The patch makes `in`/`out` keywords where a type parameter starts, so the
 * cases below also pin that `out` still works as a name where real code uses
 * it: the upstream fix PRs as written break `type F<out> = out[]`, and
 * accepting `out` as a type name everywhere broke `[out: T]` tuple labels
 * (Effect's JsonSchema.ts). Known limit, by choice: a TYPE or JSX tag
 * literally named `out`/`in` right after an expression `<` (`<out>x`,
 * `<out>…</out>`) no longer parses.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Node } from 'web-tree-sitter';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'tsx']);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-variance-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/stream.ts'), `export interface Stream<out A, in out E = never> {
  map<B>(f: (a: A) => B): Stream<B, E>
}

export function runStream<A>(s: Stream<A>): A[] {
  return []
}
`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function parse(language: 'typescript' | 'tsx', src: string) {
  return getParser(language)!.parse(src)!.rootNode;
}

/** The modifier tokens of every type_parameter, and its name. */
function typeParams(root: Node): string[] {
  return root.descendantsOfType('type_parameter').map((p) => {
    const mods: string[] = [];
    for (let i = 0; i < p.childCount; i++) {
      const c = p.child(i)!;
      if (!c.isNamed && ['in', 'out', 'const'].includes(c.type)) mods.push(c.type);
    }
    return [...mods, p.childForFieldName('name')!.text].join(' ');
  });
}

describe('TypeScript variance annotations', () => {
  it.each(['typescript', 'tsx'] as const)('%s: reads in / out / in out / const before the name', (language) => {
    const cases: Array<[string, string[]]> = [
      ['interface E<out A, in B, in out C> {}', ['out A', 'in B', 'in out C']],
      ['class C<const in T> {}', ['const in T']],
      ['class C<in const T> {}', ['in const T']],
      ['export interface Channel<\n  out OutElem,\n  in InElem = unknown\n> {}', ['out OutElem', 'in InElem']],
    ];
    for (const [src, want] of cases) {
      const tree = parse(language, src);
      expect(tree.hasError, src).toBe(false);
      expect(typeParams(tree), src).toEqual(want);
    }
  });

  it.each(['typescript', 'tsx'] as const)('%s: still takes `out` as a parameter name', (language) => {
    const cases: Array<[string, string[]]> = [
      ['type F<out> = out[];', ['out']],
      ['type H<out = number> = out;', ['out']],
      ['type I<out, T> = [out, T];', ['out', 'T']],
      ['type J<in out> = out;', ['in out']],
      ['type K<out out> = out;', ['out out']],
    ];
    for (const [src, want] of cases) {
      const tree = parse(language, src);
      expect(tree.hasError, src).toBe(false);
      expect(typeParams(tree), src).toEqual(want);
    }
    expect(parse('tsx', 'const c = <out,>(x: out) => x;').hasError).toBe(false);
  });

  it('keeps `out` usable as a name outside type parameters', () => {
    const tuple = parse('typescript', 'type P = readonly [out: number, value: string]');
    expect(tuple.hasError).toBe(false);
    expect(tuple.descendantsOfType('required_parameter').map((p) => p.childForFieldName('name')!.text)).toEqual(['out', 'value']);
    for (const src of [
      'type M = { [out in K]: 1 }',
      'type N = { [out: string]: 1 }',
      'type Q = (out: number) => void',
      'function isOut(out: unknown): out is string { return true }',
      'f<out>(x)',
      'let out = 1; out++; const o = { out }; function g(out: number) { return out }',
      'interface I { out: number; in: string }',
      'enum E { out, in }',
      'for (const k in obj) {}\nconst b = "a" in obj;',
    ]) {
      expect(parse('typescript', src).hasError, src).toBe(false);
    }
  });

  it('leaves a method whose type parameters start on the next line a method', () => {
    const cls = parse('typescript', 'class Repo {\n  find\n    <T>(id: T): T { return id }\n}');
    expect(cls.hasError).toBe(false);
    expect(cls.descendantsOfType('method_definition').map((m) => m.childForFieldName('name')!.text)).toEqual(['find']);
    const iface = parse('typescript', 'interface Api {\n  get\n    <T>(url: string): T\n}');
    expect(iface.hasError).toBe(false);
    expect(iface.descendantsOfType('method_signature').map((m) => m.childForFieldName('name')!.text)).toEqual(['get']);
  });

  it('extracts the declarations that use them', () => {
    const names = cg.getNodesInFile('src/stream.ts').map((n) => `${n.kind}:${n.name}`);
    expect(names).toEqual(expect.arrayContaining(['interface:Stream', 'method:map', 'function:runStream']));
  });
});
