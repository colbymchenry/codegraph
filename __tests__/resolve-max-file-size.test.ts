import { afterEach, describe, expect, it } from 'vitest';
import { resolveMaxFileSize } from '../src/extraction';

const DEFAULT = 1024 * 1024;
const ENV = 'CODEGRAPH_MAX_FILE_SIZE';

describe('resolveMaxFileSize', () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it('falls back to the 1 MB default when the env var is unset', () => {
    delete process.env[ENV];
    expect(resolveMaxFileSize()).toBe(DEFAULT);
  });

  it('honours a valid positive override', () => {
    process.env[ENV] = String(5 * 1024 * 1024);
    expect(resolveMaxFileSize()).toBe(5 * 1024 * 1024);
  });

  it('floors fractional byte counts', () => {
    process.env[ENV] = '2097152.9';
    expect(resolveMaxFileSize()).toBe(2 * 1024 * 1024);
  });

  it.each(['', 'not-a-number', '0', '-1', 'NaN', 'Infinity'])(
    'falls back to the default for invalid value %j',
    (raw) => {
      process.env[ENV] = raw;
      expect(resolveMaxFileSize()).toBe(DEFAULT);
    },
  );
});
