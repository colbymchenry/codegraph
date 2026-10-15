/**
 * Haskell extraction on real-world shapes:
 *
 * - a module's export list decides what is exported (none were flagged);
 * - a `pat <- e` statement in a `do` block is not a definition, and its calls
 *   belong to the enclosing function, as do a do-block `let` value's;
 * - a curried call `f a b` is one reference to `f`;
 * - a Haddock comment documents any declaration, not only the module's first;
 * - extracting the same file twice gives the same symbols;
 * - a class's method signatures are module-level methods;
 * - a qualified reference is written `Module::name`, its import alias expanded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Node, UnresolvedReference } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function find(nodes: Node[], kind: string, name: string): Node {
  const node = nodes.find((n) => n.kind === kind && n.name === name);
  expect(node, `${kind} ${name}`).toBeDefined();
  return node!;
}

function callsFrom(refs: UnresolvedReference[], from: Node): string[] {
  return refs.filter((r) => r.fromNodeId === from.id && r.referenceKind === 'calls').map((r) => r.referenceName);
}

describe('Haskell exports', () => {
  it('exports only what the module export list names', () => {
    const code = `module Lib (double, Shape(..)) where

data Shape = Circle Double | Square Double

double :: Int -> Int
double x = helper x
  where helper y = y * 2

internal :: Int
internal = 1
`;
    const { nodes } = extractFromSource('src/Lib.hs', code);
    expect(find(nodes, 'function', 'double').isExported).toBe(true);
    expect(find(nodes, 'function', 'internal').isExported).toBe(false);
    expect(find(nodes, 'function', 'helper').isExported).toBe(false);
    expect(find(nodes, 'struct', 'Shape').isExported).toBe(true);
    expect(find(nodes, 'enum_member', 'Circle').isExported).toBe(true);
  });

  it('exports every top-level declaration of a module without an export list', () => {
    const { nodes } = extractFromSource('src/Lib.hs', 'module Lib where\n\nf :: Int\nf = 1\n');
    expect(find(nodes, 'function', 'f').isExported).toBe(true);
  });
});

describe('Haskell do blocks and calls', () => {
  const code = `module Main where

import qualified Data.Map as M

main :: IO ()
main = do
  config <- readConfig "app.yaml"
  let port = lookupPort config
  serve (M.fromList []) port
`;

  it('keeps the calls of do-statements and do-block let values in the enclosing function', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('src/Main.hs', code);
    expect(nodes.find((n) => n.name === 'port')).toBeUndefined();
    const calls = callsFrom(refs, find(nodes, 'function', 'main'));
    expect(calls).toEqual(expect.arrayContaining(['readConfig', 'lookupPort', 'serve', 'Data.Map::fromList']));
  });

  it('records one reference per curried call, never a partial application', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('src/Main.hs', code);
    const calls = callsFrom(refs, find(nodes, 'function', 'main'));
    expect(calls.filter((c) => c === 'serve')).toHaveLength(1);
    expect(calls.some((c) => c.includes(' '))).toBe(false);
  });

  it('extracts the same symbols when the same file is extracted again', () => {
    const first = extractFromSource('src/Main.hs', code).nodes.map((n) => n.qualifiedName);
    const second = extractFromSource('src/Main.hs', code).nodes.map((n) => n.qualifiedName);
    expect(second).toEqual(first);
    expect(second).toContain('Main::main');
  });
});

describe('Haskell docs and classes', () => {
  it('documents every declaration with the Haddock comment before it', () => {
    const code = `module Lib where

import Data.List (sort)

-- | First.
first :: Int
first = 1

-- | Second,
-- over two lines.
second :: Int
second = 2
`;
    const { nodes } = extractFromSource('src/Lib.hs', code);
    expect(find(nodes, 'function', 'first').docstring).toBe('First.');
    expect(find(nodes, 'function', 'second').docstring).toBe('Second,\nover two lines.');
  });

  it('extracts class method signatures as module-level abstract methods', () => {
    const code = `module Pretty where

class Pretty a where
  pretty :: a -> String
  prettyList, prettyAll :: [a] -> String
`;
    const { nodes } = extractFromSource('src/Pretty.hs', code);
    const pretty = find(nodes, 'method', 'pretty');
    expect(pretty.qualifiedName).toBe('Pretty::pretty');
    expect(pretty.isAbstract).toBe(true);
    expect(find(nodes, 'method', 'prettyAll').qualifiedName).toBe('Pretty::prettyAll');
  });
});
