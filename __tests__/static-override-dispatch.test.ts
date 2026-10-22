import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe.each(['ts', 'js'])('static and instance override dispatch: %s (#2761)', (ext) => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-static-override-'));
    fs.writeFileSync(path.join(root, `classes.${ext}`), `
class InstanceBase { s() {} }
class StaticDerived extends InstanceBase { static s() {} }
class StaticBase { static s() {} }
class InstanceDerived extends StaticBase { s() {} }
class MixedBase {
  static s() {}
  s() {}
}
class StaticOnly extends MixedBase { static s() {} }
class InstanceOnly extends MixedBase { s() {} }
class FieldBase {
  run = () => {};
  static start = () => {};
}
class FieldDerived extends FieldBase {
  static run = () => {};
  start = () => {};
}
`);
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function dispatchesFrom(owner: string, name = 's') {
    const methods = cg.getNodesByName(name)
      .filter((n) => n.kind === 'method' && n.qualifiedName === `${owner}::${name}`);
    expect(methods, `${owner}::${name}`).not.toHaveLength(0);
    return methods.flatMap((n) => cg.getOutgoingEdges(n.id)
        .filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
        .map((e) => {
          const target = cg.getNode(e.target)!;
          return [n.isStatic, target.qualifiedName, target.isStatic];
        }));
  }

  it('records static and instance methods separately', () => {
    const methods = cg.getNodesByName('s')
      .filter((n) => n.kind === 'method' && n.qualifiedName === 'MixedBase::s')
      .sort((a, b) => a.startLine - b.startLine);
    expect(methods.map((n) => n.isStatic)).toEqual([true, false]);
  });

  it('does not dispatch an instance base method to a static method', () => {
    expect(dispatchesFrom('InstanceBase')).toEqual([]);
  });

  it('does not dispatch a static base method to an instance method', () => {
    expect(dispatchesFrom('StaticBase')).toEqual([]);
  });

  it('keeps same-kind links when both namespaces share a method name', () => {
    expect(dispatchesFrom('MixedBase')).toEqual(expect.arrayContaining([
      [true, 'StaticOnly::s', true],
      [false, 'InstanceOnly::s', false],
    ]));
    expect(dispatchesFrom('MixedBase')).toHaveLength(2);
  });

  it('also keeps callable class fields in their own namespace', () => {
    expect(dispatchesFrom('FieldBase', 'run')).toEqual([]);
    expect(dispatchesFrom('FieldBase', 'start')).toEqual([]);
  });
});

it('keeps Java instance overrides whose annotation text mentions static (#2761)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-static-override-java-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'Classes.java'), `
class Base {
  @SuppressWarnings("static") public void run() {}
}
class Derived extends Base {
  @Override public void run() {}
}
`);
    cg = await CodeGraph.init(root, { index: true });
    const base = cg.getNodesByName('run').find((n) => n.qualifiedName === 'Base::run');
    const derived = cg.getNodesByName('run').find((n) => n.qualifiedName === 'Derived::run');
    expect(base).toBeDefined();
    expect(derived).toBeDefined();
    expect(cg.getOutgoingEdges(base!.id)).toContainEqual(expect.objectContaining({
      kind: 'calls', target: derived!.id,
      metadata: expect.objectContaining({ synthesizedBy: 'interface-impl' }),
    }));
  } finally {
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
