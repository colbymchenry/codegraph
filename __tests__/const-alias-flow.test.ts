/**
 * A flow carries on through a const that only hands a function on.
 *
 * `export const extname = (isWin ? win32.extname : posix.extname)` holds one
 * of two methods. An import of `extname` rightly lands on the const (#2945,
 * see import-object-member-namesake.test.ts), and the const had no edge to
 * what it holds, so every call into it stopped there: 322 call sites on
 * vscode's base and editor reached no method at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import { aliasedPaths } from '../src/resolution/const-alias-synthesizer';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function indexProject(files: Record<string, string>): Promise<{ cg: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-const-alias-'));
  roots.push(root);
  write(root, files);
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return { cg, root };
}

/** What the alias named `name` in `file` links on to: `<file>:<qualified name>`, sorted. */
function aliasTargets(cg: CodeGraph, file: string, name: string): string[] {
  const alias = cg.getNodesInFile(file).find((n) => n.name === name && (n.kind === 'constant' || n.kind === 'variable'));
  expect(alias, `${file}: ${name}`).toBeDefined();
  return cg
    .getOutgoingEdgesFrom([alias!.id])
    .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'const-alias')
    .map((e) => {
      const t = cg.getNode(e.target);
      return `${t?.filePath}:${t?.qualifiedName}`;
    })
    .sort();
}

/** The names on the flow a query finds, in order. */
function flow(cg: CodeGraph, query: string): string[] {
  return resolveNamedSymbolFlow(cg, query).chains[0]?.steps.map((s) => s.node.name) ?? [];
}

const PATHS = `function validateString(value: string) { if (typeof value !== 'string') throw new Error('x'); }
export const win32 = {
  extname(path: string): string {
    validateString(path);
    return path;
  },
  sep: '\\\\',
};
export const posix = {
  extname(path: string): string {
    validateString(path);
    return path;
  },
  sep: '/',
};
const isWin = false;
export const extname = (isWin ? win32.extname : posix.extname);
`;

describe('the initializers that hand a function on', () => {
  it.each([
    ['a.b', ['a.b']],
    ['(a.b)', ['a.b']],
    ['a?.b', ['a.b']],
    ['a.b.c', ['a.b.c']],
    ['fn', ['fn']],
    ['cond ? a.b : c.d', ['a.b', 'c.d']],
    ['(cond ? a.b : c.d)', ['a.b', 'c.d']],
    ['one.two ? a.b : c.d', ['a.b', 'c.d']],
    ['cond ? a.b : other ? c.d : e.f', ['a.b', 'c.d', 'e.f']],
    ['get(x, ":") ? a.b : c.d', ['a.b', 'c.d']],
    ['a.b ?? c.d', ['a.b', 'c.d']],
    ['a.b || c.d', ['a.b', 'c.d']],
    ['a.b ?? c.d ?? e.f', ['a.b', 'c.d', 'e.f']],
    ['a.b || noop', ['a.b', 'noop']],
    ['a.b ?? (() => 1)', ['a.b']],
    ['cond ? a.b : null', ['a.b']],
    ['a.b as Handler', ['a.b']],
    ['a.b satisfies Handler', ['a.b']],
    ['a.b!', ['a.b']],
    ['(cond ? a.b : c.d) as (p: string) => string', ['a.b', 'c.d']],
    ['(x as boolean) ? a.b : c.d', ['a.b', 'c.d']],
    ['cond /* why */ ? a.b : c.d', ['a.b', 'c.d']],
    ['cond\r\n  ? a.b\r\n  : c.d', ['a.b', 'c.d']],
  ])('%s', (code, paths) => {
    expect(aliasedPaths(code)).toEqual(paths);
  });

  it.each([
    '1', '"a.b"', '`a.b`', 'true', 'null', 'undefined', 'this.x', 'super.x', 'a.b()', 'a.b.bind(a)',
    'new a.B()', '[a.b]', '{ a: b.c }', 'a.b + c.d', 'a.b && c.d', '!a.b', 'typeof a.b', '() => a.b', 'a[b]',
    'useAuth as jest.Mock', 'useAuth as unknown as jest.MockedFunction<typeof useAuth>', 'api.load as Mock',
  ])('%s hands nothing on', (code) => {
    expect(aliasedPaths(code)).toEqual([]);
  });
});

