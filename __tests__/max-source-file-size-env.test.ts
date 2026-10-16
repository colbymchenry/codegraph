/**
 * MAX_SOURCE_FILE_SIZE_BYTES is read once at module load, so an override must
 * be set before the module is imported.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ENV_VAR = 'CODEGRAPH_MAX_SOURCE_FILE_SIZE_BYTES';

afterEach(() => {
  delete process.env[ENV_VAR];
});

async function loadLimit(): Promise<number> {
  vi.resetModules();
  const mod = await import('../src/file-limits');
  return mod.MAX_SOURCE_FILE_SIZE_BYTES;
}

describe('CODEGRAPH_MAX_SOURCE_FILE_SIZE_BYTES override', () => {
  it('defaults to 1 MiB when unset', async () => {
    expect(await loadLimit()).toBe(1024 * 1024);
  });

  it('honours a valid positive override', async () => {
    process.env[ENV_VAR] = '4194304';
    expect(await loadLimit()).toBe(4194304);
  });

  it('truncates a fractional override', async () => {
    process.env[ENV_VAR] = '1000.7';
    expect(await loadLimit()).toBe(1000);
  });

  it('falls back to the default on garbage input', async () => {
    process.env[ENV_VAR] = 'not-a-number';
    expect(await loadLimit()).toBe(1024 * 1024);
  });

  it('falls back to the default on a non-positive override', async () => {
    process.env[ENV_VAR] = '0';
    expect(await loadLimit()).toBe(1024 * 1024);
    process.env[ENV_VAR] = '-5';
    expect(await loadLimit()).toBe(1024 * 1024);
  });
});
