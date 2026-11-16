/**
 * A TS/JS callback's parameter with no type written has the type its callee's
 * signature gives it, as the TypeScript checker reads it: vscode's
 * `withTestCodeEditor(text, (editor, viewModel) => …)`, whose callee declares
 * `callback: (editor: ITestCodeEditor, viewModel: ViewModel) => void`, makes
 * `editor.getSelections()` the method `ITestCodeEditor` gets from
 * `IActiveCodeEditor`, the nearest declaration up its chain, not the base
 * `IEditor`'s by the receiver's name. Read only where that is exact: an arrow
 * or function expression passed straight to one project function (the file's
 * import of it or its declaration in scope), whose signature writes that
 * parameter as a function type with a type at the callback parameter's
 * position. Generics, overloads, rest parameters, member callees and other
 * shapes are read as before, and a sync re-reads the call when the callee's
 * file changes the type it gives.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-callback-params-'));
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

const COMMON = 'export class Selection { a = 1; }\nexport interface IEditor {\n  getSelections(): Selection[] | null;\n  getModel(): unknown;\n  focus(): void;\n}\n' +
  'export interface IOther {\n  getOther(): void;\n}\n';
const BROWSER = "import { IEditor, IOther, Selection } from './common';\n" +
  'export interface ICodeEditor extends IEditor {\n  getModel(): string | null;\n}\n' +
  'export interface IActiveCodeEditor extends ICodeEditor, IOther {\n  getSelections(): Selection[];\n  getModel(): string;\n}\n' +
  'export interface IDiffEditor extends IEditor {\n  getSelections(): Selection[];\n  focus(): void;\n}\n';
const HELPERS = "import { IActiveCodeEditor, ICodeEditor } from './browser';\n" +
  'export interface ITestCodeEditor extends IActiveCodeEditor {\n  runAction(): void;\n}\n' +
  'export function withTestCodeEditor(text: string | string[], options: object, callback: (editor: ITestCodeEditor, viewModel: unknown) => void): void {\n  callback(null as any, null);\n}\n' +
  'export async function withAsyncTestCodeEditor(text: string, options: object, callback: (editor: ITestCodeEditor, model: unknown, inst: unknown) => Promise<void>): Promise<void> {\n  await callback(null as any, null, null);\n}\n' +
  'export function withCodeEditor(callback?: ((editor: ICodeEditor) => void) | undefined): void {\n  callback?.(null as any);\n}\n' +
  'export function withThis(this: unknown, callback: (editor: IActiveCodeEditor) => void): void {\n  callback(null as any);\n}\n' +
  'export function withGeneric<T>(value: T, callback: (editor: T) => void): void {\n  callback(value);\n}\n' +
  'export function withRest(...callbacks: ((editor: ITestCodeEditor) => void)[]): void {\n  callbacks.forEach((c) => c(null as any));\n}\n' +
  'export function withOverload(callback: (editor: ITestCodeEditor) => void): void;\n' +
  'export function withOverload(callback: (editor: ICodeEditor) => void): void;\n' +
  'export function withOverload(callback: (editor: any) => void): void {\n  callback(null);\n}\n' +
  'export function withEvent(callback: (event: MouseEvent) => void): void {\n  callback(null as any);\n}\n' +
  'export const holder = {\n  withTestCodeEditor(callback: (editor: ITestCodeEditor) => void): void {\n    callback(null as any);\n  },\n};\n';

describe("a callback's untyped parameter takes its callee's declared type", () => {
  it("links the nearest declaration up the callee's type, not the base interface's (vscode-be base declaration)", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/use.test.ts':
        "import { withTestCodeEditor } from './helpers';\n" +
        "suite('x', () => {\n  test('y', () => {\n    withTestCodeEditor('', {}, (editor, viewModel) => {\n      const s = editor.getSelections();\n    });\n  });\n});\n",
    });
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual(['5 editor.getSelections -> IActiveCodeEditor::getSelections 0.9']);
  }, 60_000);

  it('reads multi-line arguments, async and lone arrows, function expressions, optional callbacks and a this parameter', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/use.test.ts':
        "import { withTestCodeEditor, withAsyncTestCodeEditor, withCodeEditor, withThis } from './helpers';\n" +
        "test('shapes', async () => {\n" +
        "  withTestCodeEditor([\n    'line one, (with) [brackets]',\n    'line two',\n  ], { a: 1, b: [2, 3] }, (editor) => {\n    editor.getModel();\n  });\n" +
        "  await withAsyncTestCodeEditor('', {}, async (editor, _, inst) => {\n    editor.focus();\n  });\n" +
        "  withTestCodeEditor('', {}, editor => editor.getSelections());\n" +
        "  withTestCodeEditor('', {}, function (editor) {\n    editor.getOther();\n  });\n" +
        '  withCodeEditor((editor) => {\n    editor.getModel();\n  });\n' +
        '  withThis((editor) => {\n    [1, 2].forEach(() => editor.getSelections());\n  });\n' +
        '});\n',
    });
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual([
      '7 editor.getModel -> IActiveCodeEditor::getModel 0.9',
      // Up ITestCodeEditor's chain past IActiveCodeEditor and ICodeEditor, never the unrelated IDiffEditor's.
      '10 editor.focus -> IEditor::focus 0.9',
      '12 editor.getSelections -> IActiveCodeEditor::getSelections 0.9',
      // The second interface IActiveCodeEditor extends.
      '14 editor.getOther -> IOther::getOther 0.9',
      '17 editor.getModel -> ICodeEditor::getModel 0.9',
      '20 editor.getSelections -> IActiveCodeEditor::getSelections 0.9',
    ]);
  }, 60_000);

  it('reads a helper the file declares, and lets the callback parameter hide another function\'s typed one', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/use.test.ts':
        "import { IActiveCodeEditor, ICodeEditor } from './browser';\n" +
        'function outer(editor: ICodeEditor) {\n  return editor.getModel();\n}\n' +
        // (The helper names its own parameter otherwise: an unscoped scan for `editor:` must not find the answer.)
        "suite('x', () => {\n  function findTest(name: string, callback: (active: IActiveCodeEditor) => void): void {\n    callback(null as any);\n  }\n" +
        "  test('y', () => {\n    findTest('x', (editor) => {\n      editor.getSelections();\n    });\n  });\n});\n",
    });
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual([
      '3 editor.getModel -> ICodeEditor::getModel 0.9',
      '11 editor.getSelections -> IActiveCodeEditor::getSelections 0.9',
    ]);
  }, 60_000);

  it('reads each block its own helper of a name, and nothing for overloads in one block', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/use.test.ts':
        "import { IActiveCodeEditor, IDiffEditor } from './browser';\n" +
        "suite('a', () => {\n  function run(cb: (active: IActiveCodeEditor) => void): void {}\n" +
        '  run((editor) => editor.getSelections());\n});\n' +
        "suite('b', () => {\n  function run(cb: (diff: IDiffEditor) => void): void {}\n" +
        '  run((editor) => editor.getSelections());\n});\n' +
        "suite('c', () => {\n  function run(cb: (diff: IDiffEditor) => void): void;\n  function run(cb: (active: IActiveCodeEditor) => void): void;\n" +
        '  function run(cb: (x: any) => void): void {}\n  run((editor) => editor.getSelections());\n});\n',
    });
    const calls = methodCalls(graph, 'src/use.test.ts');
    expect(calls.slice(0, 2)).toEqual([
      '4 editor.getSelections -> IActiveCodeEditor::getSelections 0.9',
      '8 editor.getSelections -> IDiffEditor::getSelections 0.9',
    ]);
    // The overloaded helper's call is no typed one: what main guesses.
    expect(calls.slice(2).length).toBeGreaterThan(0);
    expect(calls.slice(2).filter((c) => !c.startsWith('14 ') || c.endsWith(' 0.9'))).toEqual([]);
  }, 60_000);

  it('reads nothing new for generics, rest parameters, overloads, member callees, written types, defaults and type arguments', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/use.test.ts':
        "import { ICodeEditor } from './browser';\n" +
        "import { withTestCodeEditor, withGeneric, withRest, withOverload, holder, ITestCodeEditor } from './helpers';\n" +
        "test('abstains', () => {\n" +
        '  withGeneric(null as any as ITestCodeEditor, (editor) => editor.getSelections());\n' +
        '  withRest((editor) => editor.getSelections());\n' +
        '  withOverload((editor) => editor.getSelections());\n' +
        '  holder.withTestCodeEditor((editor) => editor.getSelections());\n' +
        "  withTestCodeEditor('', {}, (editor = null as any) => editor.getSelections());\n" +
        '  withGeneric<ITestCodeEditor>(null as any, (editor) => editor.getSelections());\n' +
        "  withTestCodeEditor('', {}, (editor: ICodeEditor) => editor.getSelections());\n" +
        '});\n',
    });
    const calls = methodCalls(graph, 'src/use.test.ts');
    // None is read from the callee: each is the guess or the written type main makes.
    expect(calls.filter((c) => c.includes('IActiveCodeEditor'))).toEqual([]);
    expect(calls).toContain('10 editor.getSelections -> IEditor::getSelections 0.9');
    for (const call of calls.filter((c) => !c.startsWith('10 '))) expect(call).toMatch(/ 0\.65$/);
  }, 60_000);

  it("links no project method when the callee's type for the parameter is from outside the project", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/thing.ts': 'export class Thing {\n  preventDefault(): void {}\n}\n',
      'src/use.ts': "import { withEvent } from './helpers';\nexport function run() {\n  withEvent((event) => {\n    event.preventDefault();\n  });\n}\n",
    });
    expect(methodCalls(graph, 'src/use.ts')).toEqual([]);
  }, 60_000);

  it("a sync links the call once the callee's file gives the parameter a project type in place of the platform's", async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/thing.ts': 'export class Thing {\n  preventDefault(): void {}\n}\n',
      'src/use.ts': "import { withEvent } from './helpers';\nexport function run() {\n  withEvent((event) => {\n    event.preventDefault();\n  });\n}\n",
    };
    const { graph, root } = await index(files);
    expect(methodCalls(graph, 'src/use.ts')).toEqual([]);
    const edited = HELPERS.replace('callback: (event: MouseEvent) => void', 'callback: (event: Thing) => void')
      .replace("import { IActiveCodeEditor, ICodeEditor } from './browser';", "import { IActiveCodeEditor, ICodeEditor } from './browser';\nimport { Thing } from './thing';");
    write(root, { 'src/helpers.ts': edited });
    await graph.sync();
    const synced = methodCalls(graph, 'src/use.ts');
    expect(synced).toEqual(['4 event.preventDefault -> Thing::preventDefault 0.9']);
    const fresh = await index({ ...files, 'src/helpers.ts': edited });
    expect(methodCalls(fresh.graph, 'src/use.ts')).toEqual(synced);
  }, 90_000);

  it('a sync re-reads a guess the read type left to the guessing, there and back', async () => {
    const use = "import { withTestCodeEditor } from './helpers';\ntest('y', () => {\n  withTestCodeEditor('', {}, (editor) => {\n    editor.getOther();\n  });\n});\n";
    const files = { 'package.json': JSON.stringify({ name: 'app' }), 'src/common.ts': COMMON, 'src/browser.ts': BROWSER, 'src/helpers.ts': HELPERS, 'src/use.test.ts': use };
    const { graph, root } = await index(files);
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual(['4 editor.getOther -> IOther::getOther 0.9']);
    // ICodeEditor has no getOther: what the guessing finds stands in, read through the callee's file.
    const edited = HELPERS.replace('callback: (editor: ITestCodeEditor, viewModel: unknown) => void', 'callback: (editor: ICodeEditor, viewModel: unknown) => void');
    for (const helpers of [edited, HELPERS]) {
      write(root, { 'src/helpers.ts': helpers });
      await graph.sync();
      const fresh = await index({ ...files, 'src/helpers.ts': helpers });
      expect(methodCalls(graph, 'src/use.test.ts')).toEqual(methodCalls(fresh.graph, 'src/use.test.ts'));
    }
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual(['4 editor.getOther -> IOther::getOther 0.9']);
  }, 120_000);

  it("a sync re-reads the call when the callee's file changes the type it gives the parameter", async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common.ts': COMMON,
      'src/browser.ts': BROWSER,
      'src/helpers.ts': HELPERS,
      'src/use.test.ts':
        "import { withTestCodeEditor } from './helpers';\n" +
        "test('y', () => {\n  withTestCodeEditor('', {}, (editor) => {\n    editor.getSelections();\n  });\n});\n",
    };
    const { graph, root } = await index(files);
    expect(methodCalls(graph, 'src/use.test.ts')).toEqual(['4 editor.getSelections -> IActiveCodeEditor::getSelections 0.9']);
    const edited = HELPERS.replace('callback: (editor: ITestCodeEditor, viewModel: unknown) => void', 'callback: (editor: IDiffEditor, viewModel: unknown) => void')
      .replace("import { IActiveCodeEditor, ICodeEditor } from './browser';", "import { IActiveCodeEditor, ICodeEditor, IDiffEditor } from './browser';");
    write(root, { 'src/helpers.ts': edited });
    await graph.sync();
    const synced = methodCalls(graph, 'src/use.test.ts');
    expect(synced).toEqual(['4 editor.getSelections -> IDiffEditor::getSelections 0.9']);
    const fresh = await index({ ...files, 'src/helpers.ts': edited });
    expect(methodCalls(fresh.graph, 'src/use.test.ts')).toEqual(synced);
  }, 90_000);
});
