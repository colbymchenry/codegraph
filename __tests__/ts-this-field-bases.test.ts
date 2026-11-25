/**
 * A TypeScript/JavaScript `this.<field>` call on a field a base class
 * declares links through that base, the class its subclass's file names.
 *
 * A field the calling class doesn't declare was read off any same-named
 * class elsewhere, and never off the classes it extends: on vscode, the
 * browser `FileDialogService`'s `this.openerService` was typed by the
 * electron `FileDialogService`, and a field another app's same-named class
 * declares could type it however that app did. Now the calling class's
 * bases come first, and a same-named class elsewhere only when the call's
 * file imports or declares the type it gives the field.
 *
 * A type the declaring file imports from a package outside the project has
 * no project method, which typed locals follow too: microsoft-
 * authentication's `TelemetryReporter` from `@vscode/extension-telemetry`
 * reached another extension's interface of that name.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-field-bases-'));
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
  'src/one/store.ts': 'export class Store {\n  add(v: number) { return v; }\n}\n',
  'src/two/store.ts': 'export class Store {\n  add(v: number) { return -v; }\n}\n',
};

describe('a this.<field> call on a field a class it extends declares', () => {
  it('reads the field off the base its file imports, and its type off the import there', async () => {
    const calls = await callsOf({
      ...STORES,
      'src/base.ts': "import { Store } from './two/store';\nexport class Base {\n  protected readonly store = new Store();\n}\n",
      'src/child.ts':
        "import { Base } from './base';\n" +
        'export class Child extends Base {\n  run() {\n    return this.store.add(1);\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/child.ts: this.store.add -> src/two/store.ts::Store::add']);
  }, 60_000);

  it("reads the field's type off a class the base's own file declares", async () => {
    const calls = await callsOf({
      ...STORES,
      // A folder that sorts after `one` and `two`, so folder nearness, which
      // ties, would pick another `Store`.
      'src/zeta/base.ts':
        'export class Store {\n  add(v: number) { return v * 10; }\n}\n' +
        'export class Base {\n  protected readonly store = new Store();\n}\n',
      'src/child.ts':
        "import { Base } from './zeta/base';\n" +
        'export class Child extends Base {\n  run() {\n    return this.store.add(1);\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/child.ts: this.store.add -> src/zeta/base.ts::Store::add']);
  }, 60_000);

  it('follows an aliased import to a base of the same name', async () => {
    // vscode's sessions `EditorPart extends` the workbench's `EditorPart`.
    const calls = await callsOf({
      ...STORES,
      'src/workbench/part.ts': "import { Store } from '../two/store';\nexport class Part {\n  protected readonly store: Store = new Store();\n}\n",
      'src/sessions/part.ts':
        "import { Part as BasePart } from '../workbench/part';\n" +
        'export class Part extends BasePart {\n  run() {\n    return this.store.add(2);\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/sessions/part.ts: this.store.add -> src/two/store.ts::Store::add']);
  }, 60_000);

  it('reads it off a base many classes up, as vscode editors inherit `_store` from `Disposable`', async () => {
    const files: Record<string, string> = {
      ...STORES,
      'src/base.ts': "import { Store } from './two/store';\nexport class Base {\n  protected readonly store = new Store();\n}\n",
    };
    let parent = ['Base', './base'];
    for (const name of ['L1', 'L2', 'L3', 'L4', 'L5']) {
      files[`src/${name.toLowerCase()}.ts`] = `import { ${parent[0]} } from '${parent[1]}';\nexport class ${name} extends ${parent[0]} {}\n`;
      parent = [name, `./${name.toLowerCase()}`];
    }
    const calls = await callsOf({
      ...files,
      'src/child.ts': "import { L5 } from './l5';\nexport class Child extends L5 {\n  run() {\n    return this.store.add(1);\n  }\n}\n",
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/child.ts: this.store.add -> src/two/store.ts::Store::add']);
  }, 60_000);

  it("doesn't read the field off an unrelated class of the same name whose type the call's file doesn't name", async () => {
    const calls = await callsOf({
      ...STORES,
      'src/app-a/service.ts': "import { Store } from '../one/store';\nexport class Service {\n  private readonly store = new Store();\n}\n",
      'src/app-b/service.ts':
        'const makeStore = () => ({ add: (v: number) => v });\n' +
        'export class Service {\n  private readonly store = makeStore();\n  run() {\n    return this.store.add(3);\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual([]);
  }, 60_000);

  it('still reads it off a same-named class elsewhere whose type the call\'s file imports', async () => {
    // The calling class's own declaration goes through a wrapper the reader
    // can't vouch for (`wrap` declares no return type); the same-named
    // class elsewhere declares the field.
    const calls = await callsOf({
      ...STORES,
      'src/app/mock.ts':
        "import { Store } from '../two/store';\n" +
        'const wrap = <T>(value: T) => value;\n' +
        'export class Mock {\n' +
        '  private readonly store = wrap(new Store());\n' +
        '  run() {\n    return this.store.add(1);\n  }\n' +
        '}\n',
      'src/other/mock.ts':
        "import { Store } from '../one/store';\n" +
        'export class Mock {\n  private readonly store = new Store();\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/app/mock.ts: this.store.add -> src/two/store.ts::Store::add']);
  }, 60_000);
});

describe('a call on a value whose type a package outside the project gives', () => {
  it("links to no project class that shares the type's name", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'ext-telemetry': '^1.0.0' } }),
      'src/other.ts': 'export interface TelemetryReporter {\n  sendTelemetryEvent(name: string): void;\n}\n',
      'src/reporter.ts':
        "import TelemetryReporter from 'ext-telemetry';\n" +
        'export class Reporter {\n' +
        '  protected reporter: TelemetryReporter;\n' +
        '  constructor() {\n    this.reporter = new TelemetryReporter();\n  }\n' +
        "  send() {\n    this.reporter.sendTelemetryEvent('a');\n  }\n" +
        '}\n' +
        "export class Sub extends Reporter {\n  more() {\n    this.reporter.sendTelemetryEvent('b');\n  }\n}\n",
      'src/local.ts':
        "import TelemetryReporter from 'ext-telemetry';\n" +
        "export function f() {\n  const r = new TelemetryReporter();\n  return r.sendTelemetryEvent('c');\n}\n",
    });
    expect(calls.filter((c) => c.includes('sendTelemetryEvent'))).toEqual([]);
  }, 60_000);

  it('still links to the declaration a project file gives the package', async () => {
    // vscode's `src/typings/copilot-api.d.ts` declares `@vscode/copilot-api`.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'ext-api': '^1.0.0' } }),
      'src/typings/ext-api.d.ts': "declare module 'ext-api' {\n  export class ApiClient {\n    update(): void;\n  }\n}\n",
      'src/other.ts': 'export class ApiClient {\n  update() { return 1; }\n}\n',
      'src/use.ts':
        "import { ApiClient } from 'ext-api';\n" +
        'export class Service {\n  private readonly client: ApiClient = new ApiClient();\n' +
        '  run() {\n    return this.client.update();\n  }\n}\n' +
        'export function f() {\n  const api = new ApiClient();\n  return api.update();\n}\n',
    });
    expect(calls.filter((c) => c.includes('.update'))).toEqual([
      'src/use.ts: api.update -> src/typings/ext-api.d.ts::ApiClient::update',
      'src/use.ts: this.client.update -> src/typings/ext-api.d.ts::ApiClient::update',
    ]);
  }, 60_000);

  it('does the same for a Flow libdef, and for a `node:` import of the module a libdef declares', async () => {
    // react-native's `flow-typed/npm/tinybench_v4.1.x.js` declares
    // `tinybench`, and `flow-typed/environment/node.js` Node's modules.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'ext-bench': '^1.0.0' } }),
      'flow-typed/npm/ext-bench.js': "/**\n * @flow strict\n */\ndeclare module 'ext-bench' {\n  declare export class Bench {\n    run(): void;\n  }\n}\n",
      'flow-typed/environment/node.d.ts': "declare module 'timers' {\n  export class Timeout {\n    refresh(): Timeout;\n  }\n}\n",
      'src/other.js': 'export class Bench {\n  run() { return 1; }\n}\nexport class Timeout {\n  refresh() { return this; }\n}\n',
      'src/use.js':
        "import { Bench } from 'ext-bench';\n" +
        'export function b() {\n  const bench = new Bench();\n  return bench.run();\n}\n',
      'src/timer.ts':
        "import { Timeout } from 'node:timers';\n" +
        'export function t(timeout: Timeout) {\n  return timeout.refresh();\n}\n',
    });
    expect(calls.filter((c) => c.includes('bench.run') || c.includes('timeout.refresh'))).toEqual([
      'src/timer.ts: timeout.refresh -> flow-typed/environment/node.d.ts::Timeout::refresh',
      'src/use.js: bench.run -> flow-typed/npm/ext-bench.js::Bench::run',
    ]);
  }, 60_000);
});
