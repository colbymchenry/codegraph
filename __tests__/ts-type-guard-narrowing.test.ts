/**
 * A TS/JS receiver a user-defined type guard narrows has the narrowed type
 * where the checker narrows it: vscode's `run(editor: ICodeEditor)` opens
 * with `if (!editor.hasModel()) { return; }`, and `hasModel(): this is
 * IActiveCodeEditor` makes every `editor.getSelections()` after it in that
 * block `IActiveCodeEditor`'s, the nearest declaration up the narrowed type,
 * not the base `IEditor`'s that `ICodeEditor` inherits. So inside `if
 * (editor.hasModel()) { … }`, and for a guard function, `if
 * (isCodeEditor(x))`. Read only for those shapes: the guard's call the whole
 * condition, an early `return` or `throw` in the block holding the call or
 * the call inside the guarded block, no assignment to the receiver and no
 * function boundary between, the guarded type narrower than the declared
 * one. Anything else keeps the receiver's declared type.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-guards-'));
  roots.push(root);
  write(root, files);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { graph, root };
}

/** `<line> <refName> -> <Owner::method>` for every `calls` edge out of `file` that lands on a method other than the guard. */
function methodCalls(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      if (target.kind === 'method' && target.name !== 'hasModel') out.push(`${e.line} ${e.metadata?.refName} -> ${target.qualifiedName}`);
    }
  }
  return out.sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : 1));
}

const EDITORS =
  'export class Selection { a = 1; }\n' +
  'export interface IEditor {\n  getSelections(): Selection[] | null;\n  getModel(): unknown;\n  hasModel(): boolean;\n}\n' +
  'export interface ICodeEditor extends IEditor {\n  getModel(): string | null;\n  hasModel(): this is IActiveCodeEditor;\n}\n' +
  'export interface IActiveCodeEditor extends ICodeEditor {\n  getSelections(): Selection[];\n  getModel(): string;\n}\n' +
  'export interface IDiffEditor extends IEditor {\n  getSelections(): Selection[];\n}\n' +
  'export function isCodeEditor(thing: unknown): thing is ICodeEditor {\n  return !!thing;\n}\n' +
  'export function isSame<T>(thing: T): thing is T {\n  return !!thing;\n}\n';

