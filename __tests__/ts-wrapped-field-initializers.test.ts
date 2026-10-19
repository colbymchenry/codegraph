/**
 * A TypeScript `this.<field>` call on a field initialized through a wrapper
 * that hands back its argument — vscode's `this._register(new Emitter())`
 * and `this._store.add(new Emitter())` — links through the wrapped class.
 *
 * The field reader knew `field: T`, `field: typeof X` and `field = new X()`,
 * so vscode's most common declaration, `private readonly _onDidChange =
 * this._register(new Emitter<void>())`, gave the field no type and its
 * `fire()` calls linked nowhere. A wrapper counts only when its own
 * declaration returns its argument (`_register<T extends IDisposable>(o: T):
 * T`) and its call ends the statement: `this.box(value)` may return a box of
 * it, and `this._register(new DomEmitter(…)).event` a member of it.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-wrapped-fields-'));
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

/**
 * vscode's lifecycle wrappers, the `Emitter` the app imports, and a decoy
 * `Emitter` nearer the app (`src/app/legacy`) that a guess by method name or
 * folder would pick.
 */
const LIFECYCLE = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/base/lifecycle.ts':
    'export interface IDisposable {\n  dispose(): void;\n}\n' +
    'export class DisposableStore implements IDisposable {\n' +
    '  private readonly items: IDisposable[] = [];\n' +
    '  add<T extends IDisposable>(o: T): T {\n    this.items.push(o);\n    return o;\n  }\n' +
    '  dispose() {}\n' +
    '}\n' +
    'export abstract class Disposable implements IDisposable {\n' +
    '  protected readonly _store = new DisposableStore();\n' +
    '  protected _register<T extends IDisposable>(o: T): T {\n    return this._store.add(o);\n  }\n' +
    '  dispose() {}\n' +
    '}\n',
  'src/base/event.ts': 'export class Emitter<T> {\n  fire(event?: T) {\n    return event;\n  }\n  dispose() {}\n}\n',
  'src/app/legacy/event.ts': 'export class Emitter {\n  fire() {\n    return 0;\n  }\n  dispose() {}\n}\n',
};

const IMPORTS = "import { Disposable, DisposableStore } from '../base/lifecycle';\nimport { Emitter } from '../base/event';\n";

