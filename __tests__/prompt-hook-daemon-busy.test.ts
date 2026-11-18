/**
 * A daemon that cannot start the prompt hook's explore at once says so, and the
 * hook runs its own (#3284).
 *
 * The hook holds the user's prompt until it answers. Waiting on a daemon that is
 * still catching up, serving other calls or on its way out is worse than the
 * hook's own explore, and what such a wait answers with (a busy notice, "this
 * session is closing") is no context to inject. So the request starts now or
 * answers `{ busy: true }`:
 *   - QueryPool.tryRun takes an idle warm worker or nothing, and queues nothing;
 *   - ToolHandler.execute with `startNow` returns NOT_STARTED when it would wait;
 *   - the session turns that into the `{ busy: true }` answer;
 *   - the hook's client reads that answer as `unavailable`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { QueryPool, type PoolWorker } from '../src/mcp/query-pool';
import { NOT_STARTED, ToolHandler, type ToolResult } from '../src/mcp/tools';
import { MCPSession } from '../src/mcp/session';
import { PROMPT_EXPLORE_BUSY, PROMPT_EXPLORE_METHOD } from '../src/mcp/prompt-explore';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcTransport } from '../src/mcp/transport';
import { exploreViaDaemon } from '../src/mcp/hook-client';
import { startFakeDaemon } from './fake-daemon';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

/** A worker that says ready, then answers each call when the test releases it. */
class HeldWorker implements PoolWorker {
  private onMsg?: (m: unknown) => void;
  private onExit?: (code: number) => void;
  readonly calls: Array<{ id: number; release: (r: ToolResult) => void }> = [];
  constructor() {
    setTimeout(() => this.onMsg?.({ type: 'ready', ok: true }), 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.onMsg = cb;
    else if (event === 'exit') this.onExit = cb;
  }
  postMessage(m: unknown): void {
    const msg = m as { type: string; id: number };
    if (msg.type === 'call') {
      this.calls.push({ id: msg.id, release: (result) => this.onMsg?.({ type: 'result', id: msg.id, result }) });
    } else if (msg.type === 'close') {
      // Like the real worker: close up and exit by itself, with code 0.
      setTimeout(() => this.onExit?.(0), 0);
    }
  }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

function heldPool(): { pool: QueryPool; worker: () => HeldWorker } {
  let made: HeldWorker | undefined;
  const pool = new QueryPool({ root: null, size: 1, idleShrinkMs: 0, createWorker: () => (made = new HeldWorker()) });
  cleanups.push(() => pool.destroy());
  return { pool, worker: () => made! };
}

describe('QueryPool.tryRun — an idle warm worker or nothing (#3284)', () => {
  it('starts nothing before a worker has finished its cold start', () => {
    const { pool } = heldPool();
    expect(pool.ready).toBe(false);
    expect(pool.tryRun('codegraph_explore', { query: 'x' })).toBeNull();
  });

  it('runs at once on an idle worker, and starts nothing while that worker is busy', async () => {
    const { pool, worker } = heldPool();
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.ready).toBe(true);

    const first = pool.tryRun('codegraph_explore', { query: 'first' });
    expect(first).not.toBeNull();
    expect(worker().calls).toHaveLength(1);
    // The only worker is busy: no second call starts, and none is queued for later.
    expect(pool.tryRun('codegraph_explore', { query: 'second' })).toBeNull();

    worker().calls[0]!.release(text('FIRST'));
    await expect(first).resolves.toEqual(text('FIRST'));
    expect(worker().calls).toHaveLength(1);

    // Idle again: the next one starts.
    const third = pool.tryRun('codegraph_explore', { query: 'third' });
    expect(third).not.toBeNull();
    expect(worker().calls).toHaveLength(2);
    worker().calls[1]!.release(text('THIRD'));
    await expect(third).resolves.toEqual(text('THIRD'));
  });
});

/** An indexed project whose functions call each other, so explore has something to say. */
async function indexedProject(): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hookbusy-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'orders.ts'),
    'export function placeOrder() { return chargeCard(); }\nexport function chargeCard() { return 1; }\n',
  );
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();
  return root;
}

async function openHandler(root: string): Promise<ToolHandler> {
  const cg = await CodeGraph.open(root);
  const handler = new ToolHandler(cg);
  cleanups.push(async () => { await handler.closeAll(); cg.close(); });
  return handler;
}

