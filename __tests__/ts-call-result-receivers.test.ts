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
