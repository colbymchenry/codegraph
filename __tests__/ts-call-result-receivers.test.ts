/**
 * A TS/JS method call on a local is read by what the local holds where the
 * call is written, not guessed by the method's name:
 * - a local a library call initializes (`createRoot(el)` from react-dom,
 *   `net.createServer()`, `canvas.getContext('2d')!` on a DOM element) holds
 *   the library's value: no project method is the call's (#2947);
 * - a local a project class's static factory initializes
 *   (`DatabaseConnection.initialize(p)`) holds what the factory's signature
 *   says it returns (#2946);
 * - a receiver typed by an interface whose member of that name is a
 *   function-typed property calls that property, or a class implementing the
 *   type or building it, never an unrelated class's method (#3035).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-call-result-recv-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

/** The methods the function with this name calls, as `qualifiedName (file:line)`. */
function methodsCalledBy(name: string): string[] {
  const from = cg!.getNodesByKind('function').find((n) => n.name === name);
  expect(from, `${name} should be indexed`).toBeDefined();
  return cg!.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target)!)
    .filter((t) => t.kind === 'method')
    .map((t) => `${t.qualifiedName} (${t.filePath}:${t.startLine})`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a local a library call initializes (#2947)', () => {
  it('takes no project method guessed by the name', async () => {
    await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-dom': '^18.0.0' } }),
      'app.ts': 'export class App { render(): void {} translate(x: number): void {} close(): void {} }\n',
      'use.ts':
        "import { createRoot } from 'react-dom/client';\n" +
        "import * as net from 'net';\n" +
        "import { createServer } from 'net';\n" +
        'export function a(el: HTMLElement) { const root = createRoot(el); root.render(null); }\n' +
        'export function b() { const s = net.createServer(); s.close(); }\n' +
        'export function c() { const s = createServer(); s.close(); }\n' +
        "export function d(canvas: HTMLCanvasElement) { const ctx = canvas.getContext('2d')!; ctx.translate(1); }\n" +
        "export function e(canvas: HTMLCanvasElement) { canvas.getContext('2d')!.translate(1); }\n",
    });
    for (const fn of ['a', 'b', 'c', 'd', 'e']) expect(methodsCalledBy(fn), fn).toEqual([]);
  });

  it('still reads a project function\'s result', async () => {
    await index({
      'app.ts': 'export class App { close(): void {} }\nexport class Other { close(): void {} }\nexport function makeApp(): App { return new App(); }\n',
      'use.ts': "import { makeApp } from './app';\nexport function run() { const app = makeApp(); app.close(); }\n",
    });
    expect(methodsCalledBy('run')).toEqual(['App::close (app.ts:1)']);
  });
});

describe('a local a static factory initializes (#2946)', () => {
  it('holds what the factory returns, whatever the local is named', async () => {
    await index({
      'db.ts':
        'export class DatabaseConnection {\n' +
        "  static initialize(p: string): DatabaseConnection { return new DatabaseConnection(); }\n" +
        '  close(): void {}\n' +
        '}\n',
      'writer.ts': 'export class StoreWriter { close(): void {} }\n',
      'use.ts':
        "import { DatabaseConnection } from './db';\n" +
        "export function run() {\n  const writer = DatabaseConnection.initialize('x');\n  writer.close();\n}\n" +
        "export function runConn() {\n  const conn = DatabaseConnection.initialize('x');\n  conn.close();\n}\n",
    });
    expect(methodsCalledBy('run')).toEqual(['DatabaseConnection::close (db.ts:3)', 'DatabaseConnection::initialize (db.ts:2)']);
    expect(methodsCalledBy('runConn')).toEqual(['DatabaseConnection::close (db.ts:3)', 'DatabaseConnection::initialize (db.ts:2)']);
  });
});

