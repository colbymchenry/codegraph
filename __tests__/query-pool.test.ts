/**
 * QueryPool — the off-loop worker pool that keeps the MCP server's main
 * event loop free for the MCP transport under concurrent read load (the
 * "10 subagents time out" report). Unit tests drive the pool's queue / growth /
 * crash-recovery / backstop logic with INJECTED fake workers, so they exercise
 * the real scheduling code without spawning threads or needing a built dist.
 *
 * Integration tests below use the built engine and real worker threads against
 * real indexes to cover direct-mode routing, session accounting, and teardown.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CodeGraph } from '../src';
import { ExploreSessionState, EXPLORE_EMISSION_KEY } from '../src/mcp/explore-session-state';
import type { MCPEngine } from '../src/mcp/engine';
import { QueryPool, resolvePoolSize, type PoolWorker } from '../src/mcp/query-pool';
import type { ToolResult } from '../src/mcp/tools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallMsg { type: 'call'; id: number; toolName: string; args: Record<string, unknown> }
type Action = { result: ToolResult } | { crash: true } | { hang: true } | { wait: Promise<ToolResult> };

/**
 * Fake worker speaking the same {type:'ready'|'result'} protocol as the real
 * one. `behavior` decides per call whether to return a result, crash (exit≠0),
 * hang (never reply — exercises the backstop), or wait on a promise (lets a test
 * hold a call in-flight to observe concurrency). Emits 'ready' on a macrotask so
 * the pool has wired its listeners first.
 */