describe('ToolHandler.execute with startNow (#3284)', () => {
  it('returns NOT_STARTED from a closing handler, where a plain call gets the closing notice', async () => {
    const root = await indexedProject();
    const handler = await openHandler(root);
    void handler.closeAll();

    expect(await handler.execute('codegraph_explore', { query: 'placeOrder' }, undefined, undefined, { startNow: true })).toBe(NOT_STARTED);
    const plain = await handler.execute('codegraph_explore', { query: 'placeOrder' });
    expect(plain).not.toBe(NOT_STARTED);
    expect(plain.content[0]?.text).toMatch(/closing/i);
  });

  it('returns NOT_STARTED at once while the post-open catch-up is still running', async () => {
    const root = await indexedProject();
    const handler = await openHandler(root);
    handler.setCatchUpGate(new Promise<void>(() => { /* a catch-up that never ends */ }));

    const started = Date.now();
    expect(await handler.execute('codegraph_explore', { query: 'placeOrder' }, undefined, undefined, { startNow: true })).toBe(NOT_STARTED);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns NOT_STARTED when no warm worker is idle, and leaves nothing queued', async () => {
    const root = await indexedProject();
    const handler = await openHandler(root);
    const queued: string[] = [];
    handler.setQueryPool({
      healthy: true,
      ready: true,
      tryRun: () => null,
      run: (tool: string) => { queued.push(tool); return Promise.resolve(text('QUEUED')); },
    } as unknown as QueryPool);

    expect(await handler.execute('codegraph_explore', { query: 'placeOrder' }, undefined, undefined, { startNow: true })).toBe(NOT_STARTED);
    expect(queued).toEqual([]);
  });

  it('answers from an idle worker as a plain call would', async () => {
    const root = await indexedProject();
    const handler = await openHandler(root);
    handler.setQueryPool({
      healthy: true,
      ready: true,
      tryRun: () => Promise.resolve(text('FROM A WORKER')),
      run: () => Promise.resolve(text('QUEUED')),
    } as unknown as QueryPool);

    const result = await handler.execute('codegraph_explore', { query: 'placeOrder' }, undefined, undefined, { startNow: true });
    expect(result.content[0]?.text).toContain('FROM A WORKER');
  });
});

function fakeTransport(): JsonRpcTransport & { deliver(message: JsonRpcRequest): Promise<void>; results: unknown[] } {
  let handler: ((message: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
  const results: unknown[] = [];
  return {
    start(next) { handler = next; },
    stop() { /* nothing to tear down */ },
    send() { /* unused */ },
    notify() { /* unused */ },
    async request() { return {}; },
    sendResult(_id, result) { results.push(result); },
    sendError() { /* unused */ },
    results,
    async deliver(message) { await handler?.(message); },
  };
}

describe('the daemon answers the hook busy when it cannot start now (#3284)', () => {
  it('answers { busy: true } for a NOT_STARTED explore, and the explore itself otherwise', async () => {
    let next: ToolResult = NOT_STARTED;
    const startNow: unknown[] = [];
    const engine = {
      ensureInitialized: async () => { /* already initialized */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => '/project',
      retryInitializeSync: () => { /* already initialized */ },
      getToolHandler: () => ({
        execute: async (_tool: string, _args: unknown, _s: unknown, _w: unknown, opts?: { startNow?: boolean }) => {
          startNow.push(opts?.startNow);
          return next;
        },
      }),
    } as unknown as MCPEngine;
    const transport = fakeTransport();
    new MCPSession(transport, engine).start();

    await transport.deliver({ jsonrpc: '2.0', id: 1, method: PROMPT_EXPLORE_METHOD, params: { query: 'placeOrder' } });
    next = text('THE EXPLORE');
    await transport.deliver({ jsonrpc: '2.0', id: 2, method: PROMPT_EXPLORE_METHOD, params: { query: 'placeOrder' } });

    expect(transport.results).toEqual([PROMPT_EXPLORE_BUSY, text('THE EXPLORE')]);
    expect(startNow).toEqual([true, true]);
  });
});

describe('the hook reads a busy daemon as no daemon (#3284)', () => {
  it('is unavailable, so the hook explores itself, when the daemon answers busy', async () => {
    const root = await indexedProject();
    const daemon = await startFakeDaemon(root, { reply: () => ({ result: PROMPT_EXPLORE_BUSY }) });
    cleanups.push(() => daemon.close());

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(daemon.requests.map((r) => r.method)).toEqual([PROMPT_EXPLORE_METHOD]);
  });

  it('skips a line that answers another request, and reads the one that answers its own', async () => {
    const root = await indexedProject();
    const daemon = await startFakeDaemon(root, {
      before: [
        { jsonrpc: '2.0', method: 'notifications/message', params: {} },
        { jsonrpc: '2.0', id: 999, result: text('NOT OURS') },
      ],
      reply: () => ({ result: text('OURS') }),
    });
    cleanups.push(() => daemon.close());

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'answered', text: 'OURS' });
  });
});