describe('a type guard narrows the receiver where the checker does', () => {
  it("links the narrowed type's own declaration after an early return, and inside a guarded block (vscode-be base declaration)", async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/editors.ts': EDITORS,
      'src/use.ts':
        "import { ICodeEditor, IEditor, isCodeEditor } from './editors';\n" +
        'export class Actions {\n' +
        '  earlyReturn(editor: ICodeEditor): void {\n    if (!editor.hasModel()) {\n      return;\n    }\n' +
        '    const s = editor.getSelections();\n    if (s.length) {\n      editor.getModel();\n    }\n  }\n' +
        "  earlyThrow(editor: ICodeEditor): void {\n    if (!editor.hasModel()) throw new Error('no model');\n    editor.getSelections();\n  }\n" +
        '  guardedBlock(editor: ICodeEditor): void {\n    if (editor.hasModel()) {\n      editor.getSelections();\n    }\n    editor.getSelections();\n  }\n' +
        '  guardFunction(thing: IEditor): void {\n    if (isCodeEditor(thing)) {\n      thing.getModel();\n    }\n  }\n' +
        '}\n',
    });
    expect(methodCalls(graph, 'src/use.ts')).toEqual([
      '7 editor.getSelections -> IActiveCodeEditor::getSelections',
      '9 editor.getModel -> IActiveCodeEditor::getModel',
      '14 editor.getSelections -> IActiveCodeEditor::getSelections',
      '18 editor.getSelections -> IActiveCodeEditor::getSelections',
      // After the guarded block, the declared type again.
      '20 editor.getSelections -> IEditor::getSelections',
      '24 thing.getModel -> ICodeEditor::getModel',
    ]);
  }, 60_000);

  it('keeps the declared type for an assignment, a callback, a compound condition, a generic guard and a guard in a closed block', async () => {
    const { graph } = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/editors.ts': EDITORS,
      'src/use.ts':
        "import { ICodeEditor, isSame } from './editors';\n" +
        'export class Actions {\n' +
        '  reassigned(editor: ICodeEditor, other: ICodeEditor): void {\n    if (!editor.hasModel()) {\n      return;\n    }\n    editor = other;\n    editor.getSelections();\n  }\n' +
        '  insideCallback(editor: ICodeEditor): void {\n    if (!editor.hasModel()) {\n      return;\n    }\n    setTimeout(() => editor.getSelections(), 1);\n  }\n' +
        '  combined(editor: ICodeEditor, flag: boolean): void {\n    if (!editor.hasModel() || flag) {\n      return;\n    }\n    editor.getSelections();\n  }\n' +
        '  generic(editor: ICodeEditor): void {\n    if (isSame(editor)) {\n      editor.getSelections();\n    }\n  }\n' +
        '  closedBlock(editor: ICodeEditor, flag: boolean): void {\n    if (flag) {\n      if (!editor.hasModel()) {\n        return;\n      }\n    }\n    editor.getSelections();\n  }\n' +
        '  objectMethod(editor: ICodeEditor): unknown {\n    if (!editor.hasModel()) {\n      return null;\n    }\n    return { run() { return editor.getSelections(); } };\n  }\n' +
        '}\n',
    });
    const calls = methodCalls(graph, 'src/use.ts');
    expect(calls.length).toBe(6);
    for (const call of calls) expect(call).toMatch(/-> IEditor::getSelections$/);
  }, 60_000);

  it('reads a predicate that names a generic type by its name, for a typed local and a typed parameter (react compiler Result)', async () => {
    const results = [
      'export interface Result<T, E> {',
      '  isOk(): this is OkImpl<T>;',
      '  isErr(): this is ErrImpl<E>;',
      '  unwrap(): T;',
      '  unwrapErr(): E;',
      '}',
      'export class OkImpl<T> implements Result<T, never> {',
      '  constructor(private val: T) {}',
      '  isOk(): this is OkImpl<T> {\n    return true;\n  }',
      '  isErr(): this is ErrImpl<never> {\n    return false;\n  }',
      '  unwrap(): T {\n    return this.val;\n  }',
      "  unwrapErr(): never {\n    throw new Error('ok');\n  }",
      '}',
      'export class ErrImpl<E> implements Result<never, E> {',
      '  constructor(private val: E) {}',
      '  isOk(): this is OkImpl<never> {\n    return false;\n  }',
      '  isErr(): this is ErrImpl<E> {\n    return true;\n  }',
      "  unwrap(): never {\n    throw new Error('err');\n  }",
      '  unwrapErr(): E {\n    return this.val;\n  }',
      '}',
      '',
    ].join('\n');
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/result.ts': results,
      'src/use.ts': [
        "import { Result, OkImpl } from './result';",
        'function find(x: number): Result<string, Error> {',
        '  return new OkImpl(String(x));',
        '}',
        'export function inside(): string {',
        '  const r = find(1);',
        '  if (r.isOk()) {',
        '    return r.unwrap();',
        '  }',
        '  throw r.unwrapErr();',
        '}',
        'export function exits(r: Result<string, Error>): string {',
        '  if (!r.isOk()) {',
        "    throw new Error('no');",
        '  }',
        '  return r.unwrap();',
        '}',
        'export function errBlock(): void {',
        '  const r = find(2);',
        '  if (r.isErr()) {',
        '    r.unwrapErr();',
        '    return;',
        '  }',
        '  r.unwrap();',
        '}',
        '',
      ].join('\n'),
    };
    const unwraps = (graph: CodeGraph) => methodCalls(graph, 'src/use.ts').filter((c) => / r\.unwrap/.test(c));
    const { graph, root } = await index(files);
    expect(unwraps(graph)).toEqual([
      '8 r.unwrap -> OkImpl::unwrap',
      // After a guarded block, and after a guard that isn't negated, the type read (the checker narrows no interface there).
      '10 r.unwrapErr -> Result::unwrapErr',
      '16 r.unwrap -> OkImpl::unwrap',
      '21 r.unwrapErr -> ErrImpl::unwrapErr',
      '24 r.unwrap -> Result::unwrap',
    ]);
    // The guard stops narrowing: the interface's own declarations, the same synced as fresh.
    const edited = results.replace('  isOk(): this is OkImpl<T>;', '  isOk(): boolean;');
    write(root, { 'src/result.ts': edited });
    await graph.sync();
    const synced = unwraps(graph);
    expect(synced).toEqual([
      '8 r.unwrap -> Result::unwrap',
      '10 r.unwrapErr -> Result::unwrapErr',
      '16 r.unwrap -> Result::unwrap',
      '21 r.unwrapErr -> ErrImpl::unwrapErr',
      '24 r.unwrap -> Result::unwrap',
    ]);
    const fresh = await index({ ...files, 'src/result.ts': edited });
    expect(unwraps(fresh.graph)).toEqual(synced);
  }, 120_000);

  it("a sync re-reads the call when the guard's file changes what it narrows to", async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/editors.ts': EDITORS,
      'src/use.ts':
        "import { ICodeEditor } from './editors';\n" +
        'export function run(editor: ICodeEditor): void {\n  if (!editor.hasModel()) {\n    return;\n  }\n  editor.getSelections();\n}\n',
    };
    const { graph, root } = await index(files);
    expect(methodCalls(graph, 'src/use.ts')).toEqual(['6 editor.getSelections -> IActiveCodeEditor::getSelections']);
    // The guard now narrows to nothing narrower: the declared type's inherited method.
    const edited = EDITORS.replace('hasModel(): this is IActiveCodeEditor;', 'hasModel(): boolean;');
    write(root, { 'src/editors.ts': edited });
    await graph.sync();
    const synced = methodCalls(graph, 'src/use.ts');
    expect(synced).toEqual(['6 editor.getSelections -> IEditor::getSelections']);
    const fresh = await index({ ...files, 'src/editors.ts': edited });
    expect(methodCalls(fresh.graph, 'src/use.ts')).toEqual(synced);
  }, 90_000);
});
