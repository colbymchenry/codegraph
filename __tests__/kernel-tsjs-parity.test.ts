/**
 * Kernel↔wasm TS/JS extraction parity (R2 of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/tsjs/) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over:
 *   - the checked-in torture fixtures (every ported feature: components/HOCs,
 *     stores, RTK, vuex, fn-refs, value-ref shadowing, decorators, enums,
 *     type-alias members/tuple contracts, re-exports, JSX, field methods), and
 *   - this repo's own extraction sources (real-world TS).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (excalidraw et al.,
 * run for the §5 gate); this suite keeps the invariant alive in `npm test`.
 * Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1 turns that
 * into a failure (wired in kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'kernel-parity');
const REAL_SOURCES = [
  'src/extraction/kernel/loader.ts',
  'src/extraction/kernel/decode.ts',
  'src/extraction/parse-pool.ts',
  'src/extraction/function-ref.ts',
  'src/mcp/tools.ts',
];

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel TS/JS extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function assertParity(filePath: string, source: string, language: Language): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, language);
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, language);
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    // Meaningful comparison, not empty-vs-empty.
    expect(viaWasm.nodes.length).toBeGreaterThan(3);
    return viaWasm;
  }

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('named object literals own their members: %s (#2300)', (ext, language) => {
    const source = [
      '/* é😀 */ const Api = { read() { helper(); }, close: () => helper(), gen: function* () { yield 1; }, \'quoted-key\': function () {}, [dyn()]() { helper(); }, eager: helper(), alias: helper, helper };',
      'function helper() {}',
      '/** Saved. */',
      'export const Exported = { save() { helper(); } };',
      '(function () { const Local = { run() { helper(); } }, data = { x: 1 }; Local.run(); window.WS = { ws() { Local.run(); } }; })();',
      'App.utils = { pad(s) { return s; } };',
      '// The page.',
      'dw_page = { start() { helper(); } };',
      'function setup() { ns.late = { go() {} }; let h; h = { on() {} }; }',
      'module.exports = { cjs() {} };',
      'Foo.prototype = { proto() {} };',
      'self.handlers = { click() {} };',
      'consume({ ephemeral() {} });',
      '',
    ].join('\n');
    for (const ending of ['\n', '\r\n']) {
      const result = assertParity(`literal.${ext}`, source.replace(/\n/g, ending), language);
      expect(result.nodes.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining([
        'Api::read', 'Api::close', 'Api::gen', 'Api::quoted-key', 'Exported::save', 'Local::run', 'window.WS',
        'window.WS::ws', 'App.utils::pad', 'dw_page::start', 'ns.late::go', 'self.handlers::click',
      ]));
      // A plain name reassigned inside a function is a local, not a namespace.
      for (const name of ['cjs', 'proto', 'ephemeral', 'data', 'on']) expect(result.nodes.some((n) => n.name === name), name).toBe(false);
    }
  });

  it.each(['bundle.js', 'vendor-min.js', 'vendor.min.js'])('a minified bundle keeps its literals unowned: %s (#2300)', (file) => {
    // Mostly long lines dense with code punctuation, as a minifier writes them.
    const line = `var a={b:function(){return c(1,2)},d:function(e){return e}};window.L={f:function(){return a.b()}};`.repeat(40);
    const result = assertParity(file, `${line}\n${line}\n`, 'javascript');
    expect(result.nodes.some((n) => n.kind === 'function' && (n.name === 'b' || n.name === 'f'))).toBe(false);
  });

  describe.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('a store exported by a later statement: %s', (ext, language) => {
    it.each(['LF', 'CRLF'])('keeps its actions (%s)', (ending) => {
      // `export default useStore;` is found by a multiline regex over the
      // source. JS's `$` matches before the `\r` of a CRLF line ending; the
      // kernel's must too, or a Windows checkout loses the store's actions.
      const source = [
        'import { create } from "zustand";',
        'const useStore = create((set) => ({ inc: () => set({}) }));',
        'export default useStore;',
        '',
      ].join(ending === 'CRLF' ? '\r\n' : '\n');
      const result = assertParity(`store.${ext}`, source, language);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'inc')).toBe(true);
    });

    it.each([
      ['items$', 'export { items$ };', true],
      ['$items', 'export { $items as default };', true],
      ['items', 'export { items$ };', false],
      ['items', 'export { $items };', false],
    ] as const)('an export clause names %s only whole: `%s`', (name, exportLine, kept) => {
      // `\b` takes a `$` for a separator: it can't bound `items$` or
      // `$items`, and it finds `items` inside both. `other` keeps the
      // negative cases above assertParity's node floor.
      const source = [
        'import { create } from "zustand";',
        `const ${name} = create((set) => ({ inc: () => set({}) }));`,
        'const other = 1;',
        exportLine,
        '',
      ].join('\n');
      const result = assertParity(`store.${ext}`, source, language);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'inc')).toBe(kept);
    });
  });

  describe.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('a store whose name has a `$`, exported by a later statement: %s', (ext, language) => {
    // The later-export check builds a regex from the name. Its `$` must match
    // the character, as the kernel's escaped pattern does, not a line end.
    const store = (name: string, ...exportLines: string[]) => [
      'import { create } from "zustand";',
      `const ${name} = create((set) => ({ inc: () => set({}) }));`,
      ...exportLines,
      '',
    ].join('\n');

    it.each([
      ['items$', 'export default items$;'],
      ['$store', 'export default $store;'],
      ['a$b', 'export { a$b };'],
    ])('keeps its actions (%s)', (name, exportLine) => {
      const result = assertParity(`store.${ext}`, store(name, exportLine), language);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'inc')).toBe(true);
    });

    it('is not exported by a different name at a line end', () => {
      const result = assertParity(`store.${ext}`, store('items$', 'const items = 1;', 'export {', '  items', '};'), language);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'inc')).toBe(false);
    });
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('same-line accessors retain distinct identities after Unicode: %s (#1349)', (ext, language) => {
    const source = 'class Point { /* é😀 */ get x() { return read(); } set x(v) { write(v); } }';
    const result = assertParity(`point.${ext}`, source, language);
    const x = result.nodes.filter((n) => n.name === 'x');
    expect(x).toHaveLength(2);
    expect(x[1]!.id).toBe(`${x[0]!.id}:${source.indexOf('set x')}`);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => [r.fromNodeId, r.referenceName]))
      .toEqual([[x[0]!.id, 'read'], [x[1]!.id, 'write']]);
    // No state leaks between files or repeated extractions.
    expect(canon(assertParity(`point.${ext}`, source, language))).toEqual(canon(result));
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('leaves nested identifier receivers unresolved and keeps argument calls: %s (#1566)', (ext, language) => {
    const result = assertParity(`fixture.${ext}`, `
function readKey() { return 'answer'; }
function local() {
  const values = new Map();
  return values.get(readKey());
}
function nested(holder) {
  holder.values.get(readKey());
  holder.values?.get(readKey());
  holder['values'].get(readKey());
  holder.deep.values.get(readKey());
}
`, language);
    const nested = result.nodes.find((n) => n.name === 'nested' && n.kind === 'function');
    expect(nested).toBeDefined();
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === nested!.id)
      // Qualified sites are retained for effects; computed keys still make no
      // receiver claim. All four calls inside arguments must also survive.
      .map((r) => r.referenceName)).toEqual([
        'holder.values.get', 'readKey', 'holder.values.get', 'readKey',
        'readKey', 'holder.deep.values.get', 'readKey',
      ]);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'values.get')).toBe(true);
  });

  describe.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('private field receivers: %s (#1987)', (ext, language) => {
    it.each(['LF', 'CRLF'])('preserves private fields and optional calls (%s)', (ending) => {
      const source = `
class Mailer { send() {} }
class Vault {
  #mailer = new Mailer();
  #items = new Set();
  notify() { this.#mailer?.send(); }
  optional() { this.#mailer.send?.(); }
  put() { this.#items?.add('x'); }
}
`;
      const result = assertParity(`vault.${ext}`, ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source, language);
      expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName))
        .toEqual(['this.#mailer.send', 'this.#mailer.send', 'this.#items.add']);
    });
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('peels transparent receivers and drops untyped expression receivers: %s', (ext, language) => {
    const typed = language === 'typescript' || language === 'tsx';
    const result = assertParity(`fixture.${ext}`, `
function list() { return []; }
class Runner { go() { return 1; } }
async function exprReceivers(x, y) {
  (await list()).map(g);
  (x).run();
  ${typed ? 'x!.run(); (y as X).run(); (x satisfies X).stop(); getTarget("a")!.install(); if (x && y!.c.has(1)) {} if (x && this.e!.c.has(1)) {}' : ''}
  (a ?? b).map(g);
  arr[0].run();
  f().list.map(g);
  (() => 1).call(null);
  this.a.b.run();
  super.stop();
  new Runner().go();
  window.Api.start();
}
`, language);
    const fn = result.nodes.find((n) => n.name === 'exprReceivers');
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === fn!.id)
      .map((r) => r.referenceName)).toEqual([
        'list().map', 'list', 'x.run',
        ...(typed ? ['x.run', 'y.run', 'x.stop', 'getTarget().install', 'getTarget', 'has'] : []),
        'f', 'run', 'stop', 'go', 'start',
      ]);
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('walks a module-scope destructuring declaration like a body does: %s (#2340)', (ext, language) => {
    const typed = language === 'typescript' || language === 'tsx';
    const result = assertParity(`fixture.${ext}`, `
import { handler } from './h';
const { a } = useFoo(1);
let [b, c] = pair();
var { d: { e } } = nested();
const { f = fallback() } = withDefault(handler);
const [g = other(), ...rest] = list(() => inArrow(handler));
export const { h } = exported(new Store());
export const { useGetUserQuery } = api;
${typed ? 'const { k }: Shape = make();' : ''}
function probe() { const { j } = inner(); return j; }
export function second() { return probe(); }
`, language);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toEqual(expect.arrayContaining([
      'useFoo', 'pair', 'nested', 'fallback', 'withDefault', 'other', 'list', 'inArrow', 'exported', 'inner',
      ...(typed ? ['make'] : []),
    ]));
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'],
  ] as const)('typed styled tags are components, parsed as comparisons or not: %s', (ext, language) => {
    // `styled.div<Props>\`…\`` parses as `(styled.div < Props) > \`…\``; the
    // type argument's own operators sit between (`<A | B>`, `<Partial<A>>`).
    const result = assertParity(`styles.${ext}`, `
import styled, { css } from 'styled-components';
import { s } from './theme';
type Props = { align: 'start' | 'end' };
const Plain = styled.div\`color: red;\`;
export const Wrapper = styled.div<Props>\`color: \${(p) => s(p.align)};\`;
const CloseAction = styled.div<{ animation: Animation | null }>\`top: 0;\`;
const Content = styled(Plain)<Props>\`padding: 4px;\`;
const NudeButton = styled(Plain).attrs((props: Props) => ({ type: "button" }))<Props>\`\`;
const Either = styled.div<Props | Other>\`color: red;\`;
const Nested = styled.div<Partial<Props>>\`color: red;\`;
const Mixin = css<Props>\`color: red;\`;
const Compared = styled.length < LIMIT > 2;
const lowerCase = styled.div<Props>\`color: red;\`;
`, language);
    const kind = (name: string) => result.nodes.filter((n) => n.name === name).map((n) => n.kind);
    for (const name of ['Plain', 'Wrapper', 'CloseAction', 'Content', 'NudeButton', 'Either', 'Nested']) {
      expect(kind(name), name).toEqual(['component']);
    }
    for (const name of ['Mixin', 'Compared', 'lowerCase']) expect(kind(name), name).toEqual(['constant']);
  });

  it('torture fixture (tsx): components, stores, RTK, fn-refs, value-refs, decorators', () => {
    const file = path.join(FIXTURE_DIR, 'torture.tsx');
    assertParity('fixtures/torture.tsx', fs.readFileSync(file, 'utf8'), 'tsx');
  });

  it('torture fixture (js): field methods, wrappers, vuex module shape', () => {
    const file = path.join(FIXTURE_DIR, 'torture.js');
    assertParity('fixtures/torture.js', fs.readFileSync(file, 'utf8'), 'javascript');
  });

  it('torture fixture (java): Lombok, anonymous classes, method refs, chains', () => {
    const file = path.join(FIXTURE_DIR, 'Torture.java');
    assertParity('fixtures/Torture.java', fs.readFileSync(file, 'utf8'), 'java');
  });

  it('torture fixture (python): decorators, self fn-refs, imports, shadowing', () => {
    const file = path.join(FIXTURE_DIR, 'torture.py');
    assertParity('fixtures/torture.py', fs.readFileSync(file, 'utf8'), 'python');
  });

  it.each(['LF', 'CRLF'])('Python body docstrings parity (%s, #1905)', (ending) => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, 'docstrings.py'), 'utf8');
    const result = assertParity('ledger.py', ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source, 'python');
    expect(result.nodes.find((n) => n.kind === 'file')?.docstring).toBe('Ledger module documentation.');
    expect(result.nodes.find((n) => n.name === 'settle')?.docstring).toBe('Method comment.\n\nSettle the ledger.');
  });

  it('torture fixture (go): receivers, embedding, interfaces, composite literals', () => {
    const file = path.join(FIXTURE_DIR, 'torture.go');
    assertParity('fixtures/torture.go', fs.readFileSync(file, 'utf8'), 'go');
  });

  it('Python member values preserve receivers across callback, assignment and collection positions (#1820)', () => {
    const result = assertParity('members.py', `
class Store:
    def fetch(self, ids):
        return ids
class Consumer:
    def wire(self, pool, obj):
        pool.submit(self.store.fetch, obj.fetch)
        cb = self.store.fetch
        table = [obj.fetch, Store.fetch, self.fetch, cls.fetch]
        keyword(callback=obj.fetch)
        obj.fetch([])
        pool.submit(factory().fetch, obj[0].fetch)
`, 'python');
    const names = result.unresolvedReferences.filter(r => r.referenceKind === 'function_ref').map(r => r.referenceName);
    expect(names.sort()).toEqual(['Store.fetch', 'cls.fetch', 'obj.fetch', 'self.fetch', 'self.store.fetch']);
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'calls' && r.referenceName === 'obj.fetch')).toBe(true);
  });

  it('Go method values preserve receivers and exclude invocation receivers (#1820)', () => {
    const result = assertParity('members.go', `package demo
 type Store struct{}
 func (s *Store) Fetch() {}
 func wire(c *Store, pool Pool) {
   Submit(c.Fetch)
   cb := c.Fetch
   table := []func(){c.Fetch, Store.Fetch}
   Submit(c.store.Fetch)
   go c.Fetch()
   Submit(factory().Fetch, items[0].Fetch)
 }
`, 'go');
    const names = result.unresolvedReferences.filter(r => r.referenceKind === 'function_ref').map(r => r.referenceName);
    expect(names.sort()).toEqual(['Store.Fetch', 'c.Fetch', 'c.store.Fetch']);
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'calls' && r.referenceName === 'c.Fetch')).toBe(true);
  });

  it.each(['LF', 'CRLF'])('Go selector values stoplist the whole name, not the field (%s)', (ending) => {
    // The stoplist holds bare words like Python's `None`; `raft.None` (etcd)
    // and cgo's `C.NULL` are still values. The name is operand + field, so a
    // break or comment after the dot keeps it; one inside the operand doesn't.
    const source = `package demo
import "example.com/raft"
type Store struct{}
func (s *Store) new() any { return nil }
func wire(s *Store) {
	Submit(raft.None, C.NULL, None, nil)
	pool := sync.Pool{New: s.new}
	Submit(raft.
		Next, raft./* c */ Prev, raft.// c
		Last)
	Submit(s.
		inner.Fetch)
	_ = pool
}
`;
    const result = assertParity('values.go', ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source, 'go');
    const names = result.unresolvedReferences.filter(r => r.referenceKind === 'function_ref').map(r => r.referenceName);
    expect(names.sort()).toEqual(['C.NULL', 'raft.Last', 'raft.Next', 'raft.None', 'raft.Prev', 's.new']);
  });

  it.each(REAL_SOURCES)('real source parity: %s', (rel) => {
    const file = path.join(__dirname, '..', rel);
    assertParity(rel, fs.readFileSync(file, 'utf8'), 'typescript');
  });

  // Every torture fixture again with CRLF line endings — the shape every
  // Windows autocrlf checkout has. Derived in memory (not a checked-in CRLF
  // file) so no platform or editor can silently normalize it away. Pins the
  // JS-multiline-^ semantics in the kernel's docstring cleaning: JS `^`/m
  // anchors after \r too, so the block-continuation `\s*` eats the `\n` and
  // the cleaned docstring keeps a bare `\r` (caught on the Windows VM leg of
  // the O2 gate; diverged in the kernel until docstring.rs mirrored it).
  it.each([
    ['torture.tsx', 'tsx'],
    ['torture.js', 'javascript'],
    ['Torture.java', 'java'],
    ['torture.py', 'python'],
    ['torture.go', 'go'],
  ] as const)('torture fixture CRLF parity: %s', (name, lang) => {
    const file = path.join(FIXTURE_DIR, name);
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity(`fixtures/${name} (crlf)`, crlf, lang);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // tree-sitter error RECOVERY differs between UTF-8 (native) and UTF-16
    // (web-tree-sitter) parsing — same grammar, same core version — so the
    // kernel defers any erroring file to keep routing graph-neutral.
    const broken = 'export function f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.ts', broken, 'typescript')).toBeNull();
    // The seam still serves the file — through the wasm path.
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.ts', broken, 'typescript');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('typescript fixture parsed as plain typescript variant', () => {
    // Same content through the non-tsx grammar exercises the typescript
    // (vs tsx) LangSpec pairing.
    const file = path.join(__dirname, '..', 'src/extraction/kernel/index.ts');
    assertParity('src/extraction/kernel/index.ts', fs.readFileSync(file, 'utf8'), 'typescript');
  });
});
