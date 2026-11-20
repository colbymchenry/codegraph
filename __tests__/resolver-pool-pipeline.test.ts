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
import { POOL_START_WAIT_MS, ResolverPool } from '../src/resolution/resolver-pool';
import type { UnresolvedReference } from '../src/types';

// Any run that reaches the check engages: a test can't rely on a measured rate.
vi.mock('../src/resolution/resolver-pool', async (original) => ({
  ...await original<typeof import('../src/resolution/resolver-pool')>(),
  shouldEngageAdaptively: () => true,
}));

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
    let fannedOut = 0;
    const atPark: number[] = [];
    const atRecycle: number[] = [];
    vi.spyOn(ResolverPool, 'tryCreate').mockReturnValue({
      ready: async () => undefined,
      shareScans: () => undefined,
      destroy: async () => undefined,
      recycleWorkers: async () => { atRecycle.push(running); },
      resolveBatch: (batch: UnresolvedReference[]) => {
        fannedOut += batch.length;
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

    // The pool was up before the first batch: nothing resolves on the main thread.
    expect(fannedOut).toBe(refs.length);
    expect(most).toBe(2);
    expect(atPark.length).toBeGreaterThan(0);
    expect(atPark.filter((n) => n > 0)).toEqual([]);
    expect(atRecycle.length).toBeGreaterThan(0);
    expect(atRecycle.filter((n) => n > 0)).toEqual([]);
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  /** References no node answers to, and a pool whose start goes as `ready` says, that nothing should reach. */
  function pendingWithPool(ready: () => Promise<void>): { refs: number; destroy: ReturnType<typeof vi.fn>; resolveBatch: ReturnType<typeof vi.fn>; tryCreate: ReturnType<typeof vi.spyOn> } {
    const refs = Array.from({ length: 12 }, (_, i): UnresolvedReference => ({
      fromNodeId: 'fn:a', referenceName: `missing${i}`, referenceKind: 'calls',
      line: 1, column: i, filePath: 'a.ts', language: 'typescript',
    }));
    q.insertUnresolvedRefsBatch(refs);
    const destroy = vi.fn(async () => undefined);
    const resolveBatch = vi.fn();
    const tryCreate = vi.spyOn(ResolverPool, 'tryCreate').mockReturnValue({ ready, destroy, resolveBatch, shareScans: () => undefined } as unknown as ResolverPool);
    return { refs: refs.length, destroy, resolveBatch, tryCreate };
  }

  const resolve = (): Promise<unknown> => createResolver(dir, q).resolveAndPersistBatched(undefined, 4, undefined, { dbPath: path.join(dir, 'test.db') }, false);

  it('resolves on its own thread when the pool fails to start', async () => {
    const { destroy, resolveBatch } = pendingWithPool(async () => { throw new Error('no workers'); });
    await resolve();
    expect(resolveBatch).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  it('stops waiting for a pool that never comes up, and resolves on its own thread', async () => {
    const { refs, resolveBatch } = pendingWithPool(() => new Promise<void>(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = resolve();
      await vi.advanceTimersByTimeAsync(POOL_START_WAIT_MS - 1);
      expect(q.getUnresolvedReferencesCount()).toBe(refs);
      await vi.advanceTimersByTimeAsync(1);
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(resolveBatch).not.toHaveBeenCalled();
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  it('starts nothing up front under the bar, and never waits for a pool engaged mid-run', async () => {
    vi.unstubAllEnvs();
    expect(process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN).toBeUndefined();
    const { tryCreate, resolveBatch } = pendingWithPool(() => new Promise<void>(() => undefined));
    await resolve();
    // Once, by the adaptive check after the first batch, and that batch was not held up for it.
    expect(tryCreate).toHaveBeenCalledTimes(1);
    expect(resolveBatch).not.toHaveBeenCalled();
    expect(q.getUnresolvedReferencesCount()).toBe(0);
  });

  it('fails the start of a worker that cannot open the index, rather than leave it waiting', () => {
    const script = `
const { ResolverPool } = require(process.argv[1]);
const pool = ResolverPool.tryCreate(process.argv[2], process.argv[3]);
const stuck = setTimeout(() => { console.log('STUCK'); process.exit(0); }, 30000);
pool.ready().then(() => console.log('READY'), (err) => console.log('FAILED ' + err.message)).finally(() => {
  clearTimeout(stuck);
  pool.destroy().finally(() => process.exit(0));
});
`;
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script, path.join(repo, 'dist/resolution/resolver-pool.js'), path.join(dir, 'missing.db'), dir], {
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_RESOLVE_WORKERS: '2' },
    });
    expect(result.stdout).toMatch(/^FAILED /m);
  }, 60_000);
});
