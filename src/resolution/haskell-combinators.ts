import type { ResolutionContext } from './types';
import { haskellNameHasCanonicalOrigin, parseHaskellReferenceName } from './import-resolver';

// Only the existing extractor combinators participate. A matching member name
// in an arbitrary qualified module is not evidence of these execution semantics.
const MODULE_COMBINATORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Prelude', [
    'map', 'fmap', 'filter', 'foldr', 'foldl', 'foldr1', 'foldl1', 'concatMap',
    'any', 'all', 'mapM', 'mapM_', 'traverse', 'takeWhile', 'dropWhile', 'span',
    'break', 'zipWith', 'zipWith3', 'iterate', 'until',
    '$', '$!', '>>', '>>=', '=<<', '*>', '<*', '<*>', '<$>', '<$',
  ]],
  ['Data.List', [
    'map', 'filter', 'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1', 'concatMap',
    'find', 'any', 'all', 'mapAccumL', 'mapAccumR', 'takeWhile', 'dropWhile',
    'span', 'break', 'partition', 'groupBy', 'sortBy', 'nubBy', 'deleteBy',
    'insertBy', 'unionBy', 'intersectBy', 'zipWith', 'zipWith3', 'iterate', 'unfoldr',
  ]],
  ['Data.Foldable', [
    'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1', 'concatMap', 'find', 'any',
    'all', 'mapM_', 'traverse_',
  ]],
  ['Data.Traversable', ['mapM', 'traverse', 'mapAccumL', 'mapAccumR']],
  ['Control.Monad', [
    'mapM', 'mapM_', 'foldM', 'foldM_', 'zipWithM', 'zipWithM_',
    '>>', '>>=', '=<<', '*>', '<*', '<*>', '<$>', '<$',
  ]],
  ['Control.Applicative', ['<*>', '<**>', '<|>', '*>', '<*', '<$>', '<$']],
  ['Data.Functor', ['fmap', '<$>', '<$', '<&>', '$>']],
  ['Data.Function', ['$', '&']],
];
const MODULES_BY_NAME = new Map<string, Set<string>>();
for (const [moduleName, names] of MODULE_COMBINATORS) {
  for (const name of names) {
    const modules = MODULES_BY_NAME.get(name) ?? new Set<string>();
    modules.add(moduleName);
    MODULES_BY_NAME.set(name, modules);
  }
}
const PACKAGES = new Map(MODULE_COMBINATORS.map(([moduleName]) => [moduleName, new Set(['base'])]));

export function haskellCombinatorHasCanonicalOrigin(
  filePath: string,
  name: string,
  context: ResolutionContext,
): boolean {
  const modules = MODULES_BY_NAME.get(parseHaskellReferenceName(name).member);
  return modules !== undefined && haskellNameHasCanonicalOrigin(filePath, name, context, {
    canonicalModules: modules,
    canonicalPackages: PACKAGES,
    namespace: 'value',
    implicitPrelude: modules.has('Prelude'),
  });
}