describe('a const that names a member links on to it', () => {
  it('links a conditional to both the members it can hold, and the flow carries on through it', async () => {
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'mime.ts': `import { extname } from './path';
export function getMime(path: string) {
  return extname(path);
}
`,
    });
    expect(aliasTargets(cg, 'path.ts', 'extname')).toEqual(['path.ts:posix::extname', 'path.ts:win32::extname']);
    const chain = flow(cg, 'getMime extname validateString');
    expect(chain[0]).toBe('getMime');
    expect(chain.at(-1)).toBe('validateString');
    expect(chain).toHaveLength(4);
  });

  it('keeps the import on the const, as #2945 left it', async () => {
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'mime.ts': `import { extname } from './path';
export function getMime(path: string) { return extname(path); }
`,
    });
    const getMime = cg.getNodesInFile('mime.ts').find((n) => n.name === 'getMime')!;
    const called = cg.getOutgoingEdgesFrom([getMime.id]).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target));
    expect(called.map((n) => `${n?.kind} ${n?.qualifiedName}`)).toEqual(['constant extname']);
  });

  it('says what bridged the hop, and where', async () => {
    const { cg } = await indexProject({ 'path.ts': PATHS });
    const alias = cg.getNodesInFile('path.ts').find((n) => n.name === 'extname' && n.kind === 'constant')!;
    const [edge] = cg.getOutgoingEdgesFrom([alias.id]).filter((e) => e.provenance === 'heuristic');
    expect(edge).toMatchObject({ kind: 'calls', line: alias.startLine });
    expect(edge!.metadata).toMatchObject({ synthesizedBy: 'const-alias', registeredAt: `path.ts:${alias.startLine}` });
    expect(describeSynthesizedHop(edge)?.summary).toMatch(/^const alias of `(?:win32|posix)\.extname`$/);
  });

  it('a flow keeps going when neither the const nor the member is one the query names', async () => {
    // A name with this many definitions names none of them, so the const and
    // the member are two unnamed hops in a row, where one is the budget.
    const others = Array.from({ length: 4 }, (_, i) => `export class Other${i} { extname() {} }\n`).join('');
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'others.ts': others,
      'mime.ts': `import { extname } from './path';
export function getMime(path: string) { return extname(path); }
`,
    });
    const chain = flow(cg, 'getMime extname validateString');
    expect(chain[0]).toBe('getMime');
    expect(chain.at(-1)).toBe('validateString');
  });

  it('links a plain alias, `??`, `||` and a cast', async () => {
    const { cg } = await indexProject({
      'm.ts': `export const a = { f() {}, g: () => 1, h: function () {} };
export const b = { f() {} };
export const plain = a.f;
export const nullish = a.g ?? b.f;
export const either = a.h || b.f;
export const cast = a.f as () => void;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'plain')).toEqual(['m.ts:a::f']);
    expect(aliasTargets(cg, 'm.ts', 'nullish')).toEqual(['m.ts:a::g', 'm.ts:b::f']);
    expect(aliasTargets(cg, 'm.ts', 'either')).toEqual(['m.ts:a::h', 'm.ts:b::f']);
    expect(aliasTargets(cg, 'm.ts', 'cast')).toEqual(['m.ts:a::f']);
  });

  it('links a member of an imported namespace, however deep', async () => {
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'fns.ts': `export function join() {}
`,
      'use.ts': `import * as fns from './fns';
import * as paths from './path';
export const direct = fns.join;
export const deep = paths.win32.extname;
export const chosen = paths.extname;
export function run() { chosen('x'); }
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'direct')).toEqual(['fns.ts:join']);
    expect(aliasTargets(cg, 'use.ts', 'deep')).toEqual(['path.ts:win32::extname']);
    // The namespace's member is itself a const that hands a method on.
    expect(aliasTargets(cg, 'use.ts', 'chosen')).toEqual(['path.ts:extname']);
    expect(flow(cg, 'run validateString').at(-1)).toBe('validateString');
  });

  it('links a member through a named import, a default import and a barrel', async () => {
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'barrel.ts': `export * from './path';
`,
      'd.ts': `const api = { run() {} };
export default api;
`,
      'use.ts': `import { win32 as w } from './barrel';
import api from './d';
export const named = w.extname;
export const fromDefault = api.run;
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'named')).toEqual(['path.ts:win32::extname']);
    expect(aliasTargets(cg, 'use.ts', 'fromDefault')).toEqual(['d.ts:api::run']);
  });

  it('links what a default import or a CommonJS require states', async () => {
    const { cg } = await indexProject({
      'stated.ts': `export function other() {}
export default function parse() {}
`,
      'barrel.ts': `export { default } from './stated';
`,
      'impl.js': `function impl() {}
module.exports = impl;
`,
      'klass.js': `class K { static make() {} }
module.exports = K;
`,
      'use.ts': `import parse from './stated';
import forwarded from './barrel';
export const direct = parse;
export const through = forwarded;
`,
      'use.js': `const impl = require('./impl');
const K = require('./klass');
const alias = impl;
const make = K.make;
module.exports = { alias, make };
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'direct')).toEqual(['stated.ts:parse']);
    expect(aliasTargets(cg, 'use.ts', 'through')).toEqual(['stated.ts:parse']);
    expect(aliasTargets(cg, 'use.js', 'alias')).toEqual(['impl.js:impl']);
    expect(aliasTargets(cg, 'use.js', 'make')).toEqual(['klass.js:K::make']);
  });

  it('links a function an object only names, in its file or through an import', async () => {
    const { cg } = await indexProject({
      'impl.ts': `export function load() {}
`,
      'api.ts': `import { load } from './impl';
function save() {}
export const api = { load, write: save };
export const fromImport = api.load;
export const fromFile = api.write;
`,
    });
    expect(aliasTargets(cg, 'api.ts', 'fromImport')).toEqual(['impl.ts:load']);
    expect(aliasTargets(cg, 'api.ts', 'fromFile')).toEqual(['api.ts:save']);
  });

  it("links a class's static method and arrow, never an instance method", async () => {
    const { cg } = await indexProject({
      'm.ts': `export class C {
  static make() {}
  static arrow = () => 1;
  run() {}
}
export const make = C.make;
export const arrow = C.arrow;
export const run = C.run;
`,
      'use.ts': `import { C } from './m';
export const imported = C.make;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'make')).toEqual(['m.ts:C::make']);
    expect(aliasTargets(cg, 'm.ts', 'arrow')).toEqual(['m.ts:C::arrow']);
    expect(aliasTargets(cg, 'm.ts', 'run')).toEqual([]);
    expect(aliasTargets(cg, 'use.ts', 'imported')).toEqual(['m.ts:C::make']);
  });

  it('links a bare function name, in a conditional or alone, in its file or imported', async () => {
    const { cg } = await indexProject({
      'dev.ts': `export function devHandler() {}
`,
      'm.ts': `import { devHandler } from './dev';
function prodHandler() {}
const isDev = false;
export const handler = isDev ? devHandler : prodHandler;
export const renamed = prodHandler;
export const again = renamed;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'handler')).toEqual(['dev.ts:devHandler', 'm.ts:prodHandler']);
    expect(aliasTargets(cg, 'm.ts', 'renamed')).toEqual(['m.ts:prodHandler']);
    expect(aliasTargets(cg, 'm.ts', 'again')).toEqual(['m.ts:renamed']);
  });

  it('reads a `let` and a `var`, and an initializer too long for the index to keep', async () => {
    const long = 'a_condition_with_a_name_long_enough_to_push_the_initializer_past_what_the_index_keeps_of_it';
    const { cg } = await indexProject({
      'm.ts': `export const a = { f() {} };
export const b = { g() {} };
let viaLet = a.f;
var viaVar = b.g;
declare const ${long}: boolean;
export const long = ${long} ? a.f : b.g;
export const wrapped = ${long}
  ? a.f
  : b.g;
export const closed = check(1) ? a.f : ${long} ? b.g : a.f;
declare function check(n: number): boolean;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'viaLet')).toEqual(['m.ts:a::f']);
    expect(aliasTargets(cg, 'm.ts', 'viaVar')).toEqual(['m.ts:b::g']);
    expect(aliasTargets(cg, 'm.ts', 'long')).toEqual(['m.ts:a::f', 'm.ts:b::g']);
    expect(aliasTargets(cg, 'm.ts', 'wrapped')).toEqual(['m.ts:a::f', 'm.ts:b::g']);
    expect(aliasTargets(cg, 'm.ts', 'closed')).toEqual(['m.ts:a::f', 'm.ts:b::g']);
  });
});

describe('a const that names no function links nothing', () => {
  it('a member that is data', async () => {
    const { cg } = await indexProject({
      'path.ts': PATHS,
      'm.ts': `import { win32, posix } from './path';
export class C { static size = 3; width = 1; }
export enum Color { Red, Blue }
export const data = { count: 1, label: 'x', nested: { value: 2 } };
const isWin = false;
export const sep = isWin ? win32.sep : posix.sep;
export const size = C.size;
export const width = C.width;
export const red = Color.Red;
export const count = data.count ?? 0;
export const nested = data.nested.value;
export const missing = data.nothing;
export const flag = isWin;
`,
    });
    for (const name of ['sep', 'size', 'width', 'red', 'count', 'nested', 'missing', 'flag']) {
      expect(aliasTargets(cg, 'm.ts', name), name).toEqual([]);
    }
  });

  it('a const holding a class', async () => {
    const { cg } = await indexProject({
      'm.ts': `export class A { run() {} }
export class B { run() {} }
const isA = false;
export const Chosen = isA ? A : B;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'Chosen')).toEqual([]);
  });

  it("a const handing on another const that names no function", async () => {
    const { cg } = await indexProject({
      'm.ts': `export const size = 3;
export const data = { count: 1 };
export const first = data.count;
export const second = first;
export const third = size;
`,
    });
    for (const name of ['first', 'second', 'third']) expect(aliasTargets(cg, 'm.ts', name), name).toEqual([]);
  });

  it('two consts that only name each other', async () => {
    const { cg } = await indexProject({
      'm.ts': `export const a = b;
export const b = a;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'a')).toEqual([]);
    expect(aliasTargets(cg, 'm.ts', 'b')).toEqual([]);
  });

  it('a receiver the file does not bind, whatever the project declares by that member name', async () => {
    const { cg } = await indexProject({
      'other.ts': `export function keys() {}
export class Service { handler() {} }
export const config = { handler() {} };
`,
      'm.ts': `export const fromGlobal = Object.keys;
export const fromUnknown = settings.handler;
declare const settings: { handler(): void };
export const fromWindow = window.config.handler;
`,
    });
    for (const name of ['fromGlobal', 'fromUnknown', 'fromWindow']) expect(aliasTargets(cg, 'm.ts', name), name).toEqual([]);
  });

  it("a default import the module doesn't state, where the resolver guesses at its first export", async () => {
    const { cg } = await indexProject({
      'first-class.ts': `export class K { static make() {} }
declare function build(): unknown;
export default build();
`,
      'first-function.ts': `export function helper() {}
declare function build(): unknown;
export default build();
`,
      'exports.js': `exports.first = function () {};
exports.second = function second() {};
`,
      'use.ts': `import client from './first-function';
import made from './first-class';
export const bare = client;
export const member = made.make;
`,
      'use.js': `const named = require('./exports');
const whole = named;
const second = named.second;
module.exports = { whole, second };
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'bare')).toEqual([]);
    expect(aliasTargets(cg, 'use.ts', 'member')).toEqual([]);
    expect(aliasTargets(cg, 'use.js', 'whole')).toEqual([]);
    expect(aliasTargets(cg, 'use.js', 'second')).toEqual([]);
  });

  it('a member of a package, with a namesake in the project', async () => {
    const { cg } = await indexProject({
      'other.ts': `export function readFile() {}
`,
      'm.ts': `import * as fs from 'fs';
import { promises } from 'fs';
export const read = fs.readFile;
export const readAsync = promises.readFile;
`,
    });
    expect(aliasTargets(cg, 'm.ts', 'read')).toEqual([]);
    expect(aliasTargets(cg, 'm.ts', 'readAsync')).toEqual([]);
  });

  it('a call, a bind or a new, which are other things', async () => {
    const { cg } = await indexProject({
      'm.ts': `export const a = { f() {} };
function make() { return a.f; }
export const called = a.f();
export const bound = a.f.bind(a);
export const built = make();
`,
    });
    for (const name of ['called', 'bound', 'built']) expect(aliasTargets(cg, 'm.ts', name), name).toEqual([]);
  });

  it('a function-local const, which is no node to link', async () => {
    const { cg } = await indexProject({
      'm.ts': `export const a = { f() {} };
export function run(a: { f(): void }) {
  const f = a.f;
  return f();
}
`,
    });
    const run = cg.getNodesInFile('m.ts').find((n) => n.name === 'run')!;
    expect(cg.getOutgoingEdgesFrom([run.id]).filter((e) => e.provenance === 'heuristic')).toEqual([]);
  });

  it("a generated bundle's aliases", async () => {
    const { cg } = await indexProject({
      'app.min.js': `function b() {}
var a = b;
`,
    });
    expect(aliasTargets(cg, 'app.min.js', 'a')).toEqual([]);
  });
});