describe('a this.<field> call on a field a wrapper initializes', () => {
  it('reads `this._register(new X())` as an X when the inherited `_register` returns its argument', async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/model.ts':
        IMPORTS +
        'export class Model extends Disposable {\n' +
        '  private readonly _onDidChange = this._register(new Emitter<string>());\n' +
        '  private readonly _onDidMove = this._register(new Emitter<number>(\n' +
        '  ));\n' +
        '  private readonly _onDidOpen;\n' +
        '  constructor() {\n    super();\n    this._onDidOpen = this._register(new Emitter<void>());\n  }\n' +
        "  change() {\n    this._onDidChange.fire('a');\n    this._onDidMove.fire(1);\n    this._onDidOpen.fire();\n  }\n" +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual([
      'src/app/model.ts: this._onDidChange.fire -> src/base/event.ts::Emitter::fire',
      'src/app/model.ts: this._onDidMove.fire -> src/base/event.ts::Emitter::fire',
      'src/app/model.ts: this._onDidOpen.fire -> src/base/event.ts::Emitter::fire',
    ]);
  }, 60_000);

  it('reads `this.<store>.add(new X())` through the class the store field is declared as', async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/view.ts':
        IMPORTS +
        'export class View extends Disposable {\n' +
        '  private readonly _disposables = new DisposableStore();\n' +
        '  private readonly _onDidShow = this._store.add(new Emitter<void>());\n' +
        '  private readonly _onDidHide = this._disposables.add(new Emitter<void>());\n' +
        '  show() {\n    this._onDidShow.fire();\n  }\n' +
        '  hide() {\n    this._onDidHide.fire();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual([
      'src/app/view.ts: this._onDidHide.fire -> src/base/event.ts::Emitter::fire',
      'src/app/view.ts: this._onDidShow.fire -> src/base/event.ts::Emitter::fire',
    ]);
  }, 60_000);

  it('finds the wrapper and the store as many classes up as vscode editors inherit them from `Disposable`', async () => {
    // `… extends EditorPane extends Composite extends Component extends Themable extends Disposable`
    const chain = ['Themable', 'Component', 'Composite', 'Pane', 'EditorPane'];
    const files: Record<string, string> = { ...LIFECYCLE };
    chain.forEach((name, i) => {
      const base = i === 0 ? ['Disposable', '../base/lifecycle'] : [chain[i - 1]!, `./${chain[i - 1]!.toLowerCase()}`];
      files[`src/app/${name.toLowerCase()}.ts`] = `import { ${base[0]} } from '${base[1]}';\nexport class ${name} extends ${base[0]} {}\n`;
    });
    const calls = await callsOf({
      ...files,
      'src/app/editor.ts':
        "import { EditorPane } from './editorpane';\nimport { Emitter } from '../base/event';\n" +
        'export class Editor extends EditorPane {\n' +
        '  private readonly _onDidChange = this._register(new Emitter<void>());\n' +
        '  private readonly _onDidShow = this._store.add(new Emitter<void>());\n' +
        '  run() {\n    this._onDidChange.fire();\n    this._onDidShow.fire();\n  }\n' +
        '}\n',
    });
    // `_onDidShow` needs `_store` found on `Disposable` too.
    expect(calls.filter((c) => c.includes('.fire'))).toEqual([
      'src/app/editor.ts: this._onDidChange.fire -> src/base/event.ts::Emitter::fire',
      'src/app/editor.ts: this._onDidShow.fire -> src/base/event.ts::Emitter::fire',
    ]);
  }, 60_000);

  it('reads them in files with CRLF line endings, as a Windows checkout has', async () => {
    const files: Record<string, string> = {
      ...LIFECYCLE,
      'src/app/model.ts':
        IMPORTS +
        'class DomEmitter {\n  readonly event = (listener: () => void) => listener;\n  dispose() {}\n}\n' +
        'export class Model extends Disposable {\n' +
        '  private readonly _onDidChange = this._register(new Emitter<string>());\n' +
        '  private readonly _onDidShow = this._store.add(new Emitter<void>());\n' +
        '  private readonly _onDidHide = this._register(new Emitter<void>())\n' +
        '  private readonly onKeyDown = this._register(new DomEmitter()).event;\n' +
        "  change() {\n    this._onDidChange.fire('a');\n    this._onDidShow.fire();\n    this._onDidHide.fire();\n    this.onKeyDown.dispose();\n  }\n" +
        '}\n',
    };
    const calls = await callsOf(Object.fromEntries(Object.entries(files).map(([file, text]) => [file, text.replace(/\n/g, '\r\n')])));
    expect(calls.filter((c) => c.includes('.fire') || c.includes('.dispose'))).toEqual([
      'src/app/model.ts: this._onDidChange.fire -> src/base/event.ts::Emitter::fire',
      'src/app/model.ts: this._onDidHide.fire -> src/base/event.ts::Emitter::fire',
      'src/app/model.ts: this._onDidShow.fire -> src/base/event.ts::Emitter::fire',
    ]);
  }, 60_000);

  it("doesn't read a wrapper whose declaration doesn't return its argument", async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/box.ts':
        IMPORTS +
        'class Box<T> {\n  constructor(readonly value: T) {}\n}\n' +
        'class Widget {\n  fire() {}\n}\n' +
        'class FancyWidget extends Widget {\n  fire() {}\n}\n' +
        'export class Holder extends Disposable {\n' +
        '  private readonly _boxed = this.box(new Emitter<string>());\n' +
        '  private readonly _kept = this.keep(new Emitter<string>());\n' +
        '  private readonly _widget = this.replace(new FancyWidget());\n' +
        '  private readonly items = new Set<Emitter<string>>();\n' +
        '  private readonly _set = this.items.add(new Emitter<string>());\n' +
        '  private box<T>(value: T): Box<T> {\n    return new Box(value);\n  }\n' +
        '  private keep<T>(value: T) {\n    return value;\n  }\n' +
        // Typed with a class, not a type parameter of its own: another Widget may come back.
        '  private replace(widget: Widget): Widget {\n    return widget instanceof FancyWidget ? new Widget() : widget;\n  }\n' +
        "  run() {\n    this._boxed.fire('a');\n    this._kept.fire('b');\n    this._widget.fire();\n    this._set.fire('c');\n  }\n" +
        '}\n',
      'src/app/plain.ts':
        "import { Emitter } from '../base/event';\n" +
        'export class Plain {\n' +
        '  private readonly _onDidChange = this._register(new Emitter<void>());\n' +
        '  run() {\n    this._onDidChange.fire();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual([]);
  }, 60_000);

  it("doesn't read the wrapped class when a member of what the wrapper returns is taken", async () => {
    const calls = await callsOf({
      ...LIFECYCLE,
      'src/app/input.ts':
        IMPORTS +
        'class DomEmitter {\n  readonly event = (listener: () => void) => listener;\n  dispose() {}\n}\n' +
        'export class Input extends Disposable {\n' +
        '  private readonly onKeyDown = this._register(new DomEmitter()).event;\n' +
        '  private readonly onKeyUp = this._register(new DomEmitter())\n    .event;\n' +
        '  run() {\n    this.onKeyDown.dispose();\n    this.onKeyUp.dispose();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('.dispose'))).toEqual([]);
  }, 60_000);
});
