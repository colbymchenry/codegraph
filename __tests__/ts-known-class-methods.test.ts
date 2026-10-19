/**
 * A TypeScript call on a field or a local whose class its file's import
 * names reaches that class's method, or the method of a class it extends as
 * that class's own file names it, and never a same-named class elsewhere.
 *
 * When the class didn't declare the method itself, the call went to any
 * class with the method and the right name: vscode's `this._storage.dispose`
 * (`Storage extends Disposable`) reached a test fixture's `Disposable`, and
 * Copilot's `Emitter extends lsp.Emitter`, whose `fire` is the package's,
 * reached a test fixture's `Emitter::fire`. An interface's call through the
 * interface it extends, like `this.logService.trace()` on `ILogService
 * extends ILogger`, linked nowhere.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-known-class-'));
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

describe('a call on a value of a class its file names', () => {
  it("reaches the method the class inherits from the base its own file imports, not the call's file's namesake", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/base/lifecycle.ts': 'export class Disposable {\n  dispose() {\n    return 1;\n  }\n}\n',
      'src/base/storage.ts':
        "import { Disposable } from './lifecycle';\nexport class Storage extends Disposable {\n  get(key: string) {\n    return key;\n  }\n}\n",
      'src/app/main.ts':
        "import { Storage } from '../base/storage';\n" +
        'class Disposable {\n  dispose() {\n    return 2;\n  }\n}\n' +
        'export class Main {\n  private readonly _storage = new Storage();\n  private readonly local = new Disposable();\n' +
        '  close() {\n    this._storage.dispose();\n  }\n}\n' +
        'export function shut(storage: Storage) {\n  return storage.dispose();\n}\n',
    });
    expect(calls.filter((c) => c.includes('dispose'))).toEqual([
      'src/app/main.ts: storage.dispose -> src/base/lifecycle.ts::Disposable::dispose',
      'src/app/main.ts: this._storage.dispose -> src/base/lifecycle.ts::Disposable::dispose',
    ]);
  }, 60_000);

  it("links nothing when the method is the class's package base's, whatever project class shares the names", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'ext-lsp': '^1.0.0' } }),
      'src/util/event.ts':
        "import * as lsp from 'ext-lsp';\nexport class Emitter<T> extends lsp.Emitter<T> {\n  get size() {\n    return 0;\n  }\n}\n",
      'src/fixtures/testbed/events.ts': 'export class Emitter {\n  fire() {\n    return 0;\n  }\n}\n',
      'src/app/model.ts':
        "import { Emitter } from '../util/event';\n" +
        'export class Model {\n  private readonly _onDidChange = new Emitter<void>();\n  run() {\n    this._onDidChange.fire();\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('.fire'))).toEqual([]);
  }, 60_000);

  it('links nothing when neither the class nor anything it extends declares the method', async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/one/widget.ts': 'export class Base {\n  show() {}\n}\nexport class Widget extends Base {\n  hide() {}\n}\n',
      'src/two/widget.ts': 'export class Widget {\n  focus() {}\n}\n',
      'src/app/view.ts':
        "import { Widget } from '../one/widget';\n" +
        'export class View {\n  private readonly widget = new Widget();\n  run() {\n    this.widget.show();\n    this.widget.focus();\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('this.widget.'))).toEqual(['src/app/view.ts: this.widget.show -> src/one/widget.ts::Base::show']);
  }, 60_000);

  it('reaches a method an interface inherits from the interface it extends', async () => {
    // vscode's `ILogService` is also a constant: `createDecorator<ILogService>('logService')`.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/platform/log.ts':
        'function createDecorator<T>(id: string): T {\n  return id as unknown as T;\n}\n' +
        'export interface ILogger {\n  trace(message: string): void;\n}\n' +
        "export const ILogService = createDecorator<ILogService>('logService');\n" +
        'export interface ILogService extends ILogger {\n  flush(): void;\n}\n',
      'src/app/legacy/log.ts': 'export interface ILogger {\n  trace(message: string): void;\n}\n',
      'src/app/service.ts':
        "import { ILogService } from '../platform/log';\n" +
        'export class Service {\n  constructor(private readonly logService: ILogService) {}\n' +
        "  run() {\n    this.logService.trace('a');\n    this.logService.flush();\n  }\n}\n",
    });
    expect(calls.filter((c) => c.includes('this.logService.'))).toEqual([
      'src/app/service.ts: this.logService.flush -> src/platform/log.ts::ILogService::flush',
      'src/app/service.ts: this.logService.trace -> src/platform/log.ts::ILogger::trace',
    ]);
  }, 60_000);

  it('reaches the class an import renames on the way, not a namesake of the local name', async () => {
    // bitwarden's `export { MessageSender as MessagingService } from "@bitwarden/messaging"`.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/messaging/sender.ts': 'export abstract class MessageSender {\n  abstract send(command: string): void;\n}\n',
      'src/common/messaging.service.ts': "export { MessageSender as MessagingService } from '../messaging/sender';\n",
      'src/desktop/electron-messaging.service.ts': 'export class MessagingService {\n  send(command: string) {\n    return command;\n  }\n}\n',
      'src/desktop/settings.component.ts':
        "import { MessagingService } from '../common/messaging.service';\n" +
        'export class SettingsComponent {\n  constructor(private readonly messagingService: MessagingService) {}\n' +
        "  save() {\n    this.messagingService.send('saved');\n  }\n}\n",
    });
    expect(calls.filter((c) => c.includes('this.messagingService.send'))).toEqual([
      'src/desktop/settings.component.ts: this.messagingService.send -> src/messaging/sender.ts::MessageSender::send',
    ]);
  }, 60_000);

  it('reaches it through an interface another file extends, whose import also names a constant', async () => {
    // vscode's `ITerminalLogService extends ILogService`, `ILogService` both
    // an interface and its `createDecorator` constant.
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/platform/log.ts':
        'function createDecorator<T>(id: string): T {\n  return id as unknown as T;\n}\n' +
        'export interface ILogger {\n  trace(message: string): void;\n}\n' +
        "export const ILogService = createDecorator<ILogService>('logService');\n" +
        'export interface ILogService extends ILogger {\n  flush(): void;\n}\n',
      'src/app/legacy/log.ts': 'export interface ILogger {\n  trace(message: string): void;\n}\n',
      'src/terminal/terminal.ts':
        "import { ILogService } from '../platform/log';\n" +
        'export interface ITerminalLogService extends ILogService {\n  logTerminal(): void;\n}\n',
      'src/terminal/service.ts':
        "import { ITerminalLogService } from './terminal';\n" +
        'export class TerminalService {\n  constructor(private readonly _logService: ITerminalLogService) {}\n' +
        "  run() {\n    this._logService.trace('a');\n  }\n}\n",
    });
    expect(calls.filter((c) => c.includes('this._logService.'))).toEqual([
      'src/terminal/service.ts: this._logService.trace -> src/platform/log.ts::ILogger::trace',
    ]);
  }, 60_000);
});
