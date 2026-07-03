/**
 * ParseWorkerPool — the worker pool that parses files across cores during a full
 * `codegraph index` (issue #1015). These tests drive the pool's queue / growth /
 * recycle / crash-recovery / timeout / teardown logic with INJECTED fake
 * workers, so they exercise the real scheduling code without spawning threads or
 * needing a built dist.
 *
 * End-to-end behavior with real worker threads (each worker owns a tree-sitter
 * WASM heap and runs extractFromSource) is covered by the extraction suite
 * against a real temp project; here we pin the orchestration that makes the
 * parallelism safe.
 */
import { describe, it, expect } from 'vitest';
import { ParseWorkerPool, resolveParsePoolSize, type ParsePoolWorker, type ParseTask } from '../src/extraction/parse-pool';
import type { Language, ExtractionResult } from '../src/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ParseMsg { type: 'parse'; id: number; filePath: string; content: string; language: Language }
type Action = { result: ExtractionResult } | { crash: true } | { hang: true } | { wait: Promise<ExtractionResult> };

/**
 * Fake worker speaking the same {load-grammars → grammars-loaded} /
 * {parse → parse-result} protocol as the real parse-worker. `behavior` decides
 * per parse whether to return a result, crash (exit≠0), hang (never reply —
 * exercises the timeout), or wait on a promise (hold a parse in-flight to
 * observe concurrency). Emits 'grammars-loaded' on a macrotask so the pool has
 * wired its listeners first.
 */
class FakeWorker implements ParsePoolWorker {
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  alive = true;
  constructor(private behavior: (m: ParseMsg) => Action, private onTerminate?: () => void) {}
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
    // 'error' unused by the fakes
  }
  private reply(id: number, result: ExtractionResult): void {
    if (this.alive) this.msgCb?.({ type: 'parse-result', id, result });
  }
  postMessage(msg: unknown): void {
    const m = msg as { type: string } & Partial<ParseMsg>;
    if (m.type === 'load-grammars') {
      setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'grammars-loaded' }); }, 0);
      return;
    }
    if (m.type !== 'parse') return;
    const action = this.behavior(m as ParseMsg);
    if ('crash' in action) {
      this.alive = false;
      setTimeout(() => this.exitCb?.(1), 0); // simulate a WASM-OOM exit(1)
      return;
    }
    if ('hang' in action) return; // never reply → timeout path
    if ('wait' in action) { void action.wait.then((r) => this.reply(m.id!, r)); return; }
    setTimeout(() => this.reply(m.id!, action.result), 0);
  }
  terminate(): Promise<number> { this.alive = false; this.onTerminate?.(); return Promise.resolve(0); }
}

const task = (filePath: string, content = 'code'): ParseTask => ({ filePath, content, language: 'typescript' as Language });
const result = (tag = 0): ExtractionResult => ({ nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: tag });

/** Build a pool with a counting fake-worker factory. */
function makePool(
  size: number,
  behavior: (m: ParseMsg) => Action,
  opts: Partial<{ recycleInterval: number; parseTimeoutMs: number }> = {}
) {
  let spawned = 0, terminated = 0;
  const pool = new ParseWorkerPool({
    languages: ['typescript'] as Language[],
    size,
    recycleInterval: opts.recycleInterval,
    parseTimeoutMs: opts.parseTimeoutMs,
    createWorker: () => { spawned++; return new FakeWorker(behavior, () => { terminated++; }); },
  });
  return { pool, counts: () => ({ spawned, terminated }) };
}

describe('resolveParsePoolSize', () => {
  it('treats explicit 0 and 1 as a single worker (the rollback path)', () => {
    expect(resolveParsePoolSize('0', 8)).toBe(1);
    expect(resolveParsePoolSize('1', 8)).toBe(1);
  });
  it('honors a numeric override, capped at the hard ceiling', () => {
    expect(resolveParsePoolSize('4', 8)).toBe(4);
    expect(resolveParsePoolSize('999', 8)).toBe(16);
  });
  it('defaults to clamp(cores-1, 1, 8) when unset/blank/non-numeric', () => {
    expect(resolveParsePoolSize(undefined, 8)).toBe(7);
    expect(resolveParsePoolSize('', 8)).toBe(7);
    expect(resolveParsePoolSize('abc', 8)).toBe(7);
    expect(resolveParsePoolSize(undefined, 1)).toBe(1);   // never zero
    expect(resolveParsePoolSize(undefined, 2)).toBe(1);   // leave a core
    expect(resolveParsePoolSize(undefined, 64)).toBe(8);  // never above the default cap
  });
});

