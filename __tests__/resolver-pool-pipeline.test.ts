/**
 * The resolver pool fans batches out ahead of the ones still running, and keeps
 * a file's chunks on one worker. Neither may change what the graph holds: the
 * edges of a project resolved on the pool are the edges of the same project
 * resolved on one thread, inherited methods included, which read the `extends`
 * edges of an earlier batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createResolver } from '../src/resolution';
import { ResolverPool } from '../src/resolution/resolver-pool';
import type { UnresolvedReference } from '../src/types';

const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'dist/bin/codegraph.js');
const dump = path.join(repo, 'scripts/dump-graph.mjs');

/** Enough calls for several batches of the pool's size, each file calling into its neighbours and its base class. */
function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'));
  const files = 12;
  const methods = 60;
  for (let f = 0; f < files; f++) {
    const base = f === 0 ? '' : ` extends Service${f - 1}`;
    const body: string[] = [];
    for (let m = 0; m < methods; m++) {
      const calls = Array.from({ length: 12 }, (_, c) => `    this.method${f}_${(m + c) % methods}();\n    this.inherited${Math.max(0, f - 1)}();\n    helper${(f + c) % files}();`);
      body.push(`  method${f}_${m}(): void {\n${calls.join('\n')}\n  }`);
    }
    fs.writeFileSync(path.join(root, 'src', `service${f}.ts`), [
      ...(f === 0 ? [] : [`import { Service${f - 1} } from './service${f - 1}';`]),
      ...Array.from({ length: files }, (_, i) => i).filter((i) => i !== f).map((i) => `import { helper${i} } from './service${i}';`),
      `export function helper${f}(): void {}`,
      `export class Service${f}${base} {`,
      `  inherited${f}(): void {}`,
      ...body,
      '}',
      '',
    ].join('\n'));
  }
}

function indexedGraph(root: string, env: NodeJS.ProcessEnv): { graph: string; log: string } {
  const result = spawnSync(process.execPath, [cli, 'init', '-y', root], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  const graph = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', dump, root], { encoding: 'utf8', maxBuffer: 1 << 28 });
  fs.rmSync(path.join(root, '.codegraph'), { recursive: true, force: true });
  return { graph, log: result.stderr };
}

describe('the resolver pool', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pool-pipeline-'));
    writeProject(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('makes the graph one thread makes', () => {
    const alone = indexedGraph(root, { CODEGRAPH_NO_PARALLEL_RESOLVE: '1' });
    const pooled = indexedGraph(root, { CODEGRAPH_PARALLEL_RESOLVE_MIN: '0', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_SYNTH_TIMINGS: '1' });
    expect(pooled.log).toMatch(/batch pool: \d+ refs/);
    expect(alone.graph.length).toBeGreaterThan(1000);
    expect(pooled.graph === alone.graph).toBe(true);
  }, 120_000);
});

describe('the batch loop over a pool', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pool-batches-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    fs.writeFileSync(path.join(dir, 'a.ts'), 'callee();\n');
    q.insertNode({
      id: 'fn:a', kind: 'function', name: 'a', qualifiedName: 'a', filePath: 'a.ts', language: 'typescript',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });
    vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '0');
    vi.spyOn(ResolverPool, 'worthParallel').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('queues a batch ahead, and leaves the pool idle for the WAL valve and the recycle', async () => {
    const refs: UnresolvedReference[] = Array.from({ length: 80 }, (_, i) => ({
      fromNodeId: 'fn:a', referenceName: `missing${i}`, referenceKind: 'calls',
      line: 1, column: i, filePath: 'a.ts', language: 'typescript',
    }));
    q.insertUnresolvedRefsBatch(refs);

    let running = 0;
    let most = 0;
    const atPark: number[] = [];
    const atRecycle: number[] = [];
    vi.spyOn(ResolverPool, 'tryCreate').mockReturnValue({
      ready: async () => undefined,
      shareScans: () => undefined,
      destroy: async () => undefined,
      recycleWorkers: async () => { atRecycle.push(running); },
      resolveBatch: (batch: UnresolvedReference[]) => {
        running++;
        most = Math.max(most, running);
        return new Promise((resolve) => setTimeout(() => {
          running--;
          resolve({ resolved: [], unresolved: batch, deferredChain: [], deferredThisMember: [], byMethod: {} });
        }, 2));
      },
    } as unknown as ResolverPool);

    await createResolver(dir, q).resolveAndPersistBatched(undefined, 4, undefined, {
      dbPath: path.join(dir, 'test.db'),
      backpressure: () => {
        atPark.push(running);
        return null;
      },
    }, false);

    expect(most).toBe(2);
    expect(atPark.length).toBeGreaterThan(0);
    expect(atPark.filter((n) => n > 0)).toEqual([]);
    expect(atRecycle.length).toBeGreaterThan(0);
    expect(atRecycle.filter((n) => n > 0)).toEqual([]);
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });
});
