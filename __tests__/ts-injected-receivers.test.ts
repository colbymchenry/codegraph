/**
 * A TypeScript field or local set from a dependency-injection call that
 * hands back an instance of the class it is given has that class's type:
 * Angular's `private readonly dataService = inject(DataService)`, and
 * vscode's `this._register(this.instantiationService.createInstance(Widget,
 * …))` or `const widget = this.instantiationService.createInstance(Widget)`.
 *
 * Neither was read, so calls through them linked nowhere, or by name alone:
 * on bitwarden and ghostfolio thousands of `this.<service>.<method>()` calls
 * sat on `inject(X)` fields. Only Angular's `inject` counts (Vue's
 * `inject(key)` returns whatever was provided under the key), and only a
 * `createInstance` the project declares to return an `InstanceType` of its
 * argument.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-injected-'));
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

/** The service the app injects, and a decoy of the same name nearer the component. */
const SERVICES = {
  'src/app/data.service.ts': 'export class DataService {\n  fetchInfo() {\n    return 1;\n  }\n}\n',
  'src/app/components/legacy/data.service.ts': 'export class DataService {\n  fetchInfo() {\n    return 2;\n  }\n}\n',
};

/** vscode's lifecycle and instantiation service, and widgets: the imported one and a nearer decoy. */
const WORKBENCH = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/base/lifecycle.ts':
    'export interface IDisposable {\n  dispose(): void;\n}\n' +
    'export abstract class Disposable implements IDisposable {\n' +
    '  protected _register<T extends IDisposable>(o: T): T {\n    return o;\n  }\n' +
    '  dispose() {}\n' +
    '}\n',
  'src/platform/instantiation.ts':
    'export interface IInstantiationService {\n' +
    '  createInstance<Ctor extends new (...args: any[]) => unknown, R extends InstanceType<Ctor>>(ctor: Ctor, ...args: unknown[]): R;\n' +
    '}\n',
  'src/browser/widget.ts': 'export class Widget {\n  layout() {}\n  dispose() {}\n}\n',
  'src/browser/parts/legacy/widget.ts': 'export class Widget {\n  layout() {}\n  dispose() {}\n}\n',
};

describe('a TypeScript receiver a dependency-injection call sets up', () => {
  it("has the class Angular's inject(X) is given", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^18.0.0' } }),
      ...SERVICES,
      'src/app/components/app.component.ts':
        "import { inject } from '@angular/core';\nimport { DataService } from '../data.service';\n" +
        'export class AppComponent {\n' +
        '  private readonly dataService = inject(DataService);\n' +
        '  private readonly maybe = inject(DataService, { optional: true });\n' +
        '  ngOnInit() {\n    this.dataService.fetchInfo();\n    this.maybe.fetchInfo();\n  }\n' +
        '}\n' +
        'export function load() {\n  const service = inject(DataService);\n  return service.fetchInfo();\n}\n',
    });
    expect(calls.filter((c) => c.includes('fetchInfo'))).toEqual([
      'src/app/components/app.component.ts: service.fetchInfo -> src/app/data.service.ts::DataService::fetchInfo',
      'src/app/components/app.component.ts: this.dataService.fetchInfo -> src/app/data.service.ts::DataService::fetchInfo',
      'src/app/components/app.component.ts: this.maybe.fetchInfo -> src/app/data.service.ts::DataService::fetchInfo',
    ]);
  }, 60_000);

  it("has the type inject's type argument names, for a token that isn't a class", async () => {
    // bitwarden's `protected params = inject<AdvancedUriOptionDialogParams>(DIALOG_DATA)`.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^18.0.0', '@angular/cdk': '^18.0.0' } }),
      'src/app/params.ts': 'export interface DialogParams {\n  onContinue(): void;\n}\n',
      'src/app/legacy/params.ts': 'export interface DialogParams {\n  onContinue(): void;\n}\n',
      'src/app/dialog.component.ts':
        "import { inject } from '@angular/core';\nimport { DIALOG_DATA } from '@angular/cdk/dialog';\nimport { DialogParams } from './params';\n" +
        'export class DialogComponent {\n' +
        '  protected params = inject<DialogParams>(DIALOG_DATA);\n' +
        '  ok() {\n    this.params.onContinue();\n    const local = inject<DialogParams>(DIALOG_DATA);\n    local.onContinue();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('onContinue'))).toEqual([
      'src/app/dialog.component.ts: local.onContinue -> src/app/params.ts::DialogParams::onContinue',
      'src/app/dialog.component.ts: this.params.onContinue -> src/app/params.ts::DialogParams::onContinue',
    ]);
  }, 60_000);

  it("doesn't read a field set from an inject that isn't Angular's", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.0.0' } }),
      ...SERVICES,
      'src/app/components/app.store.ts':
        "import { inject } from 'vue';\nimport { DataService } from '../data.service';\n" +
        'export class AppStore {\n' +
        '  private readonly dataService = inject(DataService);\n' +
        '  load() {\n    return this.dataService.fetchInfo();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('this.dataService.fetchInfo'))).toEqual([]);
  }, 60_000);

  it('has the class an instantiation service that returns its InstanceType is given', async () => {
    const calls = await callsOf({
      ...WORKBENCH,
      'src/browser/parts/view.ts':
        "import { Disposable } from '../../base/lifecycle';\n" +
        "import { IInstantiationService } from '../../platform/instantiation';\n" +
        "import { Widget } from '../widget';\n" +
        'export class View extends Disposable {\n' +
        '  private readonly widget = this._register(this.instantiationService.createInstance(Widget));\n' +
        '  private readonly plain = this.instantiationService.createInstance(Widget);\n' +
        '  constructor(private readonly instantiationService: IInstantiationService) {\n    super();\n  }\n' +
        '  run() {\n    this.widget.layout();\n    this.plain.layout();\n    const local = this.instantiationService.createInstance(Widget);\n    local.layout();\n  }\n' +
        '}\n' +
        // A member of what it hands back is that member's type, not the class's.
        'class Accessor {\n  widget!: Widget;\n}\n' +
        'export function check(instantiationService: IInstantiationService) {\n' +
        '  let widget: Widget;\n' +
        '  widget = instantiationService.createInstance(Accessor).widget;\n' +
        '  return widget.dispose();\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('layout') || c.includes('widget.dispose'))).toEqual([
      'src/browser/parts/view.ts: local.layout -> src/browser/widget.ts::Widget::layout',
      'src/browser/parts/view.ts: this.plain.layout -> src/browser/widget.ts::Widget::layout',
      'src/browser/parts/view.ts: this.widget.layout -> src/browser/widget.ts::Widget::layout',
      'src/browser/parts/view.ts: widget.dispose -> src/browser/widget.ts::Widget::dispose',
    ]);
  }, 60_000);

  it("doesn't read a field from a createInstance the project doesn't declare to return its argument's instance", async () => {
    const calls = await callsOf({
      ...WORKBENCH,
      'src/platform/instantiation.ts': 'export interface IFactory {\n  createInstance(name: unknown): unknown;\n}\n',
      'src/browser/parts/view.ts':
        "import { IFactory } from '../../platform/instantiation';\n" +
        "import { Widget } from '../widget';\n" +
        'export class View {\n' +
        '  private readonly plain = this.factory.createInstance(Widget);\n' +
        '  constructor(private readonly factory: IFactory) {}\n' +
        '  run() {\n    this.plain.layout();\n  }\n' +
        '}\n',
    });
    expect(calls.filter((c) => c.includes('this.plain.layout'))).toEqual([]);
  }, 60_000);
});
