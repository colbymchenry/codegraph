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
