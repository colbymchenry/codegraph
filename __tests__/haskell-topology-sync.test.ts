import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell topology-aware sync invalidation', () => {
  let tmpDir: string | undefined;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const createGraph = async (files: Record<string, string>) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-topology-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    graph = CodeGraph.initSync(tmpDir);
    await graph.indexAll();
    return graph;
  };

  const internals = (current: CodeGraph) => current as unknown as {
    orchestrator: {
      invalidateHaskellImportEdges(...args: unknown[]): number;
      reattachCrossFileEdges(...args: unknown[]): void;
      indexFile(filePath: string): Promise<{ nodes: unknown[] }>;
    };
    db: { getDb(): { prepare(sql: string): { run(...params: unknown[]): unknown } } };
    queries: {
      getFileByPath(filePath: string): { contentHash: string; haskellTopologyHash?: string; nodeCount: number } | null;
      getMetadata(key: string): string | null;
      setMetadata(key: string, value: string): void;
      getNamesForSegment(segment: string, limit: number): string[];
      insertNodes(...args: unknown[]): void;
      upsertFile(...args: unknown[]): unknown;
      getUnresolvedReferences(): Array<{
        referenceName: string;
        referenceKind: string;
        filePath?: string;
        candidates?: string[];
      }>;
    };
  };

  const callTarget = (current: CodeGraph) => {
    const run = current.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
    return current.getOutgoingEdges(run.id)
      .map((edge) => current.getNode(edge.target))
      .find((node) => node?.name === 'foo');
  };

  it('keeps a nullary monadic binding on the named call-flow spine', async () => {
    const current = await createGraph({
      'Main.hs': [
        'module Main where',
        'scheduler :: Monad m => m ()',
        'scheduler = executeSystemCommand pending',
        'executeSystemCommand command = updateCommandResult command',
        'updateCommandResult result = result',
        'pending = pure ()',
      ].join('\n'),
    });
    const scheduler = current.getNodesByName('scheduler')[0]!;
    expect(scheduler.kind).toBe('function');
    expect(current.getCallees(scheduler.id).map(({ node }) => node.name))
      .toContain('executeSystemCommand');

    const flow = resolveNamedSymbolFlow(
      current,
      'scheduler executeSystemCommand updateCommandResult',
    );
    expect(flow.chains[0]?.steps.map(({ node }) => node.name))
      .toEqual(['scheduler', 'executeSystemCommand', 'updateCommandResult']);
  });

  it('skips the broad replay for comment-only edits and keeps incoming edges current', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const before = privateState.queries.getFileByPath('Lib.hs')!;
    const oldTargetId = callTarget(current)!.id;
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), [
      'module Lib (foo) where',
      '-- implementation note',
      'foo x = x',
      '',
    ].join('\n'));
    await current.sync();

    const after = privateState.queries.getFileByPath('Lib.hs')!;
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.haskellTopologyHash).toBe(before.haskellTopologyHash);
    expect(broadReplays).toBe(0);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)!.id).not.toBe(oldTargetId);
    expect(callTarget(current)!.filePath).toBe('Lib.hs');
  });

  it('keeps the broad replay when an import/reexport topology changes', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const before = privateState.queries.getFileByPath('Lib.hs')!;
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    await current.sync();

    expect(privateState.queries.getFileByPath('Lib.hs')!.haskellTopologyHash)
      .not.toBe(before.haskellTopologyHash);
    expect(broadReplays).toBe(1);
    expect(callTarget(current)!.filePath).toBe('B.hs');
  });

  it('rebinds unchanged consumers when indexAll changes a re-export facade', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo value = value + 1\n',
      'B.hs': 'module B (foo) where\nfoo value = value + 2\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    expect(callTarget(current)!.filePath).toBe('A.hs');

    fs.writeFileSync(
      path.join(tmpDir!, 'Lib.hs'),
      'module Lib (foo) where\nimport B (foo)\n',
    );
    const result = await current.indexAll();

    expect(result.success).toBe(true);
    expect(callTarget(current)!.filePath).toBe('B.hs');
    expect(internals(current).queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
  });

  it('recovers an interrupted indexAll invalidation on the next indexAll', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo value = value + 1\n',
      'B.hs': 'module B (foo) where\nfoo value = value + 2\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    expect(callTarget(current)!.filePath).toBe('A.hs');

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    const originalInvalidation = privateState.orchestrator.invalidateHaskellImportEdges;
    privateState.orchestrator.invalidateHaskellImportEdges = () => {
      throw new Error('injected indexAll invalidation failure');
    };
    try {
      await expect(current.indexAll()).rejects.toThrow('injected indexAll invalidation failure');
    } finally {
      privateState.orchestrator.invalidateHaskellImportEdges = originalInvalidation;
    }

    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('1');
    expect(callTarget(current)!.filePath).toBe('A.hs');

    const recovered = await current.indexAll();
    expect(recovered.success).toBe(true);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)!.filePath).toBe('B.hs');
  });

  it('fails closed when indexFiles removes a still-declared name from a Haskell export list', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    expect(callTarget(current)?.filePath).toBe('Lib.hs');

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib () where\nfoo x = x\n');
    const result = await current.indexFiles(['Lib.hs']);

    expect(result.success).toBe(true);
    expect(current.getNodesByName('foo').some((node) => node.filePath === 'Lib.hs')).toBe(true);
    expect(callTarget(current)).toBeUndefined();
    expect(internals(current).queries.getUnresolvedReferences()).toContainEqual(
      expect.objectContaining({
        referenceName: 'foo',
        referenceKind: 'calls',
      }),
    );
  });

  it('keeps an incoming Haskell import edge when indexFiles changes only the target body', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const before = privateState.queries.getFileByPath('Lib.hs')!;
    const oldTargetId = callTarget(current)!.id;

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), [
      'module Lib (foo) where',
      '-- the exported surface is unchanged',
      'foo x = x + 1',
      '',
    ].join('\n'));
    const result = await current.indexFiles(['Lib.hs']);

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(privateState.queries.getFileByPath('Lib.hs')!.haskellTopologyHash)
      .toBe(before.haskellTopologyHash);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)?.id).not.toBe(oldTargetId);
    expect(callTarget(current)?.filePath).toBe('Lib.hs');
    expect(privateState.queries.getUnresolvedReferences()).not.toContainEqual(
      expect.objectContaining({
        referenceName: 'foo',
        referenceKind: 'calls',
      }),
    );
  });

  it('keeps the qualified DuplicateRecordFields target across a body-only indexFiles reindex', async () => {
    const current = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(field), B(field)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Origin (A(field))',
        'getA x = field x',
      ].join('\n'),
    });
    const getA = current.getNodesByName('getA')
      .find((node) => node.filePath === 'Consumer.hs')!;
    const beforeTopologyHash = internals(current).queries
      .getFileByPath('Origin.hs')!.haskellTopologyHash;
    const target = () => current.getCallees(getA.id)
      .map(({ node }) => node)
      .find((node) => node.name === 'field');
    expect(target()?.qualifiedName).toContain('::A::');

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(path.join(tmpDir!, 'Origin.hs'), [
      '{-# LANGUAGE DuplicateRecordFields #-}',
      'module Origin (A(field), B(field)) where',
      '-- implementation note; the exported record surface is unchanged',
      'data A = A { field :: Int }',
      'data B = B { field :: Int }',
    ].join('\n'));
    const result = await current.indexFiles(['Origin.hs']);

    expect(result.success).toBe(true);
    expect(internals(current).queries.getFileByPath('Origin.hs')!.haskellTopologyHash)
      .toBe(beforeTopologyHash);
    expect(target()?.qualifiedName).toContain('::A::');
    expect(target()?.qualifiedName).not.toContain('::B::');
  });

  it('invalidates unchanged consumers during a scoped reexport sync', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    expect(callTarget(current)!.filePath).toBe('A.hs');

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    await current.sync({ paths: ['Lib.hs'] });

    expect(callTarget(current)!.filePath).toBe('B.hs');
  });

  it('fails closed across a transitive reexport changed through indexFiles', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    expect(callTarget(current)!.filePath).toBe('A.hs');

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    const result = await current.indexFiles(['Lib.hs']);

    expect(result.success).toBe(true);
    expect(callTarget(current)).toBeUndefined();
    expect(internals(current).queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(internals(current).queries.getUnresolvedReferences()).toContainEqual(
      expect.objectContaining({
        filePath: 'Main.hs',
        referenceName: 'foo',
        referenceKind: 'calls',
      }),
    );

    // Direct indexing is extraction-only; the next ordinary sync consumes the
    // pending ref against the new facade topology without needing another edit.
    await current.sync();
    expect(callTarget(current)!.filePath).toBe('B.hs');
  });

  it('invalidates topology when a custom-mapped Haskell module is added', async () => {
    const current = await createGraph({
      'codegraph.json': JSON.stringify({ extensions: { '.foo': 'haskell' } }),
      'old/A.hs': 'module A (foo) where\nfoo x = x\n',
      'old/Lib.foo': 'module Lib (foo) where\nimport A (foo)\n',
      'new/B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'new/Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const customCallTarget = () => {
      const run = current.getNodesByName('run')
        .find((node) => node.filePath === 'new/Main.hs')!;
      return current.getOutgoingEdges(run.id)
        .map((edge) => current.getNode(edge.target))
        .find((node) => node?.name === 'foo');
    };
    expect(customCallTarget()!.filePath).toBe('old/A.hs');

    fs.writeFileSync(
      path.join(tmpDir!, 'new/Lib.foo'),
      'module Lib (foo) where\nimport B (foo)\n',
    );
    await current.sync({ paths: ['new/Lib.foo'] });

    expect(customCallTarget()!.filePath).toBe('new/B.hs');
  });

  it('rolls a small file replacement back if incoming-edge reattachment fails', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const beforeFile = privateState.queries.getFileByPath('Lib.hs')!;
    const beforeTarget = callTarget(current)!;
    const originalReattach = privateState.orchestrator.reattachCrossFileEdges;

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(
      path.join(tmpDir!, 'Lib.hs'),
      [
        'module Lib (foo) where',
        '-- shifts the declaration id',
        'foo x = x + 1',
        'freshRecoverySymbol x = x',
        '',
      ].join('\n'),
    );
    privateState.orchestrator.reattachCrossFileEdges = () => {
      throw new Error('injected reattach failure');
    };
    try {
      await expect(current.indexFiles(['Lib.hs'])).rejects.toThrow('injected reattach failure');
    } finally {
      privateState.orchestrator.reattachCrossFileEdges = originalReattach;
    }

    expect(privateState.queries.getFileByPath('Lib.hs')!.contentHash)
      .toBe(beforeFile.contentHash);
    expect(callTarget(current)!.id).toBe(beforeTarget.id);
    await current.sync({ paths: ['Lib.hs'] });
    expect(callTarget(current)!.filePath).toBe('Lib.hs');
    expect(callTarget(current)!.id).not.toBe(beforeTarget.id);
    expect(privateState.queries.getNamesForSegment('recovery', 20))
      .toContain('freshRecoverySymbol');
  });

  it('recovers a failed indexFiles topology invalidation without another file edit', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    expect(callTarget(current)!.filePath).toBe('A.hs');

    await loadGrammarsForLanguages(['haskell']);
    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    const originalInvalidation = privateState.orchestrator.invalidateHaskellImportEdges;
    privateState.orchestrator.invalidateHaskellImportEdges = () => {
      throw new Error('injected topology invalidation failure');
    };
    try {
      await expect(current.indexFiles(['Lib.hs']))
        .rejects.toThrow('injected topology invalidation failure');
    } finally {
      privateState.orchestrator.invalidateHaskellImportEdges = originalInvalidation;
    }

    await current.indexFiles(['Lib.hs']);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('1');
    expect(callTarget(current)!.filePath).toBe('A.hs');

    const recovered = await current.sync();
    expect(recovered.haskellImportInvalidationRecovered).toBe(true);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)!.filePath).toBe('B.hs');

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport A (foo)\n');
    const originalIndexFile = privateState.orchestrator.indexFile;
    privateState.orchestrator.indexFile = async (filePath: string) => ({
      ...await originalIndexFile.call(privateState.orchestrator, filePath),
      errors: [{ message: 'injected returned error', severity: 'error' as const }],
    });
    try {
      const failed = await current.indexFiles(['Lib.hs']);
      expect(failed.errors).toContainEqual(expect.objectContaining({
        message: 'injected returned error',
        severity: 'error',
      }));
    } finally {
      privateState.orchestrator.indexFile = originalIndexFile;
    }

    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('1');
    expect(callTarget(current)!.filePath).toBe('B.hs');
    await current.sync();
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)!.filePath).toBe('A.hs');
  });

  it('demotes a persisted effect alias when its facade stops re-exporting the canonical type', async () => {
    const current = await createGraph({
      'Actions.hs': [
        'module Actions (runAction) where',
        'runAction :: IO ()',
        'runAction = pure ()',
      ].join('\n'),
      'Fake.hs': [
        'module Fake (ExceptT) where',
        'data ExceptT error monad value = Fake value',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (module X) where',
        'import Control.Monad.Except as X (ExceptT)',
      ].join('\n'),
      'Main.hs': [
        'module Main where',
        'import Facade (ExceptT)',
        'import qualified Actions as A',
        'action :: Monad m => ExceptT Failure m ()',
        'action = A.runAction',
      ].join('\n'),
    });
    const aliasEdges = () => {
      const action = current.getNodesByName('action').find((node) => node.filePath === 'Main.hs')!;
      const runAction = current.getNodesByName('runAction')
        .find((node) => node.filePath === 'Actions.hs')!;
      return current.getOutgoingEdges(action.id).filter((edge) => edge.target === runAction.id);
    };

    expect(aliasEdges()).toContainEqual(expect.objectContaining({
      kind: 'calls',
      metadata: expect.objectContaining({
        refKind: 'haskell_effect_alias',
        refCandidates: ['haskell-effect-head:ExceptT'],
      }),
    }));

    fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
      'module Facade (module X) where',
      'import Fake as X (ExceptT)',
    ].join('\n'));
    await current.sync({ paths: ['Facade.hs'] });

    expect(aliasEdges()).toContainEqual(expect.objectContaining({
      kind: 'references',
      metadata: expect.objectContaining({
        refKind: 'haskell_effect_alias',
        refCandidates: ['haskell-effect-head:ExceptT'],
      }),
    }));
    expect(aliasEdges().some((edge) => edge.kind === 'calls')).toBe(false);
  });

  it('preserves an effect-alias proof while its target is deleted and later restored', async () => {
    const actionSource = [
      'module Actions (runAction) where',
      'runAction :: IO ()',
      'runAction = pure ()',
    ].join('\n');
    const current = await createGraph({
      'Actions.hs': actionSource,
      'Facade.hs': [
        'module Facade (module X) where',
        'import Control.Monad.Except as X (ExceptT)',
      ].join('\n'),
      'Main.hs': [
        'module Main where',
        'import Facade (ExceptT)',
        'import qualified Actions as A',
        'action :: Monad m => ExceptT Failure m ()',
        'action = A.runAction',
      ].join('\n'),
    });
    const actionNode = () => current.getNodesByName('action')
      .find((node) => node.filePath === 'Main.hs')!;
    const aliasEdges = () => current.getOutgoingEdges(actionNode().id)
      .filter((edge) => current.getNode(edge.target)?.name === 'runAction');

    expect(aliasEdges()).toContainEqual(expect.objectContaining({
      kind: 'calls',
      metadata: expect.objectContaining({
        refKind: 'haskell_effect_alias',
        refCandidates: ['haskell-effect-head:ExceptT'],
      }),
    }));

    fs.unlinkSync(path.join(tmpDir!, 'Actions.hs'));
    await current.sync({ paths: ['Actions.hs'] });

    expect(aliasEdges()).toHaveLength(0);
    expect(internals(current).queries.getUnresolvedReferences()).toContainEqual(
      expect.objectContaining({
        referenceName: 'A::runAction',
        referenceKind: 'haskell_effect_alias',
        candidates: ['haskell-effect-head:ExceptT'],
      }),
    );

    fs.writeFileSync(path.join(tmpDir!, 'Actions.hs'), actionSource);
    await current.sync({ paths: ['Actions.hs'] });

    expect(aliasEdges()).toContainEqual(expect.objectContaining({
      kind: 'calls',
      metadata: expect.objectContaining({
        refKind: 'haskell_effect_alias',
        refCandidates: ['haskell-effect-head:ExceptT'],
      }),
    }));
  });

  it('replays conservatively once for a migrated file without a fingerprint', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    privateState.db.getDb().prepare(
      'UPDATE files SET haskell_topology_hash = NULL WHERE path = ?',
    ).run('Lib.hs');
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), [
      'module Lib (foo) where',
      '-- first post-migration edit',
      'foo x = x',
      '',
    ].join('\n'));
    await current.sync();

    expect(broadReplays).toBe(1);
    expect(privateState.queries.getFileByPath('Lib.hs')!.haskellTopologyHash).toBeTruthy();
    expect(callTarget(current)!.filePath).toBe('Lib.hs');
  });
});
