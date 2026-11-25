/**
 * On Windows, a worker thread that ends while V8's concurrent marker is
 * marking its heap can crash the whole process (0xC0000005, no error, no
 * dump) — most of all while it is still loading its modules. Owners wait for a
 * worker's first message before terminating it, and workers collect garbage
 * before exiting (worker-teardown.ts). These pin both halves, then end real
 * resolver and store workers right after starting them and record whether
 * each had started when it was terminated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import CodeGraph from '../src/index';
import { terminateOnceStarted, workerStarted } from '../src/worker-teardown';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

describe('terminating a worker once it has started', () => {
  it('waits for the first message', async () => {
    const w = new FakeWorker();
    const started = workerStarted(w as unknown as Worker);
    const ending = terminateOnceStarted(w, started);
    await sleep(30);
    expect(w.terminate).not.toHaveBeenCalled();
    w.emit('message', { type: 'ready' });
    await ending;
    expect(w.terminate).toHaveBeenCalledOnce();
  });

  it('counts an error or an exit as started', async () => {
    for (const event of ['error', 'exit'] as const) {
      const w = new FakeWorker();
      w.on('error', () => {});
      const started = workerStarted(w as unknown as Worker);
      w.emit(event, event === 'error' ? new Error('boom') : 1);
      await terminateOnceStarted(w, started);
      expect(w.terminate).toHaveBeenCalledOnce();
    }
  });

  it('stops waiting after the cap, and never rejects', async () => {
    const w = new FakeWorker();
    w.terminate.mockRejectedValue(new Error('already gone'));
    const t0 = Date.now();
    await terminateOnceStarted(w, new Promise<void>(() => {}), 60);
    expect(w.terminate).toHaveBeenCalledOnce();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe('collecting garbage before a worker exits', () => {
  it('runs a full collection in a real worker, and leaves no global gc behind', async () => {
    const teardown = path.resolve(__dirname, '../dist/worker-teardown.js');
    const run = (code: string) => new Promise<unknown>((resolve, reject) => {
      const w = new Worker(code, { eval: true });
      w.once('message', resolve);
      w.once('error', reject);
    });
    const ran = await run(`
      const { collectBeforeExit } = require(${JSON.stringify(teardown)});
      let junk = Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x'.repeat(32) }));
      junk = null;
      const before = process.memoryUsage().heapUsed;
      const collected = collectBeforeExit();
      const after = process.memoryUsage().heapUsed;
      require('worker_threads').parentPort.postMessage({ collected, freed: before - after, gc: typeof globalThis.gc });
    `) as { collected: boolean; freed: number; gc: string };
    expect(ran.collected).toBe(true);
    expect(ran.freed).toBeGreaterThan(0);
    expect(ran.gc).toBe('undefined');
    // A worker created afterwards doesn't get a global gc either.
    expect(await run(`require('worker_threads').parentPort.postMessage(typeof globalThis.gc)`)).toBe('undefined');
  }, 30_000);
});

describe('real workers are never terminated before they have started', () => {
  let root: string;
  let dbPath: string;
  const seen = new WeakSet<object>();
  const startedWhenEnded: boolean[] = [];

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-worker-start-')));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    dbPath = path.join(root, '.codegraph', 'codegraph.db');
    startedWhenEnded.length = 0;
    // A worker re-emits each message it posts; note which have, and what each
    // had done by the time it was terminated.
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === 'message') seen.add(this);
      return emit.call(this, event, ...args);
    });
    const terminate = Worker.prototype.terminate;
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      startedWhenEnded.push(seen.has(this));
      return terminate.call(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('the resolver pool, torn down while its workers boot', async () => {
    vi.stubEnv('CODEGRAPH_RESOLVE_WORKERS', '2');
    const { ResolverPool } = require('../dist/resolution/resolver-pool') as typeof import('../src/resolution/resolver-pool');
    const pool = ResolverPool.tryCreate(dbPath, root);
    expect(pool).not.toBeNull();
    await pool!.destroy(0); // the close fallback fires at once, mid-boot
    expect(startedWhenEnded).toEqual([true, true]);
  }, 30_000);

  it('the store writer, closed while its worker boots', async () => {
    const { StoreWriter } = require('../dist/extraction/store-writer') as typeof import('../src/extraction/store-writer');
    const writer = new StoreWriter(path.resolve(__dirname, '../dist/extraction/store-worker.js'), dbPath, false);
    await writer.close(0);
    expect(startedWhenEnded.every(Boolean)).toBe(true);
  }, 30_000);
});
