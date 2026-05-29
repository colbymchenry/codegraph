/**
 * Regression test for the MCP daemon init-hang.
 *
 * `ensureWorker()` used to await a fresh parse worker's grammar-load with a bare
 * `once('message')` that only resolved on `grammars-loaded`. If the worker DIED
 * while loading grammars (a tree-sitter WASM abort), it never sent that message,
 * so the await — and the in-process `indexMutex` it runs under — hung forever.
 * In the shared daemon that wedged initialization for every connecting client.
 *
 * `awaitWorkerGrammarLoad` must settle (never hang) on every outcome: loaded,
 * load-failed, worker error, worker exit, or timeout.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { awaitWorkerGrammarLoad } from '../src/extraction/index';

class FakeWorker extends EventEmitter {
  posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
}

const noLeakedListeners = (w: FakeWorker) =>
  w.listenerCount('message') === 0 &&
  w.listenerCount('error') === 0 &&
  w.listenerCount('exit') === 0;

describe('awaitWorkerGrammarLoad — daemon init-hang regression', () => {
  it('posts the load-grammars request and resolves on grammars-loaded', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 1000);
    expect(w.posted).toEqual([{ type: 'load-grammars', languages: ['typescript'] }]);
    w.emit('message', { type: 'grammars-loaded' });
    await expect(p).resolves.toBeUndefined();
    expect(noLeakedListeners(w)).toBe(true);
  });

  it('rejects (does not hang) on grammars-load-failed', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 1000);
    w.emit('message', { type: 'grammars-load-failed', error: 'bad wasm' });
    await expect(p).rejects.toThrow(/bad wasm/);
    expect(noLeakedListeners(w)).toBe(true);
  });

  it('rejects (does not hang) when the worker exits before grammars load — the WASM-abort case', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 1000);
    w.emit('exit', 1);
    await expect(p).rejects.toThrow(/exited/);
    expect(noLeakedListeners(w)).toBe(true);
  });

  it('rejects (does not hang) when the worker emits an error', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 1000);
    w.emit('error', new Error('worker died'));
    await expect(p).rejects.toThrow(/worker died/);
    expect(noLeakedListeners(w)).toBe(true);
  });

  it('rejects on timeout when the worker goes silent — never hangs forever', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 50);
    await expect(p).rejects.toThrow(/timed out/);
    expect(noLeakedListeners(w)).toBe(true);
  });

  it('settles exactly once — a late worker exit after grammars-loaded is ignored', async () => {
    const w = new FakeWorker();
    const p = awaitWorkerGrammarLoad(w as never, ['typescript'], 1000);
    w.emit('message', { type: 'grammars-loaded' });
    await expect(p).resolves.toBeUndefined();
    // The promise already resolved; a later crash must not double-settle or
    // throw an unhandled 'error' (listeners are gone, so emitting is a no-op).
    expect(() => w.emit('exit', 1)).not.toThrow();
    expect(noLeakedListeners(w)).toBe(true);
  });
});
