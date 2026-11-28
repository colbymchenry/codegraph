/**
 * In TypeScript and JavaScript, a value named like a class (e.g. `ky` beside
 * `class Ky`) must not link its method calls to a `static` method on that
 * class: an instance cannot call a static method.
 *
 * Genuine static calls (`Ky.create(...)`) and instance-method guesses on a
 * lowercase receiver (`ky.run(...)` -> non-static `Ky::run`) must continue to
 * resolve.
 *
 * Regression test for colbymchenry/codegraph#3429.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** Index `files` and return each call edge as `<file>: <refName> -> <target file>::<target qualified name>`. */
async function callsOf(files: Record<string, string>): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-static-method-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  const nodes = graph.getFiles().flatMap((f) => graph.getNodesInFile(f.path));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return graph.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['calls'])
    .map((e) => {
      const target = byId.get(e.target);
      return `${byId.get(e.source)?.filePath}: ${e.metadata?.refName} -> ${target?.filePath}::${target?.qualifiedName}`;
    })
    .sort();
}

describe('TS/JS value named like a class does not link to static methods (#3429)', () => {
  it('does not link self-imported or dynamically-imported `ky.create({})` to static `Ky.create`', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({
        name: 'ky',
        type: 'module',
        exports: './src/index.ts',
      }),
      'src/core.ts': [
        'export class Ky {',
        '  static create(input: string): string {',
        '    return input;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/index.ts': [
        'export type KyInstance = {',
        '  create: (defaults?: object) => KyInstance;',
        '};',
        '',
        'declare function createInstance(): KyInstance;',
        '',
        'const ky = createInstance();',
        'export default ky;',
        '',
      ].join('\n'),
      'src/use.ts': [
        "import ky from 'ky';",
        '',
        'export function selfImport() {',
        '  return ky.create({});',
        '}',
        '',
        'export async function dynamicImport() {',
        "  const {default: ky} = await import('./index.js');",
        '  return ky.create({});',
        '}',
        '',
      ].join('\n'),
    });

    const kyCreateCalls = calls.filter((c) => c.startsWith('src/use.ts: ky.create ->'));
    expect(kyCreateCalls.filter((c) => c.includes('src/core.ts::Ky::create'))).toEqual([]);
    expect(kyCreateCalls).toEqual([
      'src/use.ts: ky.create -> src/index.ts::KyInstance::create',
      'src/use.ts: ky.create -> src/index.ts::KyInstance::create',
    ]);
  }, 60_000);

  it('does not link a JS parameter or local named like a class to its static method', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', type: 'module' }),
      'src/core.js': [
        'export class Engine {',
        '  static build(opts) {',
        '    return opts;',
        '  }',
        '  start() {',
        '    return true;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/use.js': [
        'export function run(engine) {',
        '  engine.build({});',
        '  engine.start();',
        '}',
        '',
      ].join('\n'),
    });

    expect(calls.filter((c) => c.includes('engine.build'))).toEqual([]);
    expect(calls.filter((c) => c.includes('engine.start'))).toEqual([
      'src/use.js: engine.start -> src/core.js::Engine::start',
    ]);
  }, 60_000);

  it('still resolves genuine static method calls on the class itself', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', type: 'module' }),
      'src/core.ts': [
        'export class Ky {',
        '  static create(input: string): string {',
        '    return input;',
        '  }',
        '  fetch(url: string): string {',
        '    return url;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/use.ts': [
        "import { Ky } from './core';",
        '',
        'export function callStatic() {',
        "  return Ky.create('https://example.com');",
        '}',
        '',
        'export function callInstance(ky: any) {',
        "  ky.create('nope');",
        "  return ky.fetch('https://example.com');",
        '}',
        '',
      ].join('\n'),
    });

    expect(calls.filter((c) => c.includes('Ky.create'))).toEqual([
      'src/use.ts: Ky.create -> src/core.ts::Ky::create',
    ]);
    expect(calls.filter((c) => c.includes('ky.create'))).toEqual([]);
    expect(calls.filter((c) => c.includes('ky.fetch'))).toEqual([
      'src/use.ts: ky.fetch -> src/core.ts::Ky::fetch',
    ]);
  }, 60_000);

  it('skips a subclass static method to reach an inherited instance method, and skips static methods on abbreviated receivers', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', type: 'module' }),
      'src/base.ts': [
        'export class Base {',
        '  create() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/ky.ts': [
        "import { Base } from './base';",
        'export class Ky extends Base {',
        '  static create() {',
        '    return 2;',
        '  }',
        '  static reset() {',
        '    return 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/use.ts': [
        "import { Ky } from './ky';",
        'export function run(ky: any, myKy: any) {',
        '  ky.create();',
        '  myKy.reset();',
        '  Ky.reset();',
        '  return Ky.create();',
        '}',
        '',
      ].join('\n'),
    });

    expect(calls.filter((c) => c.includes('ky.create'))).toEqual([
      'src/use.ts: ky.create -> src/base.ts::Base::create',
    ]);
    expect(calls.filter((c) => c.includes('Ky.create'))).toEqual([
      'src/use.ts: Ky.create -> src/ky.ts::Ky::create',
    ]);
    expect(calls.filter((c) => c.includes('myKy.reset'))).toEqual([]);
    expect(calls.filter((c) => c.includes('Ky.reset'))).toEqual([
      'src/use.ts: Ky.reset -> src/ky.ts::Ky::reset',
    ]);
  }, 60_000);
});
