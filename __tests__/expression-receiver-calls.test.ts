/**
 * A method called on an EXPRESSION receiver never binds by bare name to an
 * unrelated project method. `(await list()).map(...)` in TypeScript and
 * `v.iter().map(...)` in Rust both reached the resolver as the bare `map`,
 * which exact-matched a TypeScript class's `map` — the Rust one across
 * languages. TS/JS now looks through wrappers that keep the receiver
 * (`(x)`, `x!`, `x as T`, `await`) and emits nothing for a receiver with no
 * static type; the resolver refuses a bare-named call into another language
 * family's class members.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  'src/adapter.ts':
    'export class GraphAdapter { async map(req?: string) { return req ?? \'\'; } }\n' +
    'export class Runner { run() { return 1; } }\n' +
    'export class Base { hello() { return 1; } }\n',
  'src/use.ts':
    "import { GraphAdapter, Runner, Base } from './adapter';\n" +
    "import { helper } from './helper.js';\n" +
    'async function list(): Promise<string[]> { return []; }\n' +
    'export async function names() {\n' +
    '  const a = (await list()).map((d) => d.length);\n' +
    '  const b = [1, 2].map((x) => x + 1);\n' +
    '  const c = (a ?? []).map((x) => x);\n' +
    '  return [a, b, c];\n' +
    '}\n' +
    'export function typed(g: GraphAdapter | undefined) {\n' +
    '  return g!.map();\n' +
    '}\n' +
    'export function fresh() { return new Runner().run() + helper(); }\n' +
    'export class Child extends Base {\n' +
    '  greet() { return this.hello() + super.hello(); }\n' +
    '}\n',
  'src/helper.js': 'export function helper() { return 2; }\n',
  'k/src/lib.rs':
    'pub fn lens(v: Vec<String>) -> Vec<usize> { v.iter().map(|s| s.len()).collect() }\n' +
    'pub fn opt(o: Option<u8>) -> Option<u16> { o.map(|x| x as u16) }\n',
  // A cgo `//export` function called from Swift through the bridging header.
  'export_ios.go': 'package main\n\nimport "C"\n\n//export OpenFluxStop\nfunc OpenFluxStop() {}\n',
  'ios/Tunnel.swift': 'func stopTunnel() {\n  OpenFluxStop()\n}\n',
  // Kotlin's `Log.i(...)` reaches the resolver as the bare `i`.
  'web/min.js': 'function i(a) { return a; }\n',
  'android/Diag.kt': 'fun report() {\n  android.util.Log.i("tag", "msg")\n}\n',
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exprrecv-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const node = (name: string, file: string) =>
  cg.getNodesByName(name).find((n) => n.filePath.endsWith(file) && (n.kind === 'function' || n.kind === 'method'))!;
const calleesOf = (name: string, file: string) =>
  cg.getCallees(node(name, file).id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node: n }) => n.qualifiedName)
    .sort();

describe('expression receivers', () => {
  it('TS: a call-result receiver does not bind `.map` to a project method', () => {
    expect(calleesOf('names', 'use.ts')).toEqual(['list']);
    expect(cg.getCallers(node('map', 'adapter.ts').id).map(({ node: n }) => n.name)).toEqual(['typed']);
  });

  it('Rust: `v.iter().map()` does not bind to a TypeScript class method', () => {
    expect(calleesOf('lens', 'lib.rs')).toEqual([]);
    expect(calleesOf('opt', 'lib.rs')).toEqual([]);
  });

  it('keeps receiver-typed, bare, constructor, this/super and TS→JS calls', () => {
    expect(calleesOf('typed', 'use.ts')).toEqual(['GraphAdapter::map']);
    expect(calleesOf('fresh', 'use.ts')).toEqual(['Runner::run', 'helper']);
    expect(calleesOf('greet', 'use.ts')).toEqual(['Base::hello']);
  });

  it('Kotlin: a bare-named call does not bind to a JavaScript function', () => {
    expect(calleesOf('report', 'Diag.kt')).toEqual([]);
  });

  it('keeps a cross-language call to an exported free function (Swift → cgo)', () => {
    expect(calleesOf('stopTunnel', 'Tunnel.swift')).toEqual(['OpenFluxStop']);
  });

  it('TS extraction: wrappers peel to the receiver, untyped expressions emit nothing', () => {
    const src =
      'async function f(x: X, y: any) {\n' +
      '  (await list()).map(g);\n' +
      '  x!.run();\n' +
      '  (y as X).run();\n' +
      '  (x satisfies X).stop();\n' +
      '  getTarget("a")!.install();\n' +
      '  (a ?? b).map(g);\n' +
      '  arr[0].run();\n' +
      '  f().list.map(g);\n' +
      '  (() => 1).call(null);\n' +
      '  this.a.b.run();\n' +
      '  new Runner().go();\n' +
      '  window.Api.start();\n' +
      '}\n';
    const refs = extractFromSource('t.ts', src, 'typescript').unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(refs).toEqual([
      'list().map', 'list', 'x.run', 'y.run', 'x.stop', 'getTarget().install', 'getTarget',
      'f', 'run', 'new Runner().go', 'start',
    ]);
  });
});
