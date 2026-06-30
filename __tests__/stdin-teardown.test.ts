/**
 * #799 — a socket-backed stdin that fails must shut the server down, not
 * orphan/busy-spin. treatStdinFailureAsShutdown is the shared guard.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { treatStdinFailureAsShutdown } from '../src/mcp/stdin-teardown';

describe('treatStdinFailureAsShutdown (#799)', () => {
  it("treats a stdin 'error' (ECONNRESET/hangup) as a shutdown signal", () => {
    const s = new PassThrough();
    let calls = 0;
    treatStdinFailureAsShutdown(() => { calls++; }, s);

    // No extra 'error' listener would throw here — the guard registers one.
    s.emit('error', new Error('read ECONNRESET'));
    expect(calls).toBe(1);
  });

  it("also fires on 'end' and on 'close'", () => {
    for (const ev of ['end', 'close'] as const) {
      const s = new PassThrough();
      let calls = 0;
      treatStdinFailureAsShutdown(() => { calls++; }, s);
      s.emit(ev);
      expect(calls, `event ${ev}`).toBe(1);
    }
  });

  it('destroys the stream so a hung fd leaves epoll', () => {
    const s = new PassThrough();
    treatStdinFailureAsShutdown(() => { /* noop */ }, s);
    s.emit('error', new Error('boom'));
    expect(s.destroyed).toBe(true);
  });

  it('fires onTerminal at most once, even across error → close', () => {
    const s = new PassThrough();
    let calls = 0;
    treatStdinFailureAsShutdown(() => { calls++; }, s);
    s.emit('error', new Error('boom')); // fire() also destroys → emits 'close'
    s.emit('close');                    // must not double-fire
    s.emit('end');
    expect(calls).toBe(1);
  });
});
