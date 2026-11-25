/**
 * The override-dispatch edges (`synthesizedBy: interface-impl`) link an
 * interface's or a base class's method to the method of the same name that a
 * class implementing or extending it declares, so a call through the base
 * reaches the override. They were made for `.ts` and `.js` classes only: a
 * `.tsx` or `.jsx` class got none, though it is a TypeScript or JavaScript
 * class, and neither did a `.ts` class whose base or interface lives in a
 * `.tsx` file, like outline's emails extending `BaseEmail`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('override dispatch in .tsx and .jsx classes', () => {
  let root = '';
  let graph: CodeGraph | null = null;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-override-'));
    const write = (rel: string, lines: string[]) => fs.writeFileSync(path.join(root, rel), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    const classes = [
      'export class Widget { render() { return null; } static create() { return 1; } }',
      'export class Button extends Widget { render() { return null; } static create() { return 2; } }',
      // A static method overrides only a static one (#2761).
      'export class Toggle extends Widget { static render() { return null; } }',
    ];
    write('src/widgets.tsx', classes);
    write('src/widgets.jsx', classes);
    // An interface and an abstract base in a .ts file, implemented in .tsx.
    write('src/shape.ts', [
      'export interface Shape { area(): number }',
      'export abstract class Figure { abstract draw(): string; describe(): string { return this.draw(); } }',
    ]);
    write('src/Circle.tsx', [
      "import { Shape, Figure } from './shape';",
      'export class Circle extends Figure implements Shape {',
      '  area(): number { return 3; }',
      '  draw(): string { return "o"; }',
      '  view() { return <div />; }',
      '}',
    ]);
    // outline's shape: a base in a .tsx file, a subclass in a .ts one.
    write('src/BaseEmail.tsx', ['export class BaseEmail { subject() { return ""; } render() { return <p />; } }']);
    write('src/WelcomeEmail.ts', [
      "import { BaseEmail } from './BaseEmail';",
      'export class WelcomeEmail extends BaseEmail { subject() { return "Welcome"; } }',
    ]);
    graph = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    graph?.close();
    graph = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `base -> override` for every interface-impl edge out of a file's nodes, by qualified name (and file, when another). */
  function overrides(file: string): string[] {
    const g = graph!;
    const out: string[] = [];
    const label = (id: string) => {
      const n = g.getNode(id)!;
      return `${n.isStatic ? 'static ' : ''}${n.qualifiedName}${n.filePath === file ? '' : ` (${path.basename(n.filePath)})`}`;
    };
    for (const node of g.getNodesInFile(file)) {
      for (const e of g.getOutgoingEdges(node.id)) {
        if (e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl') out.push(`${label(e.source)} -> ${label(e.target)}`);
      }
    }
    return out.sort();
  }

  const sameFile = ['Widget::render -> Button::render', 'static Widget::create -> static Button::create'];

  it('in a .tsx file, statics to statics', () => {
    expect(overrides('src/widgets.tsx')).toEqual(sameFile);
  });

  it('in a .jsx file, statics to statics', () => {
    expect(overrides('src/widgets.jsx')).toEqual(sameFile);
  });

  it('from a .ts interface and abstract base to the .tsx class implementing them', () => {
    expect(overrides('src/shape.ts')).toEqual([
      'Figure::draw -> Circle::draw (Circle.tsx)',
      'Shape::area -> Circle::area (Circle.tsx)',
    ]);
  });

  it('from a .tsx base to the .ts class extending it', () => {
    expect(overrides('src/BaseEmail.tsx')).toEqual(['BaseEmail::subject -> WelcomeEmail::subject (WelcomeEmail.ts)']);
  });
});