class FakeWorker implements PoolWorker {
  private msgCb?: (m: unknown) => void;
  private errorCb?: (e: Error) => void;
  private exitCb?: (code: number) => void;
  alive = true;
  constructor(private behavior: (m: CallMsg) => Action, readyOk: boolean | null = true) {
    setTimeout(() => { if (this.alive && readyOk !== null) this.emitMessage({ type: 'ready', ok: readyOk }); }, 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
    else if (event === 'error') this.errorCb = cb;
  }
  emitMessage(m: unknown): void { this.msgCb?.(m); }
  emitError(): void { this.errorCb?.(new Error('worker failed')); }
  emitExit(): void { this.exitCb?.(13); }
  private reply(id: number, result: ToolResult): void {
    if (this.alive) this.msgCb?.({ type: 'result', id, result });
  }
  postMessage(msg: unknown): void {
    const m = msg as CallMsg;
    if (!m || m.type !== 'call') return;
    const action = this.behavior(m);
    if ('crash' in action) {
      this.alive = false;
      setTimeout(() => this.exitCb?.(13), 0); // simulate a crash exit
      return;
    }
    if ('hang' in action) return; // never reply
    if ('wait' in action) { void action.wait.then((r) => this.reply(m.id, r)); return; }
    setTimeout(() => this.reply(m.id, action.result), 0);
  }
  terminate(): Promise<number> { this.alive = false; return Promise.resolve(0); }
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

describe('resolvePoolSize', () => {
  it('honors a numeric override and disables on 0', () => {
    expect(resolvePoolSize('0', 8)).toBe(0);
    expect(resolvePoolSize('3', 8)).toBe(3);
  });
  it('caps the override at the hard ceiling', () => {
    expect(resolvePoolSize('999', 8)).toBe(16);
  });
  it('defaults to clamp(cores-1, 1, 16) when unset/blank/non-numeric', () => {
    expect(resolvePoolSize(undefined, 8)).toBe(7);
    expect(resolvePoolSize('', 8)).toBe(7);
    expect(resolvePoolSize('abc', 8)).toBe(7);
    expect(resolvePoolSize(undefined, 1)).toBe(1);   // never zero
    expect(resolvePoolSize(undefined, 64)).toBe(16); // never above the ceiling
  });
});

describe('QueryPool', () => {
  it('dispatches a call and returns the worker result', async () => {
    const pool = new QueryPool({ root: '/x', size: 1, createWorker: () => new FakeWorker((m) => ({ result: ok(`r:${m.toolName}`) })) });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.content[0].text).toBe('r:codegraph_explore');
    await pool.destroy();
  });

  it('runs N concurrent calls in parallel (not serialized)', async () => {
    let active = 0, maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Each call holds in-flight until the gate opens, so max concurrency across
    // the pool is observable: with size=5 and 5 calls, all 5 should run at once.
    const behavior = (m: CallMsg): Action => ({
      wait: (async () => {
        active++; maxActive = Math.max(maxActive, active);
        await gate;
        active--;
        return ok(`r${m.id}`);
      })(),
    });
    const pool = new QueryPool({ root: '/x', size: 5, createWorker: () => new FakeWorker(behavior) });
    const calls = Promise.all(Array.from({ length: 5 }, (_, i) => pool.run('codegraph_search', { i })));
    await sleep(40); // let all workers spawn (cold-start cap → a few generations) + dispatch
    expect(maxActive).toBe(5);
    release();
    const results = await calls;
    expect(results.every((r) => /^r\d+$/.test(r.content[0].text))).toBe(true);
    await pool.destroy();
  });

  it('does not spawn the whole pool for a single call (pending-aware growth)', async () => {
    let created = 0;
    const pool = new QueryPool({ root: '/x', size: 8, createWorker: () => { created++; return new FakeWorker((m) => ({ result: ok(`r${m.id}`) })); } });
    await pool.run('codegraph_node', { symbol: 's' });
    // One eager worker + at most the cold-start cap — never all 8.
    expect(created).toBeLessThanOrEqual(2);
    await pool.destroy();
  });

  it('recycles an idle burst back to one fresh worker', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const workers: FakeWorker[] = [];
    const pool = new QueryPool({
      root: '/x', size: 4, idleShrinkMs: 20,
      createWorker: () => {
        const worker = new FakeWorker((m) => ({
          wait: gate.then(() => ok(`r${m.id}`)),
        }));
        workers.push(worker);
        return worker;
      },
    });

    const calls = Promise.all(Array.from({ length: 4 }, (_, i) => pool.run('codegraph_search', { i })));
    await sleep(40);
    expect(pool.liveWorkers).toBe(4);
    release();
    await calls;
    await sleep(40);

    expect(pool.liveWorkers).toBe(1);
    expect(workers).toHaveLength(5); // four used isolates replaced by one clean isolate
    expect(workers.slice(0, 4).every((w) => !w.alive)).toBe(true);
    expect(pool.ready).toBe(true);
    const again = await pool.run('codegraph_node', { symbol: 's' });
    expect(again.isError).toBeFalsy();
    await pool.destroy();
  });

  it('recovers from a worker crash: retries the in-flight call and respawns', async () => {
    let calls = 0;
    const pool = new QueryPool({
      root: '/x', size: 2, maxRetries: 1,
      // First dispatch crashes its worker; the retry (on a respawn/other worker) succeeds.
      createWorker: () => new FakeWorker((m) => (++calls === 1 ? { crash: true } : { result: ok(`recovered:${m.id}`) })),
    });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('recovered:1');
    await sleep(10);
    // The pool grows lazily, so one call keeps one worker — but the crash must
    // have been replaced (not dropped to zero) and the pool stays healthy and
    // keeps serving.
    expect(pool.liveWorkers).toBeGreaterThanOrEqual(1);
    expect(pool.healthy).toBe(true);
    const again = await pool.run('codegraph_node', { symbol: 's' });
    expect(again.isError).toBeFalsy();
    await pool.destroy();
  });

  it('fails a poison call gracefully without wedging the pool', async () => {
    // This specific call always crashes its worker; a normal call still works.
    const poison = (m: CallMsg) => m.toolName === 'codegraph_explore';
    const pool = new QueryPool({
      root: '/x', size: 3, maxRetries: 1,
      createWorker: () => new FakeWorker((m) => (poison(m) ? { crash: true } : { result: ok(`ok:${m.id}`) })),
    });
    const bad = await pool.run('codegraph_explore', { query: 'boom' });
    expect(bad.isError).toBe(true); // graceful, after retries
    const good = await pool.run('codegraph_search', { query: 'fine' });
    expect(good.isError).toBeFalsy();
    expect(good.content[0].text).toMatch(/^ok:/);
    await pool.destroy();
  });

  it('graceful backstop: a call that can\'t be served in time gets success-shaped busy guidance', async () => {
    // 1 worker, every call hangs; soft-timeout small → the caller gets guidance,
    // never a hard error, never a hang.
    const pool = new QueryPool({ root: '/x', size: 1, softTimeoutMs: 60, createWorker: () => new FakeWorker(() => ({ hang: true })) });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.isError).toBeFalsy();            // NOT an error (abandonment rule)
    expect(res.content[0].text).toMatch(/busy|retry/i);
    await pool.destroy();
  });

