/**
 * A call on a TypeScript local or parameter annotated as an array of a class
 * is the array's method, not the class's.
 *
 * `items: Item[]` was read as an `Item`, because the annotation's capture
 * stopped at `[`, so `items.find(…)` linked to `Item.find` whenever the class
 * declares a method of that name: on vscode, `distinctElements.find(…)` on
 * an `ExplorerItem[]` reached `ExplorerItem.find`, and `ranges.map(…)` on an
 * `OffsetRange[]` reached `OffsetRange.map`. A method arrays don't have can
 * only be called on an element that shares the array's name, as in
 * `d.forEach(d => d.dispose())`, and that one keeps the element's type.
 *
 * A local annotated as one of a type's properties (`editor:
 * IChatWidget['inputEditor']`) was read as that type too, so its calls
 * reached the type's methods of the same name, or none. It has the type the
 * property is declared with, an array of it the same way; one whose type
 * isn't written in the project (`Parameters<typeof f>[0]`) links to nothing,
 * and the call isn't matched by its name either.
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

/** Index `files` and return each call edge as `<refName> -> <target qualified name>`. */
async function callsOf(files: Record<string, string>, withFiles = false): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-array-recv-'));
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
      const source = byId.get(e.source);
      const target = byId.get(e.target);
      return withFiles
        ? `${source?.filePath}: ${e.metadata?.refName} -> ${target?.filePath}::${target?.qualifiedName}`
        : `${e.metadata?.refName} -> ${target?.qualifiedName}`;
    })
    .sort();
}

const CLASSES = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/item.ts':
    'export class Item {\n' +
    '  find(key: string) { return key; }\n' +
    '  push(value: number) { return value; }\n' +
    '  flush() { return 0; }\n' +
    '}\n' +
    'export class Repository<T> {\n' +
    '  save(value: T) { return value; }\n' +
    '  find(id: string) { return id; }\n' +
    '}\n',
  // The one project method named `findLast`, on an unrelated class.
  'src/stack.ts': 'export class Stack {\n  findLast() { return 1; }\n}\n',
};

describe('a call on a TypeScript local annotated as an array of a class', () => {
  it('links to no method of the element class', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function first(items: Item[]) {\n' +
        "  return items.find((i) => i !== undefined);\n" +
        '}\n' +
        'export function fill() {\n' +
        '  const list: Item[] = [];\n' +
        '  list.push(new Item());\n' +
        '  return list;\n' +
        '}\n' +
        'export function spaced(all: Item [], grid: Item[][]) {\n' +
        "  all.find((i) => i !== undefined);\n" +
        '  return grid.push([]);\n' +
        '}\n',
    });
    expect(calls.filter((c) => /^(items|list|all|grid)\./.test(c))).toEqual([]);
  }, 60_000);

  it("is not matched to another class's method by the call's name instead", async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function last(all: Item[]) {\n' +
        '  return all.findLast((i) => i !== undefined);\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('all.'))).toEqual([]);
  }, 60_000);

  it('does the same for an array of a generic class', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Repository } from './item';\n" +
        'export function saveAll(repos: Repository<string>[], value: string) {\n' +
        '  repos.forEach((r) => r.save(value));\n' +
        "  return repos.find((r) => r !== undefined);\n" +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('repos.'))).toEqual([]);
  }, 60_000);

  it("still links a method arrays don't have to the element's class: the call is on an element of the same name", async () => {
    // vscode's `d.forEach(d => d.dispose())` on an `IDisposable[]`, and
    // `extensions.map(extensions => extensions.syncInstalledExtensionsWithGallery(…))`.
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item } from './item';\n" +
        'export function flushAll(d: Item[]) {\n' +
        '  d.forEach((d) => d.flush());\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('d.'))).toEqual(['d.flush -> Item::flush']);
  }, 60_000);

  it('still links a call on a local annotated as the class, generic or not', async () => {
    const calls = await callsOf({
      ...CLASSES,
      'src/use.ts':
        "import { Item, Repository } from './item';\n" +
        'export function one(item: Item, repo: Repository<string>) {\n' +
        "  repo.find('x');\n" +
        "  return item.find('k');\n" +
        '}\n',
    });
    expect(calls).toEqual(['item.find -> Item::find', 'repo.find -> Repository::find']);
  }, 60_000);
});

