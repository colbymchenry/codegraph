/**
 * A method called on a `new C(...)` receiver resolves on `C` or nowhere.
 * `new RegExp(p).exec(s)` used to reach the resolver as the bare `exec` and
 * exact-match a project database wrapper's `exec`; the extractor now keeps the
 * constructed class (`new RegExp().exec`), so a built-in or external class
 * binds to nothing while a project class resolves its own (or inherited)
 * method.
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
  'src/db.ts':
    'export class SqliteDatabase { exec(sql: string) { return sql; } get(k: string) { return k; } }\n' +
    'export class Printer { toString() { return "p"; } }\n',
  'src/runner.ts':
    'export class Base { baseMethod() { return 1; } }\n' +
    'export class Runner { run() { return 1; } }\n' +
    'export class Sub extends Base { own() { return 2; } }\n',
  'src/use.ts':
    "import { Runner, Sub, Runner as R } from './runner';\n" +
    "import * as rr from './runner';\n" +
    'export function builtins(p: string, u: string, s: string) {\n' +
    '  const a = new RegExp(p).exec(s);\n' +
    '  const b = new URL(u).toString();\n' +
    '  const c = new Map([[1, 2]]).get(1);\n' +
    '  const d = new Date().getTime();\n' +
    '  return [a, b, c, d];\n' +
    '}\n' +
    'export function projectClasses() {\n' +
    '  return new Runner().run() + new Sub().baseMethod() + new Sub().own() + new R().run() + new rr.Runner().run();\n' +
    '}\n',
  'src/plain.js':
    "const { Runner } = require('./runner');\n" +
    'function jsCalls(p, s) {\n' +
    '  new RegExp(p).exec(s);\n' +
    '  new Set([1]).get(1);\n' +
    '  return new Runner().run();\n' +
    '}\n' +
    'module.exports = { jsCalls };\n',
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-newrecv-'));
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

describe('new-expression receivers', () => {
  it('TS: a built-in or external constructed class binds to no project method', () => {
    expect(calleesOf('builtins', 'use.ts')).toEqual([]);
    expect(cg.getCallers(node('exec', 'db.ts').id)).toEqual([]);
    expect(cg.getCallers(node('get', 'db.ts').id)).toEqual([]);
    expect(cg.getCallers(node('toString', 'db.ts').id)).toEqual([]);
  });

  it('TS: a project class resolves its own and inherited methods, via alias and namespace too', () => {
    expect([...new Set(calleesOf('projectClasses', 'use.ts'))]).toEqual(['Base::baseMethod', 'Runner::run', 'Sub::own']);
    expect(cg.getCallers(node('run', 'runner.ts').id).map(({ node: n }) => n.name)).toContain('projectClasses');
  });

  it('JS: the same rules apply', () => {
    expect(calleesOf('jsCalls', 'plain.js')).toEqual(['Runner::run']);
  });

  it('extraction keeps the constructed class in the ref name', () => {
    const src =
      'function f(p, s) {\n' +
      '  new RegExp(p).exec(s);\n' +
      '  (new ns.Widget<T>(1)).draw();\n' +
      '  new (pick())().go();\n' +
      '  new Runner().a.run();\n' +
      '}\n';
    const refs = extractFromSource('t.ts', src, 'typescript').unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(refs).toEqual(['new RegExp().exec', 'new ns.Widget().draw', 'pick']);
  });
});