  it('destroy settles outstanding calls instead of hanging', async () => {
    const pool = new QueryPool({ root: '/x', size: 1, softTimeoutMs: 10_000, createWorker: () => new FakeWorker(() => ({ hang: true })) });
    const pending = pool.run('codegraph_explore', { query: 'q' });
    await sleep(5);
    await pool.destroy();
    const res = await pending; // must resolve, not hang
    expect(res.isError).toBe(true);
    expect(pool.healthy).toBe(false);
  });

  describe('destroy never terminates a worker still starting up', () => {
    // Terminating a worker while it is still loading its modules can crash the
    // whole process on Windows (0xC0000005), and the daemon destroys its pool
    // whenever it stops. FakeWorker(…, null) never posts 'ready' by itself.
    it('answers callers at once, then waits for the worker to start', async () => {
      let worker!: FakeWorker;
      const pool = new QueryPool({
        root: '/x', size: 1, softTimeoutMs: 10_000,
        createWorker: () => (worker = new FakeWorker(() => ({ hang: true }), null)),
      });
      const pending = pool.run('codegraph_explore', { query: 'q' });
      let destroyed = false;
      const down = pool.destroy().then(() => { destroyed = true; });
      expect((await pending).isError).toBe(true); // not held behind the start
      await sleep(50);
      expect(destroyed).toBe(false);
      expect(worker.alive).toBe(true);
      worker.emitMessage({ type: 'ready', ok: true });
      await down;
      expect(worker.alive).toBe(false);
    });

    it('terminates a started worker at once', async () => {
      let worker!: FakeWorker;
      const pool = new QueryPool({ root: '/x', size: 1, startSettleMs: 10_000, createWorker: () => (worker = new FakeWorker(() => ({ result: ok('r') }))) });
      await sleep(5);
      const started = Date.now();
      await pool.destroy();
      expect(worker.alive).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('gives up waiting on a start that never finishes', async () => {
      let worker!: FakeWorker;
      const pool = new QueryPool({ root: '/x', size: 1, startSettleMs: 60, createWorker: () => (worker = new FakeWorker(() => ({ hang: true }), null)) });
      const started = Date.now();
      await pool.destroy();
      expect(worker.alive).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    });

    it('does not wait on a worker that died while starting', async () => {
      const workers: FakeWorker[] = [];
      const pool = new QueryPool({
        root: '/x', size: 1, startSettleMs: 10_000,
        // The first never starts; its replacement does.
        createWorker: () => { const w = new FakeWorker(() => ({ result: ok('r') }), workers.length ? true : null); workers.push(w); return w; },
      });
      workers[0].emitExit();
      await sleep(5);
      const started = Date.now();
      await pool.destroy();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(workers.every((w) => !w.alive)).toBe(true);
    });
  });

  it('is not `ready` until a worker completes its cold start (#662 first-call stall)', async () => {
    // A worker cold start is seconds (tens under load); a call queued behind it
    // waits for the 45s busy backstop with nothing served. The ToolHandler must
    // be able to see "no warm worker yet" and dispatch in-process instead — so
    // `ready` is false before the first 'ready' handshake and true after.
    // (FakeWorker posts 'ready' on a macrotask — the synchronous check below
    // observes the cold-start window.)
    const pool = new QueryPool({ root: '/x', size: 1, createWorker: () => new FakeWorker((m) => ({ result: ok(`r:${m.toolName}`) })) });
    expect(pool.ready).toBe(false); // eager worker spawned but not yet warm
    await sleep(5);                 // let the ready handshake land
    expect(pool.ready).toBe(true);
    const res = await pool.run('codegraph_status', {});
    expect(res.content[0].text).toBe('r:codegraph_status');
    await pool.destroy();
    expect(pool.ready).toBe(false); // destroyed pool must not be selected
  });

  it('retires a failed cold start and serves queued work on its replacement', async () => {
    const workers: FakeWorker[] = [];
    const pool = new QueryPool({
      root: '/x', size: 1,
      createWorker: () => {
        const worker = new FakeWorker(() => ({ result: ok('recovered') }), null);
        workers.push(worker);
        return worker;
      },
    });
    try {
      const call = pool.run('codegraph_search', {});
      workers[0].emitMessage({ type: 'ready', ok: false });
      expect(workers[0].alive).toBe(false);
      expect(pool.ready).toBe(false);
      expect(workers).toHaveLength(2);
      workers[1].emitMessage({ type: 'ready', ok: true });
      expect(await call).toEqual(ok('recovered'));
      expect(pool.ready).toBe(true);
      expect(pool.healthy).toBe(true);
    } finally { await pool.destroy(); }
  });

  it('never routes mixed-pool calls to failed workers, including after late lifecycle messages', async () => {
    const workers: FakeWorker[] = [];
    const dispatched: number[] = [];
    const pool = new QueryPool({
      root: '/x', size: 2,
      createWorker: () => {
        const index = workers.length;
        const worker = new FakeWorker(() => { dispatched.push(index); return { result: ok('served') }; }, null);
        workers.push(worker);
        return worker;
      },
    });
    try {
      workers[0].emitMessage({ type: 'ready', ok: true });
      const calls = Array.from({ length: 20 }, () => pool.run('codegraph_search', {}));
      const failed = workers[1];
      failed.emitMessage({ type: 'ready', ok: false });
      expect(failed.alive).toBe(false);
      for (let i = 0; i < 20; i++) {
        failed.emitMessage({ type: 'ready', ok: false });
        failed.emitMessage({ type: 'ready', ok: true });
        failed.emitMessage({ type: 'result', id: 1, result: ok('late') });
        failed.emitError();
        failed.emitExit();
      }
      expect(workers).toHaveLength(3);
      expect(pool.liveWorkers).toBe(2);
      expect(pool.healthy).toBe(true);
      workers[2].emitMessage({ type: 'ready', ok: true });
      expect(await Promise.all(calls)).toEqual(Array.from({ length: 20 }, () => ok('served')));
      expect(dispatched).not.toContain(1);
    } finally { await pool.destroy(); }
    workers[2].emitMessage({ type: 'ready', ok: true });
    expect(pool.liveWorkers).toBe(0);
    expect(pool.ready).toBe(false);
  });

  it('counts each failed startup once and stops replacing at the crash budget', async () => {
    const workers: FakeWorker[] = [];
    const pool = new QueryPool({
      root: '/x', size: 8, softTimeoutMs: 30,
      createWorker: () => {
        const worker = new FakeWorker(() => ({ result: ok('must not dispatch') }), null);
        workers.push(worker);
        return worker;
      },
    });
    try {
      const calls = Array.from({ length: 20 }, () => pool.run('codegraph_search', {}));
      expect(workers).toHaveLength(2); // bounded concurrent cold starts
      for (let i = 0; i < workers.length; i++) {
        expect(i).toBeLessThan(13);
        workers[i].emitMessage({ type: 'ready', ok: false });
        workers[i].emitError();
        workers[i].emitExit();
        expect(workers.filter((w) => w.alive).length).toBeLessThanOrEqual(2);
      }
      // One other pending worker can fail after the twelfth failure trips the breaker.
      expect(workers).toHaveLength(13);
      expect(pool.healthy).toBe(false);
      expect(pool.ready).toBe(false);
      expect(pool.liveWorkers).toBe(0);
      for (const result of await Promise.all(calls)) {
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toMatch(/busy/i);
      }
    } finally { await pool.destroy(); }
  });

});

// Use the built engine so its pool loads the real compiled worker sibling.
const BuiltEngine: typeof MCPEngine = require('../dist/mcp/engine').MCPEngine;

describe('MCP query pool with real projects (#1465)', () => {
  let tempDir: string;
  let engine: MCPEngine | undefined;
  let pool: QueryPool | null;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-query-pool-')));
    pool = null;
    vi.stubEnv('CODEGRAPH_QUERY_POOL_SIZE', '2');
  });

