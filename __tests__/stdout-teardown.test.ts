/**
 * #2991 — a stdout that fails (the host stopped reading it) must shut the
 * server down through its own shutdown, not the fatal handler.
 * treatStdoutFailureAsShutdown is the shared guard; the real processes are
 * covered by mcp-stdout-failure.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { treatStdoutFailureAsShutdown } from '../src/mcp/stdout-teardown';

describe('treatStdoutFailureAsShutdown (#2991)', () => {
  it.each(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'])("treats a stdout 'error' (%s) as a shutdown signal", (code) => {
    const s = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, s);

    // Without the guard's listener this emit would throw.
    s.emit('error', Object.assign(new Error(`write ${code}`), { code }));
    expect(calls).toBe(1);
  });

  it("also fires on 'close'", () => {
    const s = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, s);
    s.emit('close');
    expect(calls).toBe(1);
  });

  it('destroys the stream so later writes are dropped', () => {
    const s = new PassThrough();
    treatStdoutFailureAsShutdown(() => { /* noop */ }, s);
    s.emit('error', new Error('write EPIPE'));
    expect(s.destroyed).toBe(true);
  });

  it('fires onTerminal at most once, and absorbs a write that fails during the shutdown', async () => {
    const s = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, s);
    s.emit('error', new Error('write EPIPE')); // fire() also destroys → emits 'close'
    s.write('a response queued before the failure');
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.emit('close');
    expect(calls).toBe(1);
  });

  it('leaves a stream under backpressure alone', async () => {
    const s = new PassThrough({ highWaterMark: 1 });
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, s);
    expect(s.write('a response the host has not read yet')).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(0);
    expect(s.destroyed).toBe(false);
  });
});
