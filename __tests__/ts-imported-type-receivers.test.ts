/**
 * A call on a TypeScript/JavaScript value whose type the file imports links
 * to the method of the class the import names, when several classes share
 * the name.
 *
 * Typed calls broke a tie between same-named classes only by the call site's
 * own file, then took the first declaration indexed: on vscode, calls in
 * `src/vs/` on a `DisposableStore` imported from `vs/base/common/lifecycle`
 * reached copilot's vendored copy under `extensions/copilot/src/util/vs/`,
 * and a test's `Emitter` a fixture's copy. Java and Kotlin already followed
 * the import (#314).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-imported-recv-'));
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

/** Two classes named `Store`, each with the same methods. */
const STORES = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/one/store.ts':
    'export class Base {\n  reset() { return 1; }\n}\n' +
    'export class Store extends Base {\n  add(v: number) { return v; }\n}\n',
  'src/two/store.ts':
    'export class Base {\n  reset() { return 2; }\n}\n' +
    'export class Store extends Base {\n  add(v: number) { return -v; }\n}\n',
  'src/two/index.ts': "export { Store } from './store';\n",
};

describe('a call on a TypeScript value whose type the file imports', () => {
  it("links to the imported class's method, whichever of the same-named classes it is", async () => {
    const calls = await callsOf({
      ...STORES,
      'src/use-one.ts':
        "import { Store } from './one/store';\n" +
        'export function a(s: Store) {\n  return s.add(1);\n}\n',
      'src/use-two.ts':
        "import { Store } from './two/store';\n" +
        'export function b(s: Store) {\n  return s.add(2);\n}\n',
    });
    expect(calls.filter((c) => c.includes('s.add'))).toEqual([
      'src/use-one.ts: s.add -> src/one/store.ts::Store::add',
      'src/use-two.ts: s.add -> src/two/store.ts::Store::add',
    ]);
  }, 60_000);

  it('follows the import through a re-export, a type-only import and a namespace import', async () => {
    const calls = await callsOf({
      ...STORES,
      'src/use-barrel.ts':
        "import { Store } from './two';\n" +
        'export function b(s: Store) {\n  return s.add(2);\n}\n',
      'src/use-type.ts':
        "import type { Store } from './two/store';\n" +
        'export function t(s: Store) {\n  return s.add(3);\n}\n',
      'src/use-ns.ts':
        "import * as two from './two/store';\n" +
        'export function n() {\n  const s = new two.Store();\n  return s.add(4);\n}\n',
    });
    expect(calls.filter((c) => c.includes('s.add'))).toEqual([
      'src/use-barrel.ts: s.add -> src/two/store.ts::Store::add',
      'src/use-ns.ts: s.add -> src/two/store.ts::Store::add',
      'src/use-type.ts: s.add -> src/two/store.ts::Store::add',
    ]);
  }, 60_000);

  it("links an inherited method to the base class declared beside the imported class", async () => {
    const calls = await callsOf({
      ...STORES,
      'src/use-two.ts':
        "import { Store } from './two/store';\n" +
        'export function b(s: Store) {\n  return s.reset();\n}\n',
    });
    expect(calls.filter((c) => c.includes('s.reset'))).toEqual(['src/use-two.ts: s.reset -> src/two/store.ts::Base::reset']);
  }, 60_000);

  it("links a `this.<field>` call to the method of the class the field's file imports", async () => {
    // Both stores are as near the caller's directory, so nearness alone
    // picks the first path, `src/one`.
    const calls = await callsOf({
      ...STORES,
      'src/user.ts':
        "import { Store } from './two/store';\n" +
        'export class User {\n' +
        '  constructor(private readonly store: Store) {}\n' +
        '  run() {\n    return this.store.add(3);\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/user.ts: this.store.add -> src/two/store.ts::Store::add']);
  }, 60_000);

  it('does the same in JavaScript, for `new` of an imported or required class', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/one/store.js': 'export class Store {\n  add(v) { return v; }\n}\n',
      'lib/two/store.js': 'export class Store {\n  add(v) { return -v; }\n}\n',
      'lib/use-new.js':
        "import { Store } from './two/store';\n" +
        'export function n() {\n  const s = new Store();\n  return s.add(5);\n}\n',
      'lib/use-require.js':
        "const { Store } = require('./two/store');\n" +
        'function r() {\n  const s = new Store();\n  return s.add(6);\n}\n' +
        'module.exports = { r };\n',
    });
    expect(calls.filter((c) => c.includes('s.add'))).toEqual([
      'lib/use-new.js: s.add -> lib/two/store.js::Store::add',
      'lib/use-require.js: s.add -> lib/two/store.js::Store::add',
    ]);
  }, 60_000);

  it("still prefers a class the call's own file declares", async () => {
    const calls = await callsOf({
      ...STORES,
      'src/own.ts':
        'class Store {\n  add(v: number) { return v * 2; }\n}\n' +
        'export function o(s: Store) {\n  return s.add(7);\n}\n',
    });
    expect(calls.filter((c) => c.includes('s.add'))).toEqual(['src/own.ts: s.add -> src/own.ts::Store::add']);
  }, 60_000);
});
