/**
 * react-dom's `root.render(<X />)` linked to the project's one class-component
 * `render()` (#2589) when `root` was declared outside the calling function — a
 * module's `let root: Root | null`, a `let popupRoot: Root` in the function
 * around the one rendering — or held what `createRoot(el)` returned. A JS/TS
 * receiver the calling function doesn't type is now read by its binding in
 * scope at the call, as the function's own declaration is: the type `Root`
 * says the method is react-dom's, and a project type the binding is written
 * with or makes with `new` is the call's type. A nearer binding of the name —
 * a parameter, an arrow's or a destructured one — still decides, and another
 * function's binding holds in that function only. Nor is a class component's
 * `render()` or lifecycle method a guess for a receiver nothing types: React
 * calls those.
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

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-receiver-scope-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** `caller -> Owner::method` for every `calls` edge out of `file` that lands on a method. */
function methodCalls(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      if (target.kind === 'method') out.push(`${node.name} -> ${target.qualifiedName}`);
    }
  }
  return out.sort();
}

/** `caller -> target` for every `calls` edge out of `file`. */
function allCalls(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      out.push(`${node.name} -> ${target.name}`);
    }
  }
  return out.sort();
}

const BOUNDARY = 'import { Component } from "react";\nexport class Boundary extends Component<{ children?: React.ReactNode }> {\n  render() { return this.props.children; }\n}\n';