describe("a call on a TypeScript local annotated as one of a type's properties", () => {
  it('links to the method of the type that property is declared with', async () => {
    // vscode's `editor: IChatWidget['inputEditor']`, then `editor.executeEdits(…)`.
    const calls = await callsOf({
      ...CLASSES,
      'src/widget.ts':
        'export class CodeEditor {\n  executeEdits() { return true; }\n}\n' +
        'export interface Widget {\n  readonly inputEditor: CodeEditor;\n}\n' +
        // Another `executeEdits`, so the method's name alone picks neither.
        'export class DiffEditor {\n  executeEdits() { return false; }\n}\n',
      'src/use.ts':
        "import { Widget } from './widget';\n" +
        "export function edit(ed: Widget['inputEditor']) {\n" +
        '  return ed.executeEdits();\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('ed.'))).toEqual(['ed.executeEdits -> CodeEditor::executeEdits']);
  }, 60_000);

  it('links to that type rather than to a method of the type it indexes', async () => {
    // vscode's `visibility: ISessionChatPillVisibilityService['pullRequests']`,
    // then `visibility.isVisible(…)`, which reached the service's own `isVisible`.
    const calls = await callsOf({
      ...CLASSES,
      'src/service.ts':
        'export class Visibility {\n  isVisible() { return true; }\n}\n' +
        'export class VisibilityService {\n  readonly pullRequests: Visibility = new Visibility();\n  isVisible() { return false; }\n}\n',
      'src/use.ts':
        "import { VisibilityService } from './service';\n" +
        "export function shown(visibility: VisibilityService['pullRequests']) {\n" +
        '  return visibility.isVisible();\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('visibility.'))).toEqual(['visibility.isVisible -> Visibility::isVisible']);
  }, 60_000);

  it("links to nothing when the property's type lacks the method, not to a guess", async () => {
    // The property is declared as an intersection, whose head names no
    // `isVisible`: neither the indexed type's own method nor one found by
    // the receiver's name, like `VisibilityService.isVisible`, is the call's.
    const calls = await callsOf({
      ...CLASSES,
      'src/service.ts':
        'export interface Filter {\n  showAll(): boolean;\n}\n' +
        'export class VisibilityService {\n  readonly pullRequests!: Filter & { isVisible(): boolean };\n  isVisible() { return false; }\n}\n',
      'src/use.ts':
        "import { VisibilityService } from './service';\n" +
        "export function shown(visibility: VisibilityService['pullRequests']) {\n" +
        '  return visibility.isVisible();\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('visibility.'))).toEqual([]);
  }, 60_000);

  it("links an array property's own methods to nothing", async () => {
    // excalidraw's `groupIds: ExcalidrawElement["groupIds"]`, then `groupIds.filter(…)`.
    const calls = await callsOf({
      ...CLASSES,
      'src/element.ts': 'export class Element {\n  groupIds: string[] = [];\n  filter() { return this; }\n}\n',
      'src/use.ts':
        "import { Element } from './element';\n" +
        "export function without(groupIds: Element['groupIds'], id: string) {\n" +
        '  return groupIds.filter((g) => g !== id);\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('groupIds.'))).toEqual([]);
  }, 60_000);

  it("links to the class the property's file imports, when several share its name", async () => {
    // vscode's `disposables: ComponentFixtureContext['disposableStore']`
    // reached copilot's vendored `DisposableStore`, not the one the
    // fixture context's file imports.
    const editors = {
      'src/one/editor.ts': 'export class CodeEditor {\n  executeEdits() { return 1; }\n}\n',
      'src/two/editor.ts': 'export class CodeEditor {\n  executeEdits() { return 2; }\n}\n',
    };
    const calls = await callsOf({
      ...CLASSES,
      ...editors,
      'src/widget-one.ts': "import { CodeEditor } from './one/editor';\nexport interface WidgetOne {\n  readonly inputEditor: CodeEditor;\n}\n",
      'src/widget-two.ts': "import { CodeEditor } from './two/editor';\nexport interface WidgetTwo {\n  readonly inputEditor: CodeEditor;\n}\n",
      'src/use-one.ts':
        "import { WidgetOne } from './widget-one';\n" +
        "export function edit(ed: WidgetOne['inputEditor']) {\n  return ed.executeEdits();\n}\n",
      'src/use-two.ts':
        "import { WidgetTwo } from './widget-two';\n" +
        "export function edit(ed: WidgetTwo['inputEditor']) {\n  return ed.executeEdits();\n}\n",
    }, true);
    expect(calls.filter((c) => c.includes('ed.'))).toEqual([
      'src/use-one.ts: ed.executeEdits -> src/one/editor.ts::CodeEditor::executeEdits',
      'src/use-two.ts: ed.executeEdits -> src/two/editor.ts::CodeEditor::executeEdits',
    ]);
  }, 60_000);

  it('reads the property off the indexed type the call\'s file imports, and a class its file declares', async () => {
    // Two `Widget`s, each declaring its own `CodeEditor` beside it.
    const widget = (n: number) =>
      `export class CodeEditor {\n  executeEdits() { return ${n}; }\n}\n` +
      'export interface Widget {\n  readonly inputEditor: CodeEditor;\n}\n';
    const calls = await callsOf({
      ...CLASSES,
      'src/a/widget.ts': widget(1),
      'src/b/widget.ts': widget(2),
      'src/use-a.ts':
        "import { Widget } from './a/widget';\n" +
        "export function edit(ed: Widget['inputEditor']) {\n  return ed.executeEdits();\n}\n",
      'src/use-b.ts':
        "import type { Widget } from './b/widget';\n" +
        "export function edit(ed: Widget['inputEditor']) {\n  return ed.executeEdits();\n}\n",
    }, true);
    expect(calls.filter((c) => c.includes('ed.'))).toEqual([
      'src/use-a.ts: ed.executeEdits -> src/a/widget.ts::CodeEditor::executeEdits',
      'src/use-b.ts: ed.executeEdits -> src/b/widget.ts::CodeEditor::executeEdits',
    ]);
  }, 60_000);

  it("reads one whose property's type isn't written there, a getter's, as the type it indexes, as before", async () => {
    // vscode's `let mockPty: { onCommandExecuted: Emitter<E>['event'] }`
    // sits nearer `onCommandExecuted.fire(…)` than the local's own `let
    // onCommandExecuted: Emitter<E>`; `event` is a getter of `Emitter`, and
    // the `event: T` of its `fire(event: T)` names no type.
    const calls = await callsOf({
      ...CLASSES,
      'src/emitter.ts':
        'export class Emitter<T> {\n' +
        '  get event() { return (listener: (e: T) => void) => listener; }\n' +
        '  fire(event: T) { return event; }\n' +
        '}\n',
      'src/use.test.ts':
        "import { Emitter } from './emitter';\n" +
        'declare function suite(name: string, body: () => void): void;\n' +
        "suite('pty', () => {\n" +
        '  let onDone: Emitter<number>;\n' +
        '  let pty: {\n' +
        "    onDone: Emitter<number>['event'];\n" +
        '  };\n' +
        "  suite('fires', () => {\n" +
        '    onDone.fire(1);\n' +
        '  });\n' +
        '});\n',
    });
    expect(calls.filter((c) => c.startsWith('onDone.'))).toEqual(['onDone.fire -> Emitter::fire']);
  }, 60_000);

  it("reads a property typed by a type parameter of the indexed type as no type, whatever class shares the parameter's name", async () => {
    // `Item` is each type's own parameter here, not the project class `Item`:
    // a generic type alias, and a class whose parameter list holds braces.
    // `Stack` has a `flush` too, so the call's name alone picks neither.
    const calls = await callsOf({
      ...CLASSES,
      'src/stack.ts': 'export class Stack {\n  findLast() { return 1; }\n  flush() { return 2; }\n}\n',
      'src/state.ts':
        'export type State<Item = unknown> = { current: Item };\n' +
        'export class Shaped<Item extends { id: string } = any> { current!: Item; }\n',
      'src/use.ts':
        "import { State, Shaped } from './state';\n" +
        "export function viaAlias(x: State['current']) { return x.flush(); }\n" +
        "export function viaShaped(x: Shaped['current']) { return x.flush(); }\n",
    });
    expect(calls.filter((c) => c.startsWith('x.'))).toEqual([]);
  }, 60_000);

  it("is not matched to a method by the call's name when the property's type isn't written in the project", async () => {
    // vscode's `invocation: Parameters<typeof rawFinalizeToolInvocation>[0]`:
    // left untyped, the receiver's name alone would pick `Logger.info`.
    const calls = await callsOf({
      ...CLASSES,
      'src/logger.ts': 'export class Logger {\n  info(message: string) { return message; }\n}\n',
      'src/use.ts':
        "import { Logger } from './logger';\n" +
        'function make(logger: Logger) { return logger; }\n' +
        'export function log(logger: Parameters<typeof make>[0]) {\n' +
        "  return logger.info('x');\n" +
        '}\n',
    });
    expect(calls.filter((c) => c.startsWith('logger.'))).toEqual([]);
  }, 60_000);
});