describe('ParseWorkerPool', () => {
  it('parses a file and returns the worker result', async () => {
    const { pool } = makePool(1, () => ({ result: result(42) }));
    const res = await pool.requestParse(task('a.ts'));
    expect(res.durationMs).toBe(42);
    await pool.destroy();
  });

  it('runs N parses in parallel across the pool (not serialized)', async () => {
    let active = 0, maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { pool } = makePool(4, () => ({
      wait: (async () => { active++; maxActive = Math.max(maxActive, active); await gate; active--; return result(); })(),
    }));
    const ps = [0, 1, 2, 3].map((i) => pool.requestParse(task(`f${i}.ts`)));
    await sleep(60); // let the pool grow to size and dispatch all four
    expect(maxActive).toBe(4);
    release();
    await Promise.all(ps);
    await pool.destroy();
  });

  it('grows lazily — a single parse does not spawn the whole pool', async () => {
    const { pool, counts } = makePool(8, () => ({ result: result() }));
    await pool.requestParse(task('only.ts'));
    expect(counts().spawned).toBe(1); // just the eager warm worker
    await pool.destroy();
  });

  it('recycles a worker after recycleInterval parses', async () => {
    const { pool, counts } = makePool(1, () => ({ result: result() }), { recycleInterval: 3 });
    for (let i = 0; i < 4; i++) await pool.requestParse(task(`f${i}.ts`));
    // 3 parses on the first worker → recycle (terminate + respawn); the 4th runs
    // on the fresh worker.
    expect(counts().spawned).toBe(2);
    expect(counts().terminated).toBeGreaterThanOrEqual(1);
    await pool.destroy();
  });

  it('rejects a parse whose worker crashes (retry-pass-recognisable message) and keeps serving', async () => {
    const { pool, counts } = makePool(1, (m) => (m.filePath === 'poison.ts' ? { crash: true } : { result: result(7) }));
    // The message must contain "Worker exited" so the orchestrator's retry pass
    // re-attempts it (that's the filter it uses).
    await expect(pool.requestParse(task('poison.ts'))).rejects.toThrow(/Worker exited/);
    const ok = await pool.requestParse(task('good.ts'));
    expect(ok.durationMs).toBe(7);
    expect(counts().spawned).toBe(2); // respawned after the crash
    await pool.destroy();
  });

  it('times out a hung parse and stays usable', async () => {
    const { pool } = makePool(1, (m) => (m.filePath === 'hang.ts' ? { hang: true } : { result: result(9) }), { parseTimeoutMs: 30 });
    await expect(pool.requestParse(task('hang.ts'))).rejects.toThrow(/timed out/i);
    const ok = await pool.requestParse(task('ok.ts'));
    expect(ok.durationMs).toBe(9);
    await pool.destroy();
  });

  it('serves a queue larger than the pool size', async () => {
    const { pool } = makePool(2, (m) => ({ result: result(Number(m.filePath.replace(/\D/g, ''))) }));
    const ps = Array.from({ length: 10 }, (_, i) => pool.requestParse(task(`${i}.ts`)));
    const res = await Promise.all(ps);
    expect(res.map((r) => r.durationMs).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await pool.destroy();
  });

  it('destroy() rejects in-flight and subsequent parses', async () => {
    const { pool } = makePool(1, () => ({ hang: true }));
    const p = pool.requestParse(task('x.ts'));
    p.catch(() => {}); // avoid an unhandled rejection before we assert
    await sleep(10);
    await pool.destroy();
    await expect(p).rejects.toThrow(/destroyed/);
    await expect(pool.requestParse(task('y.ts'))).rejects.toThrow(/destroyed/);
  });
});
