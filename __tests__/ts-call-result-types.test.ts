/**
 * A TS/JS local a call initializes, with no type written, has the type the
 * called function returns, as the TypeScript checker infers it: vscode's
 * `const editor = createCodeEditorWithBrackets(…)`, whose body is `return
 * disposables.add(instantiateTestCodeEditor(…))`, holds the
 * `ITestCodeEditor` that `instantiateTestCodeEditor` declares it returns,
 * passed through `DisposableStore.add<T>(o: T): T`, so `editor.getSelections()`
 * is `IActiveCodeEditor`'s, the nearest declaration up that type's chain, not
 * the base `IEditor`'s by the receiver's name. Read only where that is exact:
 * one project function (the file's import or a declaration in scope), with
 * its return type written, or its body's one `return` giving a call read the
 * same way, a `new` of a class, or a method returning its one argument.
 * Generic functions, several returns and other shapes are read as before, and
 * a sync re-reads the call when a file the type was read from changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

async function index(files: Record<string, string>): Promise<{ graph: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-call-results-'));
  roots.push(root);
  write(root, files);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { graph, root };
}

/** `<line> <refName> -> <Owner::method> <confidence>` for every `calls` edge out of `file` that lands on a method. */
function methodCalls(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      if (target.kind === 'method') out.push(`${e.line} ${e.metadata?.refName} -> ${target.qualifiedName} ${e.metadata?.confidence}`);
    }
  }
  return out.sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : 1));
}

const LIFECYCLE = 'export interface IDisposable {\n  dispose(): void;\n}\n' +
  'export class DisposableStore implements IDisposable {\n  public add<T extends IDisposable>(o: T): T {\n    return o;\n  }\n' +
  '  public addAll<T extends IDisposable>(o: T, other: T): T {\n    return o;\n  }\n  dispose(): void {}\n}\n';
const EDITORS = "import { IDisposable } from './lifecycle';\n" +
  'export class Selection { a = 1; }\n' +
  'export interface IEditor extends IDisposable {\n  getSelections(): Selection[] | null;\n  getPosition(): number | null;\n}\n' +
  'export interface ICodeEditor extends IEditor {\n  getModel(): string | null;\n}\n' +
  'export interface IActiveCodeEditor extends ICodeEditor {\n  getSelections(): Selection[];\n  getModel(): string;\n}\n' +
  'export interface ITestCodeEditor extends IActiveCodeEditor {\n  runAction(): void;\n}\n' +
  'export interface IDiffEditor extends IEditor {\n  getSelections(): Selection[];\n}\n' +
  'export function instantiateTestCodeEditor(model: string): ITestCodeEditor {\n  return null as any;\n}\n' +
  'export function makeGeneric<T>(value: T): T {\n  return value;\n}\n' +
  'export class Widget implements IActiveCodeEditor {\n  getSelections(): Selection[] { return []; }\n  getModel(): string { return \'\'; }\n  getPosition(): number | null { return null; }\n  dispose(): void {}\n}\n' +
  'export function buildWidget() {\n  return new Widget();\n}\n' +
  'export function twoReturns(flag: boolean) {\n  if (flag) {\n    return new Widget();\n  }\n  return instantiateTestCodeEditor(\'\');\n}\n';

