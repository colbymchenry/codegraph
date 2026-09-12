import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { extractReExports } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell resolution round 2', () => {
  let tmpDir: string | undefined;
  const openGraphs = new Set<CodeGraph>();

  afterEach(() => {
    for (const current of openGraphs) {
      try { current.destroy(); } catch { /* already closed */ }
    }
    openGraphs.clear();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const createGraph = async (files: Record<string, string>): Promise<CodeGraph> => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-r2-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    const graph = CodeGraph.initSync(tmpDir);
    openGraphs.add(graph);
    await graph.indexAll();
    return graph;
  };

  const nodeAt = (graph: CodeGraph, name: string, filePath: string) =>
    graph.getNodesByName(name).find((candidate) => candidate.filePath === filePath)!;

  const outgoingTargets = (graph: CodeGraph, owner: string, filePath: string) => {
    const node = nodeAt(graph, owner, filePath);
    return graph.getOutgoingEdges(node.id).map((edge) => ({
      edge,
      target: graph.getNode(edge.target)!,
    }));
  };

  it('resolves wildcard, qualified, prefix, and dash-prefixed symbolic operators', async () => {
    const graph = await createGraph({
      'Ops.hs': [
        'module Ops ((<+>), (-->), (--⊕)) where',
        '(<+>) x _ = x',
        '(-->) x _ = x',
        '(--⊕) x _ = x',
      ].join('\n'),
      'Wildcard.hs': [
        'module Wildcard where',
        'import Ops',
        'wild x y = x <+> y',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import qualified Ops as O',
        'qualified x y = x O.<+> y',
        'prefix x y = (O.<+>) x y',
      ].join('\n'),
      'Explicit.hs': [
        'module Explicit where',
        'import Ops (',
        '  (<+>), --- an ordinary three-dash comment, not an operator',
        '  (-->),',
        '  (--⊕)',
        ')',
        'arrow x y = x --> y',
        'unicodeArrow x y = x --⊕ y',
      ].join('\n'),
    });
      const operator = nodeAt(graph, '(<+>)', 'Ops.hs');
      for (const [owner, filePath] of [
        ['wild', 'Wildcard.hs'],
        ['qualified', 'Qualified.hs'],
        ['prefix', 'Qualified.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ edge, target }) => edge.kind === 'calls' && target.id === operator.id)).toBe(true);
      }
      const arrow = nodeAt(graph, '(-->)', 'Ops.hs');
      expect(outgoingTargets(graph, 'arrow', 'Explicit.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === arrow.id)).toBe(true);
      const unicodeArrow = nodeAt(graph, '(--⊕)', 'Ops.hs');
      expect(outgoingTargets(graph, 'unicodeArrow', 'Explicit.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === unicodeArrow.id)).toBe(true);
  });

  it('resolves constructor operators containing the graph hierarchy delimiter', async () => {
    const graph = await createGraph({
      'A.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module A (T((:::))) where',
        'data T a b = a ::: b',
      ].join('\n'),
      'B.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module B where',
        'import A (T((:::)))',
        'import qualified A as X',
        'direct a b = a ::: b',
        'qualified a b = a X.::: b',
        'mapped values = map (:::) values',
        'mappedQualified values = map (X.:::) values',
      ].join('\n'),
    });
      const constructor = graph.getNodesByName('(:::)')
        .find((node) => node.filePath === 'A.hs' && node.kind === 'enum_member')!;
      expect(constructor).toBeDefined();
      expect(constructor.qualifiedName).toBe('A::T::(:::)');
      for (const owner of ['direct', 'qualified']) {
        expect(outgoingTargets(graph, owner, 'B.hs')
          .some(({ target }) => target.id === constructor.id)).toBe(true);
      }
      for (const owner of ['mapped', 'mappedQualified']) {
        const edges = outgoingTargets(graph, owner, 'B.hs')
          .filter(({ target }) => target.id === constructor.id);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.edge.kind).toBe('calls');
      }
  });

  it('does not resolve imported operators shadowed by prefix pattern binders', async () => {
    const graph = await createGraph({
      'Ops.hs': [
        'module Ops ((<::>)) where',
        '(<::>) x _ = x',
      ].join('\n'),
      'Main.hs': [
        'module Main where',
        'import Ops ((<::>))',
        'f (<::>) = (<::>) 1 2',
        'g = \\(<::>) -> (<::>) 1 2',
        'control x = (<::>) x x',
      ].join('\n'),
    });
      const imported = nodeAt(graph, '(<::>)', 'Ops.hs');
      expect(imported).toBeDefined();
      for (const owner of ['f', 'g']) {
        expect(outgoingTargets(graph, owner, 'Main.hs')
          .some(({ target }) => target.id === imported.id)).toBe(false);
      }
      expect(outgoingTargets(graph, 'control', 'Main.hs')
        .filter(({ target }) => target.id === imported.id))
        .toEqual([expect.objectContaining({ edge: expect.objectContaining({ kind: 'calls' }) })]);
  });

  it('keeps Unicode constructors single-edged through higher-order calls', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (T(..)) where',
        'data T = Éclair Int',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Origin (T(..))',
        'a xs = map Éclair xs',
        'b f = f Éclair',
        'd x = Éclair x',
      ].join('\n'),
    });
      const constructor = nodeAt(graph, 'Éclair', 'Origin.hs');
      const edgesToConstructor = (owner: string) => outgoingTargets(graph, owner, 'Consumer.hs')
        .filter(({ target }) => target.id === constructor.id)
        .map(({ edge }) => edge.kind);
      expect(edgesToConstructor('a')).toEqual(['calls']);
      expect(edgesToConstructor('b')).toEqual(['references']);
      expect(edgesToConstructor('d')).toEqual(['calls']);
  });

  it('resolves imported Unicode Other_Letter identifiers end to end', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (函数) where',
        '函数 value = value',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Origin (函数)',
        'run = 函数 1',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import qualified Origin as O',
        'runQualified = O.函数 1',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (module Origin) where',
        'import Origin',
      ].join('\n'),
      'FacadeConsumer.hs': [
        'module FacadeConsumer where',
        'import Facade (函数)',
        'runFacade = 函数 1',
      ].join('\n'),
    });
      const target = nodeAt(graph, '函数', 'Origin.hs');
      expect(target).toBeDefined();
      for (const [owner, filePath] of [
        ['run', 'Consumer.hs'],
        ['runQualified', 'Qualified.hs'],
        ['runFacade', 'FacadeConsumer.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .filter(({ target: candidate }) => candidate.id === target.id))
          .toEqual([expect.objectContaining({ edge: expect.objectContaining({ kind: 'calls' }) })]);
      }
  });

  it('distinguishes a nullary class selector from its same-qualified instance method', async () => {
    const graph = await createGraph({
      'Ops.hs': [
        '{-# LANGUAGE NullaryTypeClasses #-}',
        'module Ops (C(..), use, qualifiedUse) where',
        'class C where',
        '  act :: Int -> Int',
        'instance C where',
        '  act value = if value == 0 then value else act (value - 1)',
        'class C => D',
        'use value = act value',
        'qualifiedUse value = Ops.act value',
      ].join('\n'),
    });
      const methods = graph.getNodesByName('act').filter((node) => node.kind === 'method');
      const containingNode = (nodeId: string) => {
        const edge = graph.getIncomingEdges(nodeId).find((candidate) => candidate.kind === 'contains');
        return edge ? graph.getNode(edge.source) : null;
      };
      const selector = methods.find((node) => containingNode(node.id)?.kind === 'trait')!;
      const implementation = methods.find((node) =>
        containingNode(node.id)?.decorators?.includes('haskell-instance')
      )!;
      expect(selector).toBeDefined();
      expect(implementation).toBeDefined();
      // The collision is the point of the regression: text-only owner lookup
      // cannot tell these two nodes apart.
      expect(selector.qualifiedName).toBe(implementation.qualifiedName);

      const cClass = containingNode(selector.id)!;
      const instanceClass = containingNode(implementation.id)!;
      const dClass = graph.getNodesByName('D').find((node) => node.kind === 'trait')!;
      expect(graph.getOutgoingEdges(instanceClass.id)).toContainEqual(expect.objectContaining({
        kind: 'implements',
        target: cClass.id,
      }));
      expect(graph.getOutgoingEdges(dClass.id)).toContainEqual(expect.objectContaining({
        kind: 'extends',
        target: cClass.id,
      }));

      for (const owner of ['use', 'qualifiedUse']) {
        const calls = outgoingTargets(graph, owner, 'Ops.hs')
          .filter(({ edge }) => edge.kind === 'calls');
        expect(calls.some(({ target }) => target.id === selector.id)).toBe(true);
        expect(calls.some(({ target }) => target.id === implementation.id)).toBe(false);
      }
      expect(graph.getOutgoingEdges(implementation.id).some((edge) =>
        edge.kind === 'calls' && edge.target === implementation.id
      )).toBe(true);
  });

  it('resolves local symbolic class constraints and instance heads', async () => {
    const graph = await createGraph({
      'Classes.hs': [
        '{-# LANGUAGE TypeOperators, MultiParamTypeClasses, FlexibleContexts, FlexibleInstances, ConstraintKinds #-}',
        'module Classes where',
        'class a <::> b',
        'class (a <::> b) => Child a b',
        'instance Int <::> Bool',
        'type Both a = (Eq a, Show a)',
        'class Both a => Aliased a',
      ].join('\n'),
    });
      const operatorClass = graph.getNodesByName('(<::>)')
        .find((node) => node.kind === 'trait')!;
      const child = graph.getNodesByName('Child').find((node) => node.kind === 'trait')!;
      const instance = graph.getNodesByKind('class')
        .find((node) => node.decorators?.includes('haskell-instance'))!;
      expect(operatorClass).toBeDefined();
      expect(child).toBeDefined();
      expect(instance).toBeDefined();
      expect(graph.getOutgoingEdges(child.id)).toContainEqual(expect.objectContaining({
        kind: 'extends',
        target: operatorClass.id,
      }));
      expect(graph.getOutgoingEdges(instance.id)).toContainEqual(expect.objectContaining({
        kind: 'implements',
        target: operatorClass.id,
      }));
      const constraintAlias = graph.getNodesByName('Both')
        .find((node) => node.kind === 'type_alias')!;
      const aliasedClass = graph.getNodesByName('Aliased')
        .find((node) => node.kind === 'trait')!;
      expect(graph.getOutgoingEdges(aliasedClass.id)).toContainEqual(expect.objectContaining({
        kind: 'extends',
        target: constraintAlias.id,
      }));
  });

  it('resolves prefix and backtick calls to an exported backtick-defined function', async () => {
    const graph = await createGraph({
      'A.hs': [
        'module A (foo, sommé) where',
        'foo :: Int -> Int -> Int',
        'x `foo` y = x + y',
        'sommé :: Int -> Int -> Int',
        'x `sommé` y = x + y',
      ].join('\n'),
      'B.hs': [
        'module B where',
        'import A (foo, sommé)',
        'bar x y = x `foo` y',
        'baz = foo 1 2',
        'unicodeInfix x y = x `sommé` y',
        'unicodePrefix = sommé 1 2',
      ].join('\n'),
    });
      const foo = nodeAt(graph, 'foo', 'A.hs');
      expect(foo).toEqual(expect.objectContaining({
        kind: 'function',
        signature: 'foo :: Int -> Int -> Int',
        isExported: true,
      }));
      expect(graph.getNodesByName('(`foo`)')).toHaveLength(0);
      for (const owner of ['bar', 'baz']) {
        expect(outgoingTargets(graph, owner, 'B.hs').filter(
          ({ edge, target }) => edge.kind === 'calls' && target.id === foo.id,
        )).toHaveLength(1);
      }
      const unicode = nodeAt(graph, 'sommé', 'A.hs');
      for (const owner of ['unicodeInfix', 'unicodePrefix']) {
        expect(outgoingTargets(graph, owner, 'B.hs').filter(
          ({ edge, target }) => edge.kind === 'calls' && target.id === unicode.id,
        )).toHaveLength(1);
      }
  });

  it('resolves Unicode module, alias, value, and symbolic operator names', async () => {
    const graph = await createGraph({
      'non-mirrored-source.hs': [
        'module Éclair.Opérateurs (sommé, (⊕)) where',
        'sommé value = value',
        '(⊕) left _ = left',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import qualified Éclair.Opérateurs as É',
        'viaValue = É.sommé 1',
        'viaOperator = 1 É.⊕ 2',
      ].join('\n'),
    });
      const value = nodeAt(graph, 'sommé', 'non-mirrored-source.hs');
      const operator = nodeAt(graph, '(⊕)', 'non-mirrored-source.hs');
      expect(value.qualifiedName).toBe('Éclair.Opérateurs::sommé');
      expect(operator.qualifiedName).toBe('Éclair.Opérateurs::(⊕)');
      expect(outgoingTargets(graph, 'viaValue', 'Consumer.hs').some(
        ({ edge, target }) => edge.kind === 'calls' && target.id === value.id,
      )).toBe(true);
      expect(outgoingTargets(graph, 'viaOperator', 'Consumer.hs').some(
        ({ edge, target }) => edge.kind === 'calls' && target.id === operator.id,
      )).toBe(true);
  });

  it('resolves MagicHash identifiers without treating the hash as an operator', async () => {
    const graph = await createGraph({
      'A.hs': [
        '{-# LANGUAGE MagicHash #-}',
        'module A (foo#, Int#) where',
        'data Int# = BoxedInt',
        'foo# value = value',
      ].join('\n'),
      'B.hs': [
        '{-# LANGUAGE MagicHash #-}',
        'module B where',
        'import A (foo#, Int#)',
        'run value = foo# value',
      ].join('\n'),
    });
      const target = nodeAt(graph, 'foo#', 'A.hs');
      expect(target).toBeDefined();
      expect(outgoingTargets(graph, 'run', 'B.hs').some(
        ({ edge, target: actual }) => edge.kind === 'calls' && actual.id === target.id,
      )).toBe(true);
      expect(graph.getNodesByName('Int#').some((node) => node.filePath === 'A.hs')).toBe(true);
  });

  it('resolves exported alphabetic infix classes, constructors, and pattern synonyms', async () => {
    const graph = await createGraph({
      'A.hs': [
        '{-# LANGUAGE MultiParamTypeClasses, PatternSynonyms, TypeOperators #-}',
        'module A (Rel(..), Wrapped(WrappedBy), pattern Pair) where',
        'class a `Rel` b where',
        '  relate :: a -> b -> Bool',
        'data Wrapped a b = a `WrappedBy` b',
        'pattern Pair :: a -> b -> (a, b)',
        'pattern left `Pair` right = (left, right)',
      ].join('\n'),
      'B.hs': [
        '{-# LANGUAGE MultiParamTypeClasses, PatternSynonyms, TypeOperators #-}',
        'module B where',
        'import A (Rel(..), Wrapped(WrappedBy), pattern Pair)',
        'instance String `Rel` Bool where',
        '  relate _ _ = True',
        'viaConstructor left right = left `WrappedBy` right',
        'viaPattern left right = left `Pair` right',
      ].join('\n'),
    });
      const target = (name: string, kind: string) => graph.getNodesByName(name)
        .find((node) => node.filePath === 'A.hs' && node.kind === kind)!;
      const rel = target('Rel', 'trait');
      const instance = nodeAt(graph, 'String `Rel` Bool', 'B.hs');
      expect(graph.getOutgoingEdges(instance.id).filter((edge) =>
        edge.kind === 'implements' && edge.target === rel.id)).toHaveLength(1);

      for (const [owner, name] of [
        ['viaConstructor', 'WrappedBy'],
        ['viaPattern', 'Pair'],
      ] as const) {
        const expected = target(name, 'enum_member');
        expect(outgoingTargets(graph, owner, 'B.hs').filter(({ edge, target: actual }) =>
          edge.kind === 'calls' && actual.id === expected.id)).toHaveLength(1);
        expect(outgoingTargets(graph, owner, 'B.hs').some(({ edge, target: actual }) =>
          edge.kind === 'references' && actual.id === expected.id)).toBe(false);
      }
  });

  it('does not let quasiquoted import text make a real import ambiguous', async () => {
    const graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo value = value + 1\n',
      'C.hs': 'module C (foo) where\nfoo value = value + 2\n',
      'B.hs': [
        '{-# LANGUAGE QuasiQuotes #-}',
        'module B where',
        'import A (foo)',
        'blob = [r|',
        'import C (foo)',
        '|]',
        'unicodeBlob = [λ|',
        'import C (foo)',
        '|]',
        'run = foo 1',
      ].join('\n'),
    });
      const runTargets = outgoingTargets(graph, 'run', 'B.hs')
        .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'foo');
      expect(runTargets).toHaveLength(1);
      expect(runTargets[0]!.target.filePath).toBe('A.hs');
  });

  it('keeps instance implementations lexical only inside their own equation', async () => {
    const graph = await createGraph({
      'Class.hs': [
        'module Class (C (..)) where',
        'class C a where',
        '  action :: a -> a',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Class (C (..))',
        'instance C Int where',
        '  action 0 = 0',
        '  action x = action (x - 1)',
        'use x = action x',
      ].join('\n'),
    });
      const selector = nodeAt(graph, 'action', 'Class.hs');
      const implementation = nodeAt(graph, 'action', 'Consumer.hs');
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === selector.id)).toBe(true);
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ target }) => target.id === implementation.id)).toBe(false);
      expect(graph.getOutgoingEdges(implementation.id)
        .some((edge) => edge.kind === 'calls' && edge.target === implementation.id)).toBe(true);
  });

  it('resolves local, imported, and self-qualified record selectors and symbols', async () => {
    const graph = await createGraph({
      'Person.hs': [
        'module Person where',
        'data Person = Person { personName :: String }',
        'helper x = x',
        'local p = personName p',
        'selfField p = Person.personName p',
        'selfFunction = Person.helper 1',
        'selfConstructor = Person.Person "Ada"',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Person (Person (..))',
        'mapped xs = map personName xs',
      ].join('\n'),
    });
      const field = nodeAt(graph, 'personName', 'Person.hs');
      const helper = nodeAt(graph, 'helper', 'Person.hs');
      const constructor = graph.getNodesByName('Person')
        .find((node) => node.filePath === 'Person.hs' && node.kind === 'enum_member')!;
      for (const owner of ['local', 'selfField']) {
        expect(outgoingTargets(graph, owner, 'Person.hs')
          .some(({ target }) => target.id === field.id)).toBe(true);
      }
      expect(outgoingTargets(graph, 'selfFunction', 'Person.hs')
        .some(({ target }) => target.id === helper.id)).toBe(true);
      expect(outgoingTargets(graph, 'selfConstructor', 'Person.hs')
        .some(({ target }) => target.id === constructor.id)).toBe(true);
      expect(outgoingTargets(graph, 'mapped', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === field.id)).toBe(true);
  });

  it('uses source position to distinguish repeated local helper scopes', async () => {
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        'run b = if b',
        '  then let helper x = x',
        '       in helper 1',
        '  else let helper x = x + 1',
        '       in helper 2',
        'equations True = helper 1 where helper x = x',
        'equations False = helper 2 where helper x = x + 1',
      ].join('\n'),
    });
      const assertPositionedCalls = (owner: string, expected: Array<[number, number]>) => {
        const calls = outgoingTargets(graph, owner, 'Main.hs')
          .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper')
          .map(({ edge, target }) => [edge.line, target.startLine] as [number | undefined, number]);
        expect(calls).toEqual(expect.arrayContaining(expected));
      };
      assertPositionedCalls('run', [[4, 3], [6, 5]]);
      assertPositionedCalls('equations', [[7, 7], [8, 8]]);
  });

  it('resolves data-family instance constructors through Family(..)', async () => {
    const graph = await createGraph({
      'Family.hs': [
        '{-# LANGUAGE TypeFamilies #-}',
        'module Family (Family (..)) where',
        'data family Family a',
        'data instance Family Int = FamilyInt Int',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Family (Family (..))',
        'run = FamilyInt 1',
      ].join('\n'),
    });
      const constructor = nodeAt(graph, 'FamilyInt', 'Family.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === constructor.id)).toBe(true);
  });

  it('keeps re-export cycle detection local to each alternative branch', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin (foo) where\nfoo x = x\n',
      'A.hs': 'module A (module Origin) where\nimport Origin\n',
      'B.hs': 'module B (module Origin) where\nimport Origin\n',
      'Facade.hs': [
        'module Facade (module A, module B) where',
        'import A hiding (foo)',
        'import B',
      ].join('\n'),
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
      const foo = nodeAt(graph, 'foo', 'Origin.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === foo.id)).toBe(true);
  });

  it('follows Haskell re-export chains deeper than eight modules', async () => {
    const files: Record<string, string> = {
      'M0.hs': 'module M0 (foo) where\nfoo x = x\n',
    };
    for (let index = 1; index <= 12; index++) {
      files[`M${index}.hs`] = [
        `module M${index} (module M${index - 1}) where`,
        `import M${index - 1}`,
      ].join('\n');
    }
    files['Consumer.hs'] = 'module Consumer where\nimport M12 (foo)\nrun = foo 1\n';
    const graph = await createGraph(files);
      const foo = nodeAt(graph, 'foo', 'M0.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === foo.id)).toBe(true);
  });

  it('keeps high-fanout Haskell facades compact while resolving a local origin', async () => {
    const exportedNames = [
      'target',
      ...Array.from({ length: 120 }, (_, index) => `placeholder${index}`),
      ...Array.from({ length: 40 }, (_, index) => `Type${index}(..)`),
    ];
    const facade = [
      `module Facade (${exportedNames.join(', ')}) where`,
      'import Origin',
      ...Array.from({ length: 120 }, (_, index) => `import External${index}`),
    ].join('\n');

    // An unrestricted import is a conservative possible origin for every
    // named or parent-scoped header export. Keep those unions, but never
    // materialize either full 161 x 121 product that made real GHC
    // compatibility facades quadratic.
    const routes = extractReExports(facade, 'haskell');
    expect(routes.length).toBeLessThan(300);

    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (target, Type0(..)) where',
        'target value = value',
        'data Type0 = Type0 { typeValue :: Int }',
      ].join('\n'),
      'Facade.hs': facade,
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (target, Type0(typeValue))',
        'run = target 1',
        'readType value = typeValue value',
      ].join('\n'),
    });
      const target = nodeAt(graph, 'target', 'Origin.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ edge, target: candidate }) =>
          edge.kind === 'calls' && candidate.id === target.id
        )).toBe(true);
      const typeValue = nodeAt(graph, 'typeValue', 'Origin.hs');
      expect(outgoingTargets(graph, 'readType', 'Consumer.hs')
        .some(({ edge, target: candidate }) =>
          edge.kind === 'calls' && candidate.id === typeValue.id
        )).toBe(true);
  });

  it('does not fall back to wildcard imports when an explicit Haskell import misses', async () => {
    const graph = await createGraph({
      'Local.hs': 'module Local (target) where\ntarget value = value\n',
      'Consumer.hs': [
        'module Consumer where',
        'import Local',
        'import External.Package (target)',
        'run = target 1',
      ].join('\n'),
      'Ambiguous.hs': [
        'module Ambiguous where',
        'import Local (target)',
        'import External.Package (target)',
        'runAmbiguous = target 1',
      ].join('\n'),
      'QualifiedAmbiguous.hs': [
        'module QualifiedAmbiguous where',
        'import qualified Local as X',
        'import qualified External.Package as X',
        'runQualifiedAmbiguous = X.target 1',
      ].join('\n'),
      'QualifiedRestricted.hs': [
        'module QualifiedRestricted where',
        'import qualified Local as X',
        'import qualified External.Package as X (other)',
        'runQualifiedRestricted = X.target 1',
      ].join('\n'),
    });
      const localTarget = nodeAt(graph, 'target', 'Local.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === localTarget.id)).toBe(false);
      expect(outgoingTargets(graph, 'runAmbiguous', 'Ambiguous.hs')
        .some(({ target }) => target.id === localTarget.id)).toBe(false);
      expect(outgoingTargets(graph, 'runQualifiedAmbiguous', 'QualifiedAmbiguous.hs')
        .some(({ target }) => target.id === localTarget.id)).toBe(false);
      expect(outgoingTargets(graph, 'runQualifiedRestricted', 'QualifiedRestricted.hs')
        .some(({ target }) => target.id === localTarget.id)).toBe(true);
  });

  it('combines explicit and wildcard imports by Haskell entity identity', async () => {
    const graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo value = value\n',
      'B.hs': 'module B (foo) where\nfoo value = value + 1\n',
      'Origin.hs': 'module Origin (foo) where\nfoo value = value\n',
      'FacadeA.hs': 'module FacadeA (foo) where\nimport Origin (foo)\n',
      'FacadeB.hs': 'module FacadeB (foo) where\nimport Origin (foo)\n',
      'Fields.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Fields (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'OtherField.hs': 'module OtherField (field) where\nfield value = value\n',
      'Distinct.hs': [
        'module Distinct where',
        'import A (foo)',
        'import B',
        'runDistinct = foo 1',
      ].join('\n'),
      'SameOrigin.hs': [
        'module SameOrigin where',
        'import FacadeA (foo)',
        'import FacadeB',
        'runSame = foo 1',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import A (foo)',
        'import qualified B',
        'runQualified = foo 1',
      ].join('\n'),
      'Hidden.hs': [
        'module Hidden where',
        'import A (foo)',
        'import B hiding (foo)',
        'runHidden = foo 1',
      ].join('\n'),
      'FieldAmbiguous.hs': [
        'module FieldAmbiguous where',
        'import Fields (A(field))',
        'import Fields',
        'runField value = field value',
      ].join('\n'),
      'QualifiedFieldAmbiguous.hs': [
        'module QualifiedFieldAmbiguous where',
        'import qualified Fields as X',
        'import qualified OtherField as X',
        'runQualifiedField value = X.field value',
      ].join('\n'),
    });
      const aFoo = nodeAt(graph, 'foo', 'A.hs');
      const originFoo = nodeAt(graph, 'foo', 'Origin.hs');
      expect(outgoingTargets(graph, 'runDistinct', 'Distinct.hs')
        .some(({ target }) => target.name === 'foo')).toBe(false);
      expect(outgoingTargets(graph, 'runSame', 'SameOrigin.hs')).toContainEqual(
        expect.objectContaining({ target: expect.objectContaining({ id: originFoo.id }) }),
      );
      // Both imports contribute to one scope. The explicit route selects the
      // A field, but the wildcard route still contributes both exported
      // DuplicateRecordFields selectors, so GHC rejects the use as ambiguous.
      expect(outgoingTargets(graph, 'runField', 'FieldAmbiguous.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'runQualifiedField', 'QualifiedFieldAmbiguous.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      for (const [owner, filePath] of [
        ['runQualified', 'Qualified.hs'],
        ['runHidden', 'Hidden.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)).toContainEqual(
          expect.objectContaining({ target: expect.objectContaining({ id: aFoo.id }) }),
        );
      }
  });

  it('resolves layout-split and SOURCE-qualified imports', async () => {
    const graph = await createGraph({
      'Lib/A.hs': 'module Lib.A (foo) where\nfoo value = value\n',
      'Lib/Plain.hs': 'module Lib.Plain (plain) where\nplain value = value\n',
      'Leading.hs': [
        'module Leading where',
        'import',
        '',
        '  qualified Lib.A as X',
        'runLeading = X.foo 1',
      ].join('\n'),
      'Post.hs': [
        '{-# LANGUAGE ImportQualifiedPost #-}',
        'module Post where',
        'import Lib.A',
        '',
        '  qualified',
        '  as X',
        'runPost = X.foo 1',
      ].join('\n'),
      'Source.hs': [
        'module Source where',
        'import {-# SOURCE #-} Lib.Plain (plain)',
        'runSource = plain 1',
      ].join('\n'),
      'SourceQualified.hs': [
        'module SourceQualified where',
        'import',
        '  {-# SOURCE #-}',
        '  qualified Lib.A as X',
        'runSourceQualified = X.foo 1',
      ].join('\n'),
    });
      const foo = nodeAt(graph, 'foo', 'Lib/A.hs');
      for (const [owner, filePath] of [
        ['runLeading', 'Leading.hs'],
        ['runPost', 'Post.hs'],
        ['runSourceQualified', 'SourceQualified.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)).toContainEqual(
          expect.objectContaining({ target: expect.objectContaining({ id: foo.id }) }),
        );
      }
      const plain = nodeAt(graph, 'plain', 'Lib/Plain.hs');
      expect(outgoingTargets(graph, 'runSource', 'Source.hs')).toContainEqual(
        expect.objectContaining({ target: expect.objectContaining({ id: plain.id }) }),
      );
  });

  it('does not let a type-only explicit import shadow a value from a wildcard import', async () => {
    const graph = await createGraph({
      'TypeOnly.hs': [
        '{-# LANGUAGE ExplicitNamespaces #-}',
        'module TypeOnly (type T) where',
        'type T = Int',
      ].join('\n'),
      'ValueOnly.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module ValueOnly (pattern T) where',
        'pattern T = 1',
      ].join('\n'),
      'Both.hs': [
        'module Both (U(..)) where',
        'data U = U',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}',
        'module Consumer where',
        'import TypeOnly (type T)',
        'import ValueOnly',
        'import qualified Both as B (type U)',
        'run = T',
        'notImported = B.U',
      ].join('\n'),
    });
      const pattern = nodeAt(graph, 'T', 'ValueOnly.hs');
      const constructor = graph.getNodesByName('U')
        .find((node) => node.filePath === 'Both.hs' && node.kind === 'enum_member')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')).toContainEqual(
        expect.objectContaining({
          edge: expect.objectContaining({ kind: 'references' }),
          target: expect.objectContaining({ id: pattern.id }),
        }),
      );
      expect(outgoingTargets(graph, 'notImported', 'Consumer.hs')
        .some(({ target }) => target.id === constructor.id)).toBe(false);
  });

  it('preserves explicit type and pattern namespaces through imports and facades', async () => {
    const graph = await createGraph({
      'Both.hs': [
        '{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}',
        'module Both (U, pattern U, V, pattern V) where',
        'class U a',
        'data UValue = U',
        'class V a',
        'data VValue = V',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}',
        'module Facade (type U, pattern V) where',
        'import Both',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade',
        'class U a => UsesU a',
        'useV = V',
      ].join('\n'),
      'Rejected.hs': [
        'module Rejected where',
        'import Facade',
        'class V a => UsesV a',
        'useU = U',
      ].join('\n'),
      'HiddenPattern.hs': [
        '{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}',
        'module HiddenPattern where',
        'import Both hiding (pattern U)',
        'class U a => HiddenType a',
        'hiddenValue = U',
      ].join('\n'),
    });
      const typeU = graph.getNodesByName('U')
        .find((node) => node.filePath === 'Both.hs' && node.kind === 'trait')!;
      const valueU = graph.getNodesByName('U')
        .find((node) => node.filePath === 'Both.hs' && node.kind === 'enum_member')!;
      const typeV = graph.getNodesByName('V')
        .find((node) => node.filePath === 'Both.hs' && node.kind === 'trait')!;
      const valueV = graph.getNodesByName('V')
        .find((node) => node.filePath === 'Both.hs' && node.kind === 'enum_member')!;

      expect(outgoingTargets(graph, 'UsesU', 'Consumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: typeU.id }) }));
      expect(outgoingTargets(graph, 'useV', 'Consumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: valueV.id }) }));
      expect(outgoingTargets(graph, 'UsesV', 'Rejected.hs')
        .some(({ target }) => target.id === typeV.id)).toBe(false);
      expect(outgoingTargets(graph, 'useU', 'Rejected.hs')
        .some(({ target }) => target.id === valueU.id)).toBe(false);
      expect(outgoingTargets(graph, 'HiddenType', 'HiddenPattern.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: typeU.id }) }));
      expect(outgoingTargets(graph, 'hiddenValue', 'HiddenPattern.hs')
        .some(({ target }) => target.id === valueU.id)).toBe(false);

    const operatorRoutes = extractReExports([
      '{-# LANGUAGE ExplicitNamespaces, TypeOperators #-}',
      'module OperatorFacade ((+++), type (***)) where',
      'import OperatorOrigin',
    ].join('\n'), 'haskell');
    expect(operatorRoutes).toContainEqual(expect.objectContaining({
      kind: 'wildcard',
      source: 'OperatorOrigin',
      includedNames: expect.arrayContaining(['+++', '***']),
      haskellTypeOnlyNames: ['***'],
      haskellValueOnlyNames: ['+++'],
    }));
  });

  it('preserves grouped child namespaces through a Haskell facade', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE TypeFamilies, TypeOperators #-}',
        'module Origin (C(..)) where',
        'class C a where',
        '  type a <+> b',
        '  (<+>) :: a -> a -> a',
      ].join('\n'),
      'TypeFacade.hs': [
        '{-# LANGUAGE ExplicitNamespaces, TypeOperators #-}',
        'module TypeFacade (C(type (<+>))) where',
        'import Origin',
      ].join('\n'),
      'ValueFacade.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module ValueFacade (C((<+>))) where',
        'import Origin',
      ].join('\n'),
      'TypeConsumer.hs': [
        'module TypeConsumer where',
        'import TypeFacade',
        'runTypeFacade = (<+>)',
      ].join('\n'),
      'ValueConsumer.hs': [
        'module ValueConsumer where',
        'import ValueFacade',
        'runValueFacade = (<+>)',
      ].join('\n'),
    });
      const method = graph.getNodesByName('(<+>)')
        .find((node) => node.filePath === 'Origin.hs' && node.kind === 'method')!;
      const associatedType = graph.getNodesByName('(<+>)')
        .find((node) => node.filePath === 'Origin.hs' && node.kind === 'type_alias')!;
      expect(method).toBeDefined();
      expect(associatedType).toBeDefined();
      expect(outgoingTargets(graph, 'runTypeFacade', 'TypeConsumer.hs')
        .some(({ target }) => target.id === method.id)).toBe(false);
      expect(outgoingTargets(graph, 'runValueFacade', 'ValueConsumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: method.id }) }));

    expect(extractReExports([
      '{-# LANGUAGE ExplicitNamespaces, TypeOperators #-}',
      'module TypeFacade (C(type (<+>))) where',
      'import Origin',
    ].join('\n'), 'haskell')).toContainEqual(expect.objectContaining({
      kind: 'named',
      exportedName: '<+>',
      parentExport: 'C',
      haskellTypeOnly: true,
    }));
    expect(extractReExports([
      '{-# LANGUAGE TypeOperators #-}',
      'module ValueFacade (C((<+>))) where',
      'import Origin',
    ].join('\n'), 'haskell')).toContainEqual(expect.objectContaining({
      kind: 'named',
      exportedName: '<+>',
      parentExport: 'C',
      haskellValueOnly: true,
    }));
  });

  it('does not read a parenthesized body as an omitted module export list', () => {
    expect(extractReExports([
      'module Facade where',
      'import A',
      'foo = (bar)',
      '  where',
      '    bar = 1',
    ].join('\n'), 'haskell')).toEqual([]);
  });

  it('preserves parent clearing when compacting plain named Haskell re-exports', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (A, field) where',
        'import Origin (A, field)',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (A(field))',
        'use value = field value',
      ].join('\n'),
    });
      // A plain `field` export does not retain the consumer's grouped A
      // restriction while chasing its origin. Both Origin fields therefore
      // remain possible and the resolver must fail closed on the ambiguity.
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
  });

  it('invalidates unchanged consumers when an intermediate re-export changes or disappears', async () => {
    const graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Facade.hs': 'module Facade (foo) where\nimport A (foo)\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'foo')?.target.filePath;
      expect(targetFile()).toBe('A.hs');

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- switched source',
      ].join('\n'));
      await graph.sync();
      expect(targetFile()).toBe('B.hs');

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), 'module Facade () where\nimport B (foo)\n');
      await graph.sync();
      expect(targetFile()).toBeUndefined();

      fs.unlinkSync(path.join(tmpDir!, 'Facade.hs'));
      await graph.sync();
      expect(targetFile()).toBeUndefined();

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- restored facade',
      ].join('\n'));
      await graph.sync();
      expect(targetFile()).toBe('B.hs');
  });

  it('re-resolves imports when a newly added exact module path beats an old candidate', async () => {
    const graph = await createGraph({
      'pkg/src/Wrong.hs': 'module Foo.Bar where\ntarget x = x\n',
      'pkg/app/Consumer.hs': 'module Consumer where\nimport Foo.Bar (target)\nrun = target 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'pkg/app/Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'target')?.target.filePath;
      expect(targetFile()).toBe('pkg/src/Wrong.hs');
      const exactPath = path.join(tmpDir!, 'pkg/src/Foo/Bar.hs');
      fs.mkdirSync(path.dirname(exactPath), { recursive: true });
      fs.writeFileSync(exactPath, 'module Foo.Bar where\ntarget x = x + 1\n');
      await graph.sync();
      expect(targetFile()).toBe('pkg/src/Foo/Bar.hs');
  });

  it('resolves pattern synonyms bundled under a type export', async () => {
    const graph = await createGraph({
      'Patterns.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Patterns (T(P)) where',
        'data T = MkT',
        'pattern P = MkT',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Consumer where',
        'import Patterns (T(P))',
        'run = P',
      ].join('\n'),
    });
      const pattern = nodeAt(graph, 'P', 'Patterns.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === pattern.id)).toBe(true);
  });

  it('resolves record pattern-synonym selectors locally and through explicit imports', async () => {
    const graph = await createGraph({
      'Patterns.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Patterns (pattern Present, presentValue) where',
        'pattern Present { presentValue } = Just presentValue',
        'local x = presentValue x',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Patterns (presentValue)',
        'run x = presentValue x',
      ].join('\n'),
    });
      const selector = nodeAt(graph, 'presentValue', 'Patterns.hs');
      for (const [owner, filePath] of [['local', 'Patterns.hs'], ['run', 'Consumer.hs']] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ target }) => target.id === selector.id)).toBe(true);
      }
  });

  it('does not reinterpret a multi-segment imported module as a qualified member', async () => {
    const graph = await createGraph({
      'src/Legacy/TT/Common/RateLimit.hs': [
        'module Legacy.TT.Common.RateLimit where',
        'limit = 1',
      ].join('\n'),
      'src/Consumer.hs': [
        'module Consumer where',
        'import Legacy.TT.Common.RateLimit',
        'run = limit',
      ].join('\n'),
    });
      const consumerModule = graph.getNodesByName('Consumer')
        .find((node) => node.filePath === 'src/Consumer.hs' && node.kind === 'namespace')!;
      expect(graph.getOutgoingEdges(consumerModule.id).some((edge) => {
        const target = graph.getNode(edge.target);
        return edge.kind === 'imports'
          && target?.filePath === 'src/Legacy/TT/Common/RateLimit.hs';
      })).toBe(true);
  });

  it('recovers atomically when Haskell import invalidation is interrupted', async () => {
    let graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Facade.hs': 'module Facade (foo) where\nimport A (foo)\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'foo')?.target.filePath;
      expect(targetFile()).toBe('A.hs');
      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- force a changed size and mtime',
      ].join('\n'));

      const queries = (graph as unknown as {
        queries: { deleteEdgesBySource(nodeId: string): void };
      }).queries;
      const originalDelete = queries.deleteEdgesBySource.bind(queries);
      let injected = false;
      queries.deleteEdgesBySource = (nodeId: string) => {
        originalDelete(nodeId);
        if (!injected) {
          injected = true;
          throw new Error('injected Haskell invalidation interruption');
        }
      };
      await expect(graph.sync()).rejects.toThrow('injected Haskell invalidation interruption');

      graph.destroy();
      graph = CodeGraph.openSync(tmpDir!);
      openGraphs.add(graph);
      // The facade file record already matches disk; recovery must therefore be
      // driven by the durable invalidation marker, not filesystem change data.
      await graph.sync();
      expect(targetFile()).toBe('B.hs');
  });

  it('keeps duplicate local helpers inside their exact equation scope', async () => {
    const filler = Array.from({ length: 28 }, (_, index) => `  step${index} = ${index}`).join('\n');
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        'equations True = helper 1 where',
        filler,
        '  helper x = x',
        'equations False = helper 2 where',
        '  helper x = x + 1',
      ].join('\n'),
    });
      const helpers = graph.getNodesByName('helper').sort((a, b) => a.startLine - b.startLine);
      const calls = outgoingTargets(graph, 'equations', 'Main.hs')
        .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper');
      expect(calls.find(({ edge }) => edge.line === 2)?.target.id).toBe(helpers[0]!.id);
      expect(calls.find(({ edge }) => edge.line === 32)?.target.id).toBe(helpers[1]!.id);
  });

  it('lets a qualified import alias match the current module name when no local symbol exists', async () => {
    const graph = await createGraph({
      'X.hs': 'module X where\nfoo x = x\n',
      'A/B.hs': 'module A.B where\nimport qualified X as A.B\ny = A.B.foo\n',
    });
      const foo = nodeAt(graph, 'foo', 'X.hs');
      expect(outgoingTargets(graph, 'y', 'A/B.hs').some(({ target }) => target.id === foo.id)).toBe(true);
  });

  it('resolves ImportQualifiedPost references to self-qualified explicit exports', async () => {
    const graph = await createGraph({
      'A/B.hs': [
        'module A.B (A.B.handle, (A.B.<+>)) where',
        'handle value = value',
        '(<+>) left _ = left',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import A.B qualified as Request',
        'run value = Request.handle value',
        'operatorRun left right = left Request.<+> right',
      ].join('\n'),
    });
      const handle = nodeAt(graph, 'handle', 'A/B.hs');
      expect(handle.isExported).toBe(true);
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === handle.id)).toBe(true);
      const operator = nodeAt(graph, '(<+>)', 'A/B.hs');
      expect(operator.isExported).toBe(true);
      expect(outgoingTargets(graph, 'operatorRun', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === operator.id)).toBe(true);
  });

  it('does not treat an imported qualified export as a local export', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin (foo) where\nfoo = 1\n',
      'Facade.hs': [
        'module Facade (Origin.foo) where',
        'import Origin qualified',
        'foo = 2',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade',
        'run = foo',
      ].join('\n'),
      'SelfQualified.hs': [
        'module SelfQualified (SelfQualified.foo) where',
        'import qualified Origin as SelfQualified',
      ].join('\n'),
      'SelfConsumer.hs': [
        'module SelfConsumer where',
        'import SelfQualified',
        'runSelf = foo',
      ].join('\n'),
      // GHC rejects this same-qualifier collision as ambiguous. Keep recovery
      // fail-closed if an editor indexes the incomplete/invalid module.
      'SelfCollision.hs': [
        'module SelfCollision (SelfCollision.foo) where',
        'import qualified Origin as SelfCollision',
        'foo = 3',
      ].join('\n'),
      'CollisionConsumer.hs': [
        'module CollisionConsumer where',
        'import SelfCollision',
        'runCollision = foo',
      ].join('\n'),
    });
      const originFoo = nodeAt(graph, 'foo', 'Origin.hs');
      const localFoo = nodeAt(graph, 'foo', 'Facade.hs');
      expect(localFoo.isExported).toBe(false);
      expect(outgoingTargets(graph, 'run', 'Consumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: originFoo.id }) }));
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === localFoo.id)).toBe(false);
      expect(outgoingTargets(graph, 'runSelf', 'SelfConsumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: originFoo.id }) }));
      expect(outgoingTargets(graph, 'runCollision', 'CollisionConsumer.hs')
        .some(({ target }) => target.name === 'foo')).toBe(false);
  });

  it('re-exports qualified alias values, types, and operators', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module Origin (foo, T(..), (<+>)) where',
        'foo = 1',
        'data T = T',
        '(<+>) left _ = left',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module Facade (O.foo, O.T, (O.<+>)) where',
        'import qualified Origin as O',
      ].join('\n'),
      'GroupedFacade.hs': [
        'module GroupedFacade (O.T(..)) where',
        'import qualified Origin as O',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade',
        'runFoo = foo',
        'runOperator = 1 <+> 2',
        'notAConstructor = T',
      ].join('\n'),
      'GroupedConsumer.hs': [
        'module GroupedConsumer where',
        'import GroupedFacade',
        'runGrouped = T',
      ].join('\n'),
    });
      const originFoo = nodeAt(graph, 'foo', 'Origin.hs');
      const originOperator = graph.getNodesByName('(<+>)')
        .find((node) => node.filePath === 'Origin.hs' && node.kind === 'function')!;
      const constructor = graph.getNodesByName('T')
        .find((node) => node.filePath === 'Origin.hs' && node.kind === 'enum_member');
      expect(outgoingTargets(graph, 'runFoo', 'Consumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: originFoo.id }) }));
      expect(outgoingTargets(graph, 'runOperator', 'Consumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: originOperator.id }) }));
      expect(constructor).toBeDefined();
      expect(outgoingTargets(graph, 'notAConstructor', 'Consumer.hs')
        .some(({ target }) => target.name === 'T')).toBe(false);
      expect(outgoingTargets(graph, 'runGrouped', 'GroupedConsumer.hs'))
        .toContainEqual(expect.objectContaining({ target: expect.objectContaining({ id: constructor!.id }) }));

    const routes = extractReExports([
      '{-# LANGUAGE TypeOperators #-}',
      'module Facade (O.foo, O.T, (O.<+>)) where',
      'import qualified Origin as O',
    ].join('\n'), 'haskell');
    expect(routes).toContainEqual(expect.objectContaining({
      kind: 'wildcard',
      source: 'Origin',
      includedNames: ['foo', 'T', '<+>'],
      haskellTypeOnlyNames: ['T'],
      haskellValueOnlyNames: ['foo', '<+>'],
      haskellClearParent: true,
    }));
  });

  it('parses grouped children of operator type parents', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE TypeFamilies, TypeOperators #-}',
        'module Origin ((:*:)(..)) where',
        'data family a :*: b',
        'data instance Int :*: Bool = PairIB',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module Consumer where',
        'import Origin ((:*:)(..))',
        'run = PairIB',
      ].join('\n'),
    });
      const constructor = nodeAt(graph, 'PairIB', 'Origin.hs');
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === constructor.id)).toBe(true);
  });

  it('preserves DuplicateRecordFields parent identity through imports and re-exports', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(field), B(field)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Facade (B(field)) where',
        'import Origin (B(field))',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'getB x = field x',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import qualified Origin as O (B(field))',
        'getQualified x = O.field x',
      ].join('\n'),
    });
      const fields = graph.getNodesByName('field').filter((node) => node.filePath === 'Origin.hs');
      const bField = fields.find((node) => node.qualifiedName.includes('::B::'))!;
      const aField = fields.find((node) => node.qualifiedName.includes('::A::'))!;
      for (const [owner, filePath] of [
        ['getB', 'Consumer.hs'], ['getQualified', 'Qualified.hs'],
      ] as const) {
        const targets = outgoingTargets(graph, owner, filePath).map(({ target }) => target.id);
        expect(targets).toContain(bField.id);
        expect(targets).not.toContain(aField.id);
      }
  });

  it('uses only the immediate type owner when its name matches the module leaf', async () => {
    const graph = await createGraph({
      'Person.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module Person (Person(..), Other(..), getLocal) where',
        'data Person = Person { field :: Int }',
        'data Other = Other { field :: Int }',
        'getLocal :: Person -> Int',
        'getLocal value = value.field',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (Person(..)) where',
        'import Person (Person(..))',
      ].join('\n'),
      'Direct.hs': [
        'module Direct where',
        'import Person (Person(..))',
        'getDirect value = field value',
      ].join('\n'),
      'ThroughFacade.hs': [
        'module ThroughFacade where',
        'import Facade (field)',
        'getFacade value = field value',
      ].join('\n'),
    });
      const fields = graph.getNodesByName('field').filter((node) => node.filePath === 'Person.hs');
      const personField = fields.find((node) => node.qualifiedName === 'Person::Person::field')!;
      const otherField = fields.find((node) => node.qualifiedName === 'Person::Other::field')!;
      expect(personField).toBeDefined();
      expect(otherField).toBeDefined();
      for (const [owner, filePath] of [
        ['getLocal', 'Person.hs'],
        ['getDirect', 'Direct.hs'],
        ['getFacade', 'ThroughFacade.hs'],
      ] as const) {
        const targets = outgoingTargets(graph, owner, filePath).map(({ target }) => target.id);
        expect(targets).toContain(personField.id);
        expect(targets).not.toContain(otherField.id);
      }
  });

  it('uses Haskell value context to distinguish a constructor from a same-named type alias', async () => {
    const graph = await createGraph({
      'Api/V0.hs': [
        'module Api.V0 (API, API\'(..), consume) where',
        'type API = Int',
        'data API\' = API',
        'consume value = value',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE TypeApplications #-}',
        'module Consumer where',
        'import Api.V0 qualified',
        'typeOnly :: Api.V0.API -> Api.V0.API',
        'typeOnly value = value',
        'typeApplication = proxy @Api.V0.API',
        'typedCall value = Api.V0.consume @Api.V0.API value',
        'make = Api.V0.API',
      ].join('\n'),
    });
      const candidates = graph.getNodesByName('API').filter((node) => node.filePath === 'Api/V0.hs');
      const constructor = candidates.find((node) => node.kind === 'enum_member')!;
      const alias = candidates.find((node) => node.kind === 'type_alias')!;
      expect(constructor).toBeDefined();
      expect(alias).toBeDefined();
      const targets = outgoingTargets(graph, 'make', 'Consumer.hs').map(({ target }) => target.id);
      expect(targets).toContain(constructor.id);
      expect(targets).not.toContain(alias.id);
      const typeOnlyTargets = outgoingTargets(graph, 'typeOnly', 'Consumer.hs')
        .map(({ target }) => target.id);
      expect(typeOnlyTargets).not.toContain(constructor.id);
      expect(typeOnlyTargets).not.toContain(alias.id);
      const typeApplicationTargets = outgoingTargets(graph, 'typeApplication', 'Consumer.hs')
        .map(({ target }) => target.id);
      expect(typeApplicationTargets).not.toContain(constructor.id);
      expect(typeApplicationTargets).not.toContain(alias.id);
      const consume = nodeAt(graph, 'consume', 'Api/V0.hs');
      expect(outgoingTargets(graph, 'typedCall', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === consume.id)).toBe(true);
  });

  it('resolves type-only specialization as a value edge unless execution is proven', async () => {
    const graph = await createGraph({
      'Actions.hs': [
        '{-# LANGUAGE ExplicitForAll #-}',
        'module Actions (specialize, token, action, Token(..), Box) where',
        'data Token a = Token',
        'data Box a = MakeBox a',
        'specialize :: forall a. Int -> Int',
        'specialize value = value',
        'token :: forall a. Int',
        'token = 1',
        'action :: forall a. IO ()',
        'action = pure ()',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE TypeApplications #-}',
        'module Consumer where',
        'import qualified Actions as A',
        'asFunction = A.specialize @Int',
        'asValue = A.token @Int',
        'asConstructor = A.Token @Int',
        'applied value = A.specialize @Int value',
        'nestedApplied value = A.specialize @(A.Box Int) value',
        'viaDollar = A.specialize @Int $ 1',
        'viaStrictDollar = A.specialize @Int $! 1',
        'multilineDollar =',
        '  A.specialize @Int',
        '    $ 1',
        'viaAmp value = value & A.specialize @Int',
        'effect :: IO ()',
        'effect = A.action @Int',
        'trailingEffect = A.action',
        'trailingEffect :: IO ()',
        'run = do',
        '  A.action @Bool',
      ].join('\n'),
    });
      const target = (name: string, kind: string) => graph.getNodesByName(name)
        .find((node) => node.filePath === 'Actions.hs' && node.kind === kind)!;
      for (const [owner, name, kind] of [
        ['asFunction', 'specialize', 'function'],
        ['asValue', 'token', 'constant'],
        ['asConstructor', 'Token', 'enum_member'],
      ] as const) {
        const outgoing = outgoingTargets(graph, owner, 'Consumer.hs')
          .filter(({ target: candidate }) => candidate.id === target(name, kind).id);
        expect(outgoing, owner).toHaveLength(1);
        expect(outgoing[0]!.edge).toEqual(expect.objectContaining({ kind: 'references' }));
      }
      for (const [owner, name, kind] of [
        ['applied', 'specialize', 'function'],
        ['nestedApplied', 'specialize', 'function'],
        ['viaDollar', 'specialize', 'function'],
        ['viaStrictDollar', 'specialize', 'function'],
        ['multilineDollar', 'specialize', 'function'],
        ['viaAmp', 'specialize', 'function'],
        ['effect', 'action', 'function'],
        ['trailingEffect', 'action', 'function'],
        ['run', 'action', 'function'],
      ] as const) {
        const outgoing = outgoingTargets(graph, owner, 'Consumer.hs')
          .filter(({ target: candidate }) => candidate.id === target(name, kind).id);
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]!.edge).toEqual(expect.objectContaining({ kind: 'calls' }));
      }
      expect(outgoingTargets(graph, 'nestedApplied', 'Consumer.hs')
        .some(({ target: candidate }) => candidate.name === 'Box')).toBe(false);
  });

  it('resolves Template Haskell splices without linking quoted code as runtime flow', async () => {
    const graph = await createGraph({
      'Targets.hs': [
        'module Targets where',
        'data QuotedType = QuotedConstructor Int',
        'runtimeTarget value = value',
        'compileExpr value = value',
        'compileTyped value = value',
        'compileDecl value = value',
        'compileType value = value',
        'compilePattern value = value',
        'deferredCompile value = value',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE QuasiQuotes, TemplateHaskell #-}',
        'module Consumer where',
        'import Targets (QuotedType, runtimeTarget)',
        'import qualified Targets as T',
        'exprQuote = [| T.runtimeTarget 1 |]',
        'typedExprQuote = [|| T.runtimeTarget 1 ||]',
        'declQuote = [d| generated = T.runtimeTarget 1 |]',
        'typeQuote = [t| T.QuotedType |]',
        'patternQuote = [p| T.QuotedConstructor value |]',
        "nameQuote = 'runtimeTarget",
        "typeNameQuote = ''QuotedType",
        'quasiQuote = [qq| T.runtimeTarget 1 |]',
        'untypedSplice = $(T.compileExpr 1)',
        'typedSplice = $$(T.compileTyped 1)',
        'exprWithSplice = [| T.runtimeTarget ($(T.compileExpr 1)) |]',
        'typedExprWithSplice = [|| T.runtimeTarget ($$(T.compileTyped 1)) ||]',
        'declWithSplice = [d| generatedWithSplice = $(T.compileDecl 1) |]',
        'typeWithSplice = [t| Maybe $(T.compileType 1) |]',
        'patternWithSplice = [p| Just $(T.compilePattern 1) |]',
        'instanceWithSplice = [d| instance Eq $(T.compileType 1) where |]',
        'nestedQuote = [| [| T.runtimeTarget ($(T.deferredCompile 1)) |] |]',
        'ordinary value = T.runtimeTarget value',
      ].join('\n'),
    });
      const target = (name: string) => nodeAt(graph, name, 'Targets.hs');
      const targetsFrom = (owner: string) => outgoingTargets(graph, owner, 'Consumer.hs')
        .map(({ edge, target: candidate }) => ({ kind: edge.kind, id: candidate.id }));
      const runtimeTarget = target('runtimeTarget');

      for (const owner of [
        'exprQuote', 'typedExprQuote', 'declQuote', 'typeQuote', 'patternQuote',
        'nameQuote', 'typeNameQuote', 'quasiQuote', 'nestedQuote',
      ]) {
        expect(targetsFrom(owner), owner).toEqual([]);
      }
      for (const [owner, targetName] of [
        ['untypedSplice', 'compileExpr'],
        ['typedSplice', 'compileTyped'],
        ['exprWithSplice', 'compileExpr'],
        ['typedExprWithSplice', 'compileTyped'],
        ['declWithSplice', 'compileDecl'],
        ['typeWithSplice', 'compileType'],
        ['patternWithSplice', 'compilePattern'],
        ['instanceWithSplice', 'compileType'],
      ] as const) {
        expect(targetsFrom(owner), owner).toContainEqual({
          kind: 'calls', id: target(targetName).id,
        });
        expect(targetsFrom(owner).some(({ id }) => id === runtimeTarget.id), owner).toBe(false);
      }
      expect(targetsFrom('nestedQuote').some(({ id }) => id === target('deferredCompile').id))
        .toBe(false);
      expect(targetsFrom('ordinary')).toContainEqual({ kind: 'calls', id: runtimeTarget.id });
      expect(graph.getNodesByName('generated').some((node) => node.filePath === 'Consumer.hs'))
        .toBe(false);
      expect(graph.getNodesByName('generatedWithSplice')
        .some((node) => node.filePath === 'Consumer.hs')).toBe(false);
  });

  it('applies DuplicateRecordFields hiding before resolving a wildcard re-export', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (module Origin) where',
        'import Origin hiding (A(field))',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'getB x = field x',
      ].join('\n'),
    });
      const fields = graph.getNodesByName('field').filter((node) => node.filePath === 'Origin.hs');
      const aField = fields.find((node) => node.qualifiedName.includes('::A::'))!;
      const bField = fields.find((node) => node.qualifiedName.includes('::B::'))!;
      const targets = outgoingTargets(graph, 'getB', 'Consumer.hs').map(({ target }) => target.id);
      expect(targets).toContain(bField.id);
      expect(targets).not.toContain(aField.id);
  });

  it('uses an annotated record-dot receiver and leaves an unknown receiver unresolved', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (B(..)) where',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module Consumer where',
        'import Origin (B(..))',
        'data A = A { field :: Int }',
        'getB :: B -> Int',
        'getB value = value.field',
        'getA :: A -> Int',
        'getA value = value.field',
        'unknown value = value.field',
        'unknownParenthesized value = (value).field',
      ].join('\n'),
      'QualifiedDot.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module QualifiedDot where',
        'import qualified Origin as O',
        'data B = B { field :: Int }',
        'getQualified :: O.B -> Int',
        'getQualified value = value.field',
      ].join('\n'),
    });
      const importedField = nodeAt(graph, 'field', 'Origin.hs');
      const localField = nodeAt(graph, 'field', 'Consumer.hs');
      expect(outgoingTargets(graph, 'getB', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === importedField.id)).toBe(true);
      expect(outgoingTargets(graph, 'getB', 'Consumer.hs')
        .some(({ target }) => target.id === localField.id)).toBe(false);
      expect(outgoingTargets(graph, 'getA', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === localField.id)).toBe(true);
      expect(outgoingTargets(graph, 'unknown', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'unknownParenthesized', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'getQualified', 'QualifiedDot.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
  });

  it('claims Unicode record-dot projections and resolves only an annotated receiver', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (B(..)) where',
        'data B = B { ascii :: Int, sommé :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE OverloadedRecordDot #-}',
        'module Consumer where',
        'import Origin (B(..))',
        'unknownAscii value = value.ascii',
        'unknownUnicode value = value.sommé',
        'getUnicode :: B -> Int',
        'getUnicode value = value.sommé',
        'getUnicodeReceiver :: B -> Int',
        'getUnicodeReceiver élève = élève.sommé',
      ].join('\n'),
    });
      const fields = new Set(
        graph.getNodesByName('ascii').concat(graph.getNodesByName('sommé'))
          .filter((node) => node.kind === 'field')
          .map((node) => node.id),
      );
      const unicodeField = graph.getNodesByName('sommé')
        .find((node) => node.filePath === 'Origin.hs' && node.kind === 'field')!;
      for (const owner of ['unknownAscii', 'unknownUnicode']) {
        expect(outgoingTargets(graph, owner, 'Consumer.hs')
          .some(({ target }) => fields.has(target.id))).toBe(false);
      }
      for (const owner of ['getUnicode', 'getUnicodeReceiver']) {
        expect(outgoingTargets(graph, owner, 'Consumer.hs')
          .filter(({ target }) => target.id === unicodeField.id))
          .toEqual([expect.objectContaining({ edge: expect.objectContaining({ kind: 'references' }) })]);
      }
  });

  it.each([
    ['Origin', 'module Origin'],
    ['Origin (A(field), B(field))', 'module Origin'],
    ['Origin (A(..), B(..))', 'A(..), B(..)'],
  ])('preserves wildcard ambiguity and explicit parent selection through import %s', async (importList, exports) => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        `module Facade (C(..), ${exports}) where`,
        `import ${importList}`,
        'data C = C { field :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'use value = field value',
      ].join('\n'),
      'Selected.hs': [
        'module Selected where',
        'import Facade (B(field))',
        'selected value = field value',
      ].join('\n'),
    });
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'selected', 'Selected.hs')
        .filter(({ target }) => target.name === 'field')
        .map(({ target }) => target.qualifiedName)).toEqual(['Origin::B::field']);
  });

  it('keeps same-line local helper IDs distinct and resolves each call to its own scope', async () => {
    const filler = Array.from({ length: 36 }, () => '0 + ').join('');
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        `run b = if b then let helper x = x + 1 in ${filler}helper 1 else let helper x = x + 2 in helper 2`,
      ].join('\n'),
    });
      const helpers = graph.getNodesByName('helper')
        .filter((node) => node.filePath === 'Main.hs')
        .sort((a, b) => a.startColumn - b.startColumn);
      expect(helpers).toHaveLength(2);
      expect(helpers[0]!.id).not.toBe(helpers[1]!.id);
      const calls = outgoingTargets(graph, 'run', 'Main.hs')
        .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper')
        .sort((a, b) => (a.edge.column ?? 0) - (b.edge.column ?? 0));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.target.id).toBe(helpers[0]!.id);
      expect(calls[1]!.target.id).toBe(helpers[1]!.id);

      const originalIds = helpers.map((helper) => helper.id);
      fs.appendFileSync(path.join(tmpDir!, 'Main.hs'), '\n-- force a stable re-index\n');
      await graph.sync();
      expect(graph.getNodesByName('helper')
        .filter((node) => node.filePath === 'Main.hs')
        .sort((a, b) => a.startColumn - b.startColumn)
        .map((helper) => helper.id)).toEqual(originalIds);
  });

  it('resolves imported, qualified, and self-alias constants used as values', async () => {
    const graph = await createGraph({
      'X.hs': 'module X (foo) where\nfoo = 1\n',
      'Direct.hs': 'module Direct where\nimport X (foo)\ny = foo\n',
      'Qualified.hs': 'module Qualified where\nimport qualified X as Q\nyq = Q.foo\n',
      'A/B.hs': 'module A.B where\nimport qualified X as A.B\nys = A.B.foo\n',
    });
      const foo = graph.getNodesByName('foo')
        .find((node) => node.filePath === 'X.hs' && node.kind === 'constant')!;
      expect(foo).toBeDefined();
      for (const [owner, filePath] of [
        ['y', 'Direct.hs'],
        ['yq', 'Qualified.hs'],
        ['ys', 'A/B.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ edge, target }) => edge.kind === 'references' && target.id === foo.id)).toBe(true);
      }
  });

  it('turns only computation-returning whole-RHS aliases into call edges', async () => {
    const graph = await createGraph({
      'Actions.hs': [
        'module Actions (runAction, runTransaction, callback, answer, Token(..)) where',
        'runAction :: IO ()',
        'runAction = pure ()',
        'runTransaction :: RunTx m => m ()',
        'runTransaction = pure ()',
        'callback :: Int -> Int',
        'callback value = value',
        'answer :: Int',
        'answer = 42',
        'data Token = Token',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Actions (runAction)',
        'import qualified Actions as A',
        'plain :: IO ()',
        'plain = runAction',
        'qualified :: Bool -> IO ()',
        'qualified _ = A.runAction',
        'transaction :: RunTx m => m ()',
        'transaction = A.runTransaction',
        'choose :: Bool -> (Int -> Int)',
        'choose _ = A.callback',
        'number :: Bool -> Int',
        'number _ = A.answer',
        'copy :: Int',
        'copy = A.answer',
        'make = A.Token',
      ].join('\n'),
    });
      const action = nodeAt(graph, 'runAction', 'Actions.hs');
      const transaction = nodeAt(graph, 'runTransaction', 'Actions.hs');
      for (const [owner, target] of [
        ['plain', action],
        ['qualified', action],
      ] as const) {
        expect(outgoingTargets(graph, owner, 'Consumer.hs')
          .some(({ edge, target: actual }) => edge.kind === 'calls' && actual.id === target.id)).toBe(true);
      }

      const callback = nodeAt(graph, 'callback', 'Actions.hs');
      const answer = nodeAt(graph, 'answer', 'Actions.hs');
      for (const [owner, target] of [
        ['transaction', transaction],
        ['choose', callback],
        ['number', answer],
        ['copy', answer],
      ] as const) {
        const outgoing = outgoingTargets(graph, owner, 'Consumer.hs');
        expect(outgoing.some(({ edge, target: actual }) =>
          edge.kind === 'references' && actual.id === target.id)).toBe(true);
        expect(outgoing.some(({ edge, target: actual }) =>
          edge.kind === 'calls' && actual.id === target.id)).toBe(false);
      }

      const tokenCandidates = graph.getNodesByName('Token')
        .filter((node) => node.filePath === 'Actions.hs');
      const constructor = tokenCandidates.find((node) => node.kind === 'enum_member')!;
      const type = tokenCandidates.find((node) => node.kind === 'enum')!;
      const makeTargets = outgoingTargets(graph, 'make', 'Consumer.hs').map(({ target }) => target.id);
      expect(makeTargets).toContain(constructor.id);
      expect(makeTargets).not.toContain(type.id);
  });

  it('keeps an unannotated top-level main on the call spine without promoting ordinary aliases', async () => {
    const graph = await createGraph({
      'Actions.hs': [
        'module Actions (runAction, callback) where',
        'runAction :: IO ()',
        'runAction = pure ()',
        'callback :: Int -> Int',
        'callback value = value',
      ].join('\n'),
      'Main.hs': [
        'module Main where',
        'import qualified Actions as A',
        'main = A.runAction',
      ].join('\n'),
      'Library.hs': [
        'module Library where',
        'import qualified Actions as A',
        'alias = A.callback',
        'main _ = A.callback',
      ].join('\n'),
    });
      const main = nodeAt(graph, 'main', 'Main.hs');
      const alias = nodeAt(graph, 'alias', 'Library.hs');
      const runAction = nodeAt(graph, 'runAction', 'Actions.hs');
      const callback = nodeAt(graph, 'callback', 'Actions.hs');

      expect(main.kind).toBe('function');
      expect(outgoingTargets(graph, 'main', 'Main.hs')).toContainEqual(expect.objectContaining({
        edge: expect.objectContaining({ kind: 'calls' }),
        target: expect.objectContaining({ id: runAction.id }),
      }));
      expect(alias.kind).toBe('constant');
      expect(outgoingTargets(graph, 'alias', 'Library.hs')).toContainEqual(expect.objectContaining({
        edge: expect.objectContaining({ kind: 'references' }),
        target: expect.objectContaining({ id: callback.id }),
      }));
      expect(outgoingTargets(graph, 'alias', 'Library.hs').some(({ edge }) =>
        edge.kind === 'calls'
      )).toBe(false);
      const parameterizedMain = outgoingTargets(graph, 'main', 'Library.hs');
      expect(parameterizedMain).toContainEqual(expect.objectContaining({
        edge: expect.objectContaining({ kind: 'references' }),
        target: expect.objectContaining({ id: callback.id }),
      }));
      expect(parameterizedMain.some(({ edge, target }) =>
        edge.kind === 'calls' && target.id === callback.id
      )).toBe(false);
  });

  it('uses a foreign-export signature to resolve an effect alias as a call', async () => {
    const graph = await createGraph({
      'ForeignExport.hs': [
        '{-# LANGUAGE ForeignFunctionInterface #-}',
        'module ForeignExport where',
        'foreign export ccall "hs_action" action :: IO ()',
        'action = target',
        'target :: IO ()',
        'target = pure ()',
      ].join('\n'),
    });
      const actionNodes = graph.getNodesByName('action')
        .filter((node) => node.filePath === 'ForeignExport.hs');
      expect(actionNodes).toHaveLength(1);
      expect(actionNodes[0]).toEqual(expect.objectContaining({
        kind: 'function',
        signature: 'action :: IO ()',
      }));
      const target = nodeAt(graph, 'target', 'ForeignExport.hs');
      expect(outgoingTargets(graph, 'action', 'ForeignExport.hs')).toContainEqual(
        expect.objectContaining({
          edge: expect.objectContaining({
            kind: 'calls',
            metadata: expect.objectContaining({ refKind: 'haskell_effect_alias' }),
          }),
          target: expect.objectContaining({ id: target.id }),
        }),
      );
  });

  it('promotes point-free aliases only through canonical effect imports and re-exports', async () => {
    const graph = await createGraph({
      'Actions.hs': [
        'module Actions (runAction, register, callback) where',
        'runAction :: IO ()',
        'runAction = pure ()',
        'register :: (Int -> Int) -> IO ()',
        'register _ = pure ()',
        'callback :: Int -> Int',
        'callback value = value',
      ].join('\n'),
      'CanonicalPrelude.hs': [
        'module CanonicalPrelude (module X) where',
        'import Control.Monad.Except as X (ExceptT)',
      ].join('\n'),
      'Fake.hs': [
        'module Fake (ExceptT) where',
        'data ExceptT error monad value = Fake value',
      ].join('\n'),
      'Domain.hs': [
        'module Domain (ExceptT, IO) where',
        'import Fake (ExceptT)',
        'data IO value = FakeIO value',
      ].join('\n'),
      'CanonicalConsumer.hs': [
        'module CanonicalConsumer where',
        'import CanonicalPrelude (ExceptT)',
        'import qualified Actions as A',
        'canonical :: Monad m => ExceptT Failure m ()',
        'canonical = A.runAction',
        'canonicalIO :: ExceptT Failure IO ()',
        'canonicalIO = A.runAction',
        'callbackOwner :: IO ()',
        'callbackOwner = A.register A.callback',
      ].join('\n'),
      'QualifiedCanonicalConsumer.hs': [
        'module QualifiedCanonicalConsumer where',
        'import qualified Control.Monad.Except as E',
        'import qualified Actions as A',
        'qualifiedCanonical :: Monad m => E.ExceptT Failure m ()',
        'qualifiedCanonical = A.runAction',
      ].join('\n'),
      'PackageCanonicalConsumer.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageCanonicalConsumer where',
        'import "mtl" Control.Monad.Except (ExceptT)',
        'import qualified Actions as A',
        'packageCanonical :: Monad m => ExceptT Failure m ()',
        'packageCanonical = A.runAction',
      ].join('\n'),
      'STConsumer.hs': [
        'module STConsumer where',
        'import Control.Monad.ST (ST)',
        'import qualified Actions as A',
        'stAlias :: ST scope ()',
        'stAlias = A.runAction',
      ].join('\n'),
      'STMConsumer.hs': [
        'module STMConsumer where',
        'import Control.Concurrent.STM (STM)',
        'import qualified Actions as A',
        'stmAlias :: STM ()',
        'stmAlias = A.runAction',
      ].join('\n'),
      'CustomConsumer.hs': [
        'module CustomConsumer where',
        'import Domain (ExceptT)',
        'import qualified Actions as A',
        'custom :: Monad m => ExceptT Failure m ()',
        'custom = A.runAction',
      ].join('\n'),
      'QualifiedConsumer.hs': [
        'module QualifiedConsumer where',
        'import qualified Domain',
        'import qualified Actions as A',
        'qualifiedCustom :: Monad m => Domain.ExceptT Failure m ()',
        'qualifiedCustom = A.runAction',
      ].join('\n'),
      'PackageCustomConsumer.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageCustomConsumer where',
        'import "evil" Control.Monad.Except (ExceptT)',
        'import qualified Actions as A',
        'packageCustom :: Monad m => ExceptT Failure m ()',
        'packageCustom = A.runAction',
      ].join('\n'),
      'PackageCustomFacade.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageCustomFacade (module X) where',
        'import "evil" Control.Monad.Except as X (ExceptT)',
      ].join('\n'),
      'PackageFacadeConsumer.hs': [
        'module PackageFacadeConsumer where',
        'import PackageCustomFacade (ExceptT)',
        'import qualified Actions as A',
        'packageFacadeCustom :: Monad m => ExceptT Failure m ()',
        'packageFacadeCustom = A.runAction',
      ].join('\n'),
      'LocalConsumer.hs': [
        'module LocalConsumer where',
        'import qualified Actions as A',
        'data ExceptT error monad value = Local value',
        'localCustom :: Monad m => ExceptT Failure m ()',
        'localCustom = A.runAction',
      ].join('\n'),
      'CustomIOConsumer.hs': [
        'module CustomIOConsumer where',
        'import Prelude hiding (IO)',
        'import Domain (IO)',
        'import qualified Actions as A',
        'customIO :: IO ()',
        'customIO = A.runAction',
      ].join('\n'),
      'NoImplicitIOConsumer.hs': [
        '{-# LANGUAGE NoImplicitPrelude #-}',
        'module NoImplicitIOConsumer where',
        'import Domain (IO)',
        'import qualified Actions as A',
        'customNoImplicitIO :: IO ()',
        'customNoImplicitIO = A.runAction',
      ].join('\n'),
    });
      const action = nodeAt(graph, 'runAction', 'Actions.hs');
      const canonical = outgoingTargets(graph, 'canonical', 'CanonicalConsumer.hs');
      expect(canonical.some(({ edge, target }) =>
        edge.kind === 'calls'
        && target.id === action.id
        && edge.metadata?.refKind === 'haskell_effect_alias'
        && edge.metadata?.haskellEffectAlias === true
      )).toBe(true);
      for (const [owner, filePath] of [
        ['canonicalIO', 'CanonicalConsumer.hs'],
        ['qualifiedCanonical', 'QualifiedCanonicalConsumer.hs'],
        ['packageCanonical', 'PackageCanonicalConsumer.hs'],
        ['stAlias', 'STConsumer.hs'],
        ['stmAlias', 'STMConsumer.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath).some(({ edge, target }) =>
          edge.kind === 'calls' && target.id === action.id)).toBe(true);
      }

      for (const [owner, filePath] of [
        ['custom', 'CustomConsumer.hs'],
        ['qualifiedCustom', 'QualifiedConsumer.hs'],
        ['packageCustom', 'PackageCustomConsumer.hs'],
        ['packageFacadeCustom', 'PackageFacadeConsumer.hs'],
        ['localCustom', 'LocalConsumer.hs'],
        ['customIO', 'CustomIOConsumer.hs'],
        ['customNoImplicitIO', 'NoImplicitIOConsumer.hs'],
      ] as const) {
        const outgoing = outgoingTargets(graph, owner, filePath);
        expect(outgoing.some(({ edge, target }) =>
          edge.kind === 'references' && target.id === action.id)).toBe(true);
        expect(outgoing.some(({ edge, target }) =>
          edge.kind === 'calls' && target.id === action.id)).toBe(false);
      }

      const callback = nodeAt(graph, 'callback', 'Actions.hs');
      const callbackOwner = outgoingTargets(graph, 'callbackOwner', 'CanonicalConsumer.hs');
      expect(callbackOwner.some(({ edge, target }) =>
        edge.kind === 'references' && target.id === callback.id)).toBe(true);
      expect(callbackOwner.some(({ edge, target }) =>
        edge.kind === 'calls' && target.id === callback.id)).toBe(false);
  });

  it('requires canonical provenance for a transformer and its concrete carrier', async () => {
    const graph = await createGraph({
      'CarrierActions.hs': [
        'module CarrierActions (runAction) where',
        'import Control.Monad.Except (ExceptT)',
        'runAction :: Monad m => ExceptT String m ()',
        'runAction = pure ()',
      ].join('\n'),
      'Domain.hs': [
        'module Domain (IO) where',
        'newtype IO value = CustomIO value',
        'instance Functor IO where fmap fn (CustomIO value) = CustomIO (fn value)',
        'instance Applicative IO where',
        '  pure = CustomIO',
        '  CustomIO fn <*> CustomIO value = CustomIO (fn value)',
        'instance Monad IO where CustomIO value >>= fn = fn value',
      ].join('\n'),
      'CanonicalCarrier.hs': [
        'module CanonicalCarrier where',
        'import Control.Monad.Except (ExceptT)',
        'import qualified CarrierActions as A',
        'alias :: ExceptT String IO ()',
        'alias = A.runAction',
      ].join('\n'),
      'CustomCarrier.hs': [
        '{-# LANGUAGE NoImplicitPrelude #-}',
        'module CustomCarrier where',
        'import Prelude (String)',
        'import Control.Monad.Except (ExceptT)',
        'import Domain (IO)',
        'import qualified CarrierActions as A',
        'alias :: ExceptT String IO ()',
        'alias = A.runAction',
      ].join('\n'),
    });
      const target = nodeAt(graph, 'runAction', 'CarrierActions.hs');
      const canonical = outgoingTargets(graph, 'alias', 'CanonicalCarrier.hs');
      expect(canonical).toContainEqual(expect.objectContaining({
        edge: expect.objectContaining({
          kind: 'calls',
          metadata: expect.objectContaining({
            refKind: 'haskell_effect_alias',
            refCandidates: [
              'haskell-effect-head:ExceptT',
              'haskell-effect-head:IO',
            ],
          }),
        }),
        target: expect.objectContaining({ id: target.id }),
      }));

      const custom = outgoingTargets(graph, 'alias', 'CustomCarrier.hs');
      expect(custom).toContainEqual(expect.objectContaining({
        edge: expect.objectContaining({ kind: 'references' }),
        target: expect.objectContaining({ id: target.id }),
      }));
      expect(custom.some(({ edge, target: actual }) =>
        edge.kind === 'calls' && actual.id === target.id
      )).toBe(false);
  });

  it('never binds PackageImports modules or values to a same-named home module', async () => {
    const graph = await createGraph({
      'Actions.hs': [
        'module Actions (runAction) where',
        'runAction :: Int -> IO ()',
        'runAction _ = pure ()',
      ].join('\n'),
      'PackageOnly.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageOnly where',
        'import qualified "external-actions" Actions as A',
        'externalAlias :: Int -> IO ()',
        'externalAlias = A.runAction',
        'externalApplied :: IO ()',
        'externalApplied = A.runAction 1',
      ].join('\n'),
      'PackageUnqualified.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageUnqualified where',
        'import "external-actions" Actions (runAction)',
        'externalUnqualified :: IO ()',
        'externalUnqualified = runAction 1',
      ].join('\n'),
      'PackageFacade.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module PackageFacade (module X) where',
        'import "external-actions" Actions as X',
      ].join('\n'),
      'FacadeConsumer.hs': [
        'module FacadeConsumer where',
        'import PackageFacade (runAction)',
        'viaFacade :: IO ()',
        'viaFacade = runAction 1',
      ].join('\n'),
      'MixedConsumer.hs': [
        '{-# LANGUAGE PackageImports #-}',
        'module MixedConsumer where',
        'import Actions (runAction)',
        'import qualified "external-actions" Actions as External',
        'localApplied :: IO ()',
        'localApplied = runAction 1',
        'externalMixed :: IO ()',
        'externalMixed = External.runAction 1',
      ].join('\n'),
    });
      const localAction = nodeAt(graph, 'runAction', 'Actions.hs');
      const targetsLocalAction = (owner: string, filePath: string) =>
        outgoingTargets(graph, owner, filePath)
          .some(({ edge, target }) =>
            (edge.kind === 'calls' || edge.kind === 'references')
            && target.id === localAction.id
          );
      const importsLocalActionsFile = (moduleName: string, filePath: string) =>
        outgoingTargets(graph, moduleName, filePath)
          .some(({ edge, target }) =>
            edge.kind === 'imports'
            && target.kind === 'file'
            && target.filePath === 'Actions.hs'
          );

      expect(importsLocalActionsFile('PackageOnly', 'PackageOnly.hs')).toBe(false);
      expect(importsLocalActionsFile('PackageUnqualified', 'PackageUnqualified.hs')).toBe(false);
      expect(importsLocalActionsFile('PackageFacade', 'PackageFacade.hs')).toBe(false);
      for (const [owner, filePath] of [
        ['externalAlias', 'PackageOnly.hs'],
        ['externalApplied', 'PackageOnly.hs'],
        ['externalUnqualified', 'PackageUnqualified.hs'],
        ['viaFacade', 'FacadeConsumer.hs'],
        ['externalMixed', 'MixedConsumer.hs'],
      ] as const) {
        expect(targetsLocalAction(owner, filePath)).toBe(false);
      }

      // A deduplicated module reference still retains the genuine home-module
      // edge when the same file imports both the home and package modules.
      expect(importsLocalActionsFile('MixedConsumer', 'MixedConsumer.hs')).toBe(true);
      expect(targetsLocalAction('localApplied', 'MixedConsumer.hs')).toBe(true);
  });

  it('does not self-bind external imports in a headerless Haskell script', async () => {
    const graph = await createGraph({
      'script.hs': [
        'import Data.Monoid',
        'import Data.Map qualified as Map',
        'main = print Map.empty',
      ].join('\n'),
    });
      const file = graph.getNodesByName('script.hs')
        .find((node) => node.filePath === 'script.hs' && node.kind === 'file')!;
      const importDeclarations = graph.getNodesByName('Data.Monoid')
        .filter((node) => node.filePath === 'script.hs' && node.kind === 'import');
      expect(importDeclarations).toHaveLength(1);
      expect(graph.getOutgoingEdges(file.id)
        .filter((edge) => edge.kind === 'imports'))
        .toEqual([]);
  });

  it('never binds JavaScript, Python, or Lua calls to same-named Haskell values', async () => {
    const graph = await createGraph({
      'Targets.hs': [
        'module Targets where',
        'encode value = value',
        'decode value = value',
        'select value = value',
      ].join('\n'),
      'client.js': [
        'export function jsCaller(value) { return encode(value); }',
        'export function jsHelper(value) { return value; }',
        'export function jsSameLanguage(value) { return jsHelper(value); }',
      ].join('\n'),
      'client.py': [
        'def python_caller(value):',
        '    return decode(value)',
      ].join('\n'),
      'client.lua': [
        'function lua_caller(value)',
        '  return select(value)',
        'end',
      ].join('\n'),
    });
      const haskellTargets = new Set(
        ['encode', 'decode', 'select'].map((name) =>
          nodeAt(graph, name, 'Targets.hs').id
        )
      );
      for (const [owner, filePath] of [
        ['jsCaller', 'client.js'],
        ['python_caller', 'client.py'],
        ['lua_caller', 'client.lua'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath).some(({ edge, target }) =>
          (edge.kind === 'calls' || edge.kind === 'references')
          && haskellTargets.has(target.id)
        )).toBe(false);
      }

      const helper = nodeAt(graph, 'jsHelper', 'client.js');
      expect(outgoingTargets(graph, 'jsSameLanguage', 'client.js').some(({ edge, target }) =>
        edge.kind === 'calls' && target.id === helper.id
      )).toBe(true);
  });

  it('does not let framework name matching cross the Haskell boundary in either direction', async () => {
    const graph = await createGraph({
      'Target.hs': [
        'module Target where',
        'useHaskellTarget value = value',
        'run = useTsxTarget 1',
      ].join('\n'),
      'Library.hs': [
        'module Library (useHidden) where',
        'useHidden value = value',
      ].join('\n'),
      'HiddenConsumer.hs': [
        'module HiddenConsumer where',
        'import Library hiding (useHidden)',
        'runHidden = useHidden 1',
      ].join('\n'),
      'ImportedConsumer.hs': [
        'module ImportedConsumer where',
        'import Library (useHidden)',
        'runImported = useHidden 1',
      ].join('\n'),
      'App.tsx': [
        'export function useTsxTarget(value: number) { return value; }',
        'export function useLocalHook(value: number) { return value; }',
        'export function App() {',
        '  useLocalHook(1);',
        '  return useHaskellTarget(1);',
        '}',
      ].join('\n'),
    });
      const app = nodeAt(graph, 'App', 'App.tsx');
      const run = nodeAt(graph, 'run', 'Target.hs');
      const haskellTarget = nodeAt(graph, 'useHaskellTarget', 'Target.hs');
      const tsxTarget = nodeAt(graph, 'useTsxTarget', 'App.tsx');
      const localHook = nodeAt(graph, 'useLocalHook', 'App.tsx');
      const hiddenTarget = nodeAt(graph, 'useHidden', 'Library.hs');

      expect(graph.getOutgoingEdges(app.id).some((edge) => edge.target === haskellTarget.id))
        .toBe(false);
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === tsxTarget.id))
        .toBe(false);
      expect(graph.getOutgoingEdges(app.id).some((edge) => edge.target === localHook.id))
        .toBe(true);
      expect(outgoingTargets(graph, 'runHidden', 'HiddenConsumer.hs')
        .some(({ target }) => target.id === hiddenTarget.id)).toBe(false);
      expect(outgoingTargets(graph, 'runImported', 'ImportedConsumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === hiddenTarget.id))
        .toBe(true);
  });

  it('rejects Haskell targets reached by JVM and Razor special import paths', async () => {
    const graph = await createGraph({
      'Target.hs': [
        'module Foo where',
        'data Bar = Bar',
      ].join('\n'),
      'Main.java': [
        'import Foo.Bar;',
        'public class Main {',
        '  Bar field;',
        '}',
      ].join('\n'),
      'View.razor': [
        '@using Foo',
        '<Bar />',
      ].join('\n'),
    });
      const queries = (graph as unknown as {
        queries: { getNodesByFile(filePath: string): Array<{ id: string }> };
      }).queries;
      const haskellIds = new Set(
        queries.getNodesByFile('Target.hs').map((node) => node.id)
      );
      for (const filePath of ['Main.java', 'View.razor']) {
        const crossesIntoHaskell = queries.getNodesByFile(filePath).some((node) =>
          graph.getOutgoingEdges(node.id).some((edge) => haskellIds.has(edge.target))
        );
        expect(crossesIntoHaskell).toBe(false);
      }
  });

  it('filters a Haskell secondary target from a multi-target resolution', async () => {
    const graph = await createGraph({
      'Target.hs': 'module Target where\nhandler value = value\n',
      'client.js': [
        'export function jsTarget(value) { return value; }',
        'export function jsCaller(value) { return jsTarget(value); }',
      ].join('\n'),
    });
      const jsTarget = nodeAt(graph, 'jsTarget', 'client.js');
      const jsCaller = nodeAt(graph, 'jsCaller', 'client.js');
      const haskellTarget = nodeAt(graph, 'handler', 'Target.hs');
      const resolver = (graph as unknown as {
        resolver: {
          createEdges(resolved: unknown[]): Array<{ target: string }>;
        };
      }).resolver;

      const edges = resolver.createEdges([{
        original: {
          fromNodeId: jsCaller.id,
          referenceName: 'jsTarget',
          referenceKind: 'calls',
          line: 2,
          column: 42,
          filePath: 'client.js',
          language: 'javascript',
        },
        targetNodeId: jsTarget.id,
        alsoTargets: [{ targetNodeId: haskellTarget.id }],
        confidence: 0.95,
        resolvedBy: 'framework',
      }]);

      expect(edges.map((edge) => edge.target)).toEqual([jsTarget.id]);
  });
});