  afterEach(async () => {
    await pool?.destroy();
    await engine?.stop();
    engine = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function indexProject(name: string, symbol: string): Promise<string> {
    const root = path.join(tempDir, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'app.ts'), `export function ${symbol}() { return 42; }\n`);
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    return root;
  }

  async function start(root: string): Promise<MCPEngine> {
    engine = new BuiltEngine({ watch: false, queryPool: true });
    await engine.ensureInitialized(root);
    pool = (engine as unknown as { queryPool: QueryPool | null }).queryPool;
    return engine;
  }

  it.each([true, false])('routes concurrent reads across projects with default=%s, preserving output and session state', async (hasDefault) => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const beta = await indexProject('beta', 'betaSymbol');
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace);
    const activeEngine = await start(hasDefault ? alpha : workspace);
    expect(pool).not.toBeNull();
    await vi.waitFor(() => expect(pool!.ready).toBe(true), { timeout: 15000 });
    const handler = activeEngine.getToolHandler();
    // Drain catch-up before comparing the worker and in-process paths.
    await handler.execute('codegraph_status', { projectPath: alpha });
    const session = new ExploreSessionState();
    const calls = Array.from({ length: 6 }, (_, i) => {
      const projectPath = i % 2 ? beta : alpha;
      const query = i % 2 ? 'betaSymbol' : 'alphaSymbol';
      return handler.execute('codegraph_explore', { projectPath, query }, session);
    });
    const results = await Promise.all(calls);
    // Explicit projects pass an asynchronous catch-up gate before dispatch.
    // Check pool growth once the calls have actually reached the workers.
    expect(pool!.liveWorkers).toBe(2);
    for (const [i, result] of results.entries()) {
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(i % 2 ? 'betaSymbol' : 'alphaSymbol');
      expect(result.content[0].text).not.toContain(i % 2 ? 'alphaSymbol' : 'betaSymbol');
      expect(result).not.toHaveProperty(EXPLORE_EMISSION_KEY);
    }
    expect(session.callCount(alpha)).toBe(3);
    expect(session.callCount(beta)).toBe(3);
    const args = { projectPath: beta, query: 'betaSymbol' };
    const pooled = await handler.execute('codegraph_explore', args);
    handler.setQueryPool(null);
    expect(await handler.execute('codegraph_explore', args)).toEqual(pooled);
    handler.setQueryPool(pool);
    if (!hasDefault) {
      const missing = await handler.execute('codegraph_explore', { query: 'alphaSymbol' });
      expect(missing.isError).toBeFalsy();
      expect(missing.content[0].text).toContain(workspace);
      expect(missing.content[0].text).toContain('No CodeGraph project');
      // A default index can appear after rootless workers are already warm.
      await indexProject('workspace', 'lateSymbol');
      activeEngine.retryInitializeSync(workspace);
      const late = await handler.execute('codegraph_explore', { query: 'lateSymbol' });
      expect(late.isError).toBeFalsy();
      expect(late.content[0].text).toContain('lateSymbol');
    }
  }, 30000);

  it('retires real failed-open workers and recovers on a valid SQLite index (#1357)', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const workers: Worker[] = [];
    const exits: Promise<unknown>[] = [];
    pool = new QueryPool({
      root: alpha, size: 1,
      createWorker: () => {
        const worker = new Worker(path.resolve(__dirname, '../dist/mcp/query-worker.js'), {
          workerData: { root: workers.length === 0 ? tempDir : alpha },
        });
        workers.push(worker);
        exits.push(new Promise((resolve) => worker.once('exit', resolve)));
        return worker;
      },
    });
    try {
      const result = await pool.run('codegraph_search', { query: 'alphaSymbol' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('alphaSymbol');
      expect(workers).toHaveLength(2);
      await exits[0];
      expect(workers[0].threadId).toBe(-1);
      expect(pool.healthy).toBe(true);
    } finally {
      await pool.destroy();
      await Promise.all(exits);
    }
  }, 30000);

  it('never terminates a real worker before it has started', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const startedWhenEnded: boolean[] = [];
    pool = new QueryPool({
      root: alpha, size: 1,
      createWorker: () => {
        const worker = new Worker(path.resolve(__dirname, '../dist/mcp/query-worker.js'), { workerData: { root: alpha } });
        let started = false;
        worker.on('message', (m: { type?: string }) => { if (m?.type === 'ready') started = true; });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          startedWhenEnded.push(started);
          return terminate();
        };
        return worker;
      },
    });
    await pool.destroy(); // its eager worker is still loading
    expect(startedWhenEnded).toEqual([true]);
  }, 30000);

  it('engine stop waits for the query pool to shut down', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const activeEngine = await start(alpha);
    expect(pool).not.toBeNull();
    const realPool = pool!;
    let release!: () => void;
    const destroy = vi.spyOn(realPool, 'destroy').mockReturnValue(new Promise<void>((r) => { release = r; }));
    try {
      let stopped = false;
      const stopping = activeEngine.stop().then(() => { stopped = true; });
      // Everything else stop() closes is done well inside this; only the pool is held.
      await Promise.race([stopping, sleep(1_500)]);
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release();
      destroy.mockRestore();
      await realPool.destroy();
    }
  }, 30000);

  it('honors size=0 for projectPath-only sessions', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace);
    vi.stubEnv('CODEGRAPH_QUERY_POOL_SIZE', '0');
    const activeEngine = await start(workspace);
    expect(pool).toBeNull();
    const result = await activeEngine.getToolHandler().execute('codegraph_explore', {
      projectPath: alpha, query: 'alphaSymbol',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('alphaSymbol');
  }, 30000);

  it('stops real workers and settles queued calls on engine teardown', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const activeEngine = await start(alpha);
    expect(pool).not.toBeNull();
    const calls = Array.from({ length: 6 }, () => pool!.run('codegraph_explore', { query: 'alphaSymbol' }));
    const workers = (pool as unknown as { workers: Set<import('worker_threads').Worker> }).workers;
    const exits = [...workers].map((worker) => new Promise<void>((resolve) => worker.once('exit', () => resolve())));
    activeEngine.stop();
    const results = await Promise.all(calls);
    await Promise.all(exits);
    expect(results.every((r) => r.content[0].text.includes('shutting down'))).toBe(true);
    expect(pool!.liveWorkers).toBe(0);
    expect(pool!.healthy).toBe(false);
    await activeEngine.ensureInitialized(alpha);
    expect((activeEngine as unknown as { queryPool: QueryPool | null }).queryPool).toBeNull();
  }, 30000);
});
