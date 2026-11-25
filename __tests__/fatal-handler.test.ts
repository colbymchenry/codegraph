import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { describeFatal, installFatalHandlers } from '../src/bin/fatal-handler';

/**
 * Regression coverage for #850 (and the related #799): a fault that reaches the
 * process-wide handler must NOT be swallowed-and-kept-running, and rendering it
 * must NEVER touch `error.stack` — the lazy stack getter is what can wedge a
 * core in a V8 source-position loop.
 */
describe('describeFatal', () => {
  it('renders name + message for an Error', () => {
    expect(describeFatal(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('falls back to the name when the message is empty', () => {
    expect(describeFatal(new Error(''))).toBe('Error');
  });

  it('stringifies non-Error values', () => {
    expect(describeFatal('a string reason')).toBe('a string reason');
    expect(describeFatal(42)).toBe('42');
    expect(describeFatal(null)).toBe('null');
    expect(describeFatal(undefined)).toBe('undefined');
  });

  it('NEVER reads error.stack (the #850 hang lives in the lazy stack getter)', () => {
    const err = new Error('boom');
    let stackAccessed = false;
    Object.defineProperty(err, 'stack', {
      configurable: true,
      get() {
        // Simulates the pathological case: formatting the stack never returns.
        stackAccessed = true;
        throw new Error('stack formatting wedged');
      },
    });

    const rendered = describeFatal(err);

    expect(stackAccessed).toBe(false);
    expect(rendered).toBe('Error: boom');
    expect(rendered).not.toMatch(/\bat\b/); // no stack frames leaked in
  });

  it('never throws on a value with a hostile toString', () => {
    const hostile = {
      toString() {
        throw new Error('no stringification for you');
      },
    };
    expect(describeFatal(hostile)).toBe('<unstringifiable value>');
  });
});

describe('installFatalHandlers', () => {
  function harness() {
    const target = new EventEmitter();
    const writes: string[] = [];
    const exits: number[] = [];
    installFatalHandlers({
      target,
      write: (line) => writes.push(line),
      exit: (code) => {
        exits.push(code);
      },
    });
    return { target, writes, exits };
  }

  it('logs a bounded line and exits non-zero on an uncaught exception', () => {
    const { target, writes, exits } = harness();
    target.emit('uncaughtException', new RangeError('kaboom'));
    expect(writes).toEqual(['[CodeGraph] Uncaught exception: RangeError: kaboom\n']);
    expect(exits).toEqual([1]);
  });

  it('logs a bounded line and exits non-zero on an unhandled rejection', () => {
    const { target, writes, exits } = harness();
    target.emit('unhandledRejection', 'promise went sideways');
    expect(writes).toEqual(['[CodeGraph] Unhandled rejection: promise went sideways\n']);
    expect(exits).toEqual([1]);
  });

  it('still exits — without touching the stack — when stack formatting would wedge', () => {
    const { target, writes, exits } = harness();
    const err = new Error('wedged');
    Object.defineProperty(err, 'stack', {
      configurable: true,
      get() {
        throw new Error('stack formatting wedged');
      },
    });

    // Must not throw or hang: the handler renders message-only and exits.
    expect(() => target.emit('uncaughtException', err)).not.toThrow();
    expect(writes).toEqual(['[CodeGraph] Uncaught exception: Error: wedged\n']);
    expect(exits).toEqual([1]);
  });
});