describe('a local a call initializes takes the type the called function returns', () => {
  it("links the nearest declaration up a helper's returned type, through a pass-through and an imported function (vscode-be base declaration)", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lifecycle.ts': LIFECYCLE,
      'src/editors.ts': EDITORS,
      'src/use.test.ts':
        "import { DisposableStore } from './lifecycle';\nimport { instantiateTestCodeEditor, ITestCodeEditor } from './editors';\n" +
        "suite('x', () => {\n  let disposables: DisposableStore;\n" +
        '  function createCodeEditorWithBrackets(text: string) {\n    return disposables.add(instantiateTestCodeEditor(text));\n  }\n' +
        '  function createMockEditor(text: string): ITestCodeEditor {\n    return instantiateTestCodeEditor(text);\n  }\n' +
        "  test('y', () => {\n    const editor = createCodeEditorWithBrackets('x');\n    editor.getSelections();\n" +
        "    const other = createMockEditor('x');\n    other.getModel();\n" +
        "    const passed = disposables.add(instantiateTestCodeEditor('x'));\n    passed.getSelections();\n" +
        "    const direct = instantiateTestCodeEditor('x');\n    direct.getPosition();\n  });\n});\n",
    });
    expect(methodCalls(graph, 'src/use.test.ts').filter((c) => !c.includes('DisposableStore::add'))).toEqual([
      '13 editor.getSelections -> IActiveCodeEditor::getSelections 0.9',
      '15 other.getModel -> IActiveCodeEditor::getModel 0.9',
      '17 passed.getSelections -> IActiveCodeEditor::getSelections 0.9',
      // Up the chain past the interfaces that don't redeclare it.
      '19 direct.getPosition -> IEditor::getPosition 0.9',
    ]);
  }, 60_000);

  it("calls an instance's inherited method, never the class's static method of the name", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/edit.ts':
        'export abstract class BaseEdit {\n  compose(other: BaseEdit): BaseEdit {\n    return other;\n  }\n}\n' +
        'export class StringEdit extends BaseEdit {\n  static compose(edits: StringEdit[]): StringEdit {\n    return edits[0]!;\n  }\n}\n' +
        'export function randomEdit(): StringEdit {\n  return new StringEdit();\n}\n',
      'src/use.ts': "import { randomEdit } from './edit';\nexport function run() {\n  const e1 = randomEdit();\n  const e2 = randomEdit();\n  e1.compose(e2);\n}\n",
    });
    expect(methodCalls(graph, 'src/use.ts')).toEqual(['5 e1.compose -> BaseEdit::compose 0.9']);
  }, 60_000);

  it('reads a function that returns what it builds', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lifecycle.ts': LIFECYCLE,
      'src/editors.ts': EDITORS,
      'src/use.ts': "import { buildWidget } from './editors';\nexport function run() {\n  const built = buildWidget();\n  built.getSelections();\n}\n",
    });
    expect(methodCalls(graph, 'src/use.ts')).toEqual(['4 built.getSelections -> Widget::getSelections 0.9']);
  }, 60_000);

  it('reads nothing new for a generic function, several returns or a member of the result', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lifecycle.ts': LIFECYCLE,
      'src/editors.ts': EDITORS,
      'src/use.ts':
        "import { instantiateTestCodeEditor, makeGeneric, twoReturns } from './editors';\n" +
        'export function run() {\n' +
        "  const generic = makeGeneric(instantiateTestCodeEditor('x'));\n  generic.getSelections();\n" +
        '  const either = twoReturns(true);\n  either.getSelections();\n' +
        '}\n',
    });
    // Neither is typed: what main guesses by the method's name, never IActiveCodeEditor's at 0.9.
    for (const call of methodCalls(graph, 'src/use.ts')) expect(call).not.toMatch(/ 0\.9$/);
  }, 60_000);

  it('reads nothing new for a union of two types, returned or given to a callback, and reads one type beside null or undefined', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/types.ts':
        'export class Foo {\n  m(): number {\n    return 1;\n  }\n}\n' +
        'export class Bar {\n  m(): number {\n    return 2;\n  }\n}\n' +
        'export function pick(n: number): Foo | Bar {\n  return n ? new Foo() : new Bar();\n}\n' +
        'export function maybe(n: number): Foo | undefined {\n  return n ? new Foo() : undefined;\n}\n' +
        'export function each(cb: (item: Foo | Bar) => void): void {\n  cb(new Foo());\n}\n' +
        'export function some(cb: (item: Foo | null) => void): void {\n  cb(null);\n}\n',
      'src/use.ts':
        "import { pick, maybe, each, some } from './types';\n" +
        'export function run() {\n' +
        '  const either = pick(1);\n  either.m();\n' +
        '  const one = maybe(1);\n  one?.m();\n' +
        '  each((item) => item.m());\n' +
        '  some((item) => item?.m());\n' +
        '}\n',
    });
    // `Foo | Bar` is no one type (the checker answers both `m`s): what main makes of the name, never Foo's at 0.9.
    expect(methodCalls(graph, 'src/use.ts').filter((c) => / 0\.9$/.test(c))).toEqual([
      '6 one.m -> Foo::m 0.9',
      '8 item.m -> Foo::m 0.9',
    ]);
  }, 60_000);

  it("reads nothing new for an imported overloaded function, whose implementation's signature no caller sees (vscode's `timeout`)", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lib.ts':
        'export class Base {\n  m(): number {\n    return 1;\n  }\n}\n' +
        'export class Special extends Base {\n  m(): number {\n    return 2;\n  }\n}\n' +
        "export function make(kind: 'special'): Special;\n" +
        'export function make(kind: string): Base;\n' +
        "export function make(kind: string): Base {\n  return kind === 'special' ? new Special() : new Base();\n}\n",
      'src/use.ts': "import { make } from './lib';\nexport function run() {\n  const made = make('special');\n  made.m();\n}\n",
    });
    // The checker takes the first overload (`Special::m`); the implementation says `Base`: neither is read, so no 0.9 link.
    for (const call of methodCalls(graph, 'src/use.ts')) expect(call).not.toMatch(/ 0\.9$/);
  }, 60_000);

  it("leaves a call to main when the type read declares the name as a function-typed property, never another file's namesake type (outline's `LazyComponent`)", async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/other.ts': 'export interface Thing {\n  preload(): void;\n}\n',
      'src/load.ts':
        'export interface Thing {\n  preload: () => Promise<void>;\n}\n' +
        'export function makeThing(): Thing {\n  return { preload: async () => undefined };\n}\n',
      'src/use.ts': "import { makeThing } from './load';\nexport function run() {\n  const thing = makeThing();\n  thing.preload();\n}\n",
    };
    const { graph } = await index(files);
    // What main makes of the call by its name, never `other.ts`'s `Thing::preload` at 0.9 as if the type said so.
    const calls = methodCalls(graph, 'src/use.ts').filter((c) => c.includes('preload'));
    for (const call of calls) expect(call).not.toMatch(/ 0\.9$/);
    // A type alias the called function's file names keeps its own member (outline's `Action`).
    const aliased = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/types.ts': 'export type BaseAction = { name: string };\nexport type Action = BaseAction & {\n  perform: (n: number) => unknown;\n};\n',
      'src/actions.ts':
        "import { Action } from './types';\n" +
        'export function createAction(name: string): Action {\n  return { name, perform: () => undefined };\n}\n',
      'src/use.ts': "import { createAction } from './actions';\nexport function run() {\n  const pin = createAction('pin');\n  pin.perform(1);\n}\n",
    });
    expect(methodCalls(aliased.graph, 'src/use.ts').filter((c) => c.includes('perform'))).toEqual(['4 pin.perform -> Action::perform 0.9']);
  }, 60_000);

  it("reads nothing new for a utility type, like `Pick<DisposableStore, 'add'>`, whose members no lookup by `Pick` finds", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lifecycle.ts': LIFECYCLE + "export function leakCheck(): Pick<DisposableStore, 'add'> {\n  return new DisposableStore();\n}\n",
      // vscode's `const store = ensureNoDisposablesAreLeakedInTestSuite()`: the link main makes stays.
      'src/use.test.ts':
        "import { DisposableStore, leakCheck } from './lifecycle';\n" +
        'export function other(store: DisposableStore) {\n  return store;\n}\n' +
        "suite('x', () => {\n  const store = leakCheck();\n  test('y', () => {\n    store.add(null as any);\n  });\n});\n",
    });
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual(['8 store.add -> DisposableStore::add 0.9']);
  }, 60_000);

  it("a sync re-reads the call when the called function's file changes what it returns", async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lifecycle.ts': LIFECYCLE,
      'src/editors.ts': EDITORS,
      'src/use.ts': "import { instantiateTestCodeEditor } from './editors';\nexport function run() {\n  const editor = instantiateTestCodeEditor('x');\n  editor.getSelections();\n}\n",
    };
    const { graph, root } = await index(files);
    expect(methodCalls(graph, 'src/use.ts')).toEqual(['4 editor.getSelections -> IActiveCodeEditor::getSelections 0.9']);
    const edited = EDITORS.replace('export function instantiateTestCodeEditor(model: string): ITestCodeEditor {', 'export function instantiateTestCodeEditor(model: string): IDiffEditor {');
    write(root, { 'src/editors.ts': edited });
    await graph.sync();
    const synced = methodCalls(graph, 'src/use.ts');
    expect(synced).toEqual(['4 editor.getSelections -> IDiffEditor::getSelections 0.9']);
    const fresh = await index({ ...files, 'src/editors.ts': edited });
    expect(methodCalls(fresh.graph, 'src/use.ts')).toEqual(synced);
  }, 90_000);
});