describe('a receiver typed by an interface with a function-typed property (#3035)', () => {
  it('calls no unrelated class\'s method through a function-typed property', async () => {
    await index({
      'session.ts': 'export class Session {\n  snapshot(): number { return 1; }\n}\n',
      'queries.ts':
        'export interface Matcher {\n  (p: string): boolean;\n  snapshot?: () => (p: string) => boolean;\n}\n' +
        'export function take(fn: (p: string) => boolean) {\n  const matcher = fn as Matcher;\n  return matcher.snapshot ? matcher.snapshot() : matcher;\n}\n',
      'plain.ts': 'interface M { snapshot: () => number }\nexport function f(m: M) { return m.snapshot(); }\n',
    });
    expect(methodsCalledBy('take')).toEqual([]);
    expect(methodsCalledBy('f')).toEqual([]);
  });

  it('keeps a class whose file builds the interface out of its own methods', async () => {
    await index({
      'collab.ts':
        'export interface CollabAPI { isCollaborating: () => boolean }\n' +
        'export class Collab {\n  isCollaborating(): boolean { return true; }\n  api(): CollabAPI { return { isCollaborating: () => this.isCollaborating() }; }\n}\n',
      'share.ts': "import type { CollabAPI } from './collab';\nexport function share(collabAPI: CollabAPI) { return collabAPI.isCollaborating(); }\n",
    });
    expect(methodsCalledBy('share')).toEqual(['Collab::isCollaborating (collab.ts:3)']);
  });

  it('keeps a class that implements the abstraction', async () => {
    await index({
      'abstractions.ts': 'export abstract class AuthServiceAbstraction {\n  abstract getAuthStatus: (userId?: string) => Promise<number>;\n}\n',
      'auth.service.ts':
        "import { AuthServiceAbstraction } from './abstractions';\n" +
        'export class AuthService extends AuthServiceAbstraction {\n  getAuthStatus(userId?: string): Promise<number> { return Promise.resolve(1); }\n}\n',
      'other.ts': 'export class Unrelated { getAuthStatus(): number { return 0; } }\n',
      'consumer.ts':
        "import { AuthServiceAbstraction } from './abstractions';\n" +
        'export async function viaParam(auth: AuthServiceAbstraction) { return auth.getAuthStatus(); }\n',
    });
    expect(methodsCalledBy('viaParam')).toEqual(['AuthService::getAuthStatus (auth.service.ts:3)']);
  });
});

