/**
 * A TS/JS call written `super.run(…)` runs the method of the class's parent,
 * or of the nearest ancestor that has it (#2497). The extractor keeps such a
 * call under its bare name, so inside an override of `run` every strategy
 * found the calling method itself and the self-edge was declined, leaving the
 * call unlinked; elsewhere the call went to whatever method had the name, like
 * a sibling class's in the same file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BASE = `export class Base {
  run() { return 1; }
  init() {}
  static make() { return new Base(); }
  make() { return 2; }
}
`;

const CHILDREN = `import { Base } from './base';
export class Decoy { run() { return 'decoy'; } missing() {} }
export class Child extends Base {
  run() { return super.run(); }
}
export class Worker extends Base {
  work() { return super.run(); }
}
export class Lonely extends Base {
  go() { return super.missing(); }
}
export class Mid extends Base {}
export class Leaf extends Mid {
  run() { return super.run(); }
}
export class Mid2 extends Base {
  run() { return 3; }
}
export class Leaf2 extends Mid2 {
  run() { return super.run(); }
}
export class Maker extends Base {
  static make() { return super.make(); }
  make() { return super.make(); }
  constructor() {
    super();
    super.init();
  }
  later = () => super.init();
  each() { return [1].map(() => super.run()); }
  named() {
    const go = () => super.run();
    return go();
  }
  noted() {
    // runs the parent class's run, as webpack writes "class-static-block"
    const kind = 'class-static-block';
    return super.run(kind);
  }
  split() {
    return super
      .run();
  }
}
export class Counter extends Base {
  run(n) { return n > 0 ? this.run(n - 1) : super.run(); }
}
`;

const OUTSIDE = `export class Widget extends HTMLElement {
  connectedCallback() { super.connectedCallback(); }
  attach() { return super.connectedCallback(); }
}
export class Panel {
  connectedCallback() {}
}
`;

describe.each(['js', 'ts'])('a super call reaches the parent class (#2497): %s', (ext) => {
  let root = '';
  let graph: CodeGraph | null = null;

  afterEach(() => {
    graph?.close();
    graph = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Every `calls` edge the index resolved (synthesized dispatch left out), by qualified names. */
  function calls(g: CodeGraph): string[] {
    const out: string[] = [];
    const label = (id: string) => {
      const n = g.getNode(id)!;
      return `${n.isStatic ? 'static ' : ''}${n.qualifiedName}`;
    };
    for (const kind of ['method', 'function'] as const) {
      for (const node of g.getNodesByKind(kind)) {
        for (const e of g.getOutgoingEdges(node.id)) {
          if (e.kind !== 'calls' || e.metadata?.synthesizedBy) continue;
          out.push(`${label(e.source)} -> ${label(e.target)} [${e.metadata?.resolvedBy}]`);
        }
      }
    }
    return out.sort();
  }

  it('links the parent\'s or the nearest ancestor\'s method, of the caller\'s kind, and nothing else', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-super-call-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, `src/base.${ext}`), BASE);
    fs.writeFileSync(path.join(root, `src/children.${ext}`), CHILDREN);
    fs.writeFileSync(path.join(root, `src/outside.${ext}`), OUTSIDE);
    graph = await CodeGraph.init(root, { index: true });

    expect(calls(graph)).toEqual([
      // The issue's override, and its renamed form: not the sibling Decoy's
      // or Child's `run`, which share the file.
      'Child::run -> Base::run [instance-method]',
      // Real recursion keeps its edge beside a super call on the same line.
      'Counter::run -> Base::run [instance-method]',
      'Counter::run -> Counter::run [exact-match]',
      // A grandparent's method, and a nearer ancestor's over it.
      'Leaf2::run -> Mid2::run [instance-method]',
      'Leaf::run -> Base::run [instance-method]',
      // A constructor, an arrow field, an arrow callback, a named arrow and
      // a call split over two lines are the instance method's; a static
      // one the static's.
      'Maker::constructor -> Base::init [instance-method]',
      'Maker::each -> Base::run [instance-method]',
      'Maker::later -> Base::init [instance-method]',
      'Maker::make -> Base::make [instance-method]',
      'Maker::named -> Maker::named::go [exact-match]',
      'Maker::named::go -> Base::run [instance-method]',
      // A `class` in a comment or a string is no class expression.
      'Maker::noted -> Base::run [instance-method]',
      'Maker::split -> Base::run [instance-method]',
      'Worker::work -> Base::run [instance-method]',
      'static Maker::make -> static Base::make [instance-method]',
      // A method no ancestor has (Decoy's `missing`), and a parent outside
      // the project (HTMLElement, not Panel), link nothing.
    ]);
  }, 120_000);
});

it('a super call in a class expression is not read as the enclosing class\'s (#2497)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-super-call-expr-'));
  let graph: CodeGraph | null = null;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/base.js'), BASE);
    fs.writeFileSync(path.join(root, 'src/holder.js'), [
      "import { Base } from './base.js';",
      'export class Other { run() { return 0; } }',
      'export class Holder extends Base {',
      '  make() {',
      '    return class extends Other { run() { return super.run(); } };',
      '  }',
      '}',
      '',
    ].join('\n'));
    graph = await CodeGraph.init(root, { index: true });
    // The class expression's methods have no nodes, so its call is recorded
    // from `make`; its `super` is Other, never Holder's parent.
    const make = graph.getNodesByQualifiedName('Holder::make')[0]!;
    const targets = graph.getOutgoingEdges(make.id).filter((e) => e.kind === 'calls').map((e) => graph!.getNode(e.target)!.qualifiedName);
    expect(targets).not.toContain('Base::run');
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it('a TypeScript class reaches the class it extends, not an interface it implements (#2497)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-super-call-ts-'));
  let graph: CodeGraph | null = null;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/base.ts'), 'export class Base<T = unknown> { run(): number { return 1; } }\n');
    fs.writeFileSync(path.join(root, 'src/both.ts'), [
      "import { Base as Parent } from './base';",
      'export interface Runner { run(): number }',
      'export class Both extends Parent<string> implements Runner {',
      '  run(): number { return super.run(); }',
      '}',
      '',
    ].join('\n'));
    graph = await CodeGraph.init(root, { index: true });
    const both = graph.getNodesByQualifiedName('Both::run')[0]!;
    const targets = graph.getOutgoingEdges(both.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${graph!.getNode(e.target)!.qualifiedName} [${e.metadata?.resolvedBy}]`);
    expect(targets).toEqual(['Base::run [instance-method]']);
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
