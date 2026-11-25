/**
 * Calls on the browser's own objects link to no project method (#2907).
 *
 * `window.open('/help')`, `localStorage.getItem('token')`, `location.reload()`
 * and `history.back()` are DOM calls, yet each linked to a project class's
 * method of the same name — an app's `WindowService.open`, `StorageService.
 * getItem`, `PageService.back` — so `callers` and impact on such a wrapper
 * listed every direct DOM call in the app. Three readings did it: a receiver
 * with no type was guessed by its word or a lone method name; a chain from
 * `window` (`window.localStorage.getItem()`), recorded by its bare method name
 * so a project global hung on `window` can be found (#1707), fell to the
 * exact-name match; and a JS `self.close()` was read as `this.close()`,
 * though an unbound `self` is the global object.
 *
 * A name the file binds or imports is still its own, and `this` is still the
 * instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  graphs = [];
  dirs = [];
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-host-globals-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const cg = await CodeGraph.init(dir, { index: true });
  graphs.push(cg);
  return cg;
}

/** `caller -> target` for every call edge out of `fromFile`, by qualified name. */
function callsFrom(cg: CodeGraph, fromFile: string): string[] {
  return cg
    .getNodesInFile(fromFile)
    .flatMap((n) =>
      cg
        .getOutgoingEdges(n.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => `${n.qualifiedName} -> ${cg.getNode(e.target)?.qualifiedName}`)
    )
    .sort();
}

const SERVICES = [
  'export class WindowService {',
  '  open(url: string): void {}',
  '  close(): void {}',
  '  postMessage(m: unknown): void {}',
  '}',
  'export class StorageService {',
  '  getItem(key: string): string | null { return null; }',
  '}',
  'export class PageService {',
  '  reload(): void {}',
  '  back(): void {}',
  '}',
  '',
].join('\n');

describe('calls on browser host objects', () => {
  it('link no project method, written directly or through window or self', async () => {
    const cg = await index({
      'src/services.ts': SERVICES,
      'src/browser.ts': [
        "export function openHelp(): void { window.open('/help'); }",
        "export function readToken(): string | null { return localStorage.getItem('token'); }",
        'export function refresh(): void { location.reload(); }',
        'export function goBack(): void { history.back(); }',
        "export function readTokenChained(): string | null { return window.localStorage.getItem('token'); }",
        'export function goBackChained(): void { window.history.back(); }',
        'export function closeSelf(): void { self.close(); }',
        'export class Popup {',
        '  dismiss(): void { self.close(); }',
        '  close(): void {}',
        '}',
        '',
      ].join('\n'),
      'src/worker.js': "self.postMessage('ready');\nexport function reply(x) { self.postMessage(x); }\n",
    });
    expect(callsFrom(cg, 'src/browser.ts')).toEqual([]);
    expect(callsFrom(cg, 'src/worker.js')).toEqual([]);
  });

  it('still link a name the file binds, imports or takes as a parameter', async () => {
    const cg = await index({
      'src/router.ts': [
        'export class Router { forward(): void {} }',
        'export function createRouter(): Router { return new Router(); }',
        '',
      ].join('\n'),
      'src/nav.ts': 'export const history = { push(to: string): void {} };\n',
      'src/loc.ts': 'export class Loc { reload(): void {} }\n',
      'src/uses.ts': [
        "import { createRouter } from './router';",
        "import { history } from './nav';",
        "import { Loc } from './loc';",
        'export function local(): void {',
        '  const navigator = createRouter();',
        '  navigator.forward();',
        '}',
        "export function imported(): void { history.push('/x'); }",
        'export function param(location: Loc): void { location.reload(); }',
        '',
      ].join('\n'),
    });
    expect(callsFrom(cg, 'src/uses.ts')).toEqual([
      'imported -> history::push',
      'local -> Router::forward',
      'local -> createRouter',
      'param -> Loc::reload',
    ]);
  });

  it('still link a destructured parameter named like one, and decline after a `typeof` guard', async () => {
    // outline's commands and scenes take their Document model as `({ document }: Props)`.
    const cg = await index({
      'src/models/Model.ts': 'export class Model {\n  save(): void {}\n}\n',
      'src/models/Document.ts': "import Model from './Model';\nexport default class Document extends Model {\n  save(): void {}\n  archive(): void {}\n}\n",
      'src/services.ts': SERVICES,
      'src/DocumentPublish.tsx': [
        "import type Document from './models/Document';",
        '',
        'type Props = {',
        '  /** The document to publish. */',
        '  document: Document;',
        '};',
        '',
        'export function DocumentPublish({ document }: Props) {',
        '  const publish = async () => {',
        '    await document.save();',
        '  };',
        '  return publish;',
        '}',
        '',
      ].join('\n'),
      'src/help.ts': [
        'export function openHelp(): void {',
        "  if (typeof window !== 'undefined') window.open('/help');",
        '}',
        'export function goBack(nav: { canGoBack: boolean }): void {',
        '  if (nav.canGoBack && window.history.length > 1) history.back();',
        '}',
        '',
      ].join('\n'),
    });
    expect(callsFrom(cg, 'src/DocumentPublish.tsx')).toEqual(['DocumentPublish::publish -> Document::save']);
    expect(callsFrom(cg, 'src/help.ts')).toEqual([]);
  });

  it('still read `this`, a `self` the file binds to it, and a project object hung on window', async () => {
    const cg = await index({
      'src/dialog.js': [
        'export class Dialog {',
        '  close() {}',
        '  open() { this.close(); }',
        '  later() { var self = this; setTimeout(function () { self.close(); }); }',
        '}',
        'export const store = {',
        '  close() {},',
        '  open() { this.close(); },',
        '};',
        '',
      ].join('\n'),
      'src/app.js': 'window.App = {\n  init() {},\n};\nexport function boot() { window.App.init(); }\n',
    });
    expect(callsFrom(cg, 'src/dialog.js')).toEqual([
      'Dialog::later -> Dialog::close',
      'Dialog::open -> Dialog::close',
      'store::open -> store::close',
    ]);
    expect(callsFrom(cg, 'src/app.js')).toEqual(['boot -> window.App::init']);
  });
});
