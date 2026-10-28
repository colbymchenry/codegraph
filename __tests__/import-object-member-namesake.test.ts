/**
 * An import names one of the module's own bindings, never a method of an
 * object in it. Extraction marks an exported object literal's methods
 * exported too, and the per-file export index kept whichever came first, so
 * `import { f }` could land on `d.f` instead of the module's `export function
 * f`, or instead of what the module's export clause, re-export or default
 * export names (#2945).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-member-namesake-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

/** `<target file>:<target qualified name>:<line>` for the calls leaving `file`'s function `fn`. */
function callsFrom(cg: CodeGraph, file: string, fn: string): string[] {
  const src = cg.getNodesInFile(file).find((n) => n.name === fn)!;
  return cg
    .getOutgoingEdgesFrom([src.id])
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = cg.getNode(e.target);
      return `${t?.filePath}:${t?.qualifiedName}:${t?.startLine}`;
    })
    .sort();
}

const WALK = `import { f } from './m';
export function walk() { return f(); }
`;

describe('a named import whose module has an object with a method of that name', () => {
  it('links the exported function when an exported object with that method comes first', async () => {
    const cg = await indexProject({
      'm.ts': `export interface Driver { f(id: string): string; }
export const d: Driver = {
  f(id) { return '#' + id; },
};
let driver: Driver = d;
export function f(id: string): string { return driver.f(id); }
`,
      'walk.ts': WALK,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:f:6']);
  });

  it('links the exported function when the object comes after it', async () => {
    const cg = await indexProject({
      'm.ts': `export function f(): string { return '#'; }
export const d = {
  f() { return f(); },
};
`,
      'walk.ts': WALK,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:f:1']);
  });

  it('links what a local export clause names', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {} };
function f() {}
function impl() {}
export { f, impl as g };
`,
      'walk.ts': `import { f, g } from './m';
export function walk() { f(); g(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:f:2', 'm.ts:impl:3']);
  });

  it('follows a re-export past an exported object with that method', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {} };
export { f } from './other';
`,
      'other.ts': `export function f() {}
`,
      'walk.ts': WALK,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['other.ts:f:1']);
  });

  it('links a method the module exports by destructuring its object', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {} };
export const { f } = d;
`,
      'walk.ts': `import { f } from './m';
export function walk() { f(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:d::f:1']);
  });

  it('links destructuring exports however their pattern, annotation and object are written', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {}, g() {}, h() {}, k() {}, inner: { b: 1 } };
export const { f }: { f: () => void } = d;
export const {
  g, // the g
  inner: { b },
  h = make(1, 2),
} = d;
export const { k } = d as typeof d;
function make(a: number, b: number) { return () => a + b; }
`,
      'n.ts': `export const e = { p() {}, q() {}, r() {} };
export const { p, q }: { p: () => void; q: () => void } = e;
export const { r = '}' } = (e);
`,
      'walk.ts': `import { f, g, h, k } from './m';
import { p, q, r } from './n';
export function walk() { f(); g(); h(); k(); p(); q(); r(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual([
      'm.ts:d::f:1', 'm.ts:d::g:1', 'm.ts:d::h:1', 'm.ts:d::k:1',
      'n.ts:e::p:1', 'n.ts:e::q:1', 'n.ts:e::r:1',
    ]);
  });

  it('links a method pulled out of an object and exported by a clause, a default or module.exports', async () => {
    const cg = await indexProject({
      'm.ts': `export type Api = { f(): void };
export const Api = { f() {} };
export const { f } = Api;
`,
      'n.ts': `const d = { g() {}, h() {} };
const { g, h } = d;
export { g, h as hh };
`,
      'o.ts': `const d = { k() {} };
const { k } = d;
export default k;
`,
      'p.js': `const o = { q() {} };
const { q } = o;
module.exports = q;
`,
      'walk.ts': `import { f } from './m';
import { g, hh } from './n';
import K from './o';
const Q = require('./p');
export function walk() { f(); g(); hh(); K(); Q(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual([
      'm.ts:Api::f:2', 'n.ts:d::g:1', 'n.ts:d::h:1', 'o.ts:d::k:1', 'p.js:o::q:1',
    ]);
  });

  it("does not answer an import with a class's method", async () => {
    const cg = await indexProject({
      'm.ts': `export class C { render() {} }
`,
      'walk.ts': `import { render } from './m';
export function walk() { return render(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual([]);
  });

  it('links a namespace import\'s member to the exported function, not the object\'s method', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {} };
export function f() {}
`,
      'walk.ts': `import * as m from './m';
export function walk() { return m.f(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:f:2']);
  });

  it('still links an object method called through its object', async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { f() {} };
`,
      'walk.ts': `import { d } from './m';
export function walk() { return d.f(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:d::f:1']);
  });
});

describe('a default import', () => {
  it("links what `export default f` names, not an object's method declared first", async () => {
    const cg = await indexProject({
      'm.ts': `const d = { f() { return 1; } };
function f() { return d; }
export default f;
`,
      'walk.ts': `import X from './m';
export function walk() { return X(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual(['m.ts:f:2']);
  });

  it("links what `module.exports = g` names, not an object's method declared first", async () => {
    const cg = await indexProject({
      'm.js': `const o = { g() { return 1; } };
function g() { return o; }
module.exports = g;
`,
      'walk.js': `const G = require('./m');
function walk() { return G(); }
module.exports = { walk };
`,
    });
    expect(callsFrom(cg, 'walk.js', 'walk')).toEqual(['m.js:g:2']);
  });

  it("does not guess an exported object's method", async () => {
    const cg = await indexProject({
      'm.ts': `export const d = { helper() {} };
declare function memo<T>(c: T): T;
function Card() {}
export default memo(Card);
`,
      'walk.ts': `import X from './m';
export function walk() { return X(); }
`,
    });
    expect(callsFrom(cg, 'walk.ts', 'walk')).toEqual([]);
  });
});
