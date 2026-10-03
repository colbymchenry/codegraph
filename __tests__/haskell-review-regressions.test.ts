import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell review regressions', () => {
  const projects: Array<{ graph: CodeGraph; dir: string }> = [];
  afterEach(() => {
    for (const { graph, dir } of projects) {
      graph.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function index(files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-review-'));
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
    const graph = CodeGraph.initSync(dir);
    projects.push({ graph, dir });
    await graph.indexAll();
    return { graph, dir };
  }

  function targets(graph: CodeGraph, owner: string, file = 'Main.hs') {
    const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === file)!;
    return graph.getOutgoingEdges(node.id).map((edge) => ({
      kind: edge.kind,
      target: graph.getNode(edge.target)!.name,
    }));
  }

  it('lets the nearest named function shadow an outer parameter or value', async () => {
    const { graph } = await index({ 'Main.hs': [
      'module Main where',
      'helper x = x',
      'outer f = let f x = helper x in f 1',
      'nested = let f = 1 in let f x = helper x in f 1',
      'whereOuter f = f 1 where f x = helper x',
    ].join('\n') });
    for (const owner of ['outer', 'nested', 'whereOuter']) {
      expect(targets(graph, owner)).toContainEqual({ kind: 'calls', target: 'f' });
    }
  });

  it.each([
    ['module declaration', 'import Prelude hiding (map)\nmap _ xs = xs\nouter xs = map target xs'],
    ['parameter', 'outer map xs = map target xs'],
    ['local declaration', 'outer xs = let map _ values = values in map target xs'],
    ['import', 'import Prelude hiding (map)\nimport Custom (map)\nouter xs = map target xs'],
    ['qualified import', 'import qualified Custom as C\nouter xs = C.map target xs'],
    ['NoImplicitPrelude', '{-# LANGUAGE NoImplicitPrelude #-}\nimport Custom (map)\nouter xs = map target xs'],
  ])('keeps callback values without executing a custom map from a %s', async (_label, body) => {
    const { graph } = await index({
      'Main.hs': `${body.includes('NoImplicitPrelude') ? '{-# LANGUAGE NoImplicitPrelude #-}\n' : ''}module Main where\n${body.replace('{-# LANGUAGE NoImplicitPrelude #-}\n', '')}\ntarget x = x\n`,
      'Custom.hs': 'module Custom (map) where\nmap _ xs = xs\n',
    });
    expect(targets(graph, 'outer')).not.toContainEqual({ kind: 'calls', target: 'target' });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'references', target: 'target' });
  });

  it('preserves standard combinators through explicit imports, aliases and a facade', async () => {
    const { graph } = await index({
      'Main.hs': [
        'module Main where',
        'import qualified Prelude as P',
        'import qualified Data.List as L',
        'import qualified Control.Monad as M',
        'import qualified Data.Foldable as F',
        'import qualified Facade as X',
        'target x = x',
        'prelude xs = P.map target xs',
        'list xs = L.map target xs',
        'monadic xs = M.mapM target xs',
        'foldable xs = F.traverse_ target xs',
        'facade xs = X.map target xs',
      ].join('\n'),
      'Facade.hs': 'module Facade (map) where\nimport Prelude (map)\n',
      'Implicit.hs': 'module Implicit where\ntarget x = x\nouter xs = map target xs\n',
      'Explicit.hs': '{-# LANGUAGE NoImplicitPrelude #-}\nmodule Explicit where\nimport Prelude (map)\ntarget x = x\nouter xs = map target xs\n',
    });
    for (const owner of ['prelude', 'list', 'monadic', 'foldable', 'facade']) {
      expect(targets(graph, owner)).toContainEqual({ kind: 'calls', target: 'target' });
    }
    for (const file of ['Implicit.hs', 'Explicit.hs']) {
      expect(targets(graph, 'outer', file)).toContainEqual({ kind: 'calls', target: 'target' });
    }
  });

  it('does not assume a project-local standard-library module is canonical', async () => {
    const { graph } = await index({
      'Main.hs': 'module Main where\nimport qualified Data.List as L\ntarget x = x\nouter xs = L.map target xs\n',
      'Data/List.hs': 'module Data.List (map) where\nmap _ xs = xs\n',
    });
    expect(targets(graph, 'outer')).not.toContainEqual({ kind: 'calls', target: 'target' });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'references', target: 'target' });
  });

  it('retains constructor dependencies passed to a shadowed combinator', async () => {
    const { graph } = await index({ 'Main.hs': [
      'module Main where',
      'data Item = Item Int',
      'outer map xs = map Item xs',
    ].join('\n') });
    expect(targets(graph, 'outer')).not.toContainEqual({ kind: 'calls', target: 'Item' });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'references', target: 'Item' });
  });

  it('resolves custom application operators without executing their function argument', async () => {
    const { graph } = await index({ 'Main.hs': [
      'module Main where',
      'import Prelude hiding (($))',
      'f $ x = x',
      'target x = x',
      'outer x = target $ x',
    ].join('\n') });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'calls', target: '($)' });
    expect(targets(graph, 'outer')).not.toContainEqual({ kind: 'calls', target: 'target' });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'references', target: 'target' });
  });

  it('rechecks combinator origin when an unchanged consumer facade changes', async () => {
    const { graph, dir } = await index({
      'Main.hs': 'module Main where\nimport qualified Facade as F\ntarget x = x\nouter xs = F.map target xs\n',
      'Facade.hs': 'module Facade (map) where\nimport Prelude (map)\n',
    });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'calls', target: 'target' });
    fs.writeFileSync(path.join(dir, 'Facade.hs'), 'module Facade (map) where\nimport Prelude hiding (map)\nmap _ xs = xs\n');
    await graph.sync();
    expect(targets(graph, 'outer')).not.toContainEqual({ kind: 'calls', target: 'target' });
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'references', target: 'target' });
    fs.writeFileSync(path.join(dir, 'Facade.hs'), 'module Facade (map) where\nimport Prelude (map)\n');
    await graph.sync();
    expect(targets(graph, 'outer')).toContainEqual({ kind: 'calls', target: 'target' });
  });
});