describe('a local initialized by an instance call (#3422)', () => {
  it('does not retain an inferred helper result after an owner is augmented', async () => {
    await index({
      'maker.ts': [
        'export class A { m(): void {} }',
        'export class B { m(): void {} }',
        'export interface Maker { make(x: string): A }',
      ].join('\n'),
      'use.ts': [
        "import { A, Maker } from './maker';",
        "function build(mk: Maker) { return mk.make('x'); }",
        'function outer(mk: Maker) { return build(mk); }',
        'function makeA() { return new A(); }',
        'export function run(mk: Maker) { const s = build(mk); return s.m(); }',
        'export function nested(mk: Maker) { const s = outer(mk); return s.m(); }',
        'export function unrelated() { const s = makeA(); return s.m(); }',
      ].join('\n'),
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::m '));
    expect(calls()).toEqual([]);
    expect(methodsCalledBy('nested').filter((m) => m.includes('::m '))).toEqual([]);
    expect(methodsCalledBy('unrelated').filter((m) => m.includes('::m '))).toEqual(['A::m (maker.ts:1)']);
    const augmentation = path.join(tempDir, 'aug.ts');
    fs.writeFileSync(augmentation, "import { B } from './maker';\ndeclare module './maker' { interface Maker { make(x: string): B } }\n");
    await cg!.sync();
    expect(calls()).toEqual([]);
    fs.unlinkSync(augmentation);
    await cg!.sync();
    expect(calls()).toEqual([]);
  });

  it('does not choose a same-named type alias from a different namespace', async () => {
    await index({
      'a.ts': [
        'export class Shape { area(): number { return 1; } }',
        'export class Circle { area(): number { return 2; } }',
        'namespace NA { export type Maker = { make(): Shape }; }',
        'namespace NB {',
        '  export type Maker = { make(): Circle };',
        '  export function run(m: Maker) { const s = m.make(); return s.area(); }',
        '}',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::area '))).toEqual([]);
  });

  it('does not infer from a type augmented through a re-export', async () => {
    await index({
      'a.ts': [
        'export class A { go(): void {} }',
        'export class B { go(): void {} }',
        'export interface Maker { make(n: number): A }',
      ].join('\n'),
      'index.ts': "export { Maker } from './a';\n",
      'aug.ts': "import { B } from './a';\ndeclare module './index' { interface Maker { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './index';\nexport function run(m: Maker) { const x = m.make('s'); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('updates and retries calls as a barrel augmentation is added and removed', async () => {
    const files: Record<string, string> = {
      'a.ts': [
        'export class A { go(): void {} }',
        'export class B { go(): void {} }',
        'export interface Maker { make(n: number): A }',
      ].join('\n'),
      'inner.ts': "export { Maker } from './a';\n",
      'index.ts': "export * from './inner';\n",
      'c.ts': "import { Maker } from './index';\nexport function run(m: Maker) { const x = m.make(1); x.go(); }\n",
    };
    await index(files);
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::go '));
    const compare = async (expected: string[]) => {
      expect(calls()).toEqual(expected);
      const originalDir = tempDir;
      const originalGraph = cg!;
      cg = null;
      tempDir = '';
      try {
        await index(files);
        expect(calls()).toEqual(expected);
      } finally {
        cg?.close();
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = originalDir;
        cg = originalGraph;
      }
    };
    await compare(['A::go (a.ts:1)']);
    const augmentation = path.join(tempDir, 'aug.ts');
    files['aug.ts'] = "import { B } from './a';\ndeclare module './index' { interface Maker { make(s: string): B } }\n";
    fs.writeFileSync(augmentation, files['aug.ts']);
    await cg!.sync();
    await compare([]);
    cg!.close();
    cg = await CodeGraph.open(tempDir);
    delete files['aug.ts'];
    fs.unlinkSync(augmentation);
    await cg!.sync();
    await compare(['A::go (a.ts:1)']);
  }, 60_000);

  it('conservatively declines an unrelated same-named barrel augmentation', async () => {
    await index({
      'a.ts': 'export class A { go(): void {} }\nexport interface Maker { make(): A }\n',
      'b.ts': 'export class B { go(): void {} }\nexport interface Maker { make(): B }\n',
      'index.ts': "export { Maker } from './b';\n",
      'aug.ts': "import { B } from './b';\ndeclare module './index' { interface Maker { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make(); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('does not infer from a type augmented under a re-exported alias', async () => {
    await index({
      'a.ts': 'export class A { go(): void {} }\nexport class B { go(): void {} }\nexport interface Maker { make(n: number): A }\n',
      'index.ts': "export { Maker as Factory } from './a';\n",
      'aug.ts': "import { B } from './a';\ndeclare module './index' { interface Factory { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make('s'); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('matches fresh indexes when a renamed barrel augmentation is added and removed', async () => {
      const files: Record<string, string> = {
        'a.ts': 'export class A { go(): void {} }\nexport class B { go(): void {} }\nexport interface Maker { make(n: number): A }\n',
        'inner.ts': "export { Maker as Inner } from './a';\n",
        'index.ts': "export { Inner as Factory } from './inner';\n",
        'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make(1); x.go(); }\n",
      };
      await index(files);
      const calls = () => methodsCalledBy('run').filter((m) => m.includes('::go '));
      const compare = async (expected: string[]) => {
        expect(calls()).toEqual(expected);
        const originalDir = tempDir;
        const originalGraph = cg!;
        cg = null;
        tempDir = '';
        try {
          await index(files);
          expect(calls()).toEqual(expected);
        } finally {
          cg?.close();
          if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
          tempDir = originalDir;
          cg = originalGraph;
        }
      };
      await compare(['A::go (a.ts:1)']);
      const augmentation = path.join(tempDir, 'aug.ts');
      files['aug.ts'] = "import { B } from './a';\ndeclare module './index' { interface Factory { make(s: string): B } }\n";
      fs.writeFileSync(augmentation, files['aug.ts']);
      await cg!.sync();
      await compare([]);
      cg!.close();
      cg = await CodeGraph.open(tempDir);
      delete files['aug.ts'];
      fs.unlinkSync(augmentation);
      await cg!.sync();
      await compare(['A::go (a.ts:1)']);
  }, 60_000);

  it('updates calls when an existing augmentation barrel changes its target', async () => {
    await index({
      'a.ts': 'export class A { go(): void {} }\nexport interface Maker { make(): A }\n',
      'b.ts': 'export class B { go(): void {} }\nexport interface Maker { make(): B }\n',
      'index.ts': "export { Maker } from './b';\n",
      'aug.ts': "import { B } from './b';\ndeclare module './index' { interface Maker { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make(); x.go(); }\n",
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::go '));
    expect(calls()).toEqual([]);
    fs.writeFileSync(path.join(tempDir, 'index.ts'), "export { Maker } from './a';\n");
    await cg!.sync();
    expect(calls()).toEqual([]);
    fs.writeFileSync(path.join(tempDir, 'index.ts'), "export { Maker } from './b';\n");
    await cg!.sync();
    expect(calls()).toEqual([]);
  });

  it('does not bind a namespace-qualified return to a same-named top-level type', async () => {
    await index({
      'a.ts': [
        'export class A { go(): void {} }',
        'export class Maker { m8(): NS.A { return new NS.A(); } }',
        'export namespace NS { export class A { go(): void {} } }',
      ].join('\n'),
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.m8(); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('does not bind an imported namespace return to a same-named local type', async () => {
    await index({
      'types.ts': 'export class A { go(): void {} }\n',
      'maker.ts': [
        "import * as NS from './types';",
        'export class A { go(): void {} }',
        'export class Maker { make(): NS.A { return new NS.A(); } }',
      ].join('\n'),
      'c.ts': "import { Maker } from './maker';\nexport function run(m: Maker) { const x = m.make(); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('uses the declared result even when another type has the same method name', async () => {
    await index({
      'shape.ts': 'export interface Shape { area(): number }\n',
      'makers.ts': [
        "import { Shape } from './shape';",
        'export declare class Maker { make(): Shape }',
        'export interface MakerApi { make(): Shape }',
        'export type MakerFn = { make: () => Shape };',
      ].join('\n'),
      'other.ts': 'export class Circle { area(): number { return 1; } }\n',
      'use.ts': [
        "import type { Maker, MakerApi, MakerFn } from './makers';",
        'export function viaClass(m: Maker) { const s = m.make(); return s.area(); }',
        'export function viaInterface(m: MakerApi) { const s = m.make(); return s.area(); }',
        'export function viaProperty(m: MakerFn) { const s = m.make(); return s.area(); }',
      ].join('\n'),
    });

    for (const fn of ['viaClass', 'viaInterface', 'viaProperty']) {
      expect(methodsCalledBy(fn).filter((m) => m.includes('::area ')), fn).toEqual(['Shape::area (shape.ts:1)']);
    }
  });

  it('reads an imported constant initialized by a typed factory, as in ky', async () => {
    await index({
      'types.ts': 'export type Api = { create: () => Api; extend: () => Api };\n',
      'api.ts': [
        "import type { Api } from './types.js';",
        'const createInstance = (): Api => { throw new Error(); };',
        'const api = createInstance();',
        'export default api;',
        'export class Other { extend(): void {} }',
      ].join('\n'),
      'use.ts': "import api from './api.js';\nexport function run() { const parent = api.create(); return parent.extend(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::extend '))).toEqual(['Api::extend (types.ts:1)']);
  });

  it('only reads an unambiguous immutable factory and respects shadowing', async () => {
    await index({
      'api.ts': [
        'export interface Api { create(): Shape }',
        'export class Shape { extend(): void {} }',
        'export class Other { extend(): void {} }',
        'const factory = (): Api => { throw new Error(); };',
        'export const api = factory();',
        'let mutableFactory = (): Api => { throw new Error(); };',
        'export const mutable = mutableFactory();',
        'const genericFactory = <T>(): T => { throw new Error(); };',
        'export const generic = genericFactory<Api>();',
        'export let mutableApi = factory();',
      ].join('\n'),
      'use.ts': [
        "import { api, mutable, generic, mutableApi, Other } from './api';",
        'export function named() { const p = api.create(); p.extend(); }',
        'export function shadow(api: { create(): Other }) { const p = api.create(); p.extend(); }',
        'export function viaMutable() { const p = mutable.create(); p.extend(); }',
        'export function viaGeneric() { const p = generic.create(); p.extend(); }',
        'export function viaMutableApi() { const p = mutableApi.create(); p.extend(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('named').filter((m) => m.includes('::extend '))).toEqual(['Shape::extend (api.ts:2)']);
    expect(methodsCalledBy('shadow').filter((m) => m.includes('::extend '))).not.toContain('Shape::extend (api.ts:2)');
    for (const fn of ['viaMutable', 'viaGeneric', 'viaMutableApi']) {
      expect(methodsCalledBy(fn).filter((m) => m.includes('::extend ')), fn).toEqual([]);
    }
  });

  it('does not follow a cycle of imported constant initializers indefinitely', async () => {
    await index({
      'a.ts': "import { b } from './b';\nexport const a = b.make();\n",
      'b.ts': "import { a } from './a';\nexport const b = a.make();\n",
      'other.ts': 'export class Other { extend(): void {} }\nexport class Another { extend(): void {} }\n',
      'use.ts': "import { a } from './a';\nexport function run() { const p = a.make(); p.extend(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::extend '))).toEqual([]);
  });

  it('revisits factory-dependent results after the returned interface changes', async () => {
    const files: Record<string, string> = {
      'types.ts': [
        'export class A { extend(): void {} }',
        'export class B { extend(): void {} }',
        'export interface Api { create(): A }',
        'export interface OtherApi { create(): B }',
      ].join('\n'),
      'api.ts': [
        "import { Api, OtherApi } from './types';",
        'const factory = (): Api => { throw new Error(); };',
        'const api = factory();',
        'export default api;',
      ].join('\n'),
      'use.ts': "import api from './api';\nexport function run() { const p = api.create(); p.extend(); }\n",
    };
    await index(files);
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::extend '));
    const compare = async (expected: string[]) => {
      expect(calls()).toEqual(expected);
      const originalDir = tempDir;
      const originalGraph = cg!;
      cg = null;
      tempDir = '';
      try {
        await index(files);
        expect(calls()).toEqual(expected);
      } finally {
        cg?.close();
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = originalDir;
        cg = originalGraph;
      }
    };
    await compare(['A::extend (types.ts:1)']);
    files['types.ts'] = files['types.ts']!.replace('create(): A', 'create(): B');
    fs.writeFileSync(path.join(tempDir, 'types.ts'), files['types.ts']);
    await cg!.sync();
    await compare(['B::extend (types.ts:2)']);
    cg!.close();
    cg = await CodeGraph.open(tempDir);
    files['aug.ts'] = "import { A } from './types';\ndeclare module './types' { interface Api { create(n: number): A } }\n";
    fs.writeFileSync(path.join(tempDir, 'aug.ts'), files['aug.ts']);
    await cg!.sync();
    await compare([]);
    delete files['aug.ts'];
    fs.unlinkSync(path.join(tempDir, 'aug.ts'));
    await cg!.sync();
    await compare(['B::extend (types.ts:2)']);
    files['api.ts'] = files['api.ts']!.replace('(): Api', '(): OtherApi');
    fs.writeFileSync(path.join(tempDir, 'api.ts'), files['api.ts']);
    await cg!.sync();
    await compare(['B::extend (types.ts:2)']);
    files['types.ts'] = files['types.ts']!.replace('OtherApi { create(): B', 'OtherApi { create(): A');
    fs.writeFileSync(path.join(tempDir, 'types.ts'), files['types.ts']);
    await cg!.sync();
    await compare(['A::extend (types.ts:1)']);
    files['api.ts'] = files['api.ts']!.replace('const factory', 'let factory');
    fs.writeFileSync(path.join(tempDir, 'api.ts'), files['api.ts']);
    await cg!.sync();
    await compare([]);
    files['api.ts'] = files['api.ts']!.replace('let factory', 'const factory');
    fs.writeFileSync(path.join(tempDir, 'api.ts'), files['api.ts']);
    await cg!.sync();
    await compare(['A::extend (types.ts:1)']);
    files['api.ts'] = files['api.ts']!.replace('const api =', 'let api =');
    fs.writeFileSync(path.join(tempDir, 'api.ts'), files['api.ts']);
    await cg!.sync();
    await compare([]);
    files['api.ts'] = files['api.ts']!.replace('let api =', 'const api =');
    fs.writeFileSync(path.join(tempDir, 'api.ts'), files['api.ts']);
    await cg!.sync();
    await compare(['A::extend (types.ts:1)']);
  }, 60_000);

  it('does not pick a return type from overloads, generics, or a union', async () => {
    await index({
      'use.ts': [
        'interface Shape { area(): number }',
        'interface Circle { area(): number }',
        'interface Maker {',
        '  make(value: string): Shape;',
        '  make(value: number): Circle;',
        '  generic<T>(): Shape;',
        '  union(): Shape | Circle;',
        '}',
        'export function overloaded(m: Maker) { const s = m.make(0); return s.area(); }',
        'export function generic(m: Maker) { const s = m.generic(); return s.area(); }',
        'export function union(m: Maker) { const s = m.union(); return s.area(); }',
      ].join('\n'),
    });
    for (const fn of ['overloaded', 'generic', 'union']) {
      expect(methodsCalledBy(fn).filter((m) => m.includes('::area ')), fn).toEqual([]);
    }
  });

  it('does not infer an instance method result from an array method', async () => {
    await index({
      'repo.ts': [
        'export class Circle { save(): void {} }',
        'export class Repo<T> { find(): Circle { return new Circle(); } save(): void {} }',
        'export function run(items: Repo<number>[]) {',
        '  const r = items.find((x) => x !== undefined);',
        '  return r?.save();',
        '}',
      ].join('\n'),
    });
    expect(methodsCalledBy('run')).not.toContain('Circle::save (repo.ts:1)');
  });

  it('does not choose one return type across merged declarations', async () => {
    await index({
      'merged.ts': [
        'class A { m(): number { return 1; } onlyA(): void {} }',
        'class B { m(): number { return 2; } onlyB(): void {} }',
        'interface Maker { make(x: string): A }',
        'interface Maker { make(x: number): B }',
        'export function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from a class merged with an interface', async () => {
    await index({
      'merged.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'export class Maker { make(x: string): A { return new A(); } }',
        'export interface Maker { make(x: number): B }',
        'export function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer a return type from a module augmentation', async () => {
    await index({
      'types.ts': 'export class A { m(): number { return 1; } }\nexport class B { m(): number { return 2; } }\n',
      'maker.ts': "import type { A } from './types';\nexport interface Maker { make(x: string): A }\n",
      'augment.d.ts': [
        "import type { B } from './types';",
        "declare module './maker' { interface Maker { make(x: number): B } }",
      ].join('\n'),
      'use.ts': [
        "import type { Maker } from './maker';",
        'export function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from global interfaces merged across files', async () => {
    await index({
      'first.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'interface Maker { make(x: string): A }',
        'function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
      'second.ts': 'interface Maker { make(x: number): B }\n',
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from a module augmented in a .ts file', async () => {
    await index({
      'types.ts': 'export class A { m(): number { return 1; } }\nexport class B { m(): number { return 2; } }\n',
      'maker.ts': "import type { A } from './types';\nexport interface Maker { make(x: string): A }\n",
      'augment.ts': "import type { B } from './types';\ndeclare module './maker' { interface Maker { make(x: number): B } }\n",
      'use.ts': "import type { Maker } from './maker';\nexport function run(mk: Maker) { const s = mk.make(1); return s.m(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from package declarations merged across files', async () => {
    await index({
      'package.json': '{"name":"app"}',
      'first.d.ts': "declare module 'pkg' { export interface Maker { make(x: string): A } export class A { m(): number } }\n",
      'second.d.ts': "declare module 'pkg' { export interface Maker { make(x: number): B } export class B { m(): number } }\n",
      'use.ts': "import type { Maker } from 'pkg';\nexport function run(m: Maker) { const s = m.make(1); return s.m(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from global declarations merged through declare global', async () => {
    await index({
      'first.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'interface Maker { make(x: string): A }',
        'function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
      'second.ts': 'export {};\ndeclare global { interface Maker { make(x: number): B } }\n',
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('does not infer from namespace interfaces merged across files', async () => {
    await index({
      'first.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'namespace N {',
        '  export interface Maker { make(x: string): A }',
        '  export function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
        '}',
      ].join('\n'),
      'second.ts': 'namespace N { export interface Maker { make(x: number): B } }\n',
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('continues to infer from unrelated same-named module declarations', async () => {
    await index({
      'maker.ts': 'export interface Shape { area(): number }\nexport interface Maker { make(): Shape }\n',
      'other.ts': 'export interface Maker { make(): Other }\nexport interface Other { area(): number }\n',
      'use.ts': "import type { Maker } from './maker';\nexport function run(m: Maker) { const s = m.make(); return s.area(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::area '))).toEqual(['Shape::area (maker.ts:1)']);
  });

  it('conservatively declines same-named namespaces in separate modules', async () => {
    await index({
      'first.ts': [
        'export namespace N {',
        '  export interface Shape { area(): number }',
        '  export interface Maker { make(): Shape }',
        '  export function run(m: Maker) { const s = m.make(); return s.area(); }',
        '}',
      ].join('\n'),
      'second.ts': 'export namespace N { export interface Maker { make(): Other } export interface Other { area(): number } }\n',
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::area '))).toEqual([]);
  });

  it('updates inferred calls when a new augmentation is added and removed', async () => {
    await index({
      'types.ts': 'export class A { m(): number { return 1; } }\nexport class B { m(): number { return 2; } }\n',
      'maker.ts': "import type { A } from './types';\nexport interface Maker { make(x: string): A }\n",
      'use.ts': "import type { Maker } from './maker';\nexport function run(mk: Maker) { const s = mk.make(1); return s.m(); }\n",
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::m '));
    expect(calls()).toEqual(['A::m (types.ts:1)']);
    const augmentation = path.join(tempDir, 'augment.ts');
    fs.writeFileSync(augmentation, "import type { B } from './types';\ndeclare module './maker' { interface Maker { make(x: number): B } }\n");
    await cg!.sync();
    expect(calls()).toEqual([]);
    fs.unlinkSync(augmentation);
    await cg!.sync();
    expect(calls()).toEqual(['A::m (types.ts:1)']);
  });

  it('retries a previously unresolved result call after removing an augmentation', async () => {
    await index({
      'types.ts': 'export class A { m(): number { return 1; } }\nexport class B { m(): number { return 2; } }\n',
      'maker.ts': "import type { A } from './types';\nexport interface Maker { make(x: string): A }\n",
      'augment.ts': "import type { B } from './types';\ndeclare module './maker' { interface Maker { make(x: number): B } }\n",
      'use.ts': "import type { Maker } from './maker';\nexport function run(mk: Maker) { const s = mk.make(1); return s.m(); }\n",
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::m '));
    expect(calls()).toEqual([]);
    cg!.close();
    cg = await CodeGraph.open(tempDir);
    fs.unlinkSync(path.join(tempDir, 'augment.ts'));
    await cg!.sync();
    expect(calls()).toEqual(['A::m (types.ts:1)']);
  });

  it('updates all calls on a shared binding when an existing file gains and loses a merge', async () => {
    await index({
      'maker.ts': [
        'export class A { m(): number { return 1; } n(): number { return 1; } }',
        'export class B { m(): number { return 2; } n(): number { return 2; } }',
        'export interface Maker { make(x: string): A }',
        'export interface Other { make(): A }',
      ].join('\n'),
      'augment.ts': "import type { B } from './maker';\nexport const marker = 1;\n",
      'use.ts': [
        "import type { Maker as M, Other } from './maker';",
        'export function run(mk: M) { const s = mk.make(1); s.m(); return s.n(); }',
        'export function unaffected(mk: Other) { const s = mk.make(); return s.m(); }',
      ].join('\n'),
    });
    const calls = () => methodsCalledBy('run').filter((m) => /::[mn] /.test(m));
    const unaffected = () => methodsCalledBy('unaffected').filter((m) => m.includes('::m '));
    expect(calls()).toEqual(['A::m (maker.ts:1)', 'A::n (maker.ts:1)']);
    const file = path.join(tempDir, 'augment.ts');
    fs.writeFileSync(file, "import type { B } from './maker';\ndeclare module './maker' { interface Maker { make(x: number): B } }\nexport const marker = 1;\n");
    await cg!.sync();
    expect(calls()).toEqual([]);
    expect(unaffected()).toEqual(['A::m (maker.ts:1)']);
    fs.writeFileSync(file, "import type { B } from './maker';\nexport const marker = 1;\n");
    await cg!.sync();
    expect(calls()).toEqual(['A::m (maker.ts:1)', 'A::n (maker.ts:1)']);
    expect(unaffected()).toEqual(['A::m (maker.ts:1)']);
  });

  it('updates calls when a global interface is merged and unmerged', async () => {
    await index({
      'first.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'interface Maker { make(x: string): A }',
        'function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
      ].join('\n'),
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::m '));
    expect(calls()).toEqual(['A::m (first.ts:1)']);
    const file = path.join(tempDir, 'second.ts');
    fs.writeFileSync(file, 'interface Maker { make(x: number): B }\n');
    await cg!.sync();
    expect(calls()).toEqual([]);
    fs.unlinkSync(file);
    await cg!.sync();
    expect(calls()).toEqual(['A::m (first.ts:1)']);
  });

  it('updates calls when a namespace interface is merged and unmerged', async () => {
    await index({
      'first.ts': [
        'class A { m(): number { return 1; } }',
        'class B { m(): number { return 2; } }',
        'namespace N {',
        '  export interface Maker { make(x: string): A }',
        '  export function run(mk: Maker) { const s = mk.make(1); return s.m(); }',
        '}',
      ].join('\n'),
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::m '));
    expect(calls()).toEqual(['A::m (first.ts:1)']);
    const file = path.join(tempDir, 'second.ts');
    fs.writeFileSync(file, 'namespace N { export interface Maker { make(x: number): B } }\n');
    await cg!.sync();
    expect(calls()).toEqual([]);
    fs.unlinkSync(file);
    await cg!.sync();
    expect(calls()).toEqual(['A::m (first.ts:1)']);
  });

  it('matches a fresh index when an augmentation is added, edited, and removed', async () => {
    const files: Record<string, string> = {
      'maker.ts': [
        'export class A { m(): number { return 1; } n(): number { return 1; } }',
        'export class B { m(): number { return 2; } n(): number { return 2; } }',
        'export interface Maker { make(x: string): A }',
        'export interface Other { make(): A }',
      ].join('\n'),
      'use.ts': [
        "import type { Maker, Other } from './maker';",
        'export function run(m: Maker) { const s = m.make(1); s.m(); return s.n(); }',
        'export function unaffected(m: Other) { const s = m.make(); return s.m(); }',
      ].join('\n'),
    };
    await index(files);
    const compare = async () => {
      const current = [methodsCalledBy('run'), methodsCalledBy('unaffected')];
      const originalDir = tempDir;
      const originalGraph = cg!;
      cg = null;
      tempDir = '';
      try {
        await index(files);
        expect([methodsCalledBy('run'), methodsCalledBy('unaffected')]).toEqual(current);
      } finally {
        cg?.close();
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = originalDir;
        cg = originalGraph;
      }
    };
    await compare();
    const augmentation = path.join(tempDir, 'augment.ts');
    for (const content of [
      "import type { B } from './maker';\ndeclare module './maker' { interface Maker { make(x: number): B } }\n",
      "import type { B } from './maker';\ndeclare module './maker' { interface Other { make(x: number): B } }\n",
    ]) {
      files['augment.ts'] = content;
      fs.writeFileSync(augmentation, content);
      await cg!.sync();
      await compare();
    }
    delete files['augment.ts'];
    fs.unlinkSync(augmentation);
    await cg!.sync();
    await compare();
  }, 60_000);

  it('updates when a barrel starts and stops exporting the augmented alias', async () => {
    await index({
      'a.ts': 'export class A { go(): void {} }\nexport class B { go(): void {} }\nexport interface Maker { make(n: number): A }\n',
      'index.ts': 'export {};\n',
      'aug.ts': "import { B } from './a';\ndeclare module './index' { interface Factory { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make(1); x.go(); }\n",
    });
    const calls = () => methodsCalledBy('run').filter((m) => m.includes('::go '));
    expect(calls()).toEqual(['A::go (a.ts:1)']);
    for (const barrel of [
      "export { Maker as Factory } from './a';\n",
      "export /* renamed */ { Maker as Factory } from './a';\n",
    ]) {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), barrel);
      await cg!.sync();
      expect(calls()).toEqual([]);
      fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export {};\n');
      await cg!.sync();
      expect(calls()).toEqual(['A::go (a.ts:1)']);
    }
  }, 60_000);

  it('detects an augmentation through a renamed import and local type export', async () => {
    await index({
      'a.ts': 'export class A { go(): void {} }\nexport class B { go(): void {} }\nexport interface Maker { make(n: number): A }\n',
      'index.ts': "import type { Maker as Local } from './a';\nexport type { Local as Factory };\n",
      'aug.ts': "import { B } from './a';\ndeclare module './index' { interface Factory { make(s: string): B } }\n",
      'c.ts': "import { Maker } from './a';\nexport function run(m: Maker) { const x = m.make('s'); x.go(); }\n",
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::go '))).toEqual([]);
  });

  it('does not prefer an intersection alias member over the declared base member', async () => {
    await index({
      'intersection.ts': [
        'interface A { m(): number; onlyA(): void }',
        'interface B { m(): number; onlyB(): void }',
        'interface Base { make(): A }',
        'type X = Base & { make: () => B };',
        'export function run(x: X) { const s = x.make(); return s.m(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::m '))).toEqual([]);
  });

  it('reads comments on object aliases but declines parentheses and intersections', async () => {
    await index({
      'use.ts': [
        'interface A { area(): number }',
        'interface B { area(): number }',
        'interface Base { make(): A }',
        'type Maker = /* comment */ { make(): A };',
        'type Parenthesized = (({ make(): A }));',
        'type Intersected = (Base & { make(): B });',
        'export function positive(m: Maker) { const x = m.make(); return x.area(); }',
        'export function parentheses(m: Parenthesized) { const x = m.make(); return x.area(); }',
        'export function negative(m: Intersected) { const x = m.make(); return x.area(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('positive').filter((m) => m.includes('::area '))).toEqual(['A::area (use.ts:1)']);
    expect(methodsCalledBy('parentheses').filter((m) => m.includes('::area '))).toEqual([]);
    expect(methodsCalledBy('negative').filter((m) => m.includes('::area '))).toEqual([]);
  });

  it('does not use a class type parameter as a declared result type', async () => {
    await index({
      'generic.ts': [
        'class Box<T> { take(): T { throw new Error(); } }',
        'class Maker<T> { make(): Box<T> { throw new Error(); } }',
        'export function run(m: Maker<string>) { const s = m.make(); return s.take(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::take '))).toEqual([]);
  });

  it('conservatively declines a qualified type argument sharing a generic parameter name', async () => {
    await index({
      'generic.ts': [
        'namespace Types { export interface T {} }',
        'class Result<X> { value(): number { return 1; } }',
        'class Other { value(): number { return 2; } }',
        'interface Maker<T> { make(): Result<Types.T> }',
        'export function run(m: Maker<string>) { const r = m.make(); return r.value(); }',
      ].join('\n'),
    });
    expect(methodsCalledBy('run').filter((m) => m.includes('::value '))).toEqual([]);
  });

  it('reads function properties in interfaces and methods in type literals', async () => {
    await index({
      'shape.ts': [
        'export interface Shape { area(): number }',
        'export interface MakerApi { make: () => Shape }',
        'export type MakerMethod = { make(): Shape };',
      ].join('\n'),
      'other.ts': 'export class Circle { area(): number { return 1; } }\n',
      'use.ts': [
        "import type { MakerApi, MakerMethod } from './shape';",
        'export function viaInterface(m: MakerApi) { const s = m.make(); return s.area(); }',
        'export function viaTypeLiteral(m: MakerMethod) { const s = m.make(); return s.area(); }',
      ].join('\n'),
    });
    for (const fn of ['viaInterface', 'viaTypeLiteral']) {
      expect(methodsCalledBy(fn).filter((m) => m.includes('::area ')), fn).toEqual(['Shape::area (shape.ts:1)']);
    }
  });
});
