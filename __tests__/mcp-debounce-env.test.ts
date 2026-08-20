/**
 * CODEGRAPH_WATCH_DEBOUNCE_MS env override (issue #403).
 *
 * Lets users tune the watcher quiet window from MCP-launched configs without
 * editing the agent's command line — formatter-on-save chains and large
 * generated outputs benefit from a longer window. Clamped to [100ms, 60s];
 * out-of-range / non-numeric values fall back to the FileWatcher default
 * (2000ms) rather than throwing or silently capping a likely typo.
 */
import { describe, it, expect } from 'vitest';
import { parseDebounceEnv } from '../src/mcp/engine';

describe('parseDebounceEnv', () => {
  it('returns undefined for unset / empty values', () => {
    expect(parseDebounceEnv(undefined)).toBeUndefined();
    expect(parseDebounceEnv('')).toBeUndefined();
    expect(parseDebounceEnv('   ')).toBeUndefined();
  });

  it('accepts integer values inside [100, 60000]', () => {
    expect(parseDebounceEnv('100')).toBe(100);
    expect(parseDebounceEnv('2000')).toBe(2000);
    expect(parseDebounceEnv('5000')).toBe(5000);
    expect(parseDebounceEnv('60000')).toBe(60000);
  });

  it('rejects out-of-range values (returns undefined, lets default win)', () => {
    expect(parseDebounceEnv('0')).toBeUndefined();
    expect(parseDebounceEnv('50')).toBeUndefined();   // below 100
    expect(parseDebounceEnv('99')).toBeUndefined();
    expect(parseDebounceEnv('60001')).toBeUndefined(); // above 60s
    expect(parseDebounceEnv('-500')).toBeUndefined();
  });

  it('rejects non-integer / non-numeric values', () => {
    expect(parseDebounceEnv('abc')).toBeUndefined();
    expect(parseDebounceEnv('500.5')).toBeUndefined();
    expect(parseDebounceEnv('NaN')).toBeUndefined();
    expect(parseDebounceEnv('Infinity')).toBeUndefined();
  });

  it('accepts scientific notation that resolves to an in-range integer', () => {
    // Number('1e3') === 1000, Number.isInteger(1000) === true. Power users
    // who write debounce as 1e3 should not be surprised; the clamp still applies.
    expect(parseDebounceEnv('1e3')).toBe(1000);
  });
});
