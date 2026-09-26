/** Kotlin anonymous objects: negative shapes and traversal/ownership regressions. */
import { describe, it, expect, beforeAll } from 'vitest';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['kotlin']);
});

function extract(source: string) {
  const tree = getParser('kotlin')!.parse(source)!;
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
  tree.delete();
  const result = new TreeSitterExtractor('src/Probe.kt', source, 'kotlin').extract();
  expect(result.errors).toEqual([]);
  return result;
}

const classes = (r: ReturnType<typeof extract>) => r.nodes.filter(n => n.kind === 'class' && n.name.includes('$anon@'));
const refs = (r: ReturnType<typeof extract>, kind: string) => r.unresolvedReferences.filter(r => r.referenceKind === kind);

describe('Kotlin object literals', () => {
  it.each(['val value = ', 'fun create() = '])('keeps constructor argument calls in the enclosing scope: %s', prefix => {
    const r = extract(`${prefix}object : IFoo.Stub(computeArg()) { override fun run() { bodyCall() }; }`);
    const arg = refs(r, 'calls').filter(x => x.referenceName === 'computeArg');
    expect(arg).toHaveLength(1);
    expect(arg[0]!.fromNodeId).not.toBe(classes(r)[0]!.id);
    const run = r.nodes.find(n => n.name === 'run')!;
    expect(refs(r, 'calls').find(x => x.referenceName === 'bodyCall')?.fromNodeId).toBe(run.id);
  });

  it('extracts delegated interface identity without treating delegate calls as supertypes', () => {
    const r = extract('fun create() = object : api.IFoo by (makeDelegate()), Marker {}');
    expect(refs(r, 'extends').map(x => x.referenceName)).toEqual(['api.IFoo', 'Marker']);
    expect(refs(r, 'instantiates')).toEqual([]);
    expect(refs(r, 'calls').filter(x => x.referenceName === 'makeDelegate')).toHaveLength(1);
  });

  it('keeps generic outer and inner type segments while excluding type arguments', () => {
    const r = extract('val x = object : pkg.Outer<IFoo.Stub>.Inner<List<String>>() {}');
    expect(refs(r, 'extends').map(x => x.referenceName)).toEqual(['pkg.Outer.Inner']);
    expect(refs(r, 'instantiates').map(x => x.referenceName)).toEqual(['pkg.Outer.Inner']);
  });

  it('preserves nested members and calls of objects without explicit supertypes', () => {
    const r = extract(`fun create() = object {
      fun outer() { outerCall() }
      val child = object : IFoo.Stub() {
        override fun inner() { innerCall() }
      }
    }`);
    expect(classes(r)).toHaveLength(2);
    for (const name of ['outer', 'inner']) {
      const members = r.nodes.filter(n => n.name === name);
      expect(members).toHaveLength(1);
      expect(refs(r, 'calls').find(x => x.referenceName === `${name}Call`)?.fromNodeId).toBe(members[0]!.id);
      expect(r.edges.filter(e => e.kind === 'contains' && e.target === members[0]!.id)).toHaveLength(1);
    }
  });

  it('does not merge two same-supertype anonymous objects on one line', () => {
    const r = extract('val x = object : Base() { val child = object : Base() {}; }');
    expect(classes(r)).toHaveLength(2);
    expect(new Set(classes(r).map(n => n.id)).size).toBe(2);
    expect(refs(r, 'extends').map(x => x.fromNodeId)).toEqual(classes(r).map(n => n.id));
  });

  it('keeps same-line same-name members in distinct anonymous owners', () => {
    const r = extract('val x = object : Base() { fun run() { outerCall() }; val child = object : Base() { fun run() { innerCall() }; }; }');
    const members = r.nodes.filter(n => n.name === 'run');
    expect(members).toHaveLength(2);
    expect(new Set(members.map(n => n.id)).size).toBe(2);
    expect(refs(r, 'calls').find(x => x.referenceName === 'outerCall')?.fromNodeId).toBe(members[0]!.id);
    expect(refs(r, 'calls').find(x => x.referenceName === 'innerCall')?.fromNodeId).toBe(members[1]!.id);
  });

  it('visits an anonymous object in a constructor argument exactly once', () => {
    const r = extract(`fun create() = object : Base(object : Callback {
      override fun invoke() { callbackCall() }
    }) { fun own() { ownCall() }; }`);
    expect(classes(r)).toHaveLength(2);
    expect(r.nodes.filter(n => n.name === 'invoke')).toHaveLength(1);
    expect(refs(r, 'calls').filter(x => x.referenceName === 'callbackCall')).toHaveLength(1);
  });

  it('chooses the sole constructor after an interface and ignores generic argument decoys', () => {
    const r = extract('val x = object : Marker<IFoo.Stub>, pkg.Real.Stub(), Other {}');
    expect(refs(r, 'extends').map(x => x.referenceName)).toEqual(['Marker', 'pkg.Real.Stub', 'Other']);
    expect(refs(r, 'instantiates').map(x => x.referenceName)).toEqual(['pkg.Real.Stub']);
  });

  it('does not classify companion or named objects as anonymous literals', () => {
    const r = extract(`class Host {
      companion object : Marker {}
      object Named : Marker {}
      val value = object : Marker { fun run() {}; }
    }`);
    expect(classes(r)).toHaveLength(1);
    expect(r.nodes.filter(n => n.name === 'run')).toHaveLength(1);
  });

  it('does not throw for incomplete objects or syntactically accepted multiple constructors', () => {
    for (const source of ['val x = object :', 'val x = object : Base( {', 'val x = object : A(), B() {}']) {
      expect(() => new TreeSitterExtractor('Bad.kt', source, 'kotlin').extract()).not.toThrow();
    }
  });
});
