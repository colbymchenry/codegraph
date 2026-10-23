/**
 * A named class expression, like `register(class Widget extends Base {…})` or
 * `const Panel = class PanelImpl extends Base {…}`, is a class: it has a node,
 * members of its own and the supertypes it names (#2499). Before, its methods
 * were free functions or not indexed at all, and it extended nothing. Its
 * name is bound inside the expression alone, so outside it the name reaches
 * neither the class nor its members, and a binding of the same name around
 * it keeps meaning what it meant. A class a CommonJS module exports is the
 * module's value, which `require` hands over as it does a declaration.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const EXPRESSIONS = `class Base { run() { return 1; } }
register(class Widget extends Base {
  run() { return super.run(); }
  extra() { return this.run(); }
});
export const Panel = class PanelImpl extends Base {
  go() { return 3; }
};
register(class extends Base { anonymous() { return 4; } });
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a named class expression is a class (#2499)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);
  const variants = [['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx']] as const;

  for (const backend of backends) {
    it.each(variants)(`in %s, ${backend}`, (ext, language) => {
      const result = extract(backend, `src/widgets.${ext}`, EXPRESSIONS, language);
      const symbols = result.nodes
        .filter((n) => n.kind === 'class' || n.kind === 'method' || n.kind === 'function')
        .map((n) => `${n.kind} ${n.qualifiedName}${n.signature && n.kind === 'class' ? ` (${n.signature})` : ''}${n.isExported ? ' exported' : ''}`);
      expect(symbols).toEqual([
        'class Base',
        'method Base::run',
        'class Widget (class Widget extends Base)',
        'method Widget::run',
        'method Widget::extra',
        'class Panel::PanelImpl (class PanelImpl extends Base)',
        'method Panel::PanelImpl::go',
        // An anonymous class expression is passed over, as before.
        'function anonymous',
      ]);
      const supertypes = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'extends')
        .map((r) => `${result.nodes.find((n) => n.id === r.fromNodeId)?.qualifiedName} extends ${r.referenceName}`);
      expect(supertypes).toEqual(['Widget extends Base', 'Panel::PanelImpl extends Base']);
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree on every node and reference', () => {
    for (const [ext, language] of variants) {
      const canon = (r: ExtractionResult) => ({
        nodes: r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort(),
        refs: r.unresolvedReferences.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort(),
      });
      expect(canon(extract('kernel', `src/widgets.${ext}`, EXPRESSIONS, language)), ext)
        .toEqual(canon(extract('wasm', `src/widgets.${ext}`, EXPRESSIONS, language)));
    }
  });
});

describe.each(['js', 'ts'])('a class expression\'s name reaches it from inside alone (#2499): %s', (ext) => {
  let root = '';
  let graph: CodeGraph | null = null;

  afterEach(() => {
    graph?.close();
    graph = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** `kind source -> target [resolvedBy confidence]` for the calls, supertypes and instantiations out of a file's nodes, synthesized ones left out. */
  function edgesFrom(g: CodeGraph, file: string): string[] {
    const out: string[] = [];
    for (const node of g.getNodesInFile(file)) {
      for (const e of g.getOutgoingEdges(node.id)) {
        if (!['calls', 'extends', 'implements', 'instantiates'].includes(e.kind) || e.metadata?.synthesizedBy) continue;
        out.push(`${e.kind} ${node.qualifiedName} -> ${g.getNode(e.target)!.qualifiedName} [${e.metadata?.resolvedBy} ${e.metadata?.confidence}]`);
      }
    }
    return out.sort();
  }

  it('links the class\'s supertypes, super and this calls, and nothing outside by its name', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-class-expression-'));
    const write = (rel: string, lines: string[]) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), lines.join('\n') + '\n');
    };
    write('package.json', [JSON.stringify({ name: 'app' })]);
    write(`src/base.${ext}`, ['export class Base { run() { return 1; } }', 'export function register(T) { return T; }']);
    write(`src/widgets.${ext}`, [
      "import { Base, register } from './base';",
      'register(class Widget extends Base {',
      '  run() { return super.run(); }',
      '  extra() { return this.run(); }',
      // Another class expression's name is no binding in here either.
      '  other() { return new PanelImpl(); }',
      '});',
      'export const Panel = class PanelImpl extends Base {',
      '  go() { return super.run(); }',
      '};',
      // The inner name is no binding out here: this throws at runtime.
      'export function make() { return new Widget(); }',
      'export function panel() { return new Panel(); }',
    ]);
    write(`src/shadow.${ext}`, [
      "import { Base, register } from './base';",
      // A declaration and a constant share names with class expressions in their file.
      'export class Gadget { run() { return 0; } }',
      'export const list = [class Gadget extends Base { run() { return super.run(); } }];',
      'export const Tool = class Tool extends Base { static make() { return new Tool(); } };',
      'export function build() { return new Gadget(); }',
      'export function tool() { return new Tool(); }',
      'export function helper() { return Tool.make(); }',
    ]);
    // nitro's shape: an interface, and a class expression of its name that a
    // factory returns. A value typed by the name is the interface's.
    if (ext === 'ts') {
      write('src/env.ts', [
        'export interface Env { fetch(url: string): string }',
        'export function define() { return class Env { fetch(url: string) { return url; } }; }',
        'export function use(env: Env) { return env.fetch("/"); }',
      ]);
    }
    graph = await CodeGraph.init(root, { index: true });

    expect(edgesFrom(graph, `src/widgets.${ext}`)).toEqual([
      'calls Panel::PanelImpl::go -> Base::run [instance-method 0.9]',
      'calls Widget::extra -> Widget::run [exact-match 0.4]',
      'calls Widget::run -> Base::run [instance-method 0.9]',
      `calls src/widgets.${ext} -> register [import 0.9]`,
      'extends Panel::PanelImpl -> Base [import 0.9]',
      'extends Widget -> Base [import 0.9]',
      // `new Panel()` is the constant's, as before; `new Widget()` outside
      // the expression links nothing.
      'instantiates panel -> Panel [exact-match 0.9]',
    ]);
    expect(edgesFrom(graph, `src/shadow.${ext}`)).toEqual([
      'calls list::Gadget::run -> Base::run [instance-method 0.9]',
      'extends Tool::Tool -> Base [import 0.9]',
      'extends list::Gadget -> Base [import 0.9]',
      // Outside the expressions, the declaration and the constant keep the
      // names, at the confidence they had; inside its own body, `Tool` is
      // the class.
      'instantiates Tool::Tool::make -> Tool::Tool [exact-match 0.4]',
      'instantiates build -> Gadget [exact-match 0.9]',
      'instantiates tool -> Tool [exact-match 0.9]',
    ]);
    if (ext === 'ts') {
      expect(edgesFrom(graph, 'src/env.ts').filter((e) => e.startsWith('calls use'))).toEqual(['calls use -> Env::fetch [instance-method 0.9]']);
    }
  }, 120_000);
});

