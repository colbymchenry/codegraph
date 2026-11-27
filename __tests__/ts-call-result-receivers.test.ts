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

describe('a canvas context held in an untyped local (#3444)', () => {
  const viewport = 'export class Viewport {\n  translate(x: number, y: number): number { return x + y; }\n}\n';

  it('takes no project method guessed by the name', async () => {
    await index({
      'viewport.ts': viewport,
      'use.ts':
        "export function chained() {\n  const context = document.createElement('canvas').getContext('2d')!;\n  context.translate(1, 2);\n}\n" +
        "export function withOptions() {\n  const context = document.createElement('canvas').getContext('2d', { alpha: false })!;\n  context.translate(1, 2);\n}\n" +
        "export function twoSteps() {\n  const canvas = document.createElement('canvas');\n  const context = canvas.getContext('2d')!;\n  context.translate(1, 2);\n}\n" +
        "function createCanvas(): HTMLCanvasElement {\n  return document.createElement('canvas');\n}\n" +
        "export function fromFactory() {\n  const canvas = createCanvas();\n  const context = canvas.getContext('2d')!;\n  context.translate(1, 2);\n}\n" +
        "export function fromParam(canvas: HTMLCanvasElement) {\n  const context = canvas.getContext('2d')!;\n  context.translate(1, 2);\n}\n",
    });
    for (const fn of ['chained', 'withOptions', 'twoSteps', 'fromFactory', 'fromParam']) expect(methodsCalledBy(fn), fn).toEqual([]);
  });

  it('still reads a project value', async () => {
    await index({
      'viewport.ts': viewport + 'export function makeViewport(): Viewport { return new Viewport(); }\n',
      'other.ts': 'export class Other {\n  translate(x: number, y: number): number { return x - y; }\n}\n',
      'use.ts':
        "import { Viewport, makeViewport } from './viewport';\n" +
        'export function fromProjectFactory() {\n  const canvas = makeViewport();\n  canvas.translate(1, 2);\n}\n' +
        'export function fromNew() {\n  const canvas = new Viewport();\n  canvas.translate(1, 2);\n}\n',
    });
    expect(methodsCalledBy('fromProjectFactory')).toEqual(['Viewport::translate (viewport.ts:2)']);
    expect(methodsCalledBy('fromNew')).toEqual(['Viewport::translate (viewport.ts:2)']);
  });

  it('keeps the guess where a chain may hand back a project value', async () => {
    await index({
      'viewport.ts': viewport,
      'use.ts':
        "import { Viewport } from './viewport';\n" +
        'export function linkTakesValue(v: Viewport) {\n  const context = document.createElement(\'canvas\').getContext(v as any)!;\n  context.translate(1, 2);\n}\n' +
        'export function ownDocument(document: { make(): Viewport }) {\n  const context = document.make();\n  context.translate(1, 2);\n}\n',
    });
    expect(methodsCalledBy('linkTakesValue')).toEqual(['Viewport::translate (viewport.ts:2)']);
    expect(methodsCalledBy('ownDocument')).toEqual(['Viewport::translate (viewport.ts:2)']);
  });

  it('silences an optional call in the chain, and reads odd arguments quickly', async () => {
    const odd = '{' + 'a:1e1e'.repeat(40) + 'x}';
    await index({
      'viewport.ts': viewport,
      'use.ts':
        "export function optional() {\n  const context = document.createElement('canvas')?.getContext('2d')!;\n  context.translate(1, 2);\n}\n" +
        `export function odd() {\n  const context = document.createElement('canvas').getContext(${odd} as any)!;\n  context.translate(1, 2);\n}\n`,
    });
    expect(methodsCalledBy('optional')).toEqual([]);
    // Not literals: read as before, and quickly.
    expect(methodsCalledBy('odd')).toEqual(['Viewport::translate (viewport.ts:2)']);
  });

  it('silences a same-file factory\'s canvas used in a chain or past a `!`', async () => {
    await index({
      'viewport.ts': viewport,
      'use.ts':
        "function createCanvas(): HTMLCanvasElement {\n  return document.createElement('canvas');\n}\n" +
        "export function chainedFactory() {\n  const context = createCanvas().getContext('2d')!;\n  context.translate(1, 2);\n}\n" +
        "export function nonNullFactory() {\n  const canvas = createCanvas()!;\n  const context = canvas.getContext('2d')!;\n  context.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('chainedFactory')).toEqual([]);
    expect(methodsCalledBy('nonNullFactory')).toEqual([]);
  });

  it('keeps the DOM\'s own types when the project declares or augments them', async () => {
    await index({
      'global.d.ts':
        'declare global {\n  interface HTMLCanvasElement { snapshot(): string }\n' +
        '  interface CanvasRenderingContext2D { drawGrid(n: number): void }\n}\nexport {};\n',
      'use.ts':
        "export function snap() {\n  const c = document.createElement('canvas');\n  c.snapshot();\n}\n" +
        "export function grid() {\n  const ctx = document.createElement('canvas').getContext('2d')!;\n  ctx.drawGrid(3);\n}\n",
    });
    expect(methodsCalledBy('snap')).toEqual(['HTMLCanvasElement::snapshot (global.d.ts:2)']);
    expect(methodsCalledBy('grid')).toEqual(['CanvasRenderingContext2D::drawGrid (global.d.ts:3)']);
  });

  it('keeps a method the project adds to any element type', async () => {
    await index({
      'global.d.ts': 'declare global {\n  interface HTMLInputElement { mask(p: string): void }\n}\nexport {};\n',
      'use.ts': "export function masked() {\n  const el = document.createElement('input');\n  el.mask('99');\n}\n",
    });
    expect(methodsCalledBy('masked')).toEqual(['HTMLInputElement::mask (global.d.ts:2)']);
  });

  it('silences the call past a project class named like a canvas type', async () => {
    await index({
      'view.ts': 'export class CanvasRenderer {\n  translate(x: number, y: number): number { return x + y; }\n}\n',
      'use.ts': "export function draw() {\n  const ctx = document.createElement('canvas').getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('draw')).toEqual([]);
  });

  it('silences the call past a project Node class and a write through the local\'s member', async () => {
    await index({
      'tree.ts': 'export class Node {\n  translate(x: number, y: number): number { return x + y; }\n}\n',
      'use.ts':
        "const seen: Record<string, number> = {};\n" +
        "export function draw() {\n  const ctx = document.createElement('canvas').getContext('2d')!;\n  seen[ctx.canvas.id] = 1;\n  ctx.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('draw')).toEqual([]);
  });

  it('keeps a broad DOM type augmented in a module file, and silences past a project class with a mixin\'s name', async () => {
    await index({
      'aug.ts': 'declare global {\n  interface Element { fadeIn(): void }\n}\nexport {};\n',
      'shape.ts': 'export class CanvasRect {\n  translate(x: number, y: number): number { return x + y; }\n}\n',
      'use.ts':
        "export function fade() {\n  const c = document.createElement('div');\n  c.fadeIn();\n}\n" +
        "export function draw() {\n  const ctx = document.createElement('canvas').getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('fade')).toEqual(['Element::fadeIn (aug.ts:2)']);
    expect(methodsCalledBy('draw')).toEqual([]);
  });

  it('keeps what a canvas gives that is not a DOM value, and a write the checker is told to ignore', async () => {
    await index({
      'g.d.ts': 'interface CanvasGradient { addStops(n: number): void }\ninterface String { shout(): string }\n',
      'viewport.ts': viewport + 'export function makeViewport(): Viewport { return new Viewport(); }\n',
      'use.ts':
        "export function gradient() {\n  const grad = document.createElement('canvas').getContext('2d')!.createLinearGradient(0, 0, 10, 0);\n  grad.addStops(2);\n}\n" +
        "export function dataUrl() {\n  const url = document.createElement('canvas').toDataURL('image/png');\n  url.shout();\n}\n",
      'ignored.ts':
        "import { makeViewport } from './viewport';\n" +
        "export function ignored() {\n  let v = document.createElement('canvas');\n  // @ts-ignore\n  v = makeViewport();\n  v.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('gradient')).toEqual(['CanvasGradient::addStops (g.d.ts:1)']);
    expect(methodsCalledBy('dataUrl')).toEqual(['String::shout (g.d.ts:2)']);
    expect(methodsCalledBy('ignored')).toEqual(['Viewport::translate (viewport.ts:2)']);
  });

  it('keeps a canvas augmentation made through an interface it extends', async () => {
    await index({
      'snap.d.ts': 'interface Snapshotting { snapshot(): string }\ninterface HTMLCanvasElement extends Snapshotting {}\n',
      'use.ts':
        "export function snap() {\n  const c = document.createElement('canvas');\n  c.snapshot();\n}\n",
    });
    expect(methodsCalledBy('snap')).toEqual(['Snapshotting::snapshot (snap.d.ts:1)']);
  });

  it('keeps a canvas whose source local is written with the checker off elsewhere', async () => {
    await index({
      'viewport.ts': viewport,
      'use.ts':
        "let canvas = document.createElement('canvas');\n" +
        "export function swap(next: any) {\n  // @ts-ignore\n  canvas = next;\n}\n" +
        "export function draw() {\n  const ctx = canvas.getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('draw')).toEqual(['Viewport::translate (viewport.ts:2)']);
  });

  it('reads the checker-off comments by where they are', async () => {
    await index({
      'viewport.ts': viewport,
      'nocheck.ts': "// @ts-nocheck\nexport function nocheck() {\n  const ctx = document.createElement('canvas').getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
      'expect.ts':
        "export function expected(next: any) {\n  let canvas = document.createElement('canvas');\n  // @ts-expect-error\n  canvas = next;\n  const ctx = canvas.getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
      'elsewhere.ts':
        "export function other(x: any) {\n  // @ts-ignore\n  return x.y;\n}\n" +
        "export function offscreen() {\n  const ctx = document.createElement('canvas').transferControlToOffscreen().getContext('2d')!;\n  ctx.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('nocheck')).toEqual(['Viewport::translate (viewport.ts:2)']);
    expect(methodsCalledBy('expected')).toEqual(['Viewport::translate (viewport.ts:2)']);
    expect(methodsCalledBy('offscreen')).toEqual([]);
  });

  it('keeps a project getContext overload, a canvas subclass, and a fake context', async () => {
    await index({
      'aug.ts': "import type { MyCtx } from './ctx';\ndeclare global {\n  interface HTMLCanvasElement { getContext(id: 'mine'): MyCtx }\n}\nexport {};\n",
      'ctx.ts': 'export class MyCtx {\n  paint(): void {}\n}\n',
      'use.ts':
        "export function mine() {\n  const ctx = document.createElement('canvas').getContext('mine');\n  ctx.paint();\n}\n",
      'sub.ts':
        "class MyCanvas extends HTMLCanvasElement {\n  toDataURL(): string { return ''; }\n}\n" +
        'function createCanvas(): HTMLCanvasElement {\n  return new MyCanvas();\n}\n' +
        'export function sub() {\n  const c = createCanvas();\n  c.toDataURL();\n}\n',
    });
    expect(methodsCalledBy('mine')).toEqual(['MyCtx::paint (ctx.ts:2)']);
    expect(methodsCalledBy('sub')).toEqual(['MyCanvas::toDataURL (sub.ts:2)']);
  });

  it('still silences past a web component or an unrelated getContext', async () => {
    await index({
      'w.ts': 'export class W extends HTMLElement {\n  translate(): void {}\n}\n',
      'req.ts': 'export interface Req {\n  getContext(): string;\n}\n',
      'use.ts': "export function draw() {\n  const context = document.createElement('canvas').getContext('2d')!;\n  context.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('draw')).toEqual([]);
  });

  it('keeps a canvas augmentation made by extending a project class', async () => {
    await index({
      'snap.ts': "export class Snapshotter {\n  snapshot(): string { return ''; }\n}\ndeclare global {\n  interface HTMLCanvasElement extends Snapshotter {}\n}\n",
      'use.ts': "export function snap() {\n  const c = document.createElement('canvas');\n  c.snapshot();\n}\n",
    });
    expect(methodsCalledBy('snap')).toEqual(['Snapshotter::snapshot (snap.ts:2)']);
  });

  it('reads a canvas subclass past a comment with a brace in its head', async () => {
    await index({
      'a.ts': 'export class A7 /* { */ extends HTMLCanvasElement {\n  m7(): void {}\n}\n',
      'use.ts': "export function f7() {\n  const c = document.createElement('canvas');\n  c.m7();\n}\n",
    });
    expect(methodsCalledBy('f7')).toEqual(['A7::m7 (a.ts:2)']);
  });

  it('keeps the methods of a DOM the project implements itself', async () => {
    await index({
      'dom.ts':
        'export class HTMLElement {\n  focus(): void {}\n}\n' +
        'export class CanvasRenderingContext2D {\n  translate(x: number, y: number): void {}\n}\n',
      'viewport.ts': viewport,
      'use.ts':
        "export function run() {\n  const canvas = document.createElement('canvas');\n  const ctx = canvas.getContext('2d')!;\n  ctx.translate(1, 2);\n  canvas.focus();\n}\n",
    });
    expect(methodsCalledBy('run')).toContain('HTMLElement::focus (dom.ts:2)');
    expect(methodsCalledBy('run')).not.toContain('Viewport::translate (viewport.ts:2)');
  });

  it('keeps an element the project defines', async () => {
    await index({
      'widget.ts': 'export class MyWidget extends HTMLElement {\n  refresh(): void {}\n}\ncustomElements.define(\'my-widget\', MyWidget);\n',
      'use.ts':
        "export function made() {\n  const w = document.createElement('my-widget');\n  w.refresh();\n}\n" +
        "export function queried() {\n  const w = document.querySelector('my-widget')!;\n  w.refresh();\n}\n" +
        "export function queriedInside() {\n  const div = document.createElement('div');\n  const w = div.querySelector('my-widget')!;\n  w.refresh();\n}\n",
    });
    for (const fn of ['made', 'queried', 'queriedInside']) expect(methodsCalledBy(fn), fn).toEqual(['MyWidget::refresh (widget.ts:2)']);
  });

  it('keeps what a function the project puts on window hands back', async () => {
    await index({
      'store.ts': 'export class Store {\n  dispatch(a: string): void {}\n}\n',
      'use.ts': "export function run() {\n  const store = window.getStore();\n  store.dispatch('x');\n}\n",
    });
    expect(methodsCalledBy('run')).toEqual(['Store::dispatch (store.ts:2)']);
  });

  it('keeps a service a package container hands back by key', async () => {
    await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { awilix: '^10.0.0', jquery: '^3.0.0' } }),
      'svc.ts': 'export class UserService {\n  createUser(n: string): void {}\n}\n',
      'use.ts':
        "import { createContainer } from 'awilix';\n" +
        "export function run() {\n  const container = createContainer();\n  const svc = container.resolve('userService');\n  svc.createUser('x');\n}\n",
    });
    expect(methodsCalledBy('run')).toEqual(['UserService::createUser (svc.ts:2)']);
  });

  it('keeps what a package chain hands back', async () => {
    await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { jquery: '^3.0.0' } }),
      'grid.ts': 'export class Grid {\n  refresh(): void {}\n}\n',
      'use.ts': "import $ from 'jquery';\nexport function run() {\n  const grid = $('#grid').data('grid');\n  grid.refresh();\n}\n",
    });
    expect(methodsCalledBy('run')).toEqual(['Grid::refresh (grid.ts:2)']);
  });

  it('keeps a factory that returns a project type alias', async () => {
    await index({
      'svc.ts':
        'export class Repo {\n  save(): void {}\n}\n' +
        'export class Svc {\n  getRepo(): Repo { return new Repo(); }\n}\n' +
        'export type S = Svc;\n' +
        'export function make(): S { return new Svc(); }\n',
      'use.ts': "import { make } from './svc';\nexport function aliased() {\n  const svc = make();\n  const repo = svc.getRepo();\n  repo.save();\n}\n",
    });
    expect(methodsCalledBy('aliased')).toContain('Repo::save (svc.ts:2)');
  });

  it('keeps a local assigned again before the call', async () => {
    await index({
      'viewport.js': 'export class Viewport {\n  translate(x, y) { return x + y; }\n}\nexport function makeViewport() { return new Viewport(); }\n',
      'use.js':
        "import { makeViewport } from './viewport.js';\n" +
        "export function reassigned() {\n  let v = document.createElement('canvas');\n  v = makeViewport();\n  v.translate(1, 2);\n}\n" +
        "export function maybe(flag) {\n  let v = document.createElement('canvas');\n  if (flag) v = makeViewport();\n  v.translate(1, 2);\n}\n",
    });
    expect(methodsCalledBy('reassigned')).toEqual(['Viewport::translate (viewport.js:2)']);
    expect(methodsCalledBy('maybe')).toEqual(['Viewport::translate (viewport.js:2)']);
  });

  it('keeps a local written anywhere after its declaration', async () => {
    await index({
      'viewport.js': 'export class Viewport {\n  translate(x, y) { return x + y; }\n}\nexport function makeViewport() { return new Viewport(); }\n',
      'use.js':
        "import { makeViewport } from './viewport.js';\n" +
        "export function inLoop(items) {\n  let w = document.createElement('canvas');\n  for (const i of items) {\n    w.translate(1, 2);\n    w = makeViewport();\n  }\n}\n" +
        "export function inClosure() {\n  let v = document.createElement('canvas');\n  const f = () => v.translate(1, 2);\n  v = makeViewport();\n  f();\n}\n" +
        "export function arrayPattern() {\n  let v = document.createElement('canvas');\n  [v] = [makeViewport()];\n  v.translate(1, 2);\n}\n" +
        "export function objectPattern() {\n  let v = document.createElement('canvas');\n  ({ v } = { v: makeViewport() });\n  v.translate(1, 2);\n}\n",
    });
    for (const fn of ['inLoop', 'arrayPattern', 'objectPattern']) expect(methodsCalledBy(fn), fn).toEqual(['Viewport::translate (viewport.js:2)']);
    expect(methodsCalledBy('inClosure')).toEqual([]); // the arrow is its own function
    const arrow = cg!.getNodesByKind('function').find((n) => n.name === 'f');
    expect(arrow, 'the arrow f should be indexed').toBeDefined();
    const called = cg!.getOutgoingEdges(arrow!.id).filter((e) => e.kind === 'calls').map((e) => cg!.getNode(e.target)!.qualifiedName);
    expect(called).toEqual(['Viewport::translate']);
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
