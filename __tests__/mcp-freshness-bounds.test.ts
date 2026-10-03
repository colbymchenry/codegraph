import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { validateAnswerFiles } from '../src/mcp/answer-freshness';
import { endFreshnessMeasurements, measurePendingChanges } from '../src/mcp/index-freshness';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const workers = vi.hoisted(() => [] as any[]);
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor() { super(); workers.push(this); }
  } };
});

describe('bounded freshness validation (#1959)', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    workers.length = 0;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('marks a file beyond the byte budget unchecked instead of fresh', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-freshness-bounds-'));
    const content = 'x'.repeat(9 * 1024 * 1024);
    fs.writeFileSync(path.join(root, 'large.ts'), content);
    const result = await validateAnswerFiles(root, [{
      path: 'large.ts', contentHash: createHash('sha256').update(content).digest('hex'),
    }]);
    expect(result).toEqual({ stale: [], unchecked: ['large.ts'] });
  });

  it('bounds a stuck measurement, shares concurrent probes, and terminates its worker', async () => {
    vi.useFakeTimers();
    const pending = measurePendingChanges('/freshness-timeout');
    expect(measurePendingChanges('/freshness-timeout')).toBe(pending);
    expect(workers).toHaveLength(1);
    workers[0].emit('message', { type: 'loaded' }); // stuck past loading, in the scan
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('answers unknown on deadline but never terminates a worker still loading its modules', async () => {
    // Terminating a worker while it loads its modules can crash the process
    // on Windows (0xC0000005) — see worker-start.ts.
    vi.useFakeTimers();
    const pending = measurePendingChanges('/freshness-still-loading');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].emit('message', { type: 'loaded' });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('a server shutting down ends measurements once they have loaded', async () => {
    vi.useFakeTimers();
    const pending = measurePendingChanges('/freshness-shutdown');
    let ended = false;
    const ending = endFreshnessMeasurements().then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toBe(false);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].emit('message', { type: 'loaded' });
    await ending;
    expect(workers[0].terminate).toHaveBeenCalled();
    workers[0].emit('exit', 1); // what a terminated worker does
    expect(await pending).toBeNull();
  });

  it('returns unknown on deadline even if worker termination is delayed', async () => {
    vi.useFakeTimers();
    const pending = measurePendingChanges('/freshness-delayed-exit');
    let release!: () => void;
    workers[0].terminate.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    workers[0].emit('message', { type: 'loaded' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    release();
    await Promise.resolve();
  });

  it('aborts stalled file reads and reports all remaining paths as unchecked', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-freshness-deadline-'));
    fs.writeFileSync(path.join(root, 'stalled.ts'), 'export const x = 1;');
    vi.mocked(fs.createReadStream).mockImplementationOnce((_file, options) => new Readable({
      read() {}, signal: (options as { signal: AbortSignal }).signal,
    }) as fs.ReadStream);
    const result = await validateAnswerFiles(root, [
      { path: 'stalled.ts', contentHash: 'hash' },
      { path: 'next.ts', contentHash: 'hash' },
    ]);
    expect(result).toEqual({ stale: [], unchecked: ['stalled.ts', 'next.ts'] });
  });

  it('caps measurements across projects and releases the slots on failure', async () => {
    const first = measurePendingChanges('/freshness-one');
    const second = measurePendingChanges('/freshness-two');
    expect(await measurePendingChanges('/freshness-three')).toBeNull();
    expect(workers).toHaveLength(2);
    workers[0].emit('error', new Error('worker failed'));
    workers[1].emit('message', { type: 'counts', counts: { added: -1, modified: 0, removed: 0 } });
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    await new Promise((r) => setTimeout(r, 0)); // the slots free once each worker is terminated
    const retry = measurePendingChanges('/freshness-three');
    workers[2].emit('message', { type: 'loaded' });
    workers[2].emit('message', { type: 'counts', counts: { added: 0, modified: 1, removed: 0 } });
    expect(await retry).toEqual({ added: 0, modified: 1, removed: 0 });
  });
});