it('a guess by a receiver\'s name never reaches a class expression\'s member from code its value can\'t reach (#2499)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-class-expression-guess-'));
  let graph: CodeGraph | null = null;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    // lit's SSR DOM shim declares its document and elements this way.
    fs.writeFileSync(path.join(root, 'src/dom-shim.ts'), [
      'export const DocumentShim = class Document {',
      '  createElement(tag: string) { return tag; }',
      '};',
      'export const HTMLElementShim = class HTMLElement {',
      '  appendChild(child: unknown) { return child; }',
      '};',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src/format.ts'), 'export class Formatter { appendChild(node: unknown) { return node; } }\n');
    fs.writeFileSync(path.join(root, 'src/view.ts'), [
      'let container: HTMLElement;',
      "export function view() { container = document.createElement('div'); return container; }",
      // A class expression of its own, which it reaches.
      'export const Local = class LocalView { show() { return 1; } };',
      'export function mount(el: unknown) { container.appendChild(el); }',
      '',
    ].join('\n'));
    graph = await CodeGraph.init(root, { index: true });
    for (const name of ['view', 'mount']) {
      const fn = graph.getNodesByQualifiedName(name)[0]!;
      expect(graph.getOutgoingEdges(fn.id).filter((e) => e.kind === 'calls').map((e) => graph!.getNode(e.target)!.qualifiedName), name).toEqual([]);
    }
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it('a class a CommonJS module exports is reached through `require` as a declaration is (#2499)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-class-expression-cjs-'));
  let graph: CodeGraph | null = null;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/router.js'), [
      'module.exports = class Router {',
      '  static make() { return 1; }',
      '  route() { return 2; }',
      '};',
      // A class expression the module doesn't export keeps its scope.
      'register(class Hidden { go() { return 3; } });',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src/store.js'), 'exports.Store = class StoreImpl {\n  static open() { return 4; }\n};\n');
    fs.writeFileSync(path.join(root, 'src/app.js'), [
      "const Router = require('./router.js');",
      "const { Store } = require('./store.js');",
      'exports.start = function start() {',
      '  const r = new Router();',
      '  Router.make();',
      '  Store.open();',
      '  new Hidden().go();',
      '  return r.route();',
      '};',
      '',
    ].join('\n'));
    graph = await CodeGraph.init(root, { index: true });
    const start = graph.getNodesByQualifiedName('start')[0]!;
    const targets = graph.getOutgoingEdges(start.id)
      .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
      .map((e) => `${e.kind} ${graph!.getNode(e.target)!.kind} ${graph!.getNode(e.target)!.qualifiedName} [${e.metadata?.resolvedBy}]`)
      .sort();
    // The class, its static method and its instance's method, by what each
    // module exports, `module.exports` or `exports.Store`; the class
    // expression neither exports stays out of reach.
    expect(targets).toEqual([
      'calls method Router::make [import]',
      'calls method Router::route [instance-method]',
      'calls method StoreImpl::open [import]',
      'instantiates class Router [import]',
    ]);
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