describe('a receiver is read by its binding in scope at the call', () => {
  it("links react-dom's root to no project render, however it was declared (#2589)", async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } }),
      'src/Boundary.tsx': BOUNDARY,
      // The issue's reproduction.
      'src/popup.tsx':
        'import { createRoot, type Root } from "react-dom/client";\nlet root: Root | null = null;\n' +
        'export function showPopup(el: HTMLElement) {\n  if (!root) root = createRoot(el);\n  root.render(<div />);\n}\n',
      'src/popup2.tsx':
        'import { createRoot } from "react-dom/client";\nexport function mount(el: HTMLElement) {\n  const r = createRoot(el);\n  r.render(<div />);\n}\n',
      'src/popup3.tsx':
        'import { createRoot, type Root } from "react-dom/client";\nexport function mount3(el: HTMLElement) {\n  const r: Root = createRoot(el);\n  r.render(<div />);\n}\n' +
        'export function mount4(root: Root) {\n  root.render(<div />);\n}\n',
      'src/more.tsx':
        'import { createRoot, type Root } from "react-dom/client";\nlet modRoot: Root;\n' +
        'export function a1(el: HTMLElement) { modRoot = createRoot(el); modRoot.render(<div />); }\n\n' +
        'export function outer(el: HTMLElement) {\n  let popupRoot: Root | null = null;\n  function renderPopup() { popupRoot!.render(<div />); }\n' +
        '  popupRoot = createRoot(el);\n  return renderPopup;\n}\n',
      // Through the default export, at module scope and in a function, and in JavaScript.
      'src/main.tsx':
        'import ReactDOM from "react-dom/client";\nconst el = document.getElementById("root")!;\n' +
        'if (!el.innerHTML) {\n  const root = ReactDOM.createRoot(el);\n  root.render(<div />);\n}\n' +
        'const shared = ReactDOM.hydrateRoot(el, <div />);\nexport function rerender() {\n  shared.render(<div />);\n}\n',
      'src/Card.jsx': 'import { Component } from "react";\nexport class Card extends Component {\n  render() { return null; }\n}\n',
      'src/legacy.jsx':
        'import { createRoot } from "react-dom/client";\nexport function boot(el) {\n  const root = createRoot(el);\n  root.render(<div />);\n}\n',
    });
    for (const file of ['src/popup.tsx', 'src/popup2.tsx', 'src/popup3.tsx', 'src/more.tsx', 'src/main.tsx', 'src/legacy.jsx']) {
      expect(methodCalls(graph, file), file).toEqual([]);
    }
  }, 120_000);

  it("takes a project type from a binding outside the calling function", async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/queues.ts':
        'export class Store {\n  dispatch(action: string) { return action; }\n}\n' +
        'export class Queue {\n  dispatch(job: string) { return job; }\n}\n',
      'src/use.ts':
        'import { Store, Queue } from "./queues";\n' +
        // A module's binding, named after neither class.
        'const s = new Store();\nlet q: Queue | undefined;\n' +
        'export function send() { s.dispatch("a"); }\nexport function drain() { q!.dispatch("b"); }\n' +
        // The function around the one calling, and its parameter.
        'export function outer() {\n  const pending = new Queue();\n  function flush() { pending.dispatch("c"); }\n  return flush;\n}\n' +
        'export function around(svc: Store) {\n  function go() { svc.dispatch("d"); }\n  return go;\n}\n',
    });
    expect(methodCalls(graph, 'src/use.ts')).toEqual([
      'drain -> Queue::dispatch',
      'flush -> Queue::dispatch',
      'go -> Store::dispatch',
      'send -> Store::dispatch',
    ]);
  }, 120_000);

  it('lets a nearer binding of the name decide', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-dom': '^18.0.0' } }),
      // A method a call is guessed to is one of its own language's.
      'src/chart.tsx': 'export class Chart {\n  render() { return 1; }\n}\n',
      'src/gauge.jsx': 'export class Gauge {\n  close() { return 1; }\n}\n',
      'src/views.tsx':
        'import { createRoot, type Root } from "react-dom/client";\nimport { Chart } from "./chart";\n' +
        'let root: Root | null = null;\nexport function init(el: HTMLElement) { root = createRoot(el); }\n' +
        // A typed parameter, an arrow's own parameter, a destructured one.
        'export function typed(root: Chart) { root.render(); }\n' +
        'export function each(items: Chart[]) { items.forEach((root) => root.render()); }\n' +
        'export function Panel({ root }: { root: any }) { return root.render(); }\n' +
        // Another function's own declaration holds in that function only.
        'export function other() { const root = new Chart(); return root; }\n' +
        'export function show() { root!.render(<div />); }\n',
      // A `new` of a parameter names no class to look the method up on.
      'src/later.jsx':
        'export function make(Backend) {\n  const watcher = new Backend();\n  function stop() { watcher.close(); }\n  return stop;\n}\n',
    });
    expect(methodCalls(graph, 'src/views.tsx')).toEqual([
      'Panel -> Chart::render',
      'each -> Chart::render',
      'typed -> Chart::render',
    ]);
    expect(methodCalls(graph, 'src/later.jsx')).toEqual(['stop -> Gauge::close']);
  }, 120_000);

  it('recognizes a nearer binding across later declarators and destructuring defaults (#3293)', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-dom': '^18.0.0' } }),
      'src/chart.tsx': 'export class Chart {\n  render() { return 1; }\n}\n',
      'src/views.tsx':
        'import { createRoot, type Root } from "react-dom/client";\nimport { Chart } from "./chart";\n' +
        'let root: Root | null = null;\n' +
        'export function laterDeclarator() {\n' +
        '  let n = 0, root = new Chart();\n' +
        '  return root.render();\n' +
        '}\n' +
        'export function destructuredDefault(opt: any) {\n' +
        '  const { root = new Chart() } = opt;\n' +
        '  return root.render();\n' +
        '}\n' +
        'export function destructuredAfterDefault(opt: any) {\n' +
        '  const { x = 1, root } = opt;\n' +
        '  return root.render();\n' +
        '}\n',
    });
    expect(methodCalls(graph, 'src/views.tsx')).toEqual([
      'destructuredAfterDefault -> Chart::render',
      'destructuredDefault -> Chart::render',
      'laterDeclarator -> Chart::render',
    ]);
  }, 120_000);

  it('bounds declaration list scanning and preserves outer bindings across non-declarator commas (#3293)', async () => {
    const list30 = Array.from({ length: 30 }, (_, i) => `a${i}`).join(', ');
    const jqueryList = Array.from({ length: 15 }, (_, i) => `    j${i} = ${i}`).join(',\n');
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/gauge.ts': 'export class Gauge {\n  paint() { return 1; }\n}\nexport class Other {\n  paint() { return 2; }\n}\nexport function defaultSize() { return 10; }\n',
      'src/long-list.ts':
        'import { Gauge } from "./gauge";\n' +
        'let ob: Gauge = new Gauge();\n' +
        `var ${list30};\n` +
        `var\n${jqueryList};\n` +
        'export function run() { return ob.paint(); }\n',
      'src/for-of.ts':
        'import { Gauge } from "./gauge";\n' +
        'let ob: Gauge = new Gauge();\n' +
        'export function loop(items: any[]) {\n' +
        '  for (const [ob] of items) { ob.paint(); }\n' +
        '}\n' +
        'export function loopObj(items: any[]) {\n' +
        '  for (const { ob } of items) { ob.paint(); }\n' +
        '}\n',
      'src/non-declarator-commas.tsx':
        'import { Gauge } from "./gauge";\n' +
        'let ob: Gauge = new Gauge();\n' +
        'declare function make(): any;\n' +
        'declare function log(x: any): void;\n' +
        'export function jsx() {\n' +
        '  const el = <p>Hi, ob is set</p>;\n' +
        '  return ob.paint();\n' +
        '}\n' +
        'export function objType() {\n' +
        '  const o: { a: number, ob: string } = make();\n' +
        '  return ob.paint();\n' +
        '}\n' +
        'export function generic() {\n' +
        '  const m = new Map<string, typeof ob>();\n' +
        '  return ob.paint();\n' +
        '}\n' +
        'export function commaExpr() {\n' +
        '  const n = 1\n' +
        '  log(n), ob.paint()\n' +
        '}\n',
      'src/multiline-destruct.ts':
        'import { Gauge } from "./gauge";\n' +
        'let ob: Gauge = new Gauge();\n' +
        'declare function useState(n: number): any;\n' +
        'export function semiFree(c: any) {\n' +
        '  const [s, setS] = useState(0)\n' +
        '  ob.paint()\n' +
        '  c[s] = 1\n' +
        '}\n' +
        'export function forEntries(c: any) {\n' +
        '  for (const [k, v] of Object.entries(ob)) {\n' +
        '    c[k] = v;\n' +
        '    ob.paint();\n' +
        '  }\n' +
        '}\n',
      'src/default-val.ts':
        'import { defaultSize } from "./gauge";\n' +
        'export function check(opts: any) {\n' +
        '  const { size = defaultSize() } = opts;\n' +
        '  return defaultSize();\n' +
        '}\n',
      'src/foo.ts': 'export function foo() { return 1; }\n',
      'src/shadow.ts':
        'import { foo } from "./foo";\n' +
        'declare function make(): any;\n' +
        'export function run() {\n' +
        '  let n = 0, foo = make();\n' +
        '  foo();\n' +
        '}\n',
    });

    expect(methodCalls(graph, 'src/long-list.ts')).toEqual(['run -> Gauge::paint']);
    expect(methodCalls(graph, 'src/for-of.ts')).toEqual([]);
    expect(methodCalls(graph, 'src/non-declarator-commas.tsx')).toEqual([
      'commaExpr -> Gauge::paint',
      'generic -> Gauge::paint',
      'jsx -> Gauge::paint',
      'objType -> Gauge::paint',
    ]);
    expect(methodCalls(graph, 'src/multiline-destruct.ts')).toEqual([
      'forEntries -> Gauge::paint',
      'semiFree -> Gauge::paint',
    ]);
    expect(allCalls(graph, 'src/default-val.ts')).toEqual(['check -> defaultSize', 'check -> defaultSize']);
    expect(allCalls(graph, 'src/shadow.ts')).toEqual(['run -> make']);
  }, 120_000);
});
