import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root: string | undefined;
let graph: CodeGraph | undefined;
afterEach(() => {
  graph?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
async function project(files: Record<string, string>): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-constructors-'));
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
  graph = await CodeGraph.init(root, { index: true });
  return graph;
}
function callees(cg: CodeGraph, name: string): string[] {
  const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find(n => n.name === name)!;
  return cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls')
    .map(e => { const n = cg.getNode(e.target)!; return `${n.filePath}:${n.qualifiedName}`; }).sort();
}

describe.each(['js', 'ts', 'jsx', 'tsx'])('imported constructor identity (%s)', ext => {
  it.each([false, true])('follows a named alias with a competing method = %s', decoy => {
    return project({
      ['left.' + ext]: 'export class Left { show() { return "left"; } }',
      ...(decoy ? { ['right.' + ext]: 'export class Right { show() { return "right"; } }' } : {}),
      ['consumer.' + ext]: `import { Left as Known } from './left'; export function invoke() { const item = new Known(); return item.show(); }`,
    }).then(cg => expect(callees(cg, 'invoke')).toContain(`left.${ext}:Left::show`));
  });

  it('pins an unaliased import to its declaring file even with same-named classes', async () => {
    const cg = await project({
      ['left.' + ext]: 'export class Shared { show() { return "left"; } }',
      ['right.' + ext]: 'export class Shared { show() { return "right"; } }',
      ['consumer.' + ext]: `import { Shared } from './left'; export function invoke() { const item = new Shared(); return item.show(); }`,
    });
    expect(callees(cg, 'invoke')).toContain(`left.${ext}:Shared::show`);
    expect(callees(cg, 'invoke')).not.toContain(`right.${ext}:Shared::show`);
  });

  it.each([
    'export function invoke(Known) { const item = new Known(); return item.show(); }',
    'export function invoke({ Known }) { const item = new Known(); return item.show(); }',
    'export function invoke({ ctor: Known }) { const item = new Known(); return item.show(); }',
    'export function invoke() { try { throw unknown; } catch (Known) { const item = new Known(); return item.show(); } }',
    'export function invoke() { return values.map(Known => { const item = new Known(); return item.show(); }); }',
    'export function invoke() { const Known = factory(); const item = new Known(); return item.show(); }',
    'export function invoke() { let item = new Known(); item = factory(); return item.show(); }',
    'export function invoke() { let item = new Known(); item += 1; return item.show(); }',
    'export function invoke() { let item = new Known(); item ||= factory(); return item.show(); }',
    'export function invoke() { let item = new Known(); [item] = factory(); return item.show(); }',
    'export function invoke() { let item = new Known(); const msg = `${item = factory()}`; return item.show(); }',
    'export function invoke(item) { return item.show(); }',
  ])('does not turn an unknown or shadowed receiver into the imported class: %s', body => {
    return project({
      ['left.' + ext]: 'export class Left { show() { return "left"; } }',
      ['right.' + ext]: 'export class Right { show() { return "right"; } }',
      ['consumer.' + ext]: `import { Left as Known } from './left'; ${body}`,
    }).then(cg => expect(callees(cg, 'invoke').filter(n => n.endsWith('::show'))).toEqual([]));
  });

  it('does not select a decoy method absent from the imported class', async () => {
    const cg = await project({
      ['left.' + ext]: 'export class Left {}',
      ['right.' + ext]: 'export class Right { show() {} }',
      ['consumer.' + ext]: `import { Left as Known } from './left'; export function invoke() { const item = new Known(); return item.show(); }`,
    });
    expect(callees(cg, 'invoke').filter(n => n.endsWith('::show'))).toEqual([]);
  });

  it('follows a default import, a re-export and the exact superclass', async () => {
    const cg = await project({
      ['base.' + ext]: 'export class Base { show() {} }',
      ['left.' + ext]: `import { Base } from './base'; export default class Left extends Base {}`,
      ['barrel.' + ext]: `export { default as Known } from './left';`,
      ['decoy.' + ext]: 'export class Base { show() {} }',
      ['consumer.' + ext]: `import { Known } from './barrel'; export function invoke() { const item = new Known(); return item.show(); }`,
    });
    expect(callees(cg, 'invoke')).toContain(`base.${ext}:Base::show`);
    expect(callees(cg, 'invoke')).not.toContain(`decoy.${ext}:Base::show`);
  });

  it('retains a known local class shadowing the constructor import', async () => {
    const cg = await project({
      ['left.' + ext]: 'export class Left { show() {} }',
      ['consumer.' + ext]: `import { Left as Known } from './left'; export function invoke() { class Known { show() {} } const item = new Known(); return item.show(); }`,
    });
    expect(callees(cg, 'invoke').some(n => n.startsWith('consumer.' + ext + ':') && n.endsWith('Known::show'))).toBe(true);
    expect(callees(cg, 'invoke')).not.toContain(`left.${ext}:Left::show`);
  });
});

it('preserves calls through an imported TypeScript parameter type', async () => {
  const cg = await project({
    'left.ts': 'export class Left { show() {} }',
    'consumer.ts': `import { Left } from './left'; export function invoke(item: Left) { return item.show(); }`,
  });
  expect(callees(cg, 'invoke')).toContain('left.ts:Left::show');
});

describe.each(['js', 'ts', 'jsx', 'tsx'])('explicit superclass calls (%s)', ext => {
  it.each(['run() { return super.run(); }', 'work() { return super.run(); }', 'run() { return super\n .run(); }', 'run() { return super\n\n\n\n\n .run(); }', 'run() { return `${super.run()}`; }', 'run() { return super /* parent */ .run(); }'])('reaches the parent: %s', body => {
    return project({
      ['base.' + ext]: 'export class Base { run() { return 1; } }',
      ['decoy.' + ext]: 'export class Base { run() { return 2; } }',
      ['child.' + ext]: `import { Base } from './base'; export class Child extends Base { ${body} }`,
    }).then(cg => {
      // Locate the child explicitly: Base also declares run.
      const child = cg.getNodesInFile('child.' + ext).find(n => n.kind === 'method')!;
      const edges = cg.getOutgoingEdges(child.id).filter(e => e.kind === 'calls');
      expect(edges.map(e => cg.getNode(e.target)!.filePath)).toContain('base.' + ext);
      expect(edges.some(e => e.target === child.id)).toBe(false);
      expect(edges.map(e => cg.getNode(e.target)!.filePath)).not.toContain('decoy.' + ext);
    });
  });

  it('preserves genuine recursion on the same line as a super call', async () => {
    const cg = await project({
      ['base.' + ext]: 'export class Base { run() {} }',
      ['child.' + ext]: `import { Base } from './base'; export class Child extends Base { run(n) { super.run(); if (n) this.run(n - 1); } }`,
    });
    const child = cg.getNodesInFile('child.' + ext).find(n => n.kind === 'method')!;
    expect(cg.getOutgoingEdges(child.id)).toContainEqual(expect.objectContaining({ kind: 'calls', target: child.id }));
  });

  it('leaves an external parent unresolved instead of picking a namesake', async () => {
    const cg = await project({
      ['decoy.' + ext]: 'export class Local { run() {} }',
      ['child.' + ext]: `import { Base } from 'external-package'; export class Child extends Base { run() { return super.run(); } }`,
    });
    const child = cg.getNodesInFile('child.' + ext).find(n => n.kind === 'method')!;
    expect(cg.getOutgoingEdges(child.id).filter(e => e.kind === 'calls')).toEqual([]);
  });
});
