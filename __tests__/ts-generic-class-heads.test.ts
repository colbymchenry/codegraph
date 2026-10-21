/**
 * A TypeScript class whose head opens a type parameter list with a
 * constraint, like vscode's `class EditorPane<MementoType extends object =
 * object> extends Composite<MementoType>`, extends the class after its type
 * parameters, not the constraint's type.
 *
 * The head was read up to its first `extends`, which there is the
 * constraint: `EditorPane` read as extending `object` (so nothing),
 * `MultiWindowParts<T extends IMultiWindowPart, …>` as extending
 * `IMultiWindowPart`. Fields, wrapper methods and static methods a class
 * inherits through such a head were then missed, or found on the wrong
 * class.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-generic-heads-'));
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

/** vscode's lifecycle wrappers, the `Emitter` the app imports, and a decoy `Emitter` nearer the app. */
const LIFECYCLE = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/base/lifecycle.ts':
    'export interface IDisposable {\n  dispose(): void;\n}\n' +
    'export class DisposableStore implements IDisposable {\n  add<T extends IDisposable>(o: T): T {\n    return o;\n  }\n  dispose() {}\n}\n' +
    'export abstract class Disposable implements IDisposable {\n' +
    '  protected readonly _store = new DisposableStore();\n' +
    '  protected _register<T extends IDisposable>(o: T): T {\n    return this._store.add(o);\n  }\n' +
    '  dispose() {}\n' +
    '}\n',
  'src/base/event.ts': 'export class Emitter<T> {\n  fire(event?: T) {\n    return event;\n  }\n  dispose() {}\n}\n',
  'src/app/legacy/event.ts': 'export class Emitter {\n  fire() {\n    return 0;\n  }\n  dispose() {}\n}\n',
};

describe('a TypeScript class whose head constrains a type parameter', () => {
  it('extends the class after its type parameters, for a wrapper it inherits', async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/pane.ts':
        "import { Disposable } from '../base/lifecycle';\n" +
        'export abstract class Pane<MementoType extends object = object> extends Disposable {\n  protected memento?: MementoType;\n}\n',
      'src/app/editor.ts':
        "import { Pane } from './pane';\nimport { Emitter } from '../base/event';\n" +
        'export class Editor extends Pane<{ zoom: number }> {\n' +
        '  private readonly _onDidChange = this._register(new Emitter<void>());\n' +
        '  run() {\n    this._onDidChange.fire();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual(['src/app/editor.ts: this._onDidChange.fire -> src/base/event.ts::Emitter::fire']);
  }, 60_000);

  it('extends the class after its type parameters, for a field it inherits, not the constraint', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/store.ts': 'export class Store {\n  add(v: number) {\n    return v;\n  }\n}\n',
      // The constraint's class declares a `store` of another type with an `add`.
      'src/part.ts': 'export class Ledger {\n  add(v: number) {\n    return -v;\n  }\n}\nexport class Part {\n  protected readonly store = new Ledger();\n}\n',
      'src/root.ts': "import { Store } from './store';\nexport class Root {\n  protected readonly store = new Store();\n}\n",
      'src/parts.ts':
        "import { Part } from './part';\nimport { Root } from './root';\n" +
        'export class Parts<T extends Part, MementoType extends object = object> extends Root {\n  protected parts: T[] = [];\n}\n',
      'src/main.ts':
        "import { Parts } from './parts';\nimport { Part } from './part';\n" +
        'export class MainParts extends Parts<Part> {\n  run() {\n    return this.store.add(1);\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.store.add'))).toEqual(['src/main.ts: this.store.add -> src/store.ts::Store::add']);
  }, 60_000);

  it('reads a head that runs over several lines, below a decorator, with an arrow type in a constraint', async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/decorate.ts': 'export function Decorate(options: object) {\n  return (target: unknown) => target;\n}\n',
      'src/app/view.ts':
        "import { Disposable } from '../base/lifecycle';\nimport { Decorate } from './decorate';\n" +
        "@Decorate({ host: { class: 'view' } })\n" +
        'export class View<\n  Render extends (value: string) => void,\n  State extends object = object\n>\n  extends Disposable {\n' +
        '  protected render?: Render;\n}\n',
      'src/app/panel.ts':
        "import { View } from './view';\nimport { Emitter } from '../base/event';\n" +
        'export class Panel extends View<(value: string) => void> {\n' +
        '  private readonly _onDidShow = this._register(new Emitter<void>());\n' +
        '  show() {\n    this._onDidShow.fire();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual(['src/app/panel.ts: this._onDidShow.fire -> src/base/event.ts::Emitter::fire']);
  }, 60_000);
});
