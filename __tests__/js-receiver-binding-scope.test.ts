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
});