describe('a sync links what a fresh index does', () => {
  it('links an alias a sync adds, in a file nothing else marks', async () => {
    const { cg, root } = await indexProject({
      'a.ts': `export const a = { f() {} };
`,
      'b.ts': `export const b = 1;
`,
    });
    write(root, { 'b.ts': `import { a } from './a';
export const b = a.f;
` });
    await cg.sync();
    expect(aliasTargets(cg, 'b.ts', 'b')).toEqual(['a.ts:a::f']);
  });

  it('links a target a sync adds after the alias', async () => {
    const { cg, root } = await indexProject({
      'fns.ts': `export function other() {}
`,
      'use.ts': `import * as fns from './fns';
export const late = fns.join;
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'late')).toEqual([]);
    write(root, { 'fns.ts': `export function other() {}
export function join() {}
` });
    await cg.sync();
    expect(aliasTargets(cg, 'use.ts', 'late')).toEqual(['fns.ts:join']);
  });

  it('links a target among more definitions than a sync looks up one by one', async () => {
    const { cg, root } = await indexProject({
      'fns.ts': `export function other() {}
`,
      'use.ts': `import * as fns from './fns';
export const late = fns.join;
`,
    });
    const many = Array.from({ length: 80 }, (_, i) => `export function f${i}() {}\n`).join('');
    write(root, { 'fns.ts': `export function other() {}
export function join() {}
${many}` });
    await cg.sync();
    expect(aliasTargets(cg, 'use.ts', 'late')).toEqual(['fns.ts:join']);
  });

  it('links a target in a file a sync adds', async () => {
    const { cg, root } = await indexProject({
      'use.ts': `import * as fns from './fns';
export const late = fns.join;
`,
    });
    write(root, { 'fns.ts': `export function join() {}
` });
    await cg.sync();
    expect(aliasTargets(cg, 'use.ts', 'late')).toEqual(['fns.ts:join']);
  });

  it('drops the link when a sync removes the target', async () => {
    const { cg, root } = await indexProject({
      'fns.ts': `export function join() {}
export function other() {}
`,
      'use.ts': `import * as fns from './fns';
export const alias = fns.join;
`,
    });
    expect(aliasTargets(cg, 'use.ts', 'alias')).toEqual(['fns.ts:join']);
    write(root, { 'fns.ts': `export function other() {}
` });
    await cg.sync();
    expect(aliasTargets(cg, 'use.ts', 'alias')).toEqual([]);
  });
});
