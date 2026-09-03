import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { extractImportMappings } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell support', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('detects modules and extracts grouped equations, signatures, data, and calls', () => {
    const source = `
module Example.Domain where

import Data.Text qualified as Text

data Mode = Fast | Slow

format :: Mode -> String
format Fast = Text.unpack "fast"
format Slow = helper "slow"

helper value = value

pointFree :: Mode -> String
pointFree = format

label :: String
label = "mode"

applyDollar value = helper $ value

outer value =
  let local item = helper item
   in local value
`;
    const result = extractFromSource('src/Example/Domain.hs', source);

    expect(detectLanguage('src/Example/Domain.hs')).toBe('haskell');
    expect(result.nodes.some((node) => node.kind === 'namespace' && node.name === 'Example.Domain')).toBe(true);
    expect(result.nodes.filter((node) => node.kind === 'function' && node.name === 'format')).toHaveLength(1);
    expect(result.nodes.find((node) => node.kind === 'function' && node.name === 'format')?.signature)
      .toBe('format :: Mode -> String');
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Mode')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'Fast')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'Slow')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'pointFree')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'constant' && node.name === 'label')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'local'
      && node.isExported === false)).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('Text::unpack');
    expect(calls).toContain('helper');
    expect(calls.filter((name) => name === '$')).toHaveLength(0);
  });

  it('extracts point-free instance methods and associated type families', () => {
    const source = `
module Example.Instances where

class Runner a where
  type Result a
  run :: a -> Result a

instance Runner Int where
  type Result Int = String
  run :: Int -> String
  run = show
`;
    const result = extractFromSource('src/Example/Instances.hs', source);

    expect(result.nodes.some((node) => node.kind === 'trait' && node.name === 'Runner')).toBe(true);
    expect(result.nodes.filter((node) => node.kind === 'method' && node.name === 'run')).toHaveLength(2);
    expect(result.nodes.some((node) => node.kind === 'method' && node.name === 'run'
      && node.qualifiedName.includes('Runner Int') && node.startLine === 10 && node.endLine === 11)).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Result')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Result Int')).toBe(true);
  });

  it('extracts associated data instances and standalone deriving instances', () => {
    const source = `
{-# LANGUAGE StandaloneDeriving #-}
module Example.DataInstances where

data RowT f = RowT (f Int)

class Table table where
  data PrimaryKey table f

instance Table RowT where
  data PrimaryKey RowT f = RowId (f Int)

deriving instance Show (RowT Maybe)
`;
    const result = extractFromSource('src/Example/DataInstances.hs', source);

    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'PrimaryKey'
      && node.qualifiedName.includes('Table RowT'))).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'RowId')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'class' && node.name === 'Show (RowT Maybe)'
      && node.decorators?.includes('haskell-deriving-instance'))).toBe(true);
  });

  it('keeps declarations around a valid nested case expression', () => {
    const source = `
module Example.NestedCase where

extractBankDetails entries =
  let mDetails = do
        entry <- entries
        case lookupObject entry =<< case entry of
          Object value -> Just value
          _ -> Nothing of
          Just details -> Just details
          Nothing -> Nothing
      extract details = details
   in paymentMethodToRail $ extract mDetails
extractBankDetails value = value
`;
    const result = extractFromSource('src/Example/NestedCase.hs', source);

    expect(result.nodes.filter((node) => node.kind === 'function' && node.name === 'extractBankDetails')).toHaveLength(1);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'extract'
      && node.isExported === false)).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('lookupObject');
    expect(calls).toContain('paymentMethodToRail');
    expect(calls).toContain('extract');
    expect(calls).not.toContain('$');
  });

  it('parses explicit, wildcard, and ImportQualifiedPost imports', () => {
    const mappings = extractImportMappings(
      'Consumer.hs',
      [
        'module Consumer where',
        'import Lib.Api (runThing, Result (..), (>=>))',
        'import Lib.All',
        'import Lib.Sql qualified as SQL',
        'import qualified Lib.Legacy as Legacy',
      ].join('\n'),
      'haskell'
    );

    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'runThing', exportedName: 'runThing', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'Result', exportedName: 'Result', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '>=>', exportedName: '>=>', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.All', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'SQL', source: 'Lib.Sql', isNamespace: true,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'Legacy', source: 'Lib.Legacy', isNamespace: true,
    }));
  });

  it('parses layout-split and SOURCE imports without consuming the next declaration', () => {
    const mappings = extractImportMappings('Consumer.hs', [
      'module Consumer where',
      'import',
      '  -- lexical whitespace inside the incomplete declaration',
      '',
      '  qualified Lib.Leading as Leading',
      'import Lib.Post',
      '  {- the postpositive modifier may also follow a comment -}',
      '',
      '  qualified',
      '  as Post',
      'import {-# SOURCE #-} Lib.SourcePlain (plain)',
      'import',
      '  {-# SOURCE #-}',
      '  qualified Lib.Boot as Boot',
      '',
      '-- the complete import must not consume this declaration',
      'run = Leading.foo + Post.foo + Boot.foo',
    ].join('\n'), 'haskell');

    expect(mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localName: 'Leading', source: 'Lib.Leading', isNamespace: true,
        isQualifiedOnly: true,
      }),
      expect.objectContaining({
        localName: 'Post', source: 'Lib.Post', isNamespace: true,
        isQualifiedOnly: true,
      }),
      expect.objectContaining({
        localName: 'Boot', source: 'Lib.Boot', isNamespace: true,
        isQualifiedOnly: true,
      }),
      expect.objectContaining({
        localName: 'plain', exportedName: 'plain', source: 'Lib.SourcePlain',
        isNamespace: false,
      }),
    ]));
    // Three qualified namespace routes plus the namespace and named routes
    // contributed by the unqualified explicit SOURCE import.
    expect(mappings).toHaveLength(5);
  });

  it('resolves same-named functions by imported module and captures higher-order uses', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-'));
    fs.mkdirSync(path.join(tmpDir, 'Lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'A.hs'), [
      'module Lib.A where',
      'target x = helper x',
      'helper x = x',
      'pointFree :: Int -> Int',
      'pointFree = target',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'B.hs'), [
      'module Lib.B where',
      'target x = x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'Facade.hs'), [
      'module Lib.Facade (module Lib.A) where',
      'import Lib.A',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'Local.hs'), [
      'module Lib.Local where',
      'outer x = let hidden y = y in hidden x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'pure x = x',
      'length _ = 0',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Lib.A (target)',
      'import Lib.A qualified as A',
      'import Lib.B qualified as B',
      'import Lib.Facade (pointFree)',
      'import Lib.Local (hidden)',
      'run xs = do',
      '  mapM_ target xs',
      '  print (A.target 1)',
      '  print (pointFree 1)',
      '  print (B.target 2)',
      '  print (hidden 3)',
      '  pure (length xs)',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const targetA = graph.getNodesByName('target').find((node) => node.filePath === 'Lib/A.hs')!;
      const targetB = graph.getNodesByName('target').find((node) => node.filePath === 'Lib/B.hs')!;
      const pointFree = graph.getNodesByName('pointFree').find((node) => node.filePath === 'Lib/A.hs')!;
      const decoyPure = graph.getNodesByName('pure').find((node) => node.filePath === 'Decoy.hs')!;
      const decoyLength = graph.getNodesByName('length').find((node) => node.filePath === 'Decoy.hs')!;
      const localHidden = graph.getNodesByName('hidden').find((node) => node.filePath === 'Lib/Local.hs')!;
      const outgoing = graph.getOutgoingEdges(run.id);

      expect(outgoing.some((edge) => edge.target === targetA.id && edge.kind === 'references')).toBe(true);
      expect(outgoing.some((edge) => edge.target === targetA.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === targetB.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === pointFree.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === decoyPure.id)).toBe(false);
      expect(outgoing.some((edge) => edge.target === decoyLength.id)).toBe(false);
      expect(outgoing.some((edge) => edge.target === localHidden.id)).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('preserves the extraction coverage introduced by PR #395', () => {
    const source = `
module Combined where

class (Eq a, Show a) => Render a where
  render :: a -> String

data Person = Person { personName :: String } deriving (Show, Eq)

data Term a where
  IntTerm :: Int -> Term Int

area x = x
total xs = sum (map area xs)

(===) :: Int -> Int -> Bool
x === y = x == y

initialise = pure ()
main = do
  initialise
`;
    const result = extractFromSource('Combined.hs', source);
    const render = result.nodes.find((node) => node.kind === 'trait' && node.name === 'Render')!;
    const person = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Person')!;
    const total = result.nodes.find((node) => node.kind === 'function' && node.name === 'total')!;
    const main = result.nodes.find((node) => node.name === 'main')!;

    expect(result.nodes.some((node) => node.kind === 'field' && node.name === 'personName')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'IntTerm')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === '(===)')).toBe(true);
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === render.id && ref.referenceKind === 'extends')
      .map((ref) => ref.referenceName).sort()).toEqual(['Eq', 'Show']);
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === person.id && ref.referenceKind === 'implements')
      .map((ref) => ref.referenceName).sort()).toEqual(['Eq', 'Show']);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === total.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'area')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === main.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'initialise')).toBe(true);
  });

  it('keeps higher-order synthesis function-first and lexical-scope safe', () => {
    const result = extractFromSource('HigherOrder.hs', `
module HigherOrder where
worker x = x
good xs = map worker xs
parameter f xs = map f xs
dataFirst xs f = forM_ xs f
`);
    const callsFrom = (name: string) => {
      const owner = result.nodes.find((node) => node.kind === 'function' && node.name === name)!;
      return result.unresolvedReferences
        .filter((ref) => ref.fromNodeId === owner.id && ref.referenceKind === 'calls')
        .map((ref) => ref.referenceName);
    };
    expect(callsFrom('good')).toContain('worker');
    expect(callsFrom('parameter')).not.toContain('f');
    expect(callsFrom('dataFirst')).not.toContain('xs');
  });

  it('attributes where and operator-body calls to their own grouped symbols', () => {
    const result = extractFromSource('Scopes.hs', `
module Scopes where
helper x = x
describe x = local x where
  local value = helper value
x <+> y = helper x
`);
    const local = result.nodes.find((node) => node.kind === 'function' && node.name === 'local')!;
    const operator = result.nodes.find((node) => node.kind === 'function' && node.name === '(<+>)')!;
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === local.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'helper')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === operator.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'helper')).toBe(true);
  });

  it('captures monadic and composition operators without treating bound parameters as globals', () => {
    const result = extractFromSource('Operators.hs', `
module Operators where
parse x = x
validate x = x
handler x = x
pipeline = parse >=> validate
consume xs = xs >>= handler
parameter f xs = f <$> xs
`);
    const refsFrom = (name: string) => {
      const owner = result.nodes.find((node) => node.name === name)!;
      return result.unresolvedReferences
        .filter((ref) => ref.fromNodeId === owner.id && ref.referenceKind === 'function_ref')
        .map((ref) => ref.referenceName);
    };
    expect(refsFrom('pipeline')).toEqual(expect.arrayContaining(['parse', 'validate']));
    expect(refsFrom('consume')).toContain('handler');
    expect(refsFrom('parameter')).not.toContain('f');
  });

  it('models child imports and hiding restrictions', () => {
    const mappings = extractImportMappings('Consumer.hs', [
      'module Consumer where',
      'import Lib.Api (Result (..), Runner (run), (>=>))',
      'import Lib.Hidden hiding (secret, Box (..))',
    ].join('\n'), 'haskell');

    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.Api', parentExport: 'Result', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'run', source: 'Lib.Api', parentExport: 'Runner', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.Hidden', isNamespace: false,
      excludedNames: expect.arrayContaining(['secret', 'Box']),
      excludedParentExports: ['Box'],
    }));
  });

  it('resolves constructors and class methods imported through Parent(..)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-children-'));
    fs.writeFileSync(path.join(tmpDir, 'Canonical.hs'), [
      'module Canonical (EventExpr (..), IsEvent (..)) where',
      'data EventExpr = EventInsert | EventDelete',
      'class IsEvent a where',
      '  runEvent :: a -> EventExpr',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'data EventExpr = EventDelete',
      'class IsEvent a where',
      '  runEvent :: a -> EventExpr',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Canonical (EventExpr (..), IsEvent (..))',
      'run value = EventDelete (runEvent value)',
      'wrap = EventDelete . runEvent',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      await graph.indexAll(); // Incremental/full repetition must stay stable.
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const canonicalDelete = graph.getNodesByName('EventDelete')
        .find((node) => node.filePath === 'Canonical.hs')!;
      const decoyDelete = graph.getNodesByName('EventDelete')
        .find((node) => node.filePath === 'Decoy.hs')!;
      const canonicalMethod = graph.getNodesByName('runEvent')
        .find((node) => node.filePath === 'Canonical.hs')!;
      const outgoing = graph.getOutgoingEdges(run.id);
      const wrap = graph.getNodesByName('wrap').find((node) => node.filePath === 'Main.hs')!;
      const wrapOutgoing = graph.getOutgoingEdges(wrap.id);

      expect(outgoing.some((edge) => edge.target === canonicalDelete.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === canonicalMethod.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === decoyDelete.id)).toBe(false);
      expect(wrapOutgoing.some((edge) => edge.target === canonicalDelete.id
        && edge.kind === 'references')).toBe(true);
      expect(wrapOutgoing.some((edge) => edge.target === canonicalMethod.id
        && edge.kind === 'references')).toBe(true);
      expect(graph.getNodesByName('run').filter((node) => node.filePath === 'Main.hs')).toHaveLength(1);
    } finally {
      graph.destroy();
    }
  });

  it('honours module export lists and import hiding', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-exports-'));
    fs.writeFileSync(path.join(tmpDir, 'Lib.hs'), [
      'module Lib (public, Box (Visible)) where',
      'public x = x',
      'private x = x',
      'data Box = Visible | Secret',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Lib hiding (public)',
      'run x = public (private (Visible (Secret x)))',
    ].join('\n'));

    const extracted = extractFromSource('Lib.hs', fs.readFileSync(path.join(tmpDir, 'Lib.hs'), 'utf8'));
    expect(extracted.nodes.find((node) => node.name === 'public')?.isExported).toBe(true);
    expect(extracted.nodes.find((node) => node.name === 'private')?.isExported).toBe(false);
    expect(extracted.nodes.find((node) => node.name === 'Visible')?.isExported).toBe(true);
    expect(extracted.nodes.find((node) => node.name === 'Secret')?.isExported).toBe(false);

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const targets = new Set(graph.getOutgoingEdges(run.id).map((edge) => edge.target));
      for (const name of ['public', 'private', 'Secret']) {
        const node = graph.getNodesByName(name).find((candidate) => candidate.filePath === 'Lib.hs')!;
        expect(targets.has(node.id)).toBe(false);
      }
      const visible = graph.getNodesByName('Visible').find((node) => node.filePath === 'Lib.hs')!;
      expect(targets.has(visible.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('follows a named re-export sourced from an unqualified wildcard import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-reexport-'));
    fs.writeFileSync(path.join(tmpDir, 'Origin.hs'), 'module Origin (foo) where\nfoo x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'Facade.hs'), 'module Facade (foo) where\nimport Origin\n');
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), 'module Main where\nimport Facade (foo)\nrun = foo 1\n');

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const foo = graph.getNodesByName('foo').find((node) => node.filePath === 'Origin.hs')!;
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === foo.id && edge.kind === 'calls')).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('does not resolve monadic and let-bound callables to imported decoys', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-monad-scope-'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'handler x = x',
      'local x = x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Decoy (handler, local)',
      'run request = do',
      '  handler <- acquire',
      '  let local = handler',
      '  handler request',
      '  local request',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const outgoing = new Set(graph.getOutgoingEdges(run.id).map((edge) => edge.target));
      for (const name of ['handler', 'local']) {
        const decoy = graph.getNodesByName(name).find((node) => node.filePath === 'Decoy.hs')!;
        expect(outgoing.has(decoy.id)).toBe(false);
      }
    } finally {
      graph.destroy();
    }
  });

  it('distinguishes patterns from calls and normalizes infix and bare qualified actions', () => {
    const result = extractFromSource('Advanced.hs', `
module Advanced where
combine x y = x
run xs value = xs \`combine\` value
qualified xs ys = xs \`Data.List.union\` ys
qualifiedHof xs = Data.List.map target xs
match value = case value of
  Just handler -> handler 1
lambda = \\(Just handler) -> handler 1
monadic action = do
  Just handler <- action
  handler 1
  Server.start
  (Server.stop)
alias :: Int -> Int
alias = combine 1
target x = x
pointFree :: Int -> Int
pointFree = target
handlers :: [Int -> IO ()]
handlers = []
class C a where
  first, second :: a -> a
data family Family a
data instance Family Int = FamilyInt Int
data instance Family Bool = FamilyBool Bool
pattern Present x = Just x
`);

    const refs = result.unresolvedReferences;
    expect(refs.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'combine')).toBe(true);
    expect(refs.some((ref) => ref.referenceKind === 'calls'
      && ref.referenceName === 'Data.List::union')).toBe(true);
    const qualifiedHof = result.nodes.find((node) => node.name === 'qualifiedHof')!;
    expect(refs.some((ref) => ref.fromNodeId === qualifiedHof.id
      && ref.referenceKind === 'function_ref' && ref.referenceName === 'target')).toBe(true);
    expect(refs.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'Server::start')).toBe(true);
    expect(refs.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'Server::stop')).toBe(true);
    expect(refs.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'Just')).toBe(false);
    expect(refs.some((ref) => ref.referenceKind === 'references' && ref.referenceName === 'Just')).toBe(true);
    expect(refs.some((ref) => ref.referenceKind === 'function_ref' && ref.referenceName === 'target')).toBe(true);
    expect(result.nodes.find((node) => node.name === 'handlers')?.kind).toBe('constant');
    expect(result.nodes.filter((node) => node.kind === 'method' && ['first', 'second'].includes(node.name)))
      .toHaveLength(2);
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Family'
      && node.decorators?.includes('haskell-data-family'))).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Family Int')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Family Bool')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'Present'
      && node.decorators?.includes('haskell-pattern-synonym'))).toBe(true);
  });

  it('prefers lexical let/where functions and suppresses comprehension and guard binders', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-lexical-'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'helper x = x',
      'local x = x',
      'f x = x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Decoy (helper, local, f)',
      'run n = let helper x = if x == 0 then 0 else helper (x - 1) in helper n',
      'outer n = local n where',
      '  local x = if x == 0 then 0 else local (x - 1)',
      'comp fs xs = [f x | f <- fs, x <- xs]',
      'guarded mf x | Just f <- mf = f x',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const decoys = new Set(['helper', 'local', 'f'].map((name) =>
        graph.getNodesByName(name).find((node) => node.filePath === 'Decoy.hs')!.id));
      for (const ownerName of ['run', 'outer', 'comp', 'guarded']) {
        const owner = graph.getNodesByName(ownerName).find((node) => node.filePath === 'Main.hs')!;
        expect(graph.getOutgoingEdges(owner.id).some((edge) => decoys.has(edge.target))).toBe(false);
      }
      for (const name of ['helper', 'local']) {
        const owner = graph.getNodesByName(name).find((node) => node.filePath === 'Main.hs')!;
        const outgoing = graph.getOutgoingEdges(owner.id);
        expect(outgoing.some((edge) => edge.target === owner.id && edge.kind === 'calls')).toBe(true);
      }
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const helper = graph.getNodesByName('helper').find((node) => node.filePath === 'Main.hs')!;
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === helper.id && edge.kind === 'calls')).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('keeps function references inside Haskell import scope', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-fnref-scope-'));
    fs.writeFileSync(path.join(tmpDir, 'Lib.hs'), 'module Lib (hidden) where\nhidden x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Lib hiding (hidden)',
      'wrap = hidden . id',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'NoImport.hs'), 'module NoImport where\nwrap = hidden . id\n');

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const hidden = graph.getNodesByName('hidden').find((node) => node.filePath === 'Lib.hs')!;
      for (const filePath of ['Main.hs', 'NoImport.hs']) {
        const wrap = graph.getNodesByName('wrap').find((node) => node.filePath === filePath)!;
        expect(graph.getOutgoingEdges(wrap.id).some((edge) => edge.target === hidden.id)).toBe(false);
      }
    } finally {
      graph.destroy();
    }
  });

  it('preserves Haskell re-export aliases, restrictions, qualifiedness, and children', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-reexport-semantics-'));
    fs.writeFileSync(path.join(tmpDir, 'Origin.hs'), [
      'module Origin (foo, secret, T (..)) where',
      'foo x = x',
      'secret x = x',
      'data T = A | B',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Restricted.hs'), [
      'module Restricted (module Origin) where',
      'import Origin (foo)',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Qualified.hs'), [
      'module Qualified (module Origin) where',
      'import qualified Origin',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Aliased.hs'), [
      'module Aliased (module O) where',
      'import Origin as O',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Children.hs'), [
      'module Children (T (..)) where',
      'import Origin (T (..))',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Restricted qualified as R',
      'import Qualified qualified as Q',
      'import Aliased qualified as X',
      'import Children (T (..))',
      'restricted = R.foo 1',
      'restrictedSecret = R.secret 1',
      'qualifiedOnly = Q.foo 1',
      'aliased = X.foo 1',
      'children = A',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const origin = (name: string) => graph.getNodesByName(name)
        .find((node) => node.filePath === 'Origin.hs')!;
      const reaches = (owner: string, target: string) => {
        const from = graph.getNodesByName(owner).find((node) => node.filePath === 'Main.hs')!;
        return graph.getOutgoingEdges(from.id).some((edge) => edge.target === origin(target).id);
      };
      expect(reaches('restricted', 'foo')).toBe(true);
      expect(reaches('restrictedSecret', 'secret')).toBe(false);
      expect(reaches('qualifiedOnly', 'foo')).toBe(false);
      expect(reaches('aliased', 'foo')).toBe(true);
      expect(reaches('children', 'A')).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('prefers the exact module path when duplicate Haskell headers exist', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-duplicate-module-'));
    fs.mkdirSync(path.join(tmpDir, 'pkg', 'src', 'Foo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pkg', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'src', 'Wrong.hs'), 'module Foo.Bar where\ntarget x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'src', 'Foo', 'Bar.hs'), 'module Foo.Bar where\ntarget x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'app', 'Main.hs'), [
      'module Main where',
      'import Foo.Bar (target)',
      'run x = target x',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'pkg/app/Main.hs')!;
      const exact = graph.getNodesByName('target').find((node) => node.filePath === 'pkg/src/Foo/Bar.hs')!;
      const wrong = graph.getNodesByName('target').find((node) => node.filePath === 'pkg/src/Wrong.hs')!;
      const targets = new Set(graph.getOutgoingEdges(run.id).map((edge) => edge.target));
      expect(targets.has(exact.id)).toBe(true);
      expect(targets.has(wrong.id)).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('invalidates incoming edges when a Haskell export list changes during sync', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-sync-exports-'));
    const libPath = path.join(tmpDir, 'Lib.hs');
    fs.writeFileSync(libPath, 'module Lib (foo) where\nfoo x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), 'module Main where\nimport Lib (foo)\nrun x = foo x\n');

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      let run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      let foo = graph.getNodesByName('foo').find((node) => node.filePath === 'Lib.hs')!;
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === foo.id)).toBe(true);

      fs.writeFileSync(libPath, 'module Lib () where\nfoo x = x\n');
      await graph.sync();
      run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      foo = graph.getNodesByName('foo').find((node) => node.filePath === 'Lib.hs')!;
      expect(foo.isExported).toBe(false);
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === foo.id)).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('ignores imports inside nested Haskell comments', () => {
    const mappings = extractImportMappings('Comments.hs', [
      'module Comments where',
      '{- outer',
      '   {- inner -}',
      '   import Phantom',
      '-}',
      'import Real',
    ].join('\n'), 'haskell');
    expect(mappings.some((mapping) => mapping.source === 'Phantom')).toBe(false);
    expect(mappings.some((mapping) => mapping.source === 'Real')).toBe(true);
  });

  it('ignores source-looking imports inside quasiquotes and multiline strings', () => {
    const mappings = extractImportMappings('QuotedImports.hs', [
      '{-# LANGUAGE MultilineStrings, PackageImports, QuasiQuotes #-}',
      'module QuotedImports where',
      'import "home" Real (foo)',
      "import Primed (foo', bar')",
      'plain = [r|',
      'import Phantom.Plain (foo)',
      '|]',
      'qualified = [QQ.r|',
      'import Phantom.Qualified (foo)',
      '|]',
      'deep = [A.B.r|',
      'import Phantom.Deep (foo)',
      '|]',
      'multiline = """',
      'import Phantom.Multiline (foo)',
      '\\""" still inside',
      'import Phantom.AfterEscape (foo)',
      '"""',
      'literal = "[r| this is ordinary string data"',
      '-- [r| this is a comment opener',
      '[value| no quasiquote closer',
      'import StillReal (bar)',
      'quote = \'"\'',
      '{- nested after a character containing a double quote',
      '   {- inner -}',
      '   import Phantom.AfterChar (foo)',
      '-}',
      'import AfterChar (baz)',
    ].join('\r\n'), 'haskell');

    expect(new Set(mappings.map((mapping) => mapping.source)))
      .toEqual(new Set(['Real', 'Primed', 'StillReal', 'AfterChar']));
    expect(mappings).toContainEqual(expect.objectContaining({
      source: 'Real', packageQualifier: 'home', localName: 'foo',
    }));
    expect(mappings.filter((mapping) => mapping.source === 'Primed').map((mapping) => mapping.localName))
      .toEqual(expect.arrayContaining(["foo'", "bar'"]));
    expect(mappings.some((mapping) => mapping.source === 'Primed' && mapping.localName === 'foo'))
      .toBe(false);
  });

  it('does not close a Template Haskell quote on a string containing its delimiter', () => {
    const mappings = extractImportMappings('TemplateQuote.hs', [
      '{-# LANGUAGE TemplateHaskell #-}',
      'module TemplateQuote where',
      'import A (foo)',
      'quoted = [e| "|]" |]',
      '{- ordinary comment after the quoted string',
      '   import Phantom (foo)',
      '-}',
      'run = foo 1',
    ].join('\n'), 'haskell');

    expect(new Set(mappings.map((mapping) => mapping.source))).toEqual(new Set(['A']));
  });

  it('indexes long do blocks without quadratic lexical rescans', () => {
    const statements = Array.from({ length: 2000 }, (_, index) => `  value${index} <- action`);
    const result = extractFromSource('Generated.hs', [
      'module Generated where',
      'run = do',
      ...statements,
      '  pure ()',
    ].join('\n'));
    expect(result.nodes.some((node) => node.name === 'run')).toBe(true);
    expect(result.errors).toHaveLength(0);
  }, 4000);

  it('shares grouped signatures without leaking declaration state across extractions', () => {
    const source = [
      'module Grouped where',
      'foo, bar :: Int -> Int',
      'foo 0 = 0',
      'foo x = x',
      'bar x = x',
    ].join('\n');

    for (let i = 0; i < 25; i++) {
      const result = extractFromSource('Grouped.hs', source);
      const foo = result.nodes.filter((node) => node.kind === 'function' && node.name === 'foo');
      const bar = result.nodes.filter((node) => node.kind === 'function' && node.name === 'bar');
      expect(foo).toHaveLength(1);
      expect(bar).toHaveLength(1);
      expect(foo[0]?.signature).toBe('foo, bar :: Int -> Int');
      expect(bar[0]?.signature).toBe('foo, bar :: Int -> Int');
      expect(foo[0]?.startColumn).toBe(0);
      expect(foo[0]?.endLine).toBe(4);
    }
  });
});
