import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

type ExtractionResult = ReturnType<typeof extractFromSource>;

function refsFor(result: ExtractionResult, ownerName: string) {
  const owner = result.nodes.find((node) => node.name === ownerName);
  expect(owner, `missing owner ${ownerName}`).toBeDefined();
  return result.unresolvedReferences.filter((ref) => ref.fromNodeId === owner!.id);
}

function refsFrom(source: string, ownerName: string) {
  const result = extractFromSource('Round2.hs', source);
  return { result, refs: refsFor(result, ownerName) };
}

describe('Haskell extractor round 2', () => {
  it('preserves type and value namespaces in explicit module exports', () => {
    const source = `
{-# LANGUAGE ExplicitNamespaces, PatternSynonyms, TypeOperators #-}
module Round2 (type T, pattern V, W, X(..), (+++), type (+++)) where
data T = T
data V = V
data W = W
data X = X
type a +++ b = (a, b)
(+++) :: Int -> Int -> Int
(+++) = (+)
`;
    const result = extractFromSource('Round2.hs', source);
    const exported = (name: string, kind: string): boolean => result.nodes.some((node) =>
      node.name === name && node.kind === kind && node.isExported === true
    );

    expect(exported('T', 'enum')).toBe(true);
    expect(exported('T', 'enum_member')).toBe(false);
    expect(exported('V', 'enum')).toBe(false);
    expect(exported('V', 'enum_member')).toBe(true);
    expect(exported('W', 'enum')).toBe(true);
    expect(exported('W', 'enum_member')).toBe(false);
    expect(exported('X', 'enum')).toBe(true);
    expect(exported('X', 'enum_member')).toBe(true);
    expect(exported('(+++)', 'type_alias')).toBe(true);
    expect(exported('(+++)', 'function')).toBe(true);
  });

  it('preserves namespaces for grouped class children while keeping C(..) open', () => {
    const source = `
{-# LANGUAGE ExplicitNamespaces, TypeFamilies, TypeOperators #-}
module Round2 (C(type (<+>)), D((<!>)), E(..)) where
class C a where
  type a <+> b
  (<+>) :: a -> a -> a
class D a where
  type a <!> b
  (<!>) :: a -> a -> a
class E a where
  type a <#> b
  (<#>) :: a -> a -> a
`;
    const result = extractFromSource('Round2.hs', source);
    const exported = (name: string, kind: string): boolean => result.nodes.some((node) =>
      node.name === name && node.kind === kind && node.isExported === true
    );

    expect(exported('(<+>)', 'type_alias')).toBe(true);
    expect(exported('(<+>)', 'method')).toBe(false);
    expect(exported('(<!>)', 'type_alias')).toBe(false);
    expect(exported('(<!>)', 'method')).toBe(true);
    expect(exported('(<#>)', 'type_alias')).toBe(true);
    expect(exported('(<#>)', 'method')).toBe(true);
  });

  it('normalizes qualified and left-spine class references', () => {
    const source = `
module Round2 where
import qualified A
class (Parent a b, A.Eq a) => Child a where
  child :: a -> a
instance A.Show Thing where
  show = A.render
data Thing = Thing deriving (A.Read)
`;
    const result = extractFromSource('Round2.hs', source);
    const child = result.nodes.find((node) => node.kind === 'trait' && node.name === 'Child')!;
    const instance = result.nodes.find((node) => node.kind === 'class' && node.name === 'A.Show Thing')!;
    const thing = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Thing')!;

    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === child.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([['extends', 'Parent'], ['extends', 'A::Eq']]));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: instance.id, referenceKind: 'implements', referenceName: 'A::Show',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: thing.id, referenceKind: 'implements', referenceName: 'A::Read',
    }));
  });

  it('extracts classes from every deriving strategy clause', () => {
    const source = `
{-# LANGUAGE DeriveAnyClass, DerivingStrategies #-}
module Round2 where
data Thing = Thing
  deriving stock (Eq)
  deriving anyclass (Show, Read)
`;
    const result = extractFromSource('Round2.hs', source);
    const thing = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Thing')!;
    expect(result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === thing.id && ref.referenceKind === 'implements')
      .map((ref) => ref.referenceName)
      .sort())
      .toEqual(['Eq', 'Read', 'Show']);
  });

  it('extracts infix type, data, class, instance, and constructor declarations from their LHS', () => {
    const source = `
{-# LANGUAGE FlexibleInstances, MultiParamTypeClasses, TypeFamilies, TypeOperators #-}
module Round2 where
type a :+: b = Either a b
type family a + b
type instance Int + b = b
data family a :*: b
data instance Int :*: b = D b
class a :=: b where
  convert :: a -> b
instance Int :=: Bool where
  convert = check
data Pair a b = a :**: b
`;
    const result = extractFromSource('Round2.hs', source);
    const names = result.nodes.map((node) => [node.kind, node.name]);

    expect(names).toEqual(expect.arrayContaining([
      ['type_alias', '(:+:)'],
      ['type_alias', '(+)'],
      ['type_alias', 'Int + b'],
      ['enum', '(:*:)'],
      ['enum', 'Int :*: b'],
      ['trait', '(:=:)'],
      ['class', 'Int :=: Bool'],
      ['method', 'convert'],
      ['enum_member', '(:**:)'],
    ]));
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Either')).toBe(false);
    const operatorInstance = result.nodes.find((node) => node.kind === 'class' && node.name === 'Int :=: Bool')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: operatorInstance.id, referenceKind: 'implements', referenceName: ':=:',
    }));
  });

  it('keeps backtick declaration identifiers bare and joins their signatures and exports', () => {
    const source = [
      '{-# LANGUAGE TypeOperators #-}',
      'module Round2 (foo, sommé, PairAlias) where',
      'foo :: Int -> Int -> Int',
      'x `foo` y = x + y',
      'sommé :: Int -> Int -> Int',
      'x `sommé` y = x + y',
      'type a `PairAlias` b = (a, b)',
      '',
    ].join('\n');
    const result = extractFromSource('Round2.hs', source);
    const foo = result.nodes.filter((node) => node.kind === 'function' && node.name === 'foo');

    expect(foo).toHaveLength(1);
    expect(foo[0]).toEqual(expect.objectContaining({
      signature: 'foo :: Int -> Int -> Int',
      isExported: true,
    }));
    expect(result.nodes.some((node) => node.name === '(`foo`)')).toBe(false);
    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'function', name: 'sommé', isExported: true,
      signature: 'sommé :: Int -> Int -> Int',
    }));
    expect(result.nodes.some((node) => node.name === '(sommé)')).toBe(false);
    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'type_alias',
      name: 'PairAlias',
      isExported: true,
    }));
  });

  it('canonicalizes alphabetic infix classes, instances, and pattern synonyms', () => {
    const source = [
      '{-# LANGUAGE MultiParamTypeClasses, PatternSynonyms, StandaloneDeriving, TypeOperators #-}',
      'module Round2 (Rel, Wrapped(WrappedBy), pattern Pair) where',
      'class a `Rel` b where',
      '  relate :: a -> b -> Bool',
      'instance Int `Rel` Bool where',
      '  relate _ _ = True',
      'deriving instance Int `Rel` Bool',
      'data Wrapped a b = a `WrappedBy` b',
      'useWrapped left right = left `WrappedBy` right',
      'pattern Pair :: a -> b -> (a, b)',
      'pattern left `Pair` right = (left, right)',
      '',
    ].join('\n');
    const result = extractFromSource('Round2.hs', source);

    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'trait', name: 'Rel', isExported: true,
    }));
    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'enum_member', name: 'Pair', isExported: true,
      signature: expect.stringContaining('pattern Pair ::'),
    }));
    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'enum_member', name: 'WrappedBy', isExported: true,
    }));
    expect(result.nodes.some((node) =>
      node.name === '`Rel`'
      || node.name === '`Pair`'
      || node.name === '`WrappedBy`')).toBe(false);
    expect(result.unresolvedReferences.filter((ref) => ref.referenceKind === 'implements'))
      .toEqual([
        expect.objectContaining({ referenceName: 'Rel' }),
        expect.objectContaining({ referenceName: 'Rel' }),
      ]);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'e')).toBe(false);
    expect(refsFrom(source, 'useWrapped').refs.filter((ref) => ref.referenceName === 'WrappedBy'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
  });

  it('keeps infix operands lexical and executes view-pattern expressions', () => {
    const source = `
{-# LANGUAGE ViewPatterns #-}
module Round2 where
handler value = value
handler .@. x = handler x
view value = Just value
use value = value
f (view -> Just x) = use x
g (view config -> Nothing) = config
qualifiedView (Views.view -> Just x) = use x
h value = case value of
  Nothing -> use value
  Just y -> use y
`;
    const result = extractFromSource('Round2.hs', source);
    const operator = result.nodes.find((node) => node.name === '(.@.)')!;
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === operator.id
      && ['handler', 'x'].includes(ref.referenceName))).toBe(false);

    const f = result.nodes.find((node) => node.name === 'f')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === f.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([
        ['calls', 'view'], ['references', 'Just'], ['calls', 'use'],
      ]));
    const g = result.nodes.find((node) => node.name === 'g')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === g.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([['calls', 'view'], ['references', 'Nothing']]));
    const qualifiedView = result.nodes.find((node) => node.name === 'qualifiedView')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: qualifiedView.id, referenceKind: 'calls', referenceName: 'Views::view',
    }));
    const h = result.nodes.find((node) => node.name === 'h')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === h.id
      && ref.referenceKind === 'references').map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['Nothing', 'Just']));
  });

  it('treats prefix symbolic parameters as lexical binders', () => {
    const source = `
module Round2 where
import Ops ((<::>))
f (<::>) = (<::>) 1 2
g = \\(<::>) -> (<::>) 1 2
control x = (<::>) x x
`;
    const result = extractFromSource('Round2.hs', source);
    for (const owner of ['f', 'g']) {
      const refs = refsFrom(source, owner).refs.filter((ref) =>
        ['<::>', '(<::>)'].includes(ref.referenceName));
      expect(refs).toEqual([]);
    }
    expect(refsFrom(source, 'control').refs.filter((ref) =>
      ['<::>', '(<::>)'].includes(ref.referenceName)))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
  });

  it('does not duplicate a Unicode constructor passed to a known HOF', () => {
    const source = `
module Round2 where
data T = Éclair Int
a xs = map Éclair xs
b f = f Éclair
d x = Éclair x
`;
    expect(refsFrom(source, 'a').refs.filter((ref) => ref.referenceName === 'Éclair'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    expect(refsFrom(source, 'b').refs.filter((ref) => ref.referenceName === 'Éclair'))
      .toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    expect(refsFrom(source, 'd').refs.filter((ref) => ref.referenceName === 'Éclair'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
  });

  it('extracts and calls identifiers in the Unicode Other_Letter category', () => {
    const source = `
module Round2 (函数, run) where
import qualified Origin as O
函数 value = value
run = 函数 1
qualifiedRun = O.函数 1
`;
    const result = extractFromSource('Round2.hs', source);
    const declaration = result.nodes.find((node) => node.name === '函数');
    expect(declaration).toBeDefined();
    expect(refsFrom(source, 'run').refs.filter((ref) => ref.referenceName === '函数'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    expect(refsFrom(source, 'qualifiedRun').refs.filter((ref) => ref.referenceName === 'O::函数'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
  });

  it('distinguishes record labels, explicit binders, and field puns', () => {
    const source = `
{-# LANGUAGE NamedFieldPuns #-}
module Round2 where
data Record = Record { field :: Int -> Int }
explicit (Record { field = local }) = field (local 1)
punned Record { field } = field 1
`;
    const result = extractFromSource('Round2.hs', source);
    const explicit = result.nodes.find((node) => node.name === 'explicit')!;
    const punned = result.nodes.find((node) => node.name === 'punned')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: explicit.id, referenceKind: 'calls', referenceName: 'field',
    }));
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === explicit.id
      && ref.referenceName === 'local')).toBe(false);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === punned.id
      && ref.referenceName === 'field' && ref.referenceKind === 'calls')).toBe(false);
  });

  it('extracts symbolic and record pattern synonyms and their constructor dependencies', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern x :++: xs = x : xs
pattern Present { presentValue } = Just presentValue
`;
    const result = extractFromSource('Round2.hs', source);
    const symbolic = result.nodes.find((node) => node.kind === 'enum_member' && node.name === '(:++:)')!;
    const record = result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'Present')!;
    expect(symbolic).toBeDefined();
    expect(record).toBeDefined();
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: symbolic.id, referenceKind: 'references', referenceName: ':',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: record.id, referenceKind: 'references', referenceName: 'Just',
    }));
  });

  it('keeps signatures across pragmas and captures sections and qualified prefix operators', () => {
    const source = `
module Round2 where
f :: Int -> Int
{-# INLINE f #-}
f = id
increment = (+ 1)
mapped xs = map (\`op\` 2) xs
qualified = (L.<+>)
qualifiedSection = (1 L.<+>)
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'f')).toEqual(expect.objectContaining({
      kind: 'function', signature: 'f :: Int -> Int',
    }));
    expect(result.nodes.find((node) => node.name === 'increment')?.kind).toBe('function');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: '+' }),
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: 'op' }),
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: 'L::(<+>)' }),
    ]));
    const qualifiedSection = result.nodes.find((node) => node.name === 'qualifiedSection')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: qualifiedSection.id, referenceKind: 'function_ref', referenceName: 'L::(<+>)',
    }));
  });

  it('keeps declaration types out of runtime edges while walking annotated expressions', () => {
    const source = `
{-# LANGUAGE ScopedTypeVariables, TypeApplications #-}
module Round2 where
import qualified Request
run :: Request.HandleMonad m => Int -> m ()
run value = pure value
outer =
  let local :: forall m. Monad m => m Int
      local = pure 1
  in consume local
typed value = (make value :: Wrapper Int)
ctor = (Nothing :: Maybe Int)
typedApplication value = Request.consume @Request.HandleMonad value
nestedTypeApplication value = Request.consume @(ast Request.HandleMonad) value
`;
    const result = extractFromSource('Round2.hs', source);
    const runtimeNames = result.unresolvedReferences.map((ref) => ref.referenceName);
    for (const typeName of ['Request::HandleMonad', 'Monad', 'Wrapper', 'Maybe', 'Int', 'm']) {
      expect(runtimeNames).not.toContain(typeName);
    }
    const namespace = result.nodes.find((node) => node.kind === 'namespace' && node.name === 'Round2')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === namespace.id
      && ['calls', 'function_ref', 'references'].includes(ref.referenceKind)))
      .toEqual([]);

    expect(refsFor(result, 'run')).toContainEqual(expect.objectContaining({
      referenceKind: 'calls', referenceName: 'pure',
    }));
    expect(refsFor(result, 'typed')).toContainEqual(expect.objectContaining({
      referenceKind: 'calls', referenceName: 'make',
    }));
    expect(refsFor(result, 'ctor')).toContainEqual(expect.objectContaining({
      referenceKind: 'references', referenceName: 'Nothing',
    }));
    expect(refsFor(result, 'typedApplication')).toContainEqual(expect.objectContaining({
      referenceKind: 'calls', referenceName: 'Request::consume',
    }));
    expect(refsFor(result, 'nestedTypeApplication')).toEqual([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Request::consume' }),
    ]);
  });

  it('keeps type annotations and later view-pattern binders out of term scope', () => {
    const source = `
{-# LANGUAGE ScopedTypeVariables, ViewPatterns #-}
module Round2 where
helper value = value
typed :: forall helper. helper -> helper
typed (value :: helper) = helper value
viewed (helper -> helper) = helper
later (helper -> value) helper = value
caseViewed input = case input of
  (helper -> helper) -> helper
sequenced = do
  helper <- helper
  pure helper
guarded input
  | Just helper <- helper input = helper
comprehended input = [helper | helper <- helper input]
visibleTypeApplication (Just @helper value) = helper value
`;
    const result = extractFromSource('Round2.hs', source);
    const refs = (owner: string) => refsFor(result, owner)
      .filter((ref) => ref.referenceName === 'helper');

    for (const owner of [
      'typed', 'viewed', 'later', 'caseViewed', 'sequenced', 'guarded', 'comprehended',
      'visibleTypeApplication',
    ]) {
      expect(refs(owner), owner).toEqual([
        expect.objectContaining({ referenceKind: 'calls' }),
      ]);
    }
  });

  it('does not turn visible type specialization into a term call', () => {
    const source = `
{-# LANGUAGE GADTs, ScopedTypeVariables, TypeApplications, ViewPatterns #-}
module Round2 where
data Proxy a = Proxy
helper :: forall a. Int -> Int
helper value = value
action :: forall a. IO Int
action = pure 1
specialized = helper @Int
applied value = helper @Int value
viaDollar = helper @Int $ 1
viaStrictDollar = helper @Int $! 1
multilineDollar =
  helper @Int
    $ 1
viaAmp value = value & helper @Int
composed = id . helper @Int
passed = consume (helper @Int)
proxy = Proxy @Int
effectAlias :: IO Int
effectAlias = action @Int
run = do
  value <- action @Int
  action @Bool
view (helper @Int -> value) = value
guarded | Just value <- matcher @Int = value
generated = [value | value <- source @Int]
`;
    const result = extractFromSource('Round2.hs', source);
    const refs = (owner: string) => refsFor(result, owner);
    const named = (owner: string, name: string) => refs(owner)
      .filter((ref) => ref.referenceName === name);

    for (const owner of ['specialized', 'composed', 'passed']) {
      expect(named(owner, 'helper'), owner).toEqual([
        expect.objectContaining({ referenceKind: 'function_ref' }),
      ]);
    }
    for (const owner of ['applied', 'viaDollar', 'viaStrictDollar', 'multilineDollar', 'viaAmp']) {
      expect(named(owner, 'helper')).toEqual([
        expect.objectContaining({ referenceKind: 'calls' }),
      ]);
    }
    expect(named('proxy', 'Proxy')).toEqual([
      expect.objectContaining({ referenceKind: 'references' }),
    ]);
    expect(named('effectAlias', 'action')).toEqual([
      expect.objectContaining({ referenceKind: 'haskell_effect_alias' }),
    ]);
    expect(named('run', 'action')).toEqual([
      expect.objectContaining({ referenceKind: 'calls' }),
      expect.objectContaining({ referenceKind: 'calls' }),
    ]);
    expect(named('view', 'helper')).toEqual([
      expect.objectContaining({ referenceKind: 'calls' }),
    ]);
    expect(named('guarded', 'matcher')).toEqual([
      expect.objectContaining({ referenceKind: 'calls' }),
    ]);
    expect(named('generated', 'source')).toEqual([
      expect.objectContaining({ referenceKind: 'calls' }),
    ]);
  });

  it('keeps Template Haskell code-as-data out of runtime flow while visiting active splices', () => {
    const source = `
{-# LANGUAGE QuasiQuotes, TemplateHaskell #-}
module Round2 where
data QuotedType = QuotedConstructor Int
runtimeTarget value = value
compileExpr value = value
compileTyped value = value
compileDecl value = value
compileType value = value
compilePattern value = value
deferredCompile value = value
exprQuote = [| runtimeTarget quoteArgument |]
typedExprQuote = [|| runtimeTarget quoteArgument ||]
declQuote = [d| generated = runtimeTarget quoteArgument |]
typeQuote = [t| Either QuotedType QuotedType |]
patternQuote = [p| QuotedConstructor captured |]
nameQuote = 'runtimeTarget
typeNameQuote = ''QuotedType
quasiQuote = [qq| runtimeTarget quoteArgument |]
untypedSplice = $(compileExpr spliceArgument)
typedSplice = $$(compileTyped spliceArgument)
bareSplice = $compileExpr
parenthesizedBareSplice = $(compileExpr)
typedBareSplice = $$(compileTyped)
exprWithSplice = [| runtimeTarget ($(compileExpr spliceArgument)) |]
typedExprWithSplice = [|| runtimeTarget ($$(compileTyped spliceArgument)) ||]
exprWithBareSplice = [| runtimeTarget ($(compileExpr)) |]
typedExprWithBareSplice = [|| runtimeTarget ($$(compileTyped)) ||]
declWithSplice = [d| generatedWithSplice = $(compileDecl spliceArgument) |]
typeWithSplice = [t| Maybe $(compileType spliceArgument) |]
patternWithSplice = [p| Just $(compilePattern spliceArgument) |]
instanceWithSplice = [d| instance Eq $(compileType spliceArgument) where |]
nestedQuote = [| [| runtimeTarget ($(deferredCompile spliceArgument)) |] |]
nestedBareQuote = [| [| runtimeTarget ($(deferredCompile)) |] |]
`;
    const result = extractFromSource('Round2.hs', source);
    const refs = (owner: string) => {
      const node = result.nodes.find((candidate) => candidate.name === owner)!;
      return result.unresolvedReferences.filter((ref) => ref.fromNodeId === node.id);
    };

    for (const owner of [
      'exprQuote', 'typedExprQuote', 'declQuote', 'typeQuote', 'patternQuote',
      'nameQuote', 'typeNameQuote', 'quasiQuote', 'nestedQuote', 'nestedBareQuote',
    ]) {
      expect(refs(owner), owner).toEqual([]);
    }
    for (const [owner, target] of [
      ['untypedSplice', 'compileExpr'],
      ['typedSplice', 'compileTyped'],
      ['bareSplice', 'compileExpr'],
      ['parenthesizedBareSplice', 'compileExpr'],
      ['typedBareSplice', 'compileTyped'],
      ['exprWithSplice', 'compileExpr'],
      ['typedExprWithSplice', 'compileTyped'],
      ['exprWithBareSplice', 'compileExpr'],
      ['typedExprWithBareSplice', 'compileTyped'],
      ['declWithSplice', 'compileDecl'],
      ['typeWithSplice', 'compileType'],
      ['patternWithSplice', 'compilePattern'],
      ['instanceWithSplice', 'compileType'],
    ] as const) {
      expect(refs(owner).filter((ref) => ref.referenceKind === 'calls'), owner).toEqual([
        expect.objectContaining({ referenceName: target }),
      ]);
      expect(refs(owner).some((ref) => ref.referenceName === 'runtimeTarget'), owner).toBe(false);
    }
    expect(result.nodes.some((node) =>
      node.name === 'generated' || node.name === 'generatedWithSplice'
    )).toBe(false);
  });

  it('classifies no-argument effectful bindings without promoting pure applied values', () => {
    const cases = [
      ['main', 'function', 'main = do\n  tick'],
      ['scheduler', 'function', 'scheduler :: MonadIO m => m ()\nscheduler = forever tick'],
      ['readerAction', 'function', 'readerAction :: MonadReader env m => m Env\nreaderAction = ask'],
      ['primitiveAction', 'function', 'primitiveAction :: PrimMonad m => m Value\nprimitiveAction = load'],
      ['transactionAction', 'function', 'transactionAction :: RunTx m => m Value\ntransactionAction = loadTransaction'],
      ['ioAction', 'function', 'ioAction :: IO ()\nioAction = launch'],
      ['ioDo', 'function', 'ioDo :: IO ()\nioDo = do\n  launch'],
      ['stAction', 'function', 'stAction :: ST scope Value\nstAction = runStateThread'],
      ['stmAction', 'function', 'stmAction :: STM Value\nstmAction = runTransactionally'],
      ['exceptAction', 'function', 'exceptAction :: Monad m => ExceptT Failure m ()\nexceptAction = runExceptAction'],
      ['exceptIoAction', 'function', 'exceptIoAction :: ExceptT Failure IO ()\nexceptIoAction = runExceptIO'],
      ['readerTAction', 'function', 'readerTAction :: Monad m => ReaderT Env m Value\nreaderTAction = runReaderAction'],
      ['stateTAction', 'function', 'stateTAction :: Monad m => StateT State m Value\nstateTAction = runStateAction'],
      ['writerTAction', 'function', 'writerTAction :: Monad m => WriterT Log m Value\nwriterTAction = runWriterAction'],
      ['rwstAction', 'function', 'rwstAction :: Monad m => RWST Env Log State m Value\nrwstAction = runRwstAction'],
      ['getAction', 'constant', 'getAction :: Get Value\ngetAction = do\n  value <- parseValue\n  pure value'],
      ['parserAction', 'constant', 'parserAction :: Parser Value\nparserAction = do\n  value <- parseValue\n  pure value'],
      ['beamQuery', 'constant', 'beamQuery :: Beam.Q db scope Row\nbeamQuery = do\n  row <- selectRows\n  pure row'],
      ['unsignaturedBind', 'function', 'unsignaturedBind = do\n  value <- load\n  pure value'],
      ['unsignaturedSequence', 'function', 'unsignaturedSequence = do\n  prepare\n  launch'],
      ['signedActionSequence', 'constant', 'signedActionSequence :: CustomEffect\nsignedActionSequence = do\n  prepare\n  launch'],
      ['boxed', 'constant', 'boxed :: Maybe Int\nboxed = Just 1'],
      ['qValue', 'constant', 'qValue :: Q Int\nqValue = QValue'],
      ['parserValue', 'constant', 'parserValue :: Parser Value\nparserValue = parseValue'],
      ['getValue', 'constant', 'getValue :: Get Value\ngetValue = parseValue'],
      ['qualifiedParserValue', 'constant', 'qualifiedParserValue :: Domain.Parser Value\nqualifiedParserValue = Domain.parseValue'],
      ['qualifiedIoValue', 'constant', 'qualifiedIoValue :: Domain.IO ()\nqualifiedIoValue = Domain.launch'],
      ['beamValue', 'constant', 'beamValue :: Beam.Q db scope Row\nbeamValue = selectRows'],
      ['fakeTransformer', 'constant', 'fakeTransformer :: ExceptT Failure m Value\nfakeTransformer = boxedEffect'],
      ['qualifiedTransformerValue', undefined, 'qualifiedTransformerValue :: Monad m => Domain.ExceptT Failure m Value\nqualifiedTransformerValue = Domain.boxedEffect'],
      ['maybeDo', 'constant', 'maybeDo :: Maybe Int\nmaybeDo = do\n  Just 1'],
      ['maybeBoundDo', 'constant', 'maybeBoundDo :: Maybe Int\nmaybeBoundDo = do\n  value <- Just 1\n  pure value'],
      ['clientErrorStyle', 'constant', 'clientErrorStyle :: Result\nclientErrorStyle = do\n  let base = defaultResult\n  Result base'],
      ['unsignaturedPureDo', 'constant', 'unsignaturedPureDo = do\n  Just 1'],
      ['notMonadValue', 'constant', 'notMonadValue :: NotMonad a => a\nnotMonadValue = defaultNotMonad'],
      ['notMonadDo', 'constant', 'notMonadDo :: NotMonad a => a\nnotMonadDo = do\n  defaultNotMonad'],
      ['nonMonadValue', 'constant', 'nonMonadValue :: NonMonad a => a\nnonMonadValue = defaultNonMonad'],
      ['functorValue', 'constant', 'functorValue :: Functor f => f Int\nfunctorValue = pure 1'],
      ['environment', 'constant', 'environment :: MonadReader env m => env\nenvironment = defaultEnvironment'],
      ['label', 'constant', 'label :: String\nlabel = renderLabel config'],
    ] as const;
    const source = [
      '',
      'module Round2 where',
      'class NotMonad a where\n  notMarker :: a -> Bool',
      'class NonMonad a where\n  nonMarker :: a -> Bool',
      'data Parser a = ParserValue a',
      'data Get a = GetValue a',
      ...cases.map(([, , declaration]) => declaration),
      '',
    ].join('\n');
    const result = extractFromSource('Round2.hs', source);
    for (const [name, kind] of cases) {
      if (kind) {
        expect(result.nodes).toContainEqual(expect.objectContaining({ kind, name }));
      }
    }
  });

  it('defers nominal effect heads for whole-RHS aliases while preserving structural proof', () => {
    const effectAliases = [
      ['effectAlias', 'effectAlias :: IO ()\neffectAlias = runAction', 'runAction', ['haskell-effect-head:IO']],
      ['qualifiedEffect', 'qualifiedEffect :: Monad m => Bool -> ExceptT Failure m ()\nqualifiedEffect _ = Actions.runAction', 'Actions::runAction', ['haskell-effect-head:ExceptT']],
      ['canonicalQualifiedEffect', 'canonicalQualifiedEffect :: Monad m => Control.Monad.Trans.Except.ExceptT Failure m ()\ncanonicalQualifiedEffect = Actions.runAction', 'Actions::runAction', ['haskell-effect-head:Control.Monad.Trans.Except::ExceptT']],
      ['exceptIoAlias', 'exceptIoAlias :: ExceptT Failure IO ()\nexceptIoAlias = Actions.runAction', 'Actions::runAction', ['haskell-effect-head:ExceptT', 'haskell-effect-head:IO']],
      ['stAlias', 'stAlias :: ST scope ()\nstAlias = Actions.runAction', 'Actions::runAction', undefined],
      ['stmAlias', 'stmAlias :: STM ()\nstmAlias = Actions.runAction', 'Actions::runAction', undefined],
      ['transactionAlias', 'transactionAlias :: RunTx m => m ()\ntransactionAlias = Actions.runTransaction', 'Actions::runTransaction', ['haskell-effect-head:m']],
      ['qualifiedTransformer', 'qualifiedTransformer :: Monad m => Domain.ExceptT Failure m ()\nqualifiedTransformer = Actions.runAction', 'Actions::runAction', ['haskell-effect-head:Domain::ExceptT']],
    ] as const;
    const functionRefs = [
      ['parserAlias', 'parserAlias :: Parser Value\nparserAlias = Actions.parseValue'],
      ['getAlias', 'getAlias :: Get Value\ngetAlias = Actions.getValue'],
      ['qualifiedParserAlias', 'qualifiedParserAlias :: Domain.Parser Value\nqualifiedParserAlias = Actions.parseValue'],
      ['beamAlias', 'beamAlias :: Beam.Q db scope Row\nbeamAlias = Actions.selectRows'],
      ['qualifiedIoAlias', 'qualifiedIoAlias :: Domain.IO ()\nqualifiedIoAlias = Actions.runAction'],
      ['unprovenTransformer', 'unprovenTransformer :: ExceptT Failure m ()\nunprovenTransformer = Actions.runAction'],
      ['choose', 'choose :: Bool -> (Int -> Int)\nchoose _ = Actions.callback'],
      ['answer', 'answer :: Bool -> Int\nanswer _ = Actions.answer'],
      ['valueAlias', 'valueAlias :: Int\nvalueAlias = Actions.answer'],
    ] as const;
    const source = [
      '',
      'module Round2 where',
      'import qualified Actions',
      'data Parser a = ParserValue a',
      'data Get a = GetValue a',
      ...effectAliases.slice(0, 7).map(([, declaration]) => declaration),
      ...functionRefs.slice(0, 6).map(([, declaration]) => declaration),
      effectAliases[7][1],
      ...functionRefs.slice(6).map(([, declaration]) => declaration),
      '',
    ].join('\n');
    const result = extractFromSource('Round2.hs', source);

    for (const [owner, , referenceName, candidates] of effectAliases) {
      expect(refsFor(result, owner)).toContainEqual(expect.objectContaining({
        referenceKind: 'haskell_effect_alias',
        referenceName,
        ...(candidates ? { candidates: [...candidates] } : {}),
      }));
    }
    for (const [owner] of functionRefs) {
      const refs = refsFor(result, owner);
      expect(refs).toContainEqual(expect.objectContaining({ referenceKind: 'function_ref' }));
      expect(refs.some((ref) => ref.referenceKind === 'calls')).toBe(false);
    }
  });

  it('associates trailing signatures without moving the binding docstring', () => {
    const source = `
module Round2 where
-- | Runs the documented action.
trailingAction = Actions.runAction
{-# INLINE trailingAction #-}
trailingAction :: IO ()
trailingValue = Actions.answer
trailingValue :: Int
trailingFunction = id
trailingFunction :: Int -> Int
firstAction = Actions.first
secondAction = Actions.second
firstAction, secondAction :: IO ()
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'trailingAction')).toEqual(
      expect.objectContaining({
        kind: 'function',
        signature: 'trailingAction :: IO ()',
        docstring: expect.stringContaining('Runs the documented action.'),
      }),
    );
    expect(result.nodes.find((node) => node.name === 'trailingValue')).toEqual(
      expect.objectContaining({ kind: 'constant', signature: 'trailingValue :: Int' }),
    );
    expect(result.nodes.find((node) => node.name === 'trailingFunction')).toEqual(
      expect.objectContaining({ kind: 'function', signature: 'trailingFunction :: Int -> Int' }),
    );
    for (const [owner, target] of [
      ['trailingAction', 'Actions::runAction'],
      ['firstAction', 'Actions::first'],
      ['secondAction', 'Actions::second'],
    ] as const) {
      expect(refsFrom(source, owner).refs).toEqual([
        expect.objectContaining({
          referenceKind: 'haskell_effect_alias',
          referenceName: target,
          candidates: ['haskell-effect-head:IO'],
        }),
      ]);
    }
    expect(refsFrom(source, 'trailingValue').refs).toEqual([
      expect.objectContaining({
        referenceKind: 'function_ref', referenceName: 'Actions::answer',
      }),
    ]);
  });

  it('rejects locally shadowed primitive and transformer effect names', () => {
    const source = `
module Round2 where
import qualified Actions
data IO value = LocalIO value
data ST scope value = LocalST value
data STM value = LocalSTM value
shadowedIO :: IO ()
shadowedIO = Actions.runAction
shadowedST :: ST scope ()
shadowedST = Actions.runAction
shadowedSTM :: STM ()
shadowedSTM = Actions.runAction
shadowedExcept :: Monad m => ExceptT Failure m ()
shadowedExcept = Actions.runAction
data ExceptT error monad value = LocalExcept value
`;
    for (const name of ['shadowedIO', 'shadowedST', 'shadowedSTM', 'shadowedExcept']) {
      expect(refsFrom(source, name).result.nodes).toContainEqual(expect.objectContaining({
        kind: 'constant', name,
      }));
      expect(refsFrom(source, name).refs.some((ref) => ref.referenceKind === 'calls')).toBe(false);
    }
  });

  it('applies class-child export semantics to associated data families only', () => {
    const source = `
{-# LANGUAGE ExplicitNamespaces, PatternSynonyms, TypeFamilies #-}
module Round2 (C(..), pattern FamilyInt) where
class C a where
  data Family a
instance C Int where
  data Family Int = FamilyInt
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.kind === 'enum' && node.name === 'Family'))
      .toEqual(expect.objectContaining({ isExported: true }));
    expect(result.nodes.find((node) => node.kind === 'enum' && node.name === 'Family'
      && node.qualifiedName.includes('C Int')))
      .toEqual(expect.objectContaining({ isExported: false }));
    expect(result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'FamilyInt'))
      .toEqual(expect.objectContaining({ isExported: true }));
  });

  it('indexes pragma-separated signatures in linear time', () => {
    const declarations = Array.from({ length: 400 }, (_, index) => [
      `f${index} :: Int -> Int`,
      `{-# INLINE f${index} #-}`,
      `f${index} = id`,
    ].join('\n')).join('\n');
    const started = performance.now();
    const result = extractFromSource('ManySignatures.hs', `module ManySignatures where\n${declarations}\n`);
    const durationMs = performance.now() - started;
    expect(result.nodes.filter((node) => node.kind === 'function' && /^f\d+$/.test(node.name)))
      .toHaveLength(400);
    expect(durationMs).toBeLessThan(4_000);
  });

  it('extracts foreign imports and applies foreign-export signatures to their bindings', () => {
    const source = `
{-# LANGUAGE ForeignFunctionInterface #-}
module Round2 (c_sin, run, action) where
foreign import ccall unsafe "sin" c_sin :: Double -> IO Double
foreign export ccall "hs_run" run :: Int -> IO ()
run _ = pure ()
foreign export ccall "hs_action" action :: IO ()
action = target
target :: IO ()
target = pure ()
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'c_sin')).toEqual(expect.objectContaining({
      kind: 'function',
      isExported: true,
      decorators: expect.arrayContaining(['haskell-foreign-import']),
    }));
    expect(result.nodes.filter((node) => node.name === 'run')).toHaveLength(1);
    expect(result.nodes.find((node) => node.name === 'run')).toEqual(expect.objectContaining({
      kind: 'function',
      signature: 'run :: Int -> IO ()',
    }));
    expect(result.nodes.filter((node) => node.name === 'action')).toHaveLength(1);
    expect(result.nodes.find((node) => node.name === 'action')).toEqual(expect.objectContaining({
      kind: 'function',
      signature: 'action :: IO ()',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: 'run',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'haskell_effect_alias', referenceName: 'target',
    }));
  });

  it('records the explicit owner of bundled pattern-synonym exports', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 (T(P)) where
data T = MkT
pattern P = MkT
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'P')).toEqual(expect.objectContaining({
      kind: 'enum_member',
      isExported: true,
      decorators: expect.arrayContaining([
        'haskell-pattern-synonym', 'haskell-export-parent:T',
      ]),
    }));
  });

  it('records bare unqualified and qualified actions on the RHS of monadic binds', () => {
    const source = `
module Round2 where
run = do
  first <- action
  second <- Actions.next
  pure (first, second)
`;
    const { refs } = refsFrom(source, 'run');
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'action' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Actions::next' }),
    ]));
  });

  it('attaches standalone prefix and symbolic pattern-synonym signatures', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, TypeOperators #-}
module Round2 where
-- | Present documentation.
pattern Present :: a -> Maybe a
pattern Present x = Just x
pattern (:++:) :: a -> [a] -> [a]
pattern x :++: xs = x : xs
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'Present')).toEqual(expect.objectContaining({
      signature: 'pattern Present :: a -> Maybe a',
      docstring: expect.stringContaining('Present documentation'),
      startLine: 5,
    }));
    expect(result.nodes.find((node) => node.name === '(:++:)')).toEqual(expect.objectContaining({
      signature: 'pattern (:++:) :: a -> [a] -> [a]',
      startLine: 7,
    }));
  });

  it('attaches a standalone pattern-synonym signature declared after its equation', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
-- | Documentation anchored to the equation.
pattern Late value = Just value
pattern Late :: a -> Maybe a
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'Late')).toEqual(expect.objectContaining({
      signature: 'pattern Late :: a -> Maybe a',
      docstring: expect.stringContaining('Documentation anchored to the equation.'),
      startLine: 5,
      endLine: 6,
    }));
  });

  it('treats future mdo binders as recursive without changing ordinary do scope', () => {
    const source = `
{-# LANGUAGE RecursiveDo #-}
module Round2 where
f x = x
value = 0
getFunction = pure id
getValue = pure 1
recursive = mdo
  result <- f value
  f <- getFunction
  value <- getValue
  pure result
sequential = do
  result <- f value
  f <- getFunction
  pure result
recursiveBlock = do
  rec
    result <- f value
    f <- getFunction
    value <- getValue
  pure result
qualifiedRecursive = M.mdo
  result <- use result
  M.return result
`;
    const recursive = refsFrom(source, 'recursive').refs;
    expect(recursive.some((ref) => ['f', 'value'].includes(ref.referenceName))).toBe(false);
    const sequential = refsFrom(source, 'sequential').refs;
    expect(sequential).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'f' }),
      expect.objectContaining({ referenceName: 'value' }),
    ]));
    const recursiveBlock = refsFrom(source, 'recursiveBlock').refs;
    expect(recursiveBlock.some((ref) => ['f', 'value'].includes(ref.referenceName))).toBe(false);
    const qualifiedRecursive = refsFrom(source, 'qualifiedRecursive').refs;
    expect(qualifiedRecursive.some((ref) => ref.referenceName === 'result')).toBe(false);
  });

  it('links statically named actions executed by monadic and applicative sequence operators', () => {
    const source = `
module Round2 where
load = pure 1
next x = pure x
finish = pure ()
bind = load >>= next
flipped = next =<< load
sequenceBoth = load >> finish
applicativeBoth = load *> finish
applied = wrapped <*> load
mapped = next <$> load
flippedMap = load <&> next
replacedRight = load $> 1
replacedLeft = 1 <$ load
prefixApplied = (<*>) wrapped load
prefixSequence = (>>) load finish
prefixBind = (>>=) load next
prefixFlipped = (=<<) next load
qualifiedPrefix = (Custom.<*>) wrapped load
alternative = load <|> finish
reverseApply = load <**> wrapped
prefixAlternative = (<|>) load finish
prefixReverseApply = (<**>) load wrapped
parameter load finish = load >> finish
`;
    for (const [owner, names] of [
      ['bind', ['load']],
      ['flipped', ['load']],
      ['sequenceBoth', ['load', 'finish']],
      ['applicativeBoth', ['load', 'finish']],
      ['applied', ['wrapped', 'load']],
      ['mapped', ['load']],
      ['flippedMap', ['load']],
      ['replacedRight', ['load']],
      ['replacedLeft', ['load']],
      ['prefixApplied', ['wrapped', 'load']],
      ['prefixSequence', ['load', 'finish']],
      ['prefixBind', ['load']],
      ['prefixFlipped', ['load']],
      ['qualifiedPrefix', ['wrapped', 'load']],
      ['alternative', ['load', 'finish']],
      ['reverseApply', ['load', 'wrapped']],
      ['prefixAlternative', ['load', 'finish']],
      ['prefixReverseApply', ['load', 'wrapped']],
    ] as const) {
      const refs = refsFrom(source, owner).refs;
      for (const name of names) {
        expect(refs).toContainEqual(expect.objectContaining({
          referenceKind: 'calls', referenceName: name,
        }));
      }
    }
    const parameter = refsFrom(source, 'parameter').refs;
    expect(parameter.some((ref) => ['load', 'finish'].includes(ref.referenceName))).toBe(false);
  });

  it('captures every nested constructor used by bidirectional pattern synonyms', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern Nested x = Outer (Inner x)
pattern Match x <- Outer (Inner x) where
  Match x = Build (Wrap x)
`;
    const result = extractFromSource('Round2.hs', source);
    const nested = result.nodes.find((node) => node.name === 'Nested')!;
    const match = result.nodes.find((node) => node.name === 'Match')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === nested.id)
      .map((ref) => ref.referenceName)).toEqual(expect.arrayContaining(['Outer', 'Inner']));
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === match.id)
      .map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['Outer', 'Inner', 'Build', 'Wrap']));
  });

  it('attaches grouped standalone pattern-synonym signatures to every binding', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, TypeOperators #-}
module Round2 where
-- | Group docs.
pattern P, Q :: a -> Maybe a
pattern P x = Just x
pattern Q x = Just x
pattern (:++:), (:--:) :: a -> a -> (a, a)
pattern x :++: y = (x, y)
pattern x :--: y = (x, y)
`;
    const result = extractFromSource('Round2.hs', source);
    for (const name of ['P', 'Q']) {
      expect(result.nodes.find((node) => node.name === name)).toEqual(expect.objectContaining({
        signature: 'pattern P, Q :: a -> Maybe a',
        startLine: 5,
      }));
    }
    expect(result.nodes.find((node) => node.name === 'P')?.docstring).toContain('Group docs');
    for (const name of ['(:++:)', '(:--:)']) {
      expect(result.nodes.find((node) => node.name === name)?.signature)
        .toBe('pattern (:++:), (:--:) :: a -> a -> (a, a)');
    }
  });

  it('emits one semantic edge for constructor expressions', () => {
    const source = `
{-# LANGUAGE TypeOperators #-}
module Round2 where
data Zero = Zero
data Pair a b = a :*: b
a = Zero
b = Round2.Zero
c = 1 :*: 2
d = consume Nothing
e = (:*:) 1 True
mapped = map Just [1]
leftSection = (1 :*:)
rightSection = (:*: 2)
`;
    const result = extractFromSource('Round2.hs', source);
    for (const [owner, reference] of [['a', 'Zero'], ['b', 'Round2::Zero']] as const) {
      const refs = refsFrom(source, owner).refs.filter((ref) => ref.referenceName === reference);
      expect(refs).toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    }
    const infixRefs = result.unresolvedReferences.filter((ref) => {
      const owner = result.nodes.find((node) => node.id === ref.fromNodeId);
      return owner?.name === 'c' && ref.referenceName === ':*:';
    });
    expect(infixRefs).toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    expect(refsFrom(source, 'd').refs.filter((ref) => ref.referenceName === 'Nothing'))
      .toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    expect(refsFrom(source, 'e').refs.filter((ref) => ref.referenceName === 'True'))
      .toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    expect(refsFrom(source, 'mapped').refs.filter((ref) => ref.referenceName === 'Just'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    for (const owner of ['leftSection', 'rightSection']) {
      expect(refsFrom(source, owner).refs.filter((ref) => ref.referenceName === ':*:'))
        .toEqual([expect.objectContaining({ referenceKind: 'function_ref' })]);
    }
  });

  it('extracts every constructor in grouped GADT signatures', () => {
    const source = `
{-# LANGUAGE GADTs, TypeOperators #-}
module Round2 where
data U a where
  U1, U2 :: U Int
data T a where
  (:++:), (:--:) :: a -> a -> T a
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.filter((node) => node.kind === 'enum_member').map((node) => node.name))
      .toEqual(expect.arrayContaining(['U1', 'U2', '(:++:)', '(:--:)']));
  });

  it('keeps positional newtype payloads out of fields and expands grouped selectors', () => {
    const source = `
module Round2 where
newtype Wrap a = Wrap a
newtype Pair a = Pair (a, a)
data Record = Record { x, y :: Int }
newtype NewRecord = NewRecord { left, right :: Int }
`;
    const fields = extractFromSource('Round2.hs', source).nodes
      .filter((node) => node.kind === 'field').map((node) => node.name);
    expect(fields).toEqual(expect.arrayContaining(['x', 'y', 'left', 'right']));
    expect(fields).not.toEqual(expect.arrayContaining(['a']));
  });

  it('materializes record pattern-synonym selectors as module bindings', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 (pattern Present, presentValue, use) where
pattern Present { presentValue } = Just presentValue
use x = presentValue x
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'presentValue')).toEqual(expect.objectContaining({
      kind: 'field',
      qualifiedName: 'Round2::presentValue',
      isExported: true,
      decorators: expect.arrayContaining(['haskell-pattern-selector']),
    }));
  });

  it('extracts and deduplicates quantified superclass dependencies', () => {
    const source = `
{-# LANGUAGE ConstraintKinds, QuantifiedConstraints #-}
module Round2 where
class (Table t, forall f. SimpleKey' t f) => SimpleKey t where
class (forall x. A.Eq x => A.Eq (f x)) => Qualified f where
class c a => ParamSuper c a where
class (forall x. c x => d x) => QuantifiedVars c d where
class (F a ~ b) => Equality a b where
class (forall x. F x ~ G x) => QuantifiedEquality f where
`;
    const result = extractFromSource('Round2.hs', source);
    const refsFor = (owner: string) => {
      const node = result.nodes.find((candidate) => candidate.name === owner)!;
      return result.unresolvedReferences.filter((ref) => ref.fromNodeId === node.id
        && ref.referenceKind === 'extends').map((ref) => ref.referenceName);
    };
    expect(refsFor('SimpleKey')).toEqual(expect.arrayContaining(['Table', "SimpleKey'"]));
    expect(refsFor('Qualified')).toEqual(['A::Eq']);
    expect(refsFor('ParamSuper')).toEqual([]);
    expect(refsFor('QuantifiedVars')).toEqual([]);
    expect(refsFor('Equality')).toEqual([]);
    expect(refsFor('QuantifiedEquality')).toEqual([]);
  });

  it('captures infix patterns and bare constructors in ordinary expressions', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern x :++: xs = x : xs
match (x :++: xs) = NothingX
listed = [NothingX]
chosen flag = if flag then NothingX else OtherX
guarded x | x == NothingX = OtherX | otherwise = NothingX
multi x = if | x == NothingX -> OtherX
caseGuard x = case x of y | y == NothingX -> OtherX
`;
    const result = extractFromSource('Round2.hs', source);
    const refsFor = (owner: string) => {
      const node = result.nodes.find((candidate) => candidate.name === owner)!;
      return result.unresolvedReferences.filter((ref) => ref.fromNodeId === node.id)
        .map((ref) => ref.referenceName);
    };
    expect(refsFor('match')).toEqual(expect.arrayContaining([':++:', 'NothingX']));
    expect(refsFor('listed')).toContain('NothingX');
    expect(refsFor('chosen')).toEqual(expect.arrayContaining(['NothingX', 'OtherX']));
    for (const owner of ['guarded', 'multi', 'caseGuard']) {
      expect(refsFor(owner)).toEqual(expect.arrayContaining(['NothingX', 'OtherX']));
    }
  });

  it('captures each selector in OverloadedRecordDot projections', () => {
    const source = `
{-# LANGUAGE OverloadedRecordDot #-}
module Round2 where
run payload = payload.event
nested value = value.userInfo.email
selector = (.event)
nestedSelector = (.userInfo.email)
`;
    expect(refsFrom(source, 'run').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'references', referenceName: 'event',
    }));
    expect(refsFrom(source, 'nested').refs.filter((ref) => ref.referenceKind === 'references')
      .map((ref) => ref.referenceName)).toEqual(expect.arrayContaining(['userInfo', 'email']));
    expect(refsFrom(source, 'selector').refs.map((ref) => ref.referenceName)).toEqual(['event']);
    expect(refsFrom(source, 'nestedSelector').refs.map((ref) => ref.referenceName))
      .toEqual(['userInfo', 'email']);
  });

  it('captures ordinary and overloaded record-update field paths', () => {
    const source = `
{-# LANGUAGE OverloadedRecordUpdate #-}
module Round2 where
plain r = r { field = 1 }
nested r = r { user.name = "x" }
`;
    expect(refsFrom(source, 'plain').refs.map((ref) => ref.referenceName)).toContain('field');
    expect(refsFrom(source, 'nested').refs.map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['user', 'name']));
  });

  it('walks matcher and builder expressions owned by pattern synonyms', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, ViewPatterns #-}
module Round2 where
pattern P x <- (view -> Just x)
pattern Q x <- (Views.view config -> Outer (Inner x)) where
  Q x = Build (make x)
`;
    expect(refsFrom(source, 'P').refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'view' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Just' }),
    ]));
    const qRefs = refsFrom(source, 'Q').refs;
    expect(qRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Views::view' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Outer' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Inner' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Build' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'make' }),
    ]));
    expect(qRefs.some((ref) => ref.referenceName === 'x')).toBe(false);
  });

  it('preserves dots that belong to symbolic operator names', () => {
    const source = `
{-# LANGUAGE TypeOperators #-}
module Round2 where
(<.>) x y = x
(.+.) x y = y
f x y = x <.> y
g = (<.>)
h = (1 .+.)
i = (L.<.>)
`;
    expect(refsFrom(source, 'f').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'calls', referenceName: '<.>',
    }));
    expect(refsFrom(source, 'g').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: '(<.>)',
    }));
    expect(refsFrom(source, 'h').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: '.+.',
    }));
    expect(refsFrom(source, 'i').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: 'L::(<.>)',
    }));
  });

  it('materializes every variable from top-level pattern bindings', () => {
    const source = `
module Round2 where
(x, y) = pair
Just z = maybeZ
Record { field = selected } = record
[a, b] = items
clientA :: Int -> Int
clientB :: Int -> Int
(clientA, clientB) = clients
use = consume x y z selected a b
`;
    const result = extractFromSource('Round2.hs', source);
    for (const name of ['x', 'y', 'z', 'selected', 'a', 'b']) {
      expect(result.nodes).toContainEqual(expect.objectContaining({ kind: 'constant', name }));
    }
    for (const name of ['clientA', 'clientB']) {
      expect(result.nodes).toContainEqual(expect.objectContaining({
        kind: 'function', name, signature: `${name} :: Int -> Int`,
      }));
    }
    const z = result.nodes.find((node) => node.name === 'z')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: z.id, referenceKind: 'references', referenceName: 'Just',
    }));
  });

  it('keeps where-bound constants lexical under point bindings', () => {
    const source = `
module Round2 where
f = consume x where x = Zero
g = consume x where (x, y) = pair
`;
    for (const owner of ['f', 'g']) {
      expect(refsFrom(source, owner).refs.some((ref) => ref.referenceName === 'x')).toBe(false);
    }
  });
});
